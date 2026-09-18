import { mkdtemp, rm, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MonitoringRefreshJournal } from "./monitoring-refresh-journal";

export const scope = { siteId: "11111111-1111-4111-8111-111111111111", gatewayId: "22222222-2222-4222-8222-222222222222" };
export const command = { ...scope, refreshId: "33333333-3333-4333-8333-333333333333", batchId: "44444444-4444-4444-8444-444444444444",
  idempotencyKey: "55555555-5555-4555-8555-555555555555", sequence: 1,
  targetFixtureIds: ["66666666-6666-4666-8666-666666666666"], requestedAt: "2026-09-15T00:00:00.000Z", expiresAt: "2026-09-15T00:01:00.000Z" };
const now = () => new Date("2026-09-15T00:00:01.000Z");
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function path() { const directory = await mkdtemp(join(tmpdir(), "refresh-journal-")); directories.push(directory); return join(directory, "journal.json"); }
function terminal() { return { events: [{ ...scope, refreshId: command.refreshId, batchId: command.batchId,
  fixtureId: command.targetFixtureIds[0], reason: "not_found" as const, eventId: "88888888-8888-4888-8888-888888888888",
  sequence: 1, occurredAt: now().toISOString() }], completed: { ...scope, refreshId: command.refreshId, batchId: command.batchId,
  eventId: "77777777-7777-4777-8777-777777777777", sequence: 2, occurredAt: now().toISOString(), targetFixtureIds: command.targetFixtureIds } }; }

it("durably replays an exact terminal after restart and retains dedup identity after completion ACK", async () => {
  const file = await path();
  const first = new MonitoringRefreshJournal(file, scope, { now });
  expect((await first.accept(command)).kind).toBe("accepted");
  await first.complete(command, terminal());
  const recovered = new MonitoringRefreshJournal(file, scope, { now });
  expect((await recovered.accept(command)).terminal).toEqual(terminal());
  expect(await recovered.pending()).toHaveLength(1);
  expect(await recovered.acknowledge({ ...scope, refreshId: command.refreshId, batchId: command.batchId })).toBe(false);
  await recovered.markHandedOff(command.batchId);
  expect(await recovered.acknowledge({ ...scope, refreshId: command.refreshId, batchId: command.batchId })).toBe(true);
  const final = new MonitoringRefreshJournal(file, scope, { now });
  expect(await final.pending()).toEqual([]);
  expect((await final.accept(command)).terminal).toEqual(terminal());
  expect(JSON.parse(await readFile(file, "utf8")).records).toHaveLength(1);
});

it("refuses completion without exactly one correlated terminal event per target", async () => {
  const journal = new MonitoringRefreshJournal(await path(), scope, { now });
  await journal.accept(command);
  await expect(journal.complete(command, { ...terminal(), events: [] })).rejects.toThrow();
  await expect(journal.complete(command, { ...terminal(), events: [terminal().events[0], terminal().events[0]] })).rejects.toThrow();
  await expect(journal.complete(command, { ...terminal(), events: [{ ...terminal().events[0], sequence: 3 }] })).rejects.toThrow();
});

it("retains the durable receipt when terminal growth exceeds the restart file-size bound", async () => {
  const file = await path();
  await new MonitoringRefreshJournal(file, scope, { now }).accept(command);
  const maxBytes = Buffer.byteLength(await readFile(file, "utf8")) + 16;
  const bounded = new MonitoringRefreshJournal(file, scope, { now, maxBytes });
  await expect(bounded.complete(command, terminal())).rejects.toThrow("capacity");
  expect((await new MonitoringRefreshJournal(file, scope, { now, maxBytes }).accept(command)).kind).toBe("recovered");
});

it("fails closed on altered replay, idempotency reuse, scope, expiry and nonincreasing sequence", async () => {
  const journal = new MonitoringRefreshJournal(await path(), scope, { now });
  await journal.accept(command);
  for (const altered of [
    { ...command, targetFixtureIds: ["88888888-8888-4888-8888-888888888888"] },
    { ...command, batchId: "88888888-8888-4888-8888-888888888888", sequence: 2 },
    { ...command, gatewayId: command.siteId },
    { ...command, expiresAt: now().toISOString() },
    { ...command, batchId: "88888888-8888-4888-8888-888888888888", idempotencyKey: "99999999-9999-4999-8999-999999999999" }
  ]) await expect(journal.accept(altered)).rejects.toThrow();
});

it("marks an interrupted receipt recovered and rejects loss of an initialized journal", async () => {
  const file = await path();
  await new MonitoringRefreshJournal(file, scope, { now }).accept(command);
  expect((await new MonitoringRefreshJournal(file, scope, { now }).accept(command)).kind).toBe("recovered");
  await unlink(file);
  await expect(new MonitoringRefreshJournal(file, scope, { now }).initialize()).rejects.toThrow();
});
