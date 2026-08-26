import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mqttTopicsV2, type FixtureStateV2 } from "@led-control/shared";
import {
  StateEventCapacityGate,
  StateEventOutbox,
  StateEventOutboxPublisher
} from "./state-event-outbox";

const directories: string[] = [];
const scope = {
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "55555555-5555-4555-8555-555555555555"
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("StateEventOutbox", () => {
  it("persists mode 0600 before publish and survives restart until exact application ACK", async () => {
    const path = await outboxPath();
    const outbox = new StateEventOutbox(path, scope);
    await outbox.initialize();
    const event = fixtureState(7);

    await outbox.enqueue(event);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}.manifest.json`)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect((await outbox.pending()).map((record) => record.payload)).toEqual([event]);

    const restored = new StateEventOutbox(path, scope);
    await restored.initialize();
    expect(await restored.acknowledge({
      eventId: event.eventId,
      sequence: event.sequence + 1,
      fixtureId: event.fixtureId,
      status: "ingested",
      ingestedAt: "2026-08-26T00:00:02.000Z"
    })).toBe(false);
    expect(await restored.acknowledge({
      eventId: event.eventId,
      sequence: event.sequence,
      fixtureId: event.fixtureId,
      status: "stale_checkpoint",
      ingestedAt: "2026-08-26T00:00:02.000Z"
    })).toBe(true);
    expect(await restored.pending()).toEqual([]);
  });

  it("distinguishes first run from a missing initialized outbox and fails closed", async () => {
    const path = await outboxPath();
    const firstRun = new StateEventOutbox(path, scope);
    await firstRun.initialize();
    await firstRun.enqueue(fixtureState(7));

    await rm(path);

    await expect(new StateEventOutbox(path, scope).initialize()).rejects.toMatchObject({
      code: "STATE_OUTBOX_MISSING"
    });
    expect(JSON.parse(await readFile(`${path}.manifest.json`, "utf8"))).toMatchObject({ version: 1, scope });
  });

  it("fails closed on a corrupt manifest or non-owner-only directory", async () => {
    const path = await outboxPath();
    await new StateEventOutbox(path, scope).initialize();
    await writeFile(`${path}.manifest.json`, "{}", { mode: 0o600 });
    await expect(new StateEventOutbox(path, scope).initialize()).rejects.toMatchObject({
      code: "STATE_OUTBOX_MANIFEST_CORRUPT"
    });

    await writeFile(`${path}.manifest.json`, JSON.stringify({ version: 1, scope }), { mode: 0o600 });
    await chmod(join(path, ".."), 0o755);
    await expect(new StateEventOutbox(path, scope).initialize()).rejects.toMatchObject({
      code: "STATE_OUTBOX_PERMISSIONS"
    });
  });

  it("fails closed on unsafe or corrupt persisted state", async () => {
    const path = await outboxPath();
    await writeFile(path, "{}", { mode: 0o600 });
    await expect(new StateEventOutbox(path, scope).initialize()).rejects.toThrow("invalid state event outbox");

    await writeFile(path, JSON.stringify({ version: 1, scope, records: [], totalPayloadBytes: 0 }), { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(new StateEventOutbox(path, scope).initialize()).rejects.toThrow("unsafe state event outbox permissions");
  });

  it("reserves capacity atomically and rejects count or byte overflow before intake", async () => {
    const path = await outboxPath();
    const event = fixtureState(7);
    const payloadBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    const outbox = new StateEventOutbox(path, scope, { maxRecords: 1, maxPayloadBytes: payloadBytes });
    await outbox.initialize();

    const reservation = await outbox.reserve([{ fixtureId: event.fixtureId, payloadBytes }]);
    await outbox.enqueue(event, reservation);
    await expect(outbox.reserve([{ fixtureId: event.fixtureId, payloadBytes: 1 }])).rejects.toThrow("capacity");
    await expect(outbox.enqueue(fixtureState(8))).rejects.toThrow("capacity");
  });

  it("restores a sticky capacity gate on restart and starts only atomically reserved producers", async () => {
    const path = await outboxPath();
    const event = fixtureState(7);
    const payloadBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    const outbox = new StateEventOutbox(path, scope, { maxRecords: 1, maxPayloadBytes: payloadBytes });
    await outbox.initialize();
    const blocked: string[] = [];
    const recovered: string[] = [];
    const gate = new StateEventCapacityGate(outbox, {
      payloadBytesPerEvent: payloadBytes,
      onBlocked: async (reason) => { blocked.push(reason); },
      onRecovered: async () => { recovered.push("recovered"); }
    });
    await gate.initialize();

    const started: string[] = [];
    const results = await Promise.allSettled([
      gate.run([event.fixtureId], async (reservation) => {
        started.push("command");
        await outbox.enqueue(event, reservation);
      }),
      gate.run(["provisioning"], async () => {
        started.push("provisioning");
      }),
      gate.run(["rf-publication"], async () => {
        started.push("rf-publication");
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(started).toEqual(["command"]);
    expect(blocked).toContain("state_outbox_capacity");

    const restartedGate = new StateEventCapacityGate(
      new StateEventOutbox(path, scope, { maxRecords: 1, maxPayloadBytes: payloadBytes }),
      { payloadBytesPerEvent: payloadBytes, onBlocked: async (reason) => { blocked.push(reason); } }
    );
    await restartedGate.initialize();
    expect(restartedGate.isBlocked()).toBe(true);
    expect(blocked.at(-1)).toBe("state_outbox_capacity");

    await outbox.acknowledge({
      eventId: event.eventId,
      sequence: event.sequence,
      fixtureId: event.fixtureId,
      status: "ingested",
      ingestedAt: "2026-08-26T00:00:02.000Z"
    });
    await expect(gate.tryRecover()).resolves.toBe(true);
    expect(recovered).toEqual(["recovered"]);
  });

  it("keeps PUBACKed records and reconnects with bounded application-ACK retries", async () => {
    vi.useFakeTimers();
    const outbox = new StateEventOutbox(await outboxPath(), scope);
    await outbox.initialize();
    const event = fixtureState(7);
    await outbox.enqueue(event);
    const publish = vi.fn().mockResolvedValue(undefined);
    const publisher = new StateEventOutboxPublisher(outbox, { retryInitialDelayMs: 100, retryMaxDelayMs: 400 });

    await publisher.connect(publish);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(await outbox.pending()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));

    await publisher.acknowledge({
      eventId: event.eventId,
      sequence: event.sequence,
      fixtureId: event.fixtureId,
      status: "duplicate",
      ingestedAt: "2026-08-26T00:00:02.000Z"
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).toHaveBeenCalledTimes(2);
    publisher.disconnect();
  });
});

function fixtureState(sequence: number): FixtureStateV2 {
  return {
    ...scope,
    eventId: sequence === 7
      ? "77777777-7777-4777-8777-777777777777"
      : "88888888-8888-4888-8888-888888888888",
    sequence,
    occurredAt: "2026-08-26T00:00:01.000Z",
    fixtureId: "66666666-6666-4666-8666-666666666666",
    brightness: 70,
    powerOn: true,
    status: "online",
    statusReason: "reported",
    rssi: -60,
    hopCount: 1
  };
}

async function outboxPath() {
  const directory = await mkdtemp(join(tmpdir(), "state-event-outbox-"));
  directories.push(directory);
  return join(directory, "state-event-outbox.json");
}
