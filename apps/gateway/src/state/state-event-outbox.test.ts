import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mqttTopicsV2, type FixturePresenceV2, type FixtureStateV2 } from "@led-control/shared";
import {
  StateEventCapacityGate,
  StateEventOutbox,
  StateEventOutboxPublisher,
  StateEventReservationSlot,
  type GatewayStateEvent
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
  it("restores unreachable events and accepts only exact fixture-scoped application ACK", async () => {
    const path = await outboxPath();
    const event = { ...scope, eventId: "11111111-1111-4111-8111-111111111111", sequence: 3,
      occurredAt: "2026-09-15T00:00:00.000Z", fixtureId: "66666666-6666-4666-8666-666666666666",
      refreshId: "33333333-3333-4333-8333-333333333333", batchId: "44444444-4444-4444-8444-444444444444", reason: "read_timeout" as const };
    await new StateEventOutbox(path, scope).enqueue(event);
    const restored = new StateEventOutbox(path, scope);
    expect(await restored.pending()).toEqual([expect.objectContaining({ topic: mqttTopicsV2.fixtureUnreachable(scope.siteId, scope.gatewayId), payload: event })]);
    const ack = { eventId: event.eventId, sequence: 3, fixtureId: event.fixtureId, status: "ingested", ingestedAt: event.occurredAt };
    expect(await restored.acknowledge({ ...ack, fixtureId: event.refreshId })).toBe(false);
    expect(await restored.acknowledge(ack)).toBe(true);
    expect(await new StateEventOutbox(path, scope).pending()).toEqual([]);
  });
  it("restores state and presence records in FIFO order and ACKs only the matching event", async () => {
    const path = await outboxPath();
    const outbox = new StateEventOutbox(path, scope);
    const state = fixtureState(7);
    const presence = fixturePresence(8);
    await outbox.initialize();
    await outbox.enqueue(state);
    await outbox.enqueue(presence);

    const restored = new StateEventOutbox(path, scope);
    await restored.initialize();
    expect(await restored.pending()).toEqual([
      expect.objectContaining({ topic: mqttTopicsV2.fixtureState(scope.siteId, scope.gatewayId), payload: state }),
      expect.objectContaining({ topic: mqttTopicsV2.fixturePresence(scope.siteId, scope.gatewayId), payload: presence })
    ]);

    await expect(restored.acknowledge({
      eventId: state.eventId,
      sequence: state.sequence,
      fixtureId: state.fixtureId,
      status: "ingested",
      ingestedAt: "2026-09-14T00:00:02.000Z"
    })).resolves.toBe(true);
    expect(await restored.pending()).toEqual([
      expect.objectContaining({ topic: mqttTopicsV2.fixturePresence(scope.siteId, scope.gatewayId), payload: presence })
    ]);
  });

  it("fails closed when a presence payload is persisted under the fixture-state topic", async () => {
    const path = await outboxPath();
    const outbox = new StateEventOutbox(path, scope);
    const presence = fixturePresence(8);
    await outbox.initialize();
    const payloadBytes = Buffer.byteLength(JSON.stringify(presence), "utf8");
    await writeFile(path, JSON.stringify({
      version: 1,
      scope,
      records: [{
        topic: mqttTopicsV2.fixtureState(scope.siteId, scope.gatewayId),
        payload: presence,
        payloadBytes,
        enqueuedAt: "2026-09-14T00:00:01.000Z"
      }],
      totalPayloadBytes: payloadBytes
    }), { mode: 0o600 });

    await expect(new StateEventOutbox(path, scope).initialize()).rejects.toThrow("invalid state event outbox");
  });

  it("advances the actual publisher after a legacy committed head receives a reconciled duplicate ACK", async () => {
    const path = await outboxPath();
    const original = new StateEventOutbox(path, scope);
    await original.initialize();
    const committed = fixtureState(7);
    const next = fixtureState(8);
    await original.enqueue(committed);
    await original.enqueue(next);
    // API committed before the upgrade, but its application ACK was lost. Both records survive restart.
    const restored = new StateEventOutbox(path, scope);
    await restored.initialize();
    const publisher = new StateEventOutboxPublisher(restored);
    const published: GatewayStateEvent[] = [];
    const duplicate = { eventId: committed.eventId, sequence: committed.sequence, fixtureId: committed.fixtureId,
      status: "duplicate", ingestedAt: "2026-09-12T00:00:02.000Z" };
    try {
      await publisher.connect(async (_topic, event) => { published.push(event); });
      expect(published).toEqual([committed]);
      expect((await restored.pending()).map((record) => record.payload)).toEqual([committed, next]);
      await expect(publisher.acknowledge({ ...duplicate, sequence: next.sequence })).resolves.toBe(false);
      expect(published).toEqual([committed]);
      await expect(publisher.acknowledge(duplicate)).resolves.toBe(true);
      expect(published).toEqual([committed, next]);
      expect((await new StateEventOutbox(path, scope).pending()).map((record) => record.payload)).toEqual([next]);
      await expect(publisher.acknowledge({ ...duplicate, eventId: next.eventId, sequence: next.sequence,
        status: "ingested" })).resolves.toBe(true);
      expect(await new StateEventOutbox(path, scope).pending()).toEqual([]);
      expect(published).toEqual([committed, next]);
    } finally {
      publisher.disconnect();
    }
  });

  it("removes only the exact future-rejected head and publishes the next persisted event", async () => {
    const path = await outboxPath();
    const outbox = new StateEventOutbox(path, scope);
    await outbox.initialize();
    const poison = { ...fixtureState(7), occurredAt: "9999-01-01T00:00:00.000Z" };
    const next = fixtureState(8);
    await outbox.enqueue(poison);
    await outbox.enqueue(next);
    const published: GatewayStateEvent[] = [];
    const publisher = new StateEventOutboxPublisher(outbox);
    const acknowledgement = {
      eventId: poison.eventId,
      sequence: poison.sequence,
      fixtureId: poison.fixtureId,
      status: "rejected_future_timestamp",
      ingestedAt: "2026-08-26T00:00:02.000Z"
    };
    try {
      await publisher.connect(async (topic, payload) => {
        expect(topic).toBe(mqttTopicsV2.fixtureState(scope.siteId, scope.gatewayId));
        published.push(payload);
      });
      expect(published).toEqual([poison]);
      await expect(publisher.acknowledge({ ...acknowledgement, sequence: next.sequence })).resolves.toBe(false);
      expect((await outbox.pending()).map((record) => record.payload)).toEqual([poison, next]);
      await expect(publisher.acknowledge(acknowledgement)).resolves.toBe(true);
      expect(published).toEqual([poison, next]);
      expect((await new StateEventOutbox(path, scope).pending()).map((record) => record.payload)).toEqual([next]);
      await expect(publisher.acknowledge(acknowledgement)).resolves.toBe(false);
      expect(published).toEqual([poison, next]);
    } finally {
      publisher.disconnect();
    }
  });

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

  it("keeps one publication reservation across repeated block and ACK recovery races", async () => {
    const event = fixtureState(7);
    const payloadBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    const outbox = new StateEventOutbox(await outboxPath(), scope, {
      maxRecords: 2,
      maxPayloadBytes: payloadBytes * 2
    });
    await outbox.initialize();
    const gate = new StateEventCapacityGate(outbox, { payloadBytesPerEvent: payloadBytes });
    await gate.initialize();
    const publicationSlot = new StateEventReservationSlot(outbox);
    const standing = await gate.reserve(["*"]);
    await expect(publicationSlot.attach(standing)).resolves.toBe(true);
    expect(publicationSlot.take({ id: "stale-reservation" })).toBeUndefined();
    expect(publicationSlot.isCurrent(standing)).toBe(true);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const eventReservation = await gate.reserve([event.fixtureId]);
      await outbox.enqueue(event, eventReservation);
      await expect(gate.reserve(["provisioning"])).rejects.toThrow("capacity");
      await outbox.acknowledge({
        eventId: event.eventId,
        sequence: event.sequence,
        fixtureId: event.fixtureId,
        status: "ingested",
        ingestedAt: "2026-08-26T00:00:02.000Z"
      });

      const recovery = await gate.recoverAndReserve(["*"]);
      expect(recovery).not.toBeNull();
      await expect(publicationSlot.attach(recovery!)).resolves.toBe(false);
      expect(publicationSlot.isCurrent(standing)).toBe(true);

      const probe = await gate.reserve(["probe"]);
      await expect(outbox.release(probe)).resolves.toBe(true);
      await expect(outbox.release(probe)).resolves.toBe(false);
    }

    await expect(publicationSlot.release()).resolves.toBe(true);
    await expect(publicationSlot.release()).resolves.toBe(false);
    const fullCapacity = await outbox.reserve([
      { fixtureId: "probe-1", payloadBytes },
      { fixtureId: "probe-2", payloadBytes }
    ]);
    await outbox.release(fullCapacity);
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

function fixturePresence(sequence: number): FixturePresenceV2 {
  return {
    ...scope,
    eventId: "99999999-9999-4999-8999-999999999999",
    sequence,
    occurredAt: "2026-09-14T00:00:01.000Z",
    fixtureId: "66666666-6666-4666-8666-666666666666",
    controlMode: "sensor",
    rawHighBrightness: 127,
    configuredBrightness: null,
    rssi: -41,
    hopCount: null
  };
}

async function outboxPath() {
  const directory = await mkdtemp(join(tmpdir(), "state-event-outbox-"));
  directories.push(directory);
  return join(directory, "state-event-outbox.json");
}
