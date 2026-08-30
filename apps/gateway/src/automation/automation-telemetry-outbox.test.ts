import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import {
  StorageHeadroomManager,
  type StorageHeadroomBackgroundTask
} from "../storage/storage-headroom-manager";
import { automationTelemetryRecordsHash } from "./automation-telemetry-handoff";
import { AutomationTelemetryGapJournal } from "./automation-telemetry-gap-journal";
import {
  AutomationTelemetryCommitUncertainError,
  AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES,
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
    await expect(stat(`${test.path}.gap`)).resolves.toMatchObject({
      size: AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES
    });
  });

  it("preserves rename-success uncertainty through ENOSPC and failed background replenishment without recording a gap", async () => {
    const test = await outboxFixture();
    const stable = await test.outbox.append(eventInput("event_started", {}));
    const tasks: StorageHeadroomBackgroundTask[] = [];
    let allocations = 0;
    const headroom = new StorageHeadroomManager(`${test.path}.shared-reserve`, 32_768, {
      preallocate: async (_path, bytes) => {
        allocations += 1;
        if (allocations > 1) throw Object.assign(new Error("replenish still full"), { code: "ENOSPC" });
        return bytes;
      },
      release: async () => undefined,
      getFreeBytes: async () => 128 * 1024,
      scheduleBackground: (task) => { tasks.push(task); return tasks.length; },
      cancelBackground: () => undefined
    });
    let writes = 0;
    const uncertain = new AutomationTelemetryOutbox(test.path, automationScope, {
      headroom,
      write: async (path, value) => {
        writes += 1;
        if (writes === 1) throw Object.assign(new Error("disk full before temp allocation"), { code: "ENOSPC" });
        if (writes === 2) {
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
    await expect(tasks[0]!()).resolves.toBeUndefined();
    expect((await uncertain.inspect()).gap).toBeNull();
    expect((await uncertain.inspect()).records.map((record) => record.event.kind)).toEqual([
      stable.event.kind,
      "vehicle_detected"
    ]);
    expect(headroom.snapshot()).toMatchObject({
      status: "released",
      counters: { releaseCount: 1, retryCount: 1, replenishFailureCount: 1 }
    });

    const restarted = new AutomationTelemetryOutbox(test.path, automationScope, { headroomBytes: 32_768 });
    await restarted.initialize();
    expect((await restarted.pending()).map((record) => record.event.kind)).toEqual([
      "event_started",
      "vehicle_detected"
    ]);
    headroom.stop();
  });

  it("fences repeated handoff attempts instead of recording a gap when uncertain target visibility cannot be reconciled", async () => {
    const test = await outboxFixture();
    let inject = true;
    const uncertain = new AutomationTelemetryOutbox(test.path, automationScope, {
      headroomBytes: 32_768,
      write: async (path, value) => {
        if (!inject) return writeJsonAtomic(path, value);
        inject = false;
        try {
          await writeJsonAtomic(path, value, {
            syncParentDirectory: async () => { throw new Error("injected directory fsync failure"); }
          });
        } catch (error) {
          await rm(path, { force: true });
          throw error;
        }
      }
    });
    await uncertain.initialize();
    const records = [eventInput("vehicle_detected", {})];
    const handoff = {
      handoffId: "77777777-7777-4777-8777-777777777777",
      recordsHash: automationTelemetryRecordsHash(records),
      records
    };

    await expect(uncertain.appendBatch(handoff)).rejects.toBeInstanceOf(AutomationTelemetryCommitUncertainError);
    await expect(uncertain.appendBatch(handoff)).rejects.toBeInstanceOf(AutomationTelemetryCommitUncertainError);
    await expect(new AutomationTelemetryGapJournal(`${test.path}.gap`).read()).resolves.toBeNull();
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

  it("commits a lifecycle handoff as one batch with no persisted prefix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-batch-"));
    directories.push(directory);
    const path = join(directory, "outbox.json");
    const outbox = new AutomationTelemetryOutbox(path, automationScope, {
      headroomBytes: 8_192,
      write: async (target, value) => {
        if (Array.isArray((value as { records?: unknown }).records) &&
          ((value as { records: unknown[] }).records.length === 2)) {
          throw new Error("injected batch commit failure");
        }
        await writeJsonAtomic(target, value);
      }
    });
    await outbox.initialize();
    const recorder = new AutomationTelemetryRecorder(outbox);

    const result = await recorder.recordLifecycle({
      revision: 3,
      events: [
        {
          kind: "vehicle_detected",
          ruleId,
          occurrenceKey: "occurrence-1",
          occurredAt: "2026-08-30T01:00:00.000Z",
          payload: { sourceFixtureId: "00000000-0000-4000-8000-000000000102" }
        },
        {
          kind: "event_started",
          ruleId,
          occurrenceKey: "occurrence-1",
          occurredAt: "2026-08-30T01:00:00.000Z",
          payload: {}
        }
      ]
    });

    expect((await outbox.inspect()).records).toEqual([]);
    expect(result.droppedRecords).toHaveLength(2);
  });

  it("deduplicates an exact persisted gap handoff across the outbox commit and state-clear boundary", async () => {
    const test = await outboxFixture();
    const input = {
      handoffId: "11111111-1111-4111-8111-111111111111",
      recordsHash: `sha256:${"b".repeat(64)}`,
      provenance: "automation_state_gap" as const,
      revision: 7,
      firstDroppedAt: "2026-08-30T01:00:00.000Z",
      lastDroppedAt: "2026-08-30T01:05:00.000Z",
      droppedCount: 4
    };

    await test.outbox.recordGap(input);
    await test.outbox.recordGap(input);

    expect((await test.outbox.inspect()).gap).toMatchObject({ droppedCount: 4 });
  });

  it("preallocates a fixed gap journal and accepts drops after ENOSPC degrades regular storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-enospc-"));
    directories.push(directory);
    const path = join(directory, "outbox.json");
    const enospc = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const headroom = new StorageHeadroomManager(`${path}.reserve`, 8_192, {
      preallocate: async () => { throw enospc; },
      scheduleBackground: () => 1,
      cancelBackground: () => undefined
    });
    const outbox = new AutomationTelemetryOutbox(path, automationScope, {
      headroom,
      write: async () => { throw enospc; }
    });

    await expect(outbox.initialize()).resolves.toMatchObject({ mode: "degraded" });
    const records = [eventInput("event_started", {})];
    const result = await outbox.appendBatch({
      handoffId: "33333333-3333-4333-8333-333333333333",
      recordsHash: automationTelemetryRecordsHash(records),
      records
    });

    expect(result.droppedRecords).toEqual([eventInput("event_started", {})]);
    await expect(stat(`${path}.gap`)).resolves.toMatchObject({ size: AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES });
    headroom.stop();
  });

  it("updates the preallocated gap journal in place and recovers its last fsynced block", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-gap-journal-"));
    directories.push(directory);
    const path = join(directory, "gap.bin");
    const journal = new AutomationTelemetryGapJournal(path, () => "44444444-4444-4444-8444-444444444444");
    await journal.initialize();
    const before = await stat(path);
    await journal.record({
      handoffId: "55555555-5555-4555-8555-555555555555",
      recordsHash: `sha256:${"e".repeat(64)}`,
      provenance: "automation_handoff_storage",
      revision: 8,
      firstDroppedAt: "2026-08-30T01:00:00.000Z",
      lastDroppedAt: "2026-08-30T01:00:02.000Z",
      droppedCount: 3
    });
    const after = await stat(path);
    const restarted = new AutomationTelemetryGapJournal(path);

    expect(after.size).toBe(AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES);
    expect(after.ino).toBe(before.ino);
    expect(after.blocks).toBe(before.blocks);
    await expect(restarted.read()).resolves.toMatchObject({
      gapHandoffId: "44444444-4444-4444-8444-444444444444",
      droppedCount: 3,
      lastSourceHandoffId: "55555555-5555-4555-8555-555555555555"
    });
  });

  it("keeps shared regular atomic-rewrite headroom untouched across normal outbox commits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-headroom-"));
    directories.push(directory);
    const path = join(directory, "outbox.json");
    const reservePath = join(directory, "automation-storage.reserve");
    const headroom = new StorageHeadroomManager(reservePath, 8_192);
    const outbox = new AutomationTelemetryOutbox(path, automationScope, { maxBytes: 8_192, headroom });
    await outbox.initialize();
    const before = await stat(reservePath);

    await outbox.append(eventInput("event_started", {}));
    await outbox.append(eventInput("vehicle_detected", {}));

    const after = await stat(reservePath);
    expect(after).toMatchObject({ size: 8_192, ino: before.ino, blocks: before.blocks });
    expect((await stat(path)).size).toBeLessThanOrEqual(8_192);
    expect(headroom.snapshot()).toMatchObject({
      status: "available",
      counters: { preallocatedBytes: 8_192, releaseCount: 0, retryCount: 0 }
    });
    headroom.stop();
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
  const outbox = new AutomationTelemetryOutbox(path, automationScope, {
    ...options,
    headroomBytes: options.maxBytes ?? 32_768
  });
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
