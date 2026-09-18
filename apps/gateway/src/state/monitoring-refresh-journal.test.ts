import { mkdtemp, rm, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
const resultAck = () => ({ eventId: terminal().events[0].eventId, fixtureId: command.targetFixtureIds[0], sequence: 1, status: "ingested", ingestedAt: now().toISOString() });

it("durably replays an exact terminal after restart and retains dedup identity after completion ACK", async () => {
  const file = await path();
  const first = new MonitoringRefreshJournal(file, scope, { now });
  expect((await first.accept(command)).kind).toBe("accepted");
  await first.complete(command, terminal());
  const recovered = new MonitoringRefreshJournal(file, scope, { now });
  expect((await recovered.accept(command)).terminal).toEqual(terminal());
  expect(await recovered.pending()).toHaveLength(1);
  expect(await recovered.acknowledge({ ...scope, refreshId: command.refreshId, batchId: command.batchId })).toBe(false);
  await recovered.markEventHandedOff(command.batchId, terminal().events[0].eventId);
  await recovered.markHandedOff(command.batchId);
  expect(await recovered.acknowledge({ ...scope, refreshId: command.refreshId, batchId: command.batchId })).toBe(false);
  await recovered.acknowledgeEvent(resultAck());
  expect(await recovered.acknowledge({ ...scope, refreshId: command.refreshId, batchId: command.batchId })).toBe(true);
  const final = new MonitoringRefreshJournal(file, scope, { now });
  expect(await final.pending()).toEqual([]);
  expect((await final.accept(command)).terminal).toEqual(terminal());
  expect(JSON.parse(await readFile(file, "utf8")).records).toHaveLength(1);
});

it("requires durable event-by-event progress before batch handoff and restores it after restart", async () => {
  const file = await path();
  const journal = new MonitoringRefreshJournal(file, scope, { now });
  await journal.accept(command);
  await journal.complete(command, terminal());
  await expect(journal.markHandedOff(command.batchId)).rejects.toThrow();
  await expect(journal.markEventHandedOff(command.batchId, command.refreshId)).rejects.toThrow();
  await journal.markEventHandedOff(command.batchId, terminal().events[0].eventId);
  const recovered = new MonitoringRefreshJournal(file, scope, { now });
  expect((await recovered.pending())[0].handedOffEventIds).toEqual([terminal().events[0].eventId]);
  await recovered.markEventHandedOff(command.batchId, terminal().events[0].eventId);
  await recovered.markHandedOff(command.batchId);
  expect((await recovered.pending())[0].handedOff).toBe(true);
});

it("replays unacknowledged v1 results during migration because handoff did not prove application ACK", async () => {
  const file = await path();
  const journal = new MonitoringRefreshJournal(file, scope, { now });
  await journal.accept(command); await journal.complete(command, terminal());
  await journal.markEventHandedOff(command.batchId, terminal().events[0].eventId);
  await journal.markHandedOff(command.batchId);
  const legacy = JSON.parse(await readFile(file, "utf8"));
  legacy.version = 1;
  delete legacy.records[0].handedOffEventIds;
  delete legacy.records[0].acknowledgedEventIds;
  await writeFile(file, JSON.stringify(legacy));
  const recovered = new MonitoringRefreshJournal(file, scope, { now });
  expect((await recovered.pending())[0]).toMatchObject({ handedOff: false, handedOffEventIds: [], acknowledgedEventIds: [] });
  expect(await recovered.acknowledge({ ...scope, refreshId: command.refreshId, batchId: command.batchId })).toBe(false);
  expect(JSON.parse(await readFile(file, "utf8")).version).toBe(2);
});

it("fails closed on null persisted per-event handoff progress", async () => {
  const file = await path();
  await new MonitoringRefreshJournal(file, scope, { now }).accept(command);
  const corrupt = JSON.parse(await readFile(file, "utf8"));
  corrupt.records[0].handedOffEventIds = null;
  await writeFile(file, JSON.stringify(corrupt));
  await expect(new MonitoringRefreshJournal(file, scope, { now }).initialize()).rejects.toThrow("handoff progress");
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

it("accepts reordered new sequences after restart, but never altered sequence reuse", async () => {
  const file = await path();
  const later = { ...command, sequence: 2, batchId: "88888888-8888-4888-8888-888888888888", idempotencyKey: "99999999-9999-4999-8999-999999999999" };
  await new MonitoringRefreshJournal(file, scope, { now }).accept(later);
  const recovered = new MonitoringRefreshJournal(file, scope, { now });
  expect((await recovered.accept(command)).kind).toBe("accepted");
  expect((await recovered.accept(command)).kind).toBe("running");
  await expect(recovered.accept({ ...later, sequence: 1 })).rejects.toThrow("conflict");
  await expect(recovered.accept({ ...command, targetFixtureIds: [scope.siteId] })).rejects.toThrow("conflict");
  const expired = new MonitoringRefreshJournal(file, scope, { now: () => new Date(command.expiresAt) });
  await expect(expired.accept(command)).rejects.toThrow("expired");
});

it("fails closed on altered replay, idempotency reuse, scope, expiry and reused sequence", async () => {
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

it("reclaims expired ACKed terminals across sustained usage under the byte bound", async () => {
  const file = await path();
  let clock = now();
  const options = { now: () => clock, maxBytes: 8_000 };
  for (let n = 0; n < 24; n++) {
    const journal = new MonitoringRefreshJournal(file, scope, options);
    const next = { ...command, batchId: randomUUID(), idempotencyKey: randomUUID(), sequence: n + 1,
      requestedAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 1000).toISOString() };
    await journal.accept(next);
    const done = terminal(); done.events[0].batchId = next.batchId; done.completed.batchId = next.batchId;
    await journal.complete(next, done);
    await journal.markEventHandedOff(next.batchId, done.events[0].eventId);
    await journal.markHandedOff(next.batchId);
    await journal.acknowledgeEvent(resultAck());
    await journal.acknowledge({ ...scope, refreshId: next.refreshId, batchId: next.batchId });
    expect((await new MonitoringRefreshJournal(file, scope, options).accept(next)).terminal).toEqual(done);
    clock = new Date(clock.getTime() + 1000);
  }
  const restarted = new MonitoringRefreshJournal(file, scope, options);
  await restarted.initialize();
  expect(JSON.parse(await readFile(file, "utf8")).records).toEqual([]);
  await expect(restarted.accept({ ...command, expiresAt: clock.toISOString() })).rejects.toThrow("expired");
});

it("retains expired unacknowledged results but prunes expired terminal failures", async () => {
  const file = await path();
  const journal = new MonitoringRefreshJournal(file, scope, { now });
  await journal.accept(command); await journal.complete(command, terminal());
  const failed = { ...command, batchId: randomUUID(), idempotencyKey: randomUUID(), sequence: 2 };
  await journal.accept(failed); await journal.complete(failed, { events: [], failure: "transport_unavailable" });
  const restarted = new MonitoringRefreshJournal(file, scope, { now: () => new Date(command.expiresAt) });
  await restarted.initialize();
  expect(await restarted.pending()).toHaveLength(1);
  expect(JSON.parse(await readFile(file, "utf8")).records.map((row: any) => row.command.batchId)).toEqual([command.batchId]);
});
