import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import {
  AutomationTelemetryCommitUncertainError,
  AutomationTelemetryOutbox,
  AutomationTelemetryPublisher,
  AutomationTelemetryRecorder
} from "./automation-telemetry-outbox";
import { automationScope } from "./automation-test-fixtures";

const directories: string[] = [];
const ruleId = "00000000-0000-4000-8000-000000000104";

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AutomationTelemetryOutbox", () => {
  it("persists immutable event identity across restart and deletes only an exact application ACK", async () => {
    const test = await outboxFixture();
    const stored = await test.outbox.append(eventInput("event_started", {
      sourceFixtureId: "00000000-0000-4000-8000-000000000102"
    }));
    const restarted = new AutomationTelemetryOutbox(test.path, automationScope);

    expect(await restarted.pending()).toEqual([stored]);
    await expect(restarted.markIngested({
      eventId: stored.event.eventId,
      sequence: stored.event.sequence,
      reportPayloadHash: `sha256:${"f".repeat(64)}`
    })).resolves.toBe("conflict");
    expect(await restarted.pending()).toHaveLength(1);

    await expect(restarted.markIngested({
      eventId: stored.event.eventId,
      sequence: stored.event.sequence,
      reportPayloadHash: stored.reportPayloadHash
    })).resolves.toBe("deleted");
    expect(await restarted.pending()).toEqual([]);
  });

  it("coalesces an unpublished active-event extension to the newest immutable record", async () => {
    const test = await outboxFixture();
    const occurrenceKey = `${ruleId}:2026-08-30T01:00:00.000Z`;
    const first = await test.outbox.append(eventInput("event_extended", {
      holdUntil: "2026-08-30T01:01:00.000Z"
    }, occurrenceKey));
    const latest = await test.outbox.append(eventInput("event_extended", {
      holdUntil: "2026-08-30T01:01:30.000Z"
    }, occurrenceKey));

    expect(latest.event.eventId).not.toBe(first.event.eventId);
    expect(await test.outbox.pending()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          eventId: latest.event.eventId,
          sequence: latest.event.sequence,
          payload: { holdUntil: "2026-08-30T01:01:30.000Z" }
        })
      })
    ]);
  });

  it("keeps the entire atomic file under its byte limit and accumulates a fixed gap at capacity", async () => {
    const test = await outboxFixture({ maxBytes: 8_192 });
    let appended = 0;
    while (appended < 200) {
      await test.outbox.append(eventInput("vehicle_detected", {
        sourceFixtureId: "00000000-0000-4000-8000-000000000102",
        padding: "x".repeat(256)
      }));
      appended += 1;
    }

    const file = await stat(test.path);
    expect(file.size).toBeLessThanOrEqual(8_192);
    const debug = await test.outbox.inspect();
    expect(debug.gap).toMatchObject({ droppedCount: expect.any(Number) });
    expect(debug.gap!.droppedCount).toBeGreaterThan(0);
    expect(await readFile(test.path, "utf8")).toContain("firstDroppedAt");
  });

  it("restores the previous visible file and fences the uncertain append", async () => {
    const test = await outboxFixture();
    const stable = await test.outbox.append(eventInput("event_started", {}));
    let inject = true;
    const uncertain = new AutomationTelemetryOutbox(test.path, automationScope, {
      write: async (path, value) => {
        if (inject) {
          inject = false;
          await writeJsonAtomic(path, value, {
            syncParentDirectory: async () => { throw new Error("injected directory fsync failure"); }
          });
          return;
        }
        await writeJsonAtomic(path, value);
      }
    });
    await uncertain.initialize();

    await expect(uncertain.append(eventInput("vehicle_detected", {})))
      .rejects.toBeInstanceOf(AutomationTelemetryCommitUncertainError);
    expect(await uncertain.pending()).toEqual([stable]);
  });

  it("imports an exact pre-outbox telemetry gap without expanding it per dropped event", async () => {
    const test = await outboxFixture();
    await test.outbox.recordGap({
      revision: 7,
      firstDroppedAt: "2026-08-30T01:00:00.000Z",
      lastDroppedAt: "2026-08-30T01:05:00.000Z",
      droppedCount: 42
    });

    expect((await test.outbox.inspect()).gap).toMatchObject({
      revision: 7,
      firstDroppedAt: "2026-08-30T01:00:00.000Z",
      lastDroppedAt: "2026-08-30T01:05:00.000Z",
      droppedCount: 42
    });
  });
});

describe("AutomationTelemetryPublisher", () => {
  it("publishes QoS 1 exact payload, retries on reconnect, and retains until application ACK", async () => {
    const test = await outboxFixture();
    const stored = await test.outbox.append(eventInput("event_started", {}));
    const firstClient = mqttClient();
    const publisher = new AutomationTelemetryPublisher(test.outbox, automationScope, {
      retryInitialDelayMs: 60_000
    });

    await publisher.connect(firstClient);
    expect(firstClient.publish).toHaveBeenCalledWith(
      expect.stringContaining("/events/automation/execution"),
      JSON.stringify(stored.event),
      { qos: 1 },
      expect.any(Function)
    );
    expect(await test.outbox.pending()).toHaveLength(1);

    publisher.disconnect();
    const reconnected = mqttClient();
    await publisher.connect(reconnected);
    expect(reconnected.publish).toHaveBeenCalledTimes(1);

    await test.outbox.markIngested({
      eventId: stored.event.eventId,
      sequence: stored.event.sequence,
      reportPayloadHash: stored.reportPayloadHash
    });
    await publisher.stopAndDrain();
    expect(await test.outbox.pending()).toEqual([]);
  });

  it("starts a new reconnect generation while the previous publish callback is still pending", async () => {
    const test = await outboxFixture();
    await test.outbox.append(eventInput("event_started", {}));
    const firstClient = {
      publish: vi.fn((
        _topic: string,
        _payload: string,
        _options: { qos: 1 },
        _callback: (error?: Error) => void
      ) => undefined)
    };
    const publisher = new AutomationTelemetryPublisher(test.outbox, automationScope, {
      publishTimeoutMs: 10_000,
      retryInitialDelayMs: 60_000
    });
    const firstDrain = publisher.connect(firstClient).catch((error) => error);
    await vi.waitFor(() => expect(firstClient.publish).toHaveBeenCalledTimes(1));

    publisher.disconnect();
    const reconnected = mqttClient();
    await publisher.connect(reconnected);

    expect(reconnected.publish).toHaveBeenCalledTimes(1);
    firstClient.publish.mock.calls[0]?.[3]?.(new Error("old connection closed"));
    await firstDrain;
    await publisher.stopAndDrain();
  });
});

describe("AutomationTelemetryRecorder", () => {
  it("records lifecycle in order and attributes final base-return results to the ended vehicle rule", async () => {
    const test = await outboxFixture();
    const recorder = new AutomationTelemetryRecorder(test.outbox);
    const fixtureId = "00000000-0000-4000-8000-000000000101";
    const occurrenceKey = `${ruleId}:2026-08-30T01:00:00.000Z`;
    await recorder.recordLifecycle({
      revision: 3,
      events: [
        {
          kind: "vehicle_detected",
          ruleId,
          occurrenceKey,
          occurredAt: "2026-08-30T01:00:00.000Z",
          payload: { sourceFixtureId: "00000000-0000-4000-8000-000000000102" }
        },
        {
          kind: "event_started",
          ruleId,
          occurrenceKey,
          occurredAt: "2026-08-30T01:00:00.000Z",
          payload: { targetFixtureIds: [fixtureId] }
        }
      ]
    });
    await recorder.recordTerminal({
      revision: 3,
      actions: [{
        fixtureId,
        brightnessPercent: 20,
        sourceType: "current",
        sourceId: null,
        occurrenceKey: null
      }],
      results: [{
        fixtureId,
        status: "succeeded",
        brightnessPercent: 20,
        faultCode: null,
        errorCode: null,
        occurredAt: "2026-08-30T01:01:00.000Z"
      }],
      causes: [{
        kind: "event_ended",
        ruleId,
        occurrenceKey,
        occurredAt: "2026-08-30T01:01:00.000Z",
        payload: { targetFixtureIds: [fixtureId], reason: "hold_expired" }
      }]
    });

    const pending = await test.outbox.pending();
    expect(pending.map(({ event }) => [event.sequence, event.kind])).toEqual([
      [1, "vehicle_detected"],
      [2, "event_started"],
      [3, "action_result"]
    ]);
    expect(pending[2]?.event).toMatchObject({
      ruleId,
      occurrenceKey,
      payload: {
        sourceType: "vehicle_event_rule",
        sourceId: ruleId,
        results: [expect.objectContaining({ fixtureId, status: "succeeded" })]
      }
    });
  });
});

async function outboxFixture(options: { maxBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-outbox-"));
  directories.push(directory);
  const path = join(directory, "outbox.json");
  const outbox = new AutomationTelemetryOutbox(path, automationScope, options);
  await outbox.initialize();
  return { path, outbox };
}

function eventInput(kind: "vehicle_detected" | "event_started" | "event_extended", payload: Record<string, unknown>, occurrenceKey: string | null = null) {
  return {
    revision: 1,
    ruleId,
    occurrenceKey,
    kind,
    occurredAt: "2026-08-30T01:00:00.000Z",
    payload
  } as const;
}

function mqttClient() {
  return {
    publish: vi.fn((_topic: string, _payload: string, _options: { qos: 1 }, callback: (error?: Error) => void) => {
      callback();
      return undefined as never;
    })
  };
}
