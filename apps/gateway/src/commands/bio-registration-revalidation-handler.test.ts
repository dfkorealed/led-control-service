import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BioRegistrationRevalidationCommand } from "@led-control/shared";
import { CommandJournal } from "./command-journal";
import { StateEventOutbox } from "../state/state-event-outbox";
import { handleBioRegistrationRevalidation, recoverBioRegistrationRevalidations } from "./bio-registration-revalidation-handler";
import { recoverBioSensorModes } from "./bio-sensor-mode-handler";
import * as meshStoreFile from "../mesh/mesh-store-file";

const command: BioRegistrationRevalidationCommand = {
  version: 2, purpose: "bio_registration_revalidation", operation: "query",
  commandId: "10000000-0000-4000-8000-000000000001", siteId: "10000000-0000-4000-8000-000000000002",
  gatewayId: "10000000-0000-4000-8000-000000000003", fixtureId: "10000000-0000-4000-8000-000000000004",
  nodeId: "10000000-0000-4000-8000-000000000005", assignmentVersion: 1,
  meshAddress: "0x0001", deviceIdentityHash: "a".repeat(64),
  requestedAt: "2026-10-06T00:00:00.000Z", expiresAt: "2026-10-06T00:00:30.000Z"
};
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "bio-revalidation-")); directories.push(dir);
  const path = join(dir, "journal.json"), outboxPath = join(dir, "outbox.json");
  const outbox = new StateEventOutbox(outboxPath, command); await outbox.initialize();
  return { path, outboxPath, journal: new CommandJournal(path), outbox, scope: command,
    nextSequence: vi.fn(async () => 1), clockTrusted: vi.fn(async () => true),
    now: () => new Date("2026-10-06T00:00:01.000Z") };
}
describe("read-only BIO registration revalidation", () => {
  it("withholds durable receipts for rename-visible accepted work until the parent fsync barrier recovers", async () => {
    const f = await fixture(), adapter = { sensorModeOperation: vi.fn() }, receipts = vi.fn();
    let failing = true;
    const syncParentDirectory = vi.fn(async (directory: string) => {
      if (failing) throw new Error("injected parent fsync failure after rename");
      const handle = await open(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    });
    const writeJsonAtomic = meshStoreFile.writeJsonAtomic;
    // Keep the actual write/file fsync/rename/readback machinery; only the final
    // directory barrier fails, so the rejected accepted record remains readable.
    vi.spyOn(meshStoreFile, "writeJsonAtomic").mockImplementation((path, value, options) =>
      writeJsonAtomic(path, value, path === f.path ? { syncParentDirectory } : options));
    const options = { ...f, onDurableReceipt: receipts };
    await expect(handleBioRegistrationRevalidation(adapter, command, options)).rejects.toBeInstanceOf(meshStoreFile.AtomicJsonCommitUncertainError);
    expect(syncParentDirectory).toHaveBeenCalledTimes(2);
    const accepted = JSON.parse(await readFile(f.path, "utf8"));
    expect(accepted.records[command.commandId]).toMatchObject({ state: "accepted", command: { kind: "bio_registration_revalidation", command } });
    expect(receipts).not.toHaveBeenCalled(); expect(adapter.sensorModeOperation).not.toHaveBeenCalled();
    for (const retry of [() => handleBioRegistrationRevalidation(adapter, command, options), () => recoverBioRegistrationRevalidations(options)]) {
      await expect(retry()).rejects.toBeInstanceOf(meshStoreFile.AtomicJsonCommitUncertainError);
      expect(receipts).not.toHaveBeenCalled(); expect(adapter.sensorModeOperation).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(accepted);
      expect(await f.outbox.pending()).toEqual([]); expect(f.nextSequence).not.toHaveBeenCalled();
    }
    expect(syncParentDirectory).toHaveBeenCalledTimes(6);
    failing = false;
    await Promise.all([handleBioRegistrationRevalidation(adapter, command, options), recoverBioRegistrationRevalidations(options)]);
    expect(receipts).toHaveBeenCalledTimes(2); expect(adapter.sensorModeOperation).not.toHaveBeenCalled();
    expect(f.nextSequence).toHaveBeenCalledTimes(1);
    const terminal = (await f.outbox.pending())[0].payload;
    expect(terminal).toMatchObject({ status: "unknown", errorCode: "GATEWAY_RESTART", sequence: 1 });
    expect((await new CommandJournal(f.path).get(command.commandId))?.result).toEqual(terminal);
    expect(await f.journal.pendingBioRegistrationRevalidations()).toEqual([]);
    await handleBioRegistrationRevalidation(adapter, command, options);
    expect((await f.outbox.pending()).map(row => row.payload)).toEqual([terminal]);
    expect(f.nextSequence).toHaveBeenCalledTimes(1); expect(adapter.sensorModeOperation).not.toHaveBeenCalled();
  });
  it.each(["sensor", "force-on", "force-off"] as const)("observes %s with an explicit query DTO and preserves separate Fixture/node identity", async mode => {
    const f = await fixture(); const setWrites: unknown[] = [];
    const adapter = { sensorModeOperation: vi.fn(async (input: { operation: string }) => {
      if (input.operation !== "query") setWrites.push(input);
      return mode;
    }) };
    await handleBioRegistrationRevalidation(adapter, command, f);
    const { purpose: _purpose, ...query } = command;
    expect(adapter.sensorModeOperation).toHaveBeenCalledWith(query, expect.anything());
    expect(setWrites).toEqual([]);
    const { requestedAt: _requestedAt, expiresAt: _expiresAt, ...identity } = command;
    expect((await f.outbox.pending())[0].payload).toMatchObject({ ...identity,
      status: "observed", observedMode: mode, evidence: "mode_get" });
    expect(await f.journal.latestFixtureSnapshots()).toEqual([]);
    await handleBioRegistrationRevalidation(adapter, command, f);
    expect(adapter.sensorModeOperation).toHaveBeenCalledTimes(1); expect(await f.outbox.pending()).toHaveLength(1);
  });
  it("owns duplicate deliveries and recovery together while acknowledging only durable receipts", async () => {
    const f = await fixture(); let release!: (mode: "sensor") => void, entered!: () => void;
    const read = new Promise<"sensor">(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const adapter = { sensorModeOperation: vi.fn(async () => { entered(); return read; }) }, receipts = vi.fn();
    const options = { ...f, onDurableReceipt: receipts };
    const first = handleBioRegistrationRevalidation(adapter, command, options);
    const second = handleBioRegistrationRevalidation(adapter, command, options);
    await Promise.race([started, first, second]);
    expect(receipts).toHaveBeenCalledTimes(2);
    const recovery = recoverBioRegistrationRevalidations(options);
    await expect(handleBioRegistrationRevalidation(adapter, { ...command, meshAddress: "0x0002" }, options)).rejects.toThrow("identity conflict");
    release("sensor"); await Promise.all([first, second, recovery]);
    expect(adapter.sensorModeOperation).toHaveBeenCalledTimes(1); expect(f.nextSequence).toHaveBeenCalledTimes(1);
    expect(await f.outbox.pending()).toHaveLength(1);
  });
  it.each(["scope", "clock", "future", "expired", "abort"])("rejects %s authority before GET", async reason => {
    const f = await fixture(), adapter = { sensorModeOperation: vi.fn() }, controller = new AbortController();
    if (reason === "abort") controller.abort();
    const options = { ...f, signal: controller.signal,
      scope: reason === "scope" ? { ...command, assignmentVersion: 2 } : f.scope,
      clockTrusted: async () => reason !== "clock",
      now: () => new Date(reason === "future" ? "2026-10-05T23:59:59Z" : reason === "expired" ? command.expiresAt : "2026-10-06T00:00:01Z") };
    if (reason === "scope") await expect(handleBioRegistrationRevalidation(adapter, command, options)).rejects.toThrow("scope");
    else {
      await handleBioRegistrationRevalidation(adapter, command, options);
      expect((await f.outbox.pending())[0].payload).toMatchObject({ status: reason === "future" || reason === "expired" ? "timed_out" : "unknown",
        errorCode: reason === "clock" ? "GATEWAY_CLOCK_UNTRUSTED" : reason === "abort" ? "GATEWAY_SHUTDOWN" : "COMMAND_EXPIRED" });
    }
    expect(adapter.sensorModeOperation).not.toHaveBeenCalled();
  });
  it.each(["clock", "expired", "future", "abort", "malformed", "identity"])("cannot observe after %s changes during GET", async reason => {
    const f = await fixture(), controller = new AbortController(); let after = false;
    const adapter = { sensorModeOperation: vi.fn(async () => {
      after = true;
      if (reason === "abort") controller.abort();
      if (reason === "identity") throw new Error("BIO sensor mode transport changed");
      return reason === "malformed" ? "invalid" as "sensor" : "sensor" as const;
    }) };
    await handleBioRegistrationRevalidation(adapter, command, { ...f, signal: controller.signal,
      clockTrusted: async () => !(after && reason === "clock"),
      now: () => new Date(after && reason === "expired" ? command.expiresAt : after && reason === "future" ? "2026-10-05T23:59:59Z" : "2026-10-06T00:00:01Z") });
    expect((await f.outbox.pending())[0].payload).not.toHaveProperty("observedMode");
    expect((await f.outbox.pending())[0].payload).not.toHaveProperty("evidence");
  });
  it("bounds adapter deadline by 8 seconds and ignores a stuck GET after shutdown", async () => {
    const f = await fixture(), controller = new AbortController(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const adapter = { sensorModeOperation: vi.fn((_command, control) => { expect(control.deadlineAt).toBe(Date.parse("2026-10-06T00:00:09Z")); entered(); return new Promise<"sensor">(() => {}); }) };
    const handling = handleBioRegistrationRevalidation(adapter, command, { ...f, signal: controller.signal });
    await Promise.race([started, handling]); controller.abort(); await handling;
    expect((await f.outbox.pending())[0].payload).toMatchObject({ status: "unknown", errorCode: "GATEWAY_SHUTDOWN" });
  });
  it.each([8_000, 1_000])("bounds a stuck GET by the smaller owned/remaining budget of %d ms", async budget => {
    const f = await fixture(); vi.useFakeTimers();
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const adapter = { sensorModeOperation: vi.fn((_input, control) => {
      expect(control.deadlineAt).toBe(f.now().getTime() + budget); entered(); return new Promise<"sensor">(() => {});
    }) };
    const input = budget === 1_000 ? { ...command, expiresAt: "2026-10-06T00:00:02.000Z" } : command;
    const handling = handleBioRegistrationRevalidation(adapter, input, f);
    await Promise.race([started, handling]); await vi.advanceTimersByTimeAsync(budget); await handling;
    expect((await f.outbox.pending())[0].payload).toMatchObject({ status: "timed_out", errorCode: "MODE_GET_UNCONFIRMED" });
  });
  it("recovers accepted work once as GATEWAY_RESTART and old sensor-mode recovery ignores it", async () => {
    const f = await fixture(); await f.journal.accept(command.commandId, { kind: "bio_registration_revalidation", command });
    expect(await f.journal.pendingSensorModeOperations()).toEqual([]); await recoverBioSensorModes(f);
    expect(await f.outbox.pending()).toEqual([]);
    const journal = new CommandJournal(f.path);
    await Promise.all([recoverBioRegistrationRevalidations({ ...f, journal }), recoverBioRegistrationRevalidations({ ...f, journal })]);
    expect((await f.outbox.pending())[0].payload).toMatchObject({ status: "unknown", errorCode: "GATEWAY_RESTART" });
    expect(f.nextSequence).toHaveBeenCalledTimes(1); expect(await journal.pendingBioRegistrationRevalidations()).toEqual([]);
  });
  it("skips restart work from another assignment", async () => {
    const f = await fixture(); await f.journal.accept(command.commandId, { kind: "bio_registration_revalidation", command });
    await recoverBioRegistrationRevalidations({ ...f, scope: { ...command, assignmentVersion: 2 } });
    expect(await f.outbox.pending()).toEqual([]); expect(await f.journal.pendingBioRegistrationRevalidations()).toHaveLength(1);
  });
  it("retains the terminal on outbox failure and retries exactly the same event without GET", async () => {
    const f = await fixture(), adapter = { sensorModeOperation: vi.fn(async () => "sensor" as const) };
    const enqueue = vi.spyOn(f.outbox, "enqueue").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(handleBioRegistrationRevalidation(adapter, command, f)).rejects.toThrow("disk unavailable");
    const terminal = (await f.journal.get(command.commandId))?.result;
    expect(await f.journal.pendingBioRegistrationRevalidations()).toHaveLength(1);
    enqueue.mockRestore(); await recoverBioRegistrationRevalidations({ ...f, journal: new CommandJournal(f.path) });
    expect((await f.outbox.pending())[0].payload).toEqual(terminal); expect(adapter.sensorModeOperation).toHaveBeenCalledTimes(1);
    expect(f.nextSequence).toHaveBeenCalledTimes(1);
  });
  it("does not ACK a failed journal acceptance or call GET", async () => {
    const f = await fixture(), adapter = { sensorModeOperation: vi.fn() }, receipt = vi.fn();
    vi.spyOn(f.journal, "accept").mockRejectedValue(new Error("fsync unavailable"));
    await expect(handleBioRegistrationRevalidation(adapter, command, { ...f, onDurableReceipt: receipt })).rejects.toThrow("fsync unavailable");
    expect(receipt).not.toHaveBeenCalled(); expect(adapter.sensorModeOperation).not.toHaveBeenCalled();
    expect(await f.outbox.pending()).toEqual([]);
  });
  it("retains outbox and exact terminal if the final journal handoff fsync fails", async () => {
    const f = await fixture(), adapter = { sensorModeOperation: vi.fn(async () => "force-on" as const) };
    vi.spyOn(f.journal, "markBioRegistrationRevalidationHandedOff").mockRejectedValueOnce(new Error("handoff fsync failed"));
    await expect(handleBioRegistrationRevalidation(adapter, command, f)).rejects.toThrow("handoff fsync failed");
    const terminal = (await f.outbox.pending())[0].payload;
    expect(await f.journal.pendingBioRegistrationRevalidations()).toHaveLength(1);
    await recoverBioRegistrationRevalidations({ ...f, journal: new CommandJournal(f.path) });
    expect((await f.outbox.pending()).map(row => row.payload)).toEqual([terminal]);
    expect(adapter.sensorModeOperation).toHaveBeenCalledTimes(1); expect(f.nextSequence).toHaveBeenCalledTimes(1);
  });
  it("retains accepted work if terminal persistence fails and restart never repeats GET", async () => {
    const f = await fixture(), adapter = { sensorModeOperation: vi.fn(async () => "sensor" as const) };
    vi.spyOn(f.journal, "complete").mockRejectedValue(new Error("terminal fsync failed"));
    await expect(handleBioRegistrationRevalidation(adapter, command, f)).rejects.toThrow("terminal fsync failed");
    expect(JSON.parse(await readFile(f.path, "utf8")).records[command.commandId].state).toBe("accepted");
    expect(await f.outbox.pending()).toEqual([]);
    await recoverBioRegistrationRevalidations({ ...f, journal: new CommandJournal(f.path) });
    expect((await f.outbox.pending())[0].payload).toMatchObject({ errorCode: "GATEWAY_RESTART" });
    expect(adapter.sensorModeOperation).toHaveBeenCalledTimes(1);
  });
});
