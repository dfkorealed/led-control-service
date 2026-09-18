import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { handleFixturePresenceCheck, MonitoringRefreshEventPublisher } from "./fixture-presence-check-handler";
import { MonitoringRefreshJournal } from "../state/monitoring-refresh-journal";
import { StateEventOutbox, StateEventOutboxPublisher, type GatewayStateEvent } from "../state/state-event-outbox";
import { BioUsbDongleAdapter } from "../adapters/bio-usb-dongle-adapter";
import { BioUsbError } from "../bio/bio-usb-error";
import { EventEmitter } from "node:events";
import { BioDongleClient } from "../bio/bio-dongle-client";
import { encodeCrcFrame } from "../bio/bio-frame-codec";

const scope = { siteId: "11111111-1111-4111-8111-111111111111", gatewayId: "22222222-2222-4222-8222-222222222222" };
const firstId = "66666666-6666-4666-8666-666666666666";
const secondId = "77777777-7777-4777-8777-777777777777";
const command = { ...scope, refreshId: "33333333-3333-4333-8333-333333333333", batchId: "44444444-4444-4444-8444-444444444444",
  idempotencyKey: "55555555-5555-4555-8555-555555555555", sequence: 1, targetFixtureIds: [firstId, secondId],
  requestedAt: "2026-09-15T00:00:00.000Z", expiresAt: "2026-09-15T00:01:00.000Z" };
const now = () => new Date("2026-09-15T00:00:01.000Z");
const presence = { fixtureId: firstId, controlMode: "sensor" as const, rawHighBrightness: 5, configuredBrightness: 50,
  rssi: -55, hopCount: null, observedAt: now().toISOString() };
const directories: string[] = [];
const publishers: MonitoringRefreshEventPublisher[] = [];
afterEach(async () => { publishers.splice(0).forEach((publisher) => publisher.disconnect()); vi.useRealTimers();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "refresh-handler-")); directories.push(directory);
  const journal = new MonitoringRefreshJournal(join(directory, "journal.json"), scope, { now });
  const outbox = new StateEventOutbox(join(directory, "outbox.json"), scope);
  const completed: unknown[] = [];
  const publisher = new MonitoringRefreshEventPublisher(journal, outbox, { retryMs: 10 }); publishers.push(publisher);
  await publisher.connect(async (_topic, event) => { expect((await outbox.pending()).length).toBeGreaterThan(0); completed.push(event); });
  let sequence = 10;
  return { directory, journal, outbox, publisher, completed,
    options: { now, retryDelayMs: 1, nextSequence: async () => sequence++ } };
}

it("retries only first-pass failures and persists sensor presence/unreachable before completion", async () => {
  const f = await fixture();
  const adapter = { probeFixturePresence: vi.fn().mockResolvedValueOnce([{ fixtureId: firstId, outcome: "online", presence },
    { fixtureId: secondId, outcome: "not_found" }]).mockResolvedValueOnce([{ fixtureId: secondId, outcome: "not_found" }]) };
  await handleFixturePresenceCheck(adapter, f.journal, command, f.publisher, f.options);
  expect(adapter.probeFixturePresence.mock.calls.map(([ids]) => ids)).toEqual([[firstId, secondId], [secondId]]);
  const events = (await f.outbox.pending()).map((row) => row.payload);
  expect(events).toEqual([
    expect.objectContaining({ fixtureId: firstId, controlMode: "sensor", refreshId: command.refreshId, batchId: command.batchId }),
    expect.objectContaining({ fixtureId: secondId, reason: "not_found", refreshId: command.refreshId, batchId: command.batchId })
  ]);
  expect(events.every((event) => !("brightness" in event) && !("powerOn" in event))).toBe(true);
  expect(f.completed).toHaveLength(1);
});

it("persists real BlueZ lighting observations as correlated state without BIO metadata", async () => {
  const f = await fixture();
  const adapter = { probeFixturePresence: vi.fn(async (ids: string[]) => ids.map((fixtureId) => ({ fixtureId, outcome: "online" as const,
    lightingObservation: { fixtureId, brightness: 75, powerOn: false, observedAt: now().toISOString() } }))) };
  await handleFixturePresenceCheck(adapter, f.journal, command, f.publisher, f.options);
  const records = await new StateEventOutbox(join(f.directory, "outbox.json"), scope).pending();
  expect(records.map((row) => row.payload)).toEqual(command.targetFixtureIds.map((fixtureId) => expect.objectContaining({
    fixtureId, brightness: 75, powerOn: false, status: "online", refreshId: command.refreshId, batchId: command.batchId
  })));
  expect(records.every((row) => !("controlMode" in row.payload))).toBe(true);
  expect(adapter.probeFixturePresence).toHaveBeenCalledTimes(1);
});

it("waits the default 250ms and treats a second-pass verified response as online", async () => {
  const f = await fixture();
  const times: number[] = [];
  const adapter = { probeFixturePresence: vi.fn(async (ids: string[]) => {
    times.push(performance.now());
    return ids.map((fixtureId) => times.length === 1 ? { fixtureId, outcome: "read_timeout" as const }
      : { fixtureId, outcome: "online" as const, presence: { ...presence, fixtureId } });
  }) };
  await handleFixturePresenceCheck(adapter, f.journal, command, f.publisher, { ...f.options, retryDelayMs: undefined });
  expect(times).toHaveLength(2);
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(249);
  expect((await f.outbox.pending()).every((row) => "controlMode" in row.payload)).toBe(true);
});

it("does not repeat hardware work for a live duplicate or altered terminal replay", async () => {
  const f = await fixture();
  let release!: (value: Array<{ fixtureId: string; outcome: "online"; presence: typeof presence }>) => void;
  const adapter = { probeFixturePresence: vi.fn(() => new Promise<Array<{ fixtureId: string; outcome: "online"; presence: typeof presence }>>((resolve) => { release = resolve; })) };
  const handling = handleFixturePresenceCheck(adapter, f.journal, command, f.publisher, f.options);
  await vi.waitFor(() => expect(adapter.probeFixturePresence).toHaveBeenCalledOnce());
  await handleFixturePresenceCheck(adapter, f.journal, command, f.publisher, f.options);
  release(command.targetFixtureIds.map((fixtureId) => ({ fixtureId, outcome: "online", presence: { ...presence, fixtureId } })));
  await handling;
  await expect(handleFixturePresenceCheck(adapter, f.journal, { ...command, targetFixtureIds: [firstId] }, f.publisher, f.options)).rejects.toThrow("identity conflict");
  expect(adapter.probeFixturePresence).toHaveBeenCalledOnce();
});

it("does not emit unreachable if the command expires while terminal sequences are being persisted", async () => {
  const f = await fixture();
  let expired = false;
  const adapter = { probeFixturePresence: vi.fn(async (ids: string[]) => ids.map((fixtureId) => ({ fixtureId, outcome: "read_failed" as const }))) };
  await handleFixturePresenceCheck(adapter, f.journal, command, f.publisher, { ...f.options,
    now: () => expired ? new Date(command.expiresAt) : now(), nextSequence: async () => { expired = true; return 12; } });
  expect(await f.outbox.pending()).toEqual([]);
  expect(f.completed).toEqual([]);
});

it("cannot emit completion while durable fixture outbox has no capacity and resumes on restart", async () => {
  const f = await fixture();
  f.publisher.disconnect();
  const bounded = new StateEventOutbox(join(f.directory, "bounded.json"), scope, { maxRecords: 1 });
  const publisher = new MonitoringRefreshEventPublisher(f.journal, bounded, { retryMs: 10 }); publishers.push(publisher);
  const completed: unknown[] = [];
  await publisher.connect(async (_topic, event) => { completed.push(event); });
  const adapter = { probeFixturePresence: vi.fn(async (ids: string[]) => ids.map((fixtureId) => ({ fixtureId, outcome: "read_timeout" as const }))) };
  await handleFixturePresenceCheck(adapter, f.journal, command, publisher, f.options);
  expect(completed).toEqual([]);
  expect((await f.journal.pending())[0].handedOff).toBe(false);
  publisher.disconnect();
  const recovered = new MonitoringRefreshEventPublisher(new MonitoringRefreshJournal(join(f.directory, "journal.json"), scope, { now }),
    new StateEventOutbox(join(f.directory, "bounded.json"), scope), { retryMs: 10 }); publishers.push(recovered);
  await recovered.connect(async (_topic, event) => { completed.push(event); });
  expect(completed).toHaveLength(1);
  expect(await new StateEventOutbox(join(f.directory, "bounded.json"), scope).pending()).toHaveLength(2);
});

it.each(["malformed", "aggregate-close", "unsupported"])("BIO %s stays a batch failure through the real handler and outbox", async (failure) => {
  const f = await fixture();
  const client = { scan: vi.fn(async () => [{ deviceUuid: "bio:a1b2c3d4e5f6", nativeUuid: "a1b2c3d4e5f6", logicalAddress: 257,
    networkId: 0, firmwareVersion: "1", rssi: -41 }]), startIdentify: vi.fn(), stopIdentify: vi.fn(), restoreSensorMode: vi.fn(),
    assignAddressOnce: vi.fn(), reconcileAddress: vi.fn(), setOutput: vi.fn(), readDeviceInfo: vi.fn(),
    readBrightness: failure === "unsupported" ? undefined : vi.fn(async () => {
      throw failure === "aggregate-close" ? new AggregateError([new BioUsbError("TIMEOUT", "ack"), new BioUsbError("CLOSE_FAILED", "close")])
        : new BioUsbError("MALFORMED_FRAME", "private frame");
    }) };
  const mappings = { listConfirmed: vi.fn(async () => [{ fixtureId: firstId, deviceUuid: "bio:a1b2c3d4e5f6", nativeUuid: "a1b2c3d4e5f6", logicalAddress: 257 }] as any),
    findByDeviceUuidIncludingReserved: vi.fn(), reserve: vi.fn(), confirm: vi.fn(), findByFixtureId: vi.fn(), findByLogicalAddress: vi.fn() };
  await handleFixturePresenceCheck(new BioUsbDongleAdapter(client, mappings), f.journal, command, f.publisher, f.options);
  expect(await f.outbox.pending()).toEqual([]);
  expect(f.completed).toEqual([]);
  expect((await f.journal.accept(command)).terminal).toEqual({ events: [], failure: "transport_unavailable" });
  expect(client.scan).toHaveBeenCalledTimes(failure === "unsupported" ? 0 : 1);
});

it("keeps an ACK-then-USB-disconnect unverified through real client, transport, adapter and durable handler", async () => {
  const f = await fixture();
  const writes: Buffer[] = [];
  let connections = 0; let disconnects = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const client = new BioDongleClient({ scanDurationMs: 1, observationTimeoutMs: 50, connectionFactory: () => {
    connections++;
    const events = new EventEmitter();
    return {
      async open() {}, async close() {},
      onData(listener: (bytes: Buffer) => void) { events.on("data", listener); return () => { events.off("data", listener); }; },
      onDisconnect(listener: (error: Error) => void) { events.on("disconnect", listener); return () => { events.off("disconnect", listener); }; },
      async write(bytes: Uint8Array) {
        const frame = Buffer.from(bytes); writes.push(frame);
        queueMicrotask(() => {
          if (frame[0] !== 0x55) return;
          if (frame[2] === 0x82) events.emit("data", Buffer.from("55aa030c02050320682f0000000300001147", "hex"));
          else if (frame[2] === 0x0a) events.emit("data", Buffer.from("55aa0b0d0001000000000000010c000320c50e", "hex"));
          else if (frame[2] === 0x10) {
            events.emit("data", Buffer.from("55aa1101002055", "hex"));
            const body = frame.subarray(19, -2).toString("hex");
            if (body === "8305") {
              const payload = Buffer.alloc(28); payload.writeInt8(-41, 0);
              Buffer.from("a1b2c3d4e5f6", "hex").copy(payload, 1); payload[7] = 0x83; payload[8] = 46;
              payload.writeUInt16BE(257, 9); payload.writeUInt16BE(0xc000, 11);
              Buffer.from("0a010505085932020100030000", "hex").copy(payload, 15);
              events.emit("data", encodeCrcFrame(0x12, payload));
            }
            if (body === "4e13") {
              const timer = setTimeout(() => { timers.delete(timer); disconnects++; events.emit("disconnect", new Error("USB detached")); }, 5);
              timers.add(timer);
            }
          }
        });
      }
    };
  } });
  const mappings = { listConfirmed: vi.fn(async () => [{ fixtureId: firstId, deviceUuid: "bio:a1b2c3d4e5f6", nativeUuid: "a1b2c3d4e5f6", logicalAddress: 257 }] as any),
    findByDeviceUuidIncludingReserved: vi.fn(), reserve: vi.fn(), confirm: vi.fn(), findByFixtureId: vi.fn(), findByLogicalAddress: vi.fn() };
  const scopedCommand = { ...command, targetFixtureIds: [firstId] };
  try {
    await client.probe();
    await handleFixturePresenceCheck(new BioUsbDongleAdapter(client, mappings), f.journal, scopedCommand, f.publisher, f.options);
    expect(await f.outbox.pending()).toEqual([]);
    expect(f.completed).toEqual([]);
    expect((await f.journal.accept(scopedCommand)).terminal).toEqual({ events: [], failure: "transport_unavailable" });
    await vi.waitFor(() => expect(connections).toBe(2), { timeout: 2500 });
    expect(disconnects).toBe(1);
    expect(writes.filter((bytes) => bytes[0] === 0x55 && bytes[2] === 0x10).map((bytes) => bytes.subarray(19, -2).toString("hex")))
      .toEqual(["8305", "85", "4e13"]);
  } finally { for (const timer of timers) clearTimeout(timer); await client.close(); }
});

it.each([false, true])("publishes partial handoff and continues after ACK with capacity one (restart=%s)", async (restart) => {
  const f = await fixture(); f.publisher.disconnect();
  const path = join(f.directory, "bounded-progress.json");
  const bounded = new StateEventOutbox(path, scope, { maxRecords: 1 });
  const statePublisher = new StateEventOutboxPublisher(bounded, { retryInitialDelayMs: 10, retryMaxDelayMs: 10 });
  const observed: GatewayStateEvent[] = [];
  await statePublisher.connect(async (_topic, event) => { observed.push(event); });
  const completed: unknown[] = [];
  const publisher = new MonitoringRefreshEventPublisher(f.journal, bounded, { retryMs: 60_000, wakeStateOutbox: () => statePublisher.wake() });
  publishers.push(publisher);
  try {
    await publisher.connect(async (_topic, event) => { completed.push(event); });
    const adapter = { probeFixturePresence: vi.fn(async (ids: string[]) => ids.map((fixtureId) => ({ fixtureId, outcome: "not_found" as const }))) };
    await handleFixturePresenceCheck(adapter, f.journal, command, publisher, f.options);
    await vi.waitFor(() => expect(observed.some((event) => event.fixtureId === firstId)).toBe(true));
    expect(completed).toEqual([]);
    const first = observed[0];
    await statePublisher.acknowledge({ eventId: first.eventId, fixtureId: first.fixtureId, sequence: first.sequence,
      status: "ingested", ingestedAt: now().toISOString() });
    if (restart) { await publisher.stopAndDrain(); statePublisher.disconnect(); }
    const recoveredJournal = restart ? new MonitoringRefreshJournal(join(f.directory, "journal.json"), scope, { now }) : f.journal;
    const recoveredOutbox = restart ? new StateEventOutbox(path, scope, { maxRecords: 1 }) : bounded;
    const recovered = restart ? new MonitoringRefreshEventPublisher(recoveredJournal, recoveredOutbox, { retryMs: 60_000 }) : publisher;
    if (restart) {
      publishers.push(recovered);
      await recovered.connect(async (_topic, event) => { completed.push(event); });
    } else await recovered.wake();
    expect((await recoveredOutbox.pending()).map((row) => row.payload.fixtureId)).toEqual([secondId]);
    expect(completed).toHaveLength(1);
    expect(await recovered.acknowledge({ ...scope, refreshId: command.refreshId, batchId: command.batchId })).toBe(true);
    expect(await recoveredJournal.pending()).toEqual([]);
    expect(adapter.probeFixturePresence).toHaveBeenCalledTimes(2);
  } finally { statePublisher.disconnect(); await publisher.stopAndDrain(); }
});

it("shutdown stops waiting for a hung probe without producing unreachable", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const adapter = { probeFixturePresence: vi.fn(() => new Promise<never>(() => undefined)) };
  const handling = handleFixturePresenceCheck(adapter, f.journal, command, f.publisher, { ...f.options, signal: controller.signal });
  await vi.waitFor(() => expect(adapter.probeFixturePresence).toHaveBeenCalledOnce());
  controller.abort();
  const outcome = await Promise.race([handling.then(() => "drained"), new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100))]);
  expect(outcome).toBe("drained");
  expect(await f.outbox.pending()).toEqual([]);
});

it("reconnect during a stuck completion publish resumes replay on the replacement connection", async () => {
  const f = await fixture();
  f.publisher.disconnect();
  let started = false;
  await f.publisher.connect(async () => { started = true; await new Promise<void>(() => undefined); });
  const adapter = { probeFixturePresence: vi.fn(async (ids: string[]) => ids.map((fixtureId) => ({ fixtureId, outcome: "not_found" as const }))) };
  const handling = handleFixturePresenceCheck(adapter, f.journal, command, f.publisher, f.options);
  await vi.waitFor(() => expect(started).toBe(true));
  const replayed: unknown[] = [];
  await f.publisher.connect(async (_topic, event) => { replayed.push(event); });
  await handling;
  expect(replayed).toHaveLength(1);
});

it("replays durable terminal after restart without probing and retries completion until dedicated ACK", async () => {
  const f = await fixture();
  const adapter = { probeFixturePresence: vi.fn(async (ids: string[]) => ids.map((fixtureId) => ({ fixtureId, outcome: "not_found" as const }))) };
  await handleFixturePresenceCheck(adapter, f.journal, command, f.publisher, f.options);
  f.publisher.disconnect();
  const recovered = new MonitoringRefreshJournal(join(f.directory, "journal.json"), scope, { now });
  const published: unknown[] = [];
  const publisher = new MonitoringRefreshEventPublisher(recovered, new StateEventOutbox(join(f.directory, "outbox.json"), scope), { retryMs: 10 });
  publishers.push(publisher);
  await publisher.connect(async (_topic, event) => { published.push(event); });
  adapter.probeFixturePresence.mockClear();
  await handleFixturePresenceCheck(adapter, recovered, command, publisher, f.options);
  expect(adapter.probeFixturePresence).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(published.length).toBeGreaterThan(1));
  expect(await publisher.acknowledge({ ...scope, refreshId: command.refreshId, batchId: command.batchId })).toBe(true);
  expect(await recovered.pending()).toEqual([]);
});

it.each(["transport", "shutdown", "malformed"])("keeps %s batch failure unverified without unreachable/completion", async (failure) => {
  const f = await fixture();
  const controller = new AbortController();
  const adapter = { probeFixturePresence: vi.fn(async () => {
    if (failure === "shutdown") controller.abort();
    if (failure === "transport") throw new Error("private transport detail");
    return failure === "malformed" ? [] : [{ fixtureId: firstId, outcome: "not_found" as const }, { fixtureId: secondId, outcome: "not_found" as const }];
  }) };
  await handleFixturePresenceCheck(adapter, f.journal, command, f.publisher, { ...f.options, signal: controller.signal });
  expect(await f.outbox.pending()).toEqual([]);
  expect(f.completed).toEqual([]);
  expect(adapter.probeFixturePresence).toHaveBeenCalledTimes(1);
  expect((await f.journal.accept(command)).terminal).toMatchObject({ failure: expect.any(String), events: [] });
});

it("rejects expired/scope/duplicate/65-target commands before adapter access and accepts 64", async () => {
  const f = await fixture();
  const adapter = { probeFixturePresence: vi.fn(async (ids: string[]) => ids.map((fixtureId) => ({ fixtureId, outcome: "not_found" as const }))) };
  const ids = Array.from({ length: 65 }, (_, n) => `${n.toString().padStart(8, "0")}-0000-4000-8000-000000000000`);
  for (const invalid of [{ ...command, expiresAt: now().toISOString() }, { ...command, siteId: scope.gatewayId },
    { ...command, targetFixtureIds: [firstId, firstId] }, { ...command, targetFixtureIds: ids }]) {
    await expect(handleFixturePresenceCheck(adapter, f.journal, invalid, f.publisher, f.options)).rejects.toThrow();
  }
  expect(adapter.probeFixturePresence).not.toHaveBeenCalled();
  await handleFixturePresenceCheck(adapter, f.journal, { ...command, targetFixtureIds: ids.slice(0, 64) }, f.publisher, f.options);
  expect(await f.outbox.pending()).toHaveLength(64);
});
