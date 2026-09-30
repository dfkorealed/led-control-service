import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BioSensorModeCommand } from "@led-control/shared";
import { CommandJournal } from "./command-journal";
import { StateEventOutbox, StateEventOutboxPublisher } from "../state/state-event-outbox";
import { handleBioSensorMode, recoverBioSensorModes } from "./bio-sensor-mode-handler";

const command: BioSensorModeCommand = { version: 2, commandId: "10000000-0000-4000-8000-000000000001", siteId: "10000000-0000-4000-8000-000000000002",
  gatewayId: "10000000-0000-4000-8000-000000000003", fixtureId: "10000000-0000-4000-8000-000000000004", nodeId: "10000000-0000-4000-8000-000000000005",
  meshAddress: "0x0001", assignmentVersion: 1, deviceIdentityHash: "a".repeat(64), operation: "ensure_sensor", requestedAt: "2026-09-30T00:00:00.000Z", expiresAt: "2026-09-30T00:00:30.000Z" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "bio-mode-"));
  const path = join(dir, "journal.json");
  const outbox = new StateEventOutbox(join(dir, "outbox.json"), command);
  await outbox.initialize();
  return { path, outboxPath: join(dir, "outbox.json"), journal: new CommandJournal(path), outbox, scope: command, now: () => new Date("2026-09-30T00:00:01.000Z"), nextSequence: async () => 1 };
}
describe("durable BIO sensor mode commands", () => {
  it("retains a result until full outbox capacity returns without repeating SET", async () => {
    const f = await fixture();
    f.outbox = new StateEventOutbox(f.outboxPath, command, { maxRecords: 1 });
    const adapter = { sensorModeOperation: vi.fn().mockResolvedValue("sensor") };
    await handleBioSensorMode(adapter, command, f);
    const second = { ...command, commandId: "10000000-0000-4000-8000-000000000099", operation: "query" as const };
    await expect(handleBioSensorMode(adapter, second, f)).rejects.toThrow();
    expect((await f.journal.pendingSensorModeOperations())).toHaveLength(1);
    const event = (await f.outbox.pending())[0].payload;
    await f.outbox.acknowledge({ eventId: event.eventId, sequence: event.sequence, fixtureId: event.fixtureId,
      status: "ingested", ingestedAt: "2026-09-30T00:00:03.000Z" });
    await recoverBioSensorModes(f);
    expect((await f.outbox.pending())[0].payload).toMatchObject({ commandId: second.commandId, modeVerified: true });
    expect(adapter.sensorModeOperation).toHaveBeenCalledTimes(2);
    expect(await f.journal.pendingSensorModeOperations()).toEqual([]);
  });
  it("replays a persisted result after disconnect and removes it only after application ACK", async () => {
    const f = await fixture();
    await handleBioSensorMode({ sensorModeOperation: async () => "sensor" }, command, f);
    const restarted = new StateEventOutbox(f.outboxPath, command);
    const publisher = new StateEventOutboxPublisher(restarted);
    try {
      const sent: unknown[] = [];
      await publisher.connect(async (_topic, result) => { sent.push(result); });
      expect(sent).toHaveLength(1);
      const [record] = await restarted.pending();
      expect(record.payload).toMatchObject({ commandId: command.commandId, modeVerified: true });
      expect(await publisher.acknowledge({ eventId: record.payload.eventId, sequence: record.payload.sequence,
        fixtureId: record.payload.fixtureId, status: "ingested", ingestedAt: "2026-09-30T00:00:02.000Z" })).toBe(true);
      expect(await restarted.pending()).toEqual([]);
    } finally { publisher.disconnect(); }
  });
  it("acknowledges both live duplicate receipts before the slow GET completes", async () => {
    const f = await fixture();
    let entered!: () => void; let release!: (value: "sensor") => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const read = new Promise<"sensor">((resolve) => { release = resolve; });
    const adapter = { sensorModeOperation: async () => { entered(); return read; } };
    const receipts = vi.fn();
    const first = handleBioSensorMode(adapter, command, { ...f, onDurableReceipt: receipts });
    const second = handleBioSensorMode(adapter, command, { ...f, onDurableReceipt: receipts });
    await started;
    try { expect(receipts).toHaveBeenCalledTimes(2); }
    finally { release("sensor"); await Promise.all([first, second]); }
  });
  it("rejects another assignment and an untrusted clock before any physical operation", async () => {
    const f = await fixture(); const adapter = { sensorModeOperation: vi.fn() };
    await expect(handleBioSensorMode(adapter, { ...command, assignmentVersion: 2 }, f)).rejects.toThrow("scope");
    await handleBioSensorMode(adapter, command, { ...f, clockTrusted: async () => false });
    expect(adapter.sensorModeOperation).not.toHaveBeenCalled();
    expect((await f.outbox.pending())[0].payload).toMatchObject({ modeVerified: false, errorCode: "GATEWAY_CLOCK_UNTRUSTED" });
  });
  it("journals GET success, replays without RF, and never updates brightness snapshots", async () => {
    const f = await fixture();
    const adapter = { sensorModeOperation: vi.fn().mockResolvedValue("sensor") };
    await handleBioSensorMode(adapter, command, f);
    await handleBioSensorMode(adapter, command, f);
    expect(adapter.sensorModeOperation).toHaveBeenCalledTimes(1);
    expect((await f.outbox.pending()).map((row) => row.payload)).toEqual([expect.objectContaining({ modeVerified: true, evidence: "mode_get" })]);
    expect(await f.journal.latestFixtureSnapshots()).toEqual([]);
  });
  it("rejects same ID with another operation before IO", async () => {
    const f = await fixture();
    await handleBioSensorMode({ sensorModeOperation: async () => "sensor" }, command, f);
    await expect(handleBioSensorMode({}, { ...command, operation: "query" }, f)).rejects.toThrow("identity conflict");
  });
  it("recovers interrupted work as unknown and only a new query can verify", async () => {
    const f = await fixture();
    await f.journal.accept(command.commandId, { kind: "bio_sensor_mode", command });
    f.journal = new CommandJournal(f.path);
    await recoverBioSensorModes(f);
    expect((await f.outbox.pending())[0].payload).toMatchObject({ modeVerified: false, errorCode: "GATEWAY_RESTART" });
    const query = { ...command, commandId: "10000000-0000-4000-8000-000000000009", operation: "query" as const, requeryOfCommandId: command.commandId };
    const adapter = { sensorModeOperation: vi.fn().mockResolvedValue("sensor") };
    await handleBioSensorMode(adapter, query, f);
    expect(adapter.sensorModeOperation).toHaveBeenCalledWith(query, expect.anything());
    expect((await f.outbox.pending())[1].payload).toMatchObject({ commandId: query.commandId, modeVerified: true });
  });
  it.each(["force-on", "force-off"] as const)("GET %s is a mismatch, not verified", async (mode) => {
    const f = await fixture();
    await handleBioSensorMode({ sensorModeOperation: async () => mode }, command, f);
    expect((await f.outbox.pending())[0].payload).toMatchObject({ status: "mismatch", modeVerified: false, observedMode: mode });
  });
  it("bounds a stuck read and ignores its late success", async () => {
    const f = await fixture();
    await handleBioSensorMode({ sensorModeOperation: () => new Promise(() => {}) }, command, { ...f, timeoutMs: 5 });
    expect((await f.outbox.pending())[0].payload).toMatchObject({ status: "timed_out", modeVerified: false });
  });
  it("never invokes an adapter for expired commands", async () => {
    const f = await fixture();
    const adapter = { sensorModeOperation: vi.fn() };
    await handleBioSensorMode(adapter, command, { ...f, now: () => new Date("2026-09-30T01:00:00Z") });
    expect(adapter.sensorModeOperation).not.toHaveBeenCalled();
    expect((await f.outbox.pending())[0].payload).toMatchObject({ modeVerified: false, errorCode: "COMMAND_EXPIRED" });
  });
});
