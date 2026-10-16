import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BioDeviceMappingStore } from "../bio/bio-device-mapping-store";
import { FixtureRegistrationRemovalJournal } from "../state/fixture-registration-removal-journal";
import { FixtureRegistrationRemovalHandler } from "./fixture-registration-removal-handler";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import { mappingInput, removalAck, removalCommand, removalNow, removalScope } from "../../test/registration-removal-fixtures";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "removal-handler-")); roots.push(root);
  const mappingPath = join(root, "mappings.json"), journalPath = join(root, "removals.json");
  const port = new BioDeviceMappingStore(mappingPath, () => removalNow);
  await port.reserve(mappingInput); await port.confirm(mappingInput.deviceUuid, mappingInput.logicalAddress);
  const journal = new FixtureRegistrationRemovalJournal(journalPath); await journal.initialize();
  let reason: string | null = null, cleanups = 0;
  const options = { journal, port, scope: removalScope, clockTrusted: async () => true,
    blockedReason: async () => reason, afterRetire: async () => { cleanups++; }, now: () => removalNow };
  return { root, journalPath, mappingPath, port, journal, options, setReason: (value: string) => { reason = value; },
    cleanups: () => cleanups, handler: new FixtureRegistrationRemovalHandler(options) };
}
describe("durable registration removal handler", () => {
  it("removes an offline lamp without any RF dependency and replays the exact terminal after restart", async () => {
    const f = await fixture(); const command = removalCommand();
    const terminal = await f.handler.handle(command);
    expect(terminal).toMatchObject({ status: "removed", errorCode: null });
    expect(f.cleanups()).toBe(1);
    expect(await f.port.findByFixtureId(command.fixtureId)).toBeNull();
    const restarted = new FixtureRegistrationRemovalHandler({ ...f.options, journal: new FixtureRegistrationRemovalJournal(f.journalPath),
      port: new BioDeviceMappingStore(f.mappingPath) });
    expect(await restarted.handle(command)).toEqual(terminal);
    expect(f.cleanups()).toBe(1);
  });
  it.each(["siteId", "gatewayId", "gatewaySerial", "assignmentVersion"] as const)("rejects wrong assignment %s before intake", async key => {
    const f = await fixture();
    const changed = key === "assignmentVersion" ? 8 : key === "gatewaySerial" ? "other-gateway" : "77777777-7777-4777-8777-777777777777";
    expect(() => f.handler.handle(removalCommand({ [key]: changed }))).toThrow("REMOVAL_SCOPE_MISMATCH");
    expect(await f.journal.records()).toEqual([]);
  });
  it("rejects an invalid binding hash without touching the mapping", async () => {
    const f = await fixture();
    expect(await f.handler.handle({ ...removalCommand(), bindingHash: `sha256:${"0".repeat(64)}` })).toMatchObject({ status: "rejected", errorCode: "REMOVAL_BINDING_HASH_MISMATCH" });
    expect(await f.port.findByFixtureId(mappingInput.fixtureId)).not.toBeNull();
  });
  it.each(["CONTROL_IN_PROGRESS", "CONTROL_UNCERTAIN", "RESTORATION_REQUIRED", "SCHEDULE_REFERENCED", "GROUP_REFERENCED", "SENSOR_OPERATION_IN_PROGRESS"])("preserves registration on runtime refusal %s", async reason => {
    const f = await fixture(); f.setReason(reason);
    expect(await f.handler.handle(removalCommand())).toMatchObject({ status: "rejected", errorCode: reason });
    expect(await f.port.findByFixtureId(mappingInput.fixtureId)).not.toBeNull(); expect(f.cleanups()).toBe(0);
  });
  it("fails closed for old adapters", async () => {
    const f = await fixture(); const handler = new FixtureRegistrationRemovalHandler({ ...f.options, port: undefined });
    expect(await handler.handle(removalCommand())).toMatchObject({ status: "rejected", errorCode: "UNSUPPORTED_ADAPTER" });
  });
  it("rejects expired commands before mutation", async () => {
    const f = await fixture(); const handler = new FixtureRegistrationRemovalHandler({ ...f.options, now: () => new Date("2026-10-16T00:00:30.000Z") });
    expect(await handler.handle(removalCommand())).toMatchObject({ status: "rejected", errorCode: "COMMAND_EXPIRED" });
  });
  it("does not let same-operation altered content erase its first result", async () => {
    const f = await fixture(); const first = await f.handler.handle(removalCommand());
    await expect(f.handler.handle(removalCommand({ expiresAt: "2026-10-16T00:00:29.000Z" }))).rejects.toThrow("REMOVAL_OPERATION_CONFLICT");
    expect(await f.handler.handle(removalCommand())).toEqual(first);
  });
  it("retains terminal after PUBACK and accepts only an exact application ACK", async () => {
    const f = await fixture(); const terminal = await f.handler.handle(removalCommand()); const events: unknown[] = [];
    f.handler.connect(async (_topic, event) => { events.push(event); });
    try {
      await f.handler.flush(); await f.handler.flush(); expect(events).toEqual([terminal, terminal]);
      expect(await f.handler.acknowledge({ ...removalAck(terminal), resultHash: `sha256:${"0".repeat(64)}` })).toBe(false);
      expect((await f.journal.records())[0].acknowledged).toBe(false);
      expect(await f.handler.acknowledge(removalAck(terminal))).toBe(true);
      await f.handler.flush(); expect(events).toHaveLength(2);
      expect(JSON.parse(await readFile(f.journalPath, "utf8")).records[0].acknowledged).toBe(true);
    } finally { await f.handler.stopAndDrain(); }
  });
  it("recovers an exact tombstone after crash between mapping retirement and terminal persistence", async () => {
    const f = await fixture(); const command = removalCommand(); await f.journal.accept(command); await f.port.retireRegistration(command);
    const handler = new FixtureRegistrationRemovalHandler({ ...f.options, journal: new FixtureRegistrationRemovalJournal(f.journalPath), port: new BioDeviceMappingStore(f.mappingPath) });
    await handler.recover(); expect((await f.journal.records())[0].terminal?.status).toBe("removed");
  });
  it("proves an accepted-but-never-admitted restart did not mutate, without executing deletion", async () => {
    const f = await fixture(); const command = removalCommand(); const captured = (await f.port.findByFixtureId(command.fixtureId))!;
    await f.journal.accept(command); await f.handler.recover();
    expect((await f.journal.records())[0].terminal).toMatchObject({ status: "rejected", errorCode: "REMOVAL_NOT_ADMITTED" });
    expect(f.port.isRegistrationCurrent(captured)).toBe(true); expect(f.cleanups()).toBe(0);
  });
  it("replays an expired exact terminal without generating a replacement event", async () => {
    const f = await fixture(); const command = removalCommand(), first = await f.handler.handle(command);
    const late = new FixtureRegistrationRemovalHandler({ ...f.options, now: () => new Date("2026-10-17T00:00:00.000Z") });
    expect(await late.handle(command)).toEqual(first);
  });
  it("finishes same-operation reconciliation after cleanup failure, including after TTL", async () => {
    const f = await fixture(); let attempts = 0;
    const handler = new FixtureRegistrationRemovalHandler({ ...f.options, afterRetire: async () => {
      if (++attempts === 1) throw new Error("cleanup unavailable");
    } });
    const first = await handler.handle(removalCommand()); expect(first.status).toBe("reconcile_required");
    const restarted = new FixtureRegistrationRemovalHandler({ ...f.options, now: () => new Date("2026-10-17T00:00:00.000Z") });
    const completed = await restarted.handle(removalCommand()); expect(completed.status).toBe("removed");
    expect(await restarted.acknowledge(removalAck(first))).toBe(false);
    expect((await f.journal.records())[0].acknowledged).toBe(false);
    expect((await f.journal.records())[0].previousTerminals).toEqual([first]);
  });
  it("retries a failed publish on the same connection and retains exact event identity", async () => {
    const f = await fixture(), first = await f.handler.handle(removalCommand());
    const handler = new FixtureRegistrationRemovalHandler({ ...f.options, retryMs: 1 });
    const events: unknown[] = [];
    let retried!: () => void; const second = new Promise<void>(resolve => { retried = resolve; });
    handler.connect(async (_topic, event) => {
      events.push(event);
      if (events.length === 1) throw new Error("broker unavailable");
      handler.disconnect(); retried();
    });
    try { await second; expect(events).toEqual([first, first]); expect((await f.journal.records())[0].acknowledged).toBe(false); }
    finally { await handler.stopAndDrain(); }
  });
  it("does not acknowledge intake until its real journal write is durable", async () => {
    const f = await fixture(); let release!: () => void, reached!: () => void;
    const accepted = new Promise<void>(resolve => { reached = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const journal = new FixtureRegistrationRemovalJournal(f.journalPath, async (path, value, options) => {
      const record = (value as { records?: unknown[] }).records;
      if (record?.length && !JSON.stringify(record).includes('"admitted":true')) { reached(); await barrier; }
      await writeJsonAtomic(path, value, options);
    });
    const handler = new FixtureRegistrationRemovalHandler({ ...f.options, journal }); let receipts = 0;
    const work = handler.handle(removalCommand(), () => { receipts++; });
    try { await accepted; expect(receipts).toBe(0); } finally { release(); }
    expect((await work).status).toBe("removed"); expect(receipts).toBe(1);
  });
  it("recovers a real terminal-file write failure after mapping commit without repeating removal", async () => {
    const f = await fixture(); let failed = false;
    const journal = new FixtureRegistrationRemovalJournal(f.journalPath, async (path, value, options) => {
      if (!failed && (value as { records?: Array<{ terminal: unknown }> }).records?.some(row => row.terminal)) {
        failed = true; throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      await writeJsonAtomic(path, value, options);
    });
    await expect(new FixtureRegistrationRemovalHandler({ ...f.options, journal }).handle(removalCommand())).rejects.toThrow("disk full");
    expect(await f.port.retirement(removalCommand())).not.toBeNull();
    const restarted = new FixtureRegistrationRemovalHandler({ ...f.options, journal: new FixtureRegistrationRemovalJournal(f.journalPath) });
    expect((await restarted.handle(removalCommand())).status).toBe("removed");
  });
  it("recovers a durably admitted intent after TTL without minting another operation", async () => {
    const f = await fixture(); await f.journal.accept(removalCommand()); await f.journal.admit(removalCommand().operationId);
    const handler = new FixtureRegistrationRemovalHandler({ ...f.options, now: () => new Date("2026-10-17T00:00:00.000Z") });
    expect(await handler.handle(removalCommand())).toMatchObject({ status: "removed", operationId: removalCommand().operationId });
  });
  it("recovers a first-retirement manifest-only crash without exposing the old mapping or requiring a new TTL", async () => {
    const f = await fixture(), command = removalCommand();
    await f.journal.accept(command); await f.journal.admit(command.operationId);
    await writeJsonAtomic(`${f.mappingPath}.retirement-manifest`, { version: 1, firstRemoval: command });
    const mappings = new BioDeviceMappingStore(f.mappingPath);
    await expect(mappings.validate()).resolves.toBeUndefined();
    expect(await mappings.findByFixtureId(command.fixtureId)).toBeNull();
    const handler = new FixtureRegistrationRemovalHandler({ ...f.options, port: mappings,
      now: () => new Date("2026-10-17T00:00:00.000Z") });
    expect((await handler.handle(command)).status).toBe("removed");
    expect(await new BioDeviceMappingStore(f.mappingPath).retirement(command)).not.toBeNull();
  });
  it("keeps a manifest-only intent reconcilable while clock trust is lost, then removes the same expired command", async () => {
    const f = await fixture(), command = removalCommand();
    const captured = (await f.port.findByFixtureId(command.fixtureId))!;
    await f.journal.accept(command); await f.journal.admit(command.operationId);
    const manifest = { version: 1, firstRemoval: command };
    await writeJsonAtomic(`${f.mappingPath}.retirement-manifest`, manifest);
    const originalMapping = await readFile(f.mappingPath, "utf8");
    let trusted = false, clockChecks = 0;
    const restart = () => new FixtureRegistrationRemovalHandler({ ...f.options,
      journal: new FixtureRegistrationRemovalJournal(f.journalPath), port: new BioDeviceMappingStore(f.mappingPath),
      clockTrusted: async () => { clockChecks++; return trusted; },
      now: () => new Date("2026-10-17T00:00:00.000Z") });
    await restart().recover();
    const first = (await f.journal.records())[0].terminal!;
    expect(first).toMatchObject({ status: "reconcile_required", errorCode: "REMOVAL_RECONCILE_REQUIRED" });
    expect(await readFile(f.mappingPath, "utf8")).toBe(originalMapping);
    expect(JSON.parse(await readFile(`${f.mappingPath}.retirement-manifest`, "utf8"))).toEqual(manifest);
    expect(f.cleanups()).toBe(0);
    const mappings = new BioDeviceMappingStore(f.mappingPath);
    expect(await mappings.findByFixtureId(command.fixtureId)).toBeNull();
    expect(mappings.isRegistrationCurrent(captured)).toBe(false);
    expect(await mappings.retirement(command)).toBeNull();
    expect(await restart().handle(command)).toEqual(first);
    await expect(restart().handle(removalCommand({ nodeId: "77777777-7777-4777-8777-777777777777" })))
      .rejects.toThrow("REMOVAL_OPERATION_CONFLICT");
    trusted = true;
    const recovered = restart(), terminal = await recovered.handle(command);
    expect(terminal).toMatchObject({ status: "removed", operationId: command.operationId, bindingHash: command.bindingHash });
    expect(clockChecks).toBeGreaterThanOrEqual(4);
    expect(f.cleanups()).toBe(1);
    expect(await new BioDeviceMappingStore(f.mappingPath).retirement(command)).not.toBeNull();
    expect(await recovered.acknowledge(removalAck(first))).toBe(false);
    expect((await f.journal.records())[0]).toMatchObject({ admitted: true, previousTerminals: [first], terminal });
  });
  it("still rejects a first-seen command with an untrusted clock without creating a retirement intent", async () => {
    const f = await fixture();
    const handler = new FixtureRegistrationRemovalHandler({ ...f.options, clockTrusted: async () => false });
    expect(await handler.handle(removalCommand())).toMatchObject({ status: "rejected", errorCode: "GATEWAY_CLOCK_UNTRUSTED" });
    expect(await f.port.findByFixtureId(mappingInput.fixtureId)).not.toBeNull();
    await expect(readFile(`${f.mappingPath}.retirement-manifest`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.cleanups()).toBe(0);
  });
  it("preserves admission if clock trust disappears at the final pre-retirement check", async () => {
    const f = await fixture(); let checks = 0;
    const handler = new FixtureRegistrationRemovalHandler({ ...f.options, clockTrusted: async () => ++checks === 1 });
    expect(await handler.handle(removalCommand())).toMatchObject({ status: "reconcile_required" });
    expect((await f.journal.records())[0].admitted).toBe(true);
    expect(await f.port.retirement(removalCommand())).toBeNull();
    expect(f.cleanups()).toBe(0);
    const recovered = new FixtureRegistrationRemovalHandler({ ...f.options,
      journal: new FixtureRegistrationRemovalJournal(f.journalPath), port: new BioDeviceMappingStore(f.mappingPath),
      now: () => new Date("2026-10-17T00:00:00.000Z") });
    expect(await recovered.handle(removalCommand())).toMatchObject({ status: "removed" });
  });
  it.each(["journal", "manifest"])("fails closed after %s file loss", async lost => {
    const f = await fixture(); await f.handler.handle(removalCommand());
    await rm(lost === "journal" ? f.journalPath : `${f.journalPath}.manifest`);
    await expect(new FixtureRegistrationRemovalJournal(f.journalPath).initialize()).rejects.toThrow();
  });
});
