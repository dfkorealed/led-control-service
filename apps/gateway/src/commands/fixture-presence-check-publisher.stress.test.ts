import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import { MonitoringRefreshJournal } from "../state/monitoring-refresh-journal";
import { StateEventOutbox } from "../state/state-event-outbox";
import { MonitoringRefreshEventPublisher } from "./fixture-presence-check-handler";

it("yields while draining 300 batches of 64 targets without cloning all pending results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "refresh-stress-"));
  const file = join(directory, "journal.json");
  const scope = { siteId: randomUUID(), gatewayId: randomUUID() };
  const now = () => new Date("2026-09-15T00:00:01.000Z");
  const records = Array.from({ length: 300 }, (_, index) => {
    const command = { ...scope, refreshId: randomUUID(), batchId: randomUUID(), idempotencyKey: randomUUID(), sequence: index + 1,
      targetFixtureIds: Array.from({ length: 64 }, () => randomUUID()), requestedAt: "2026-09-15T00:00:00.000Z", expiresAt: "2026-09-15T00:01:00.000Z" };
    const events = command.targetFixtureIds.map((fixtureId, target) => ({ ...scope, refreshId: command.refreshId, batchId: command.batchId,
      fixtureId, eventId: randomUUID(), sequence: index * 65 + target + 1, occurredAt: now().toISOString(), reason: "not_found" }));
    const completed = { ...scope, refreshId: command.refreshId, batchId: command.batchId, eventId: randomUUID(),
      sequence: index * 65 + 65, occurredAt: now().toISOString(), targetFixtureIds: command.targetFixtureIds };
    // Recreate the deployed v2 boundary: every event handed off, API result ACKs still delayed.
    return { command, terminal: { events, completed }, handedOff: true, handedOffEventIds: events.map((event) => event.eventId),
      acknowledged: false, acknowledgedEventIds: [] };
  });
  await writeJsonAtomic(`${file}.manifest.json`, { version: 1, scope });
  await writeJsonAtomic(file, { version: 2, scope, sequence: 300, records });
  const originalBytes = Buffer.byteLength(await readFile(file, "utf8"));
  const journal = new MonitoringRefreshJournal(file, scope, { now });
  await journal.initialize();
  // Counters deliberately retain no calls/results: a spy would keep 300 full cloned snapshots
  // alive and turn this CPU regression into an artificial multi-gigabyte test memory leak.
  let pendingCalls = 0, cloneCalls = 0;
  const pending = journal.pending.bind(journal), clone = globalThis.structuredClone;
  journal.pending = () => { pendingCalls++; return pending(); };
  globalThis.structuredClone = ((...args: Parameters<typeof structuredClone>) => { cloneCalls++; return clone(...args); }) as typeof structuredClone;
  const publisher = new MonitoringRefreshEventPublisher(journal, new StateEventOutbox(join(directory, "outbox.json"), scope), { retryMs: 60_000 });
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 0);
  const start = performance.now();
  let completionAttempts = 0;
  try {
    await publisher.connect(async () => { completionAttempts++; });
    const elapsedMs = performance.now() - start;
    console.info(JSON.stringify({ batches: 300, targets: 64, originalBytes, elapsedMs, pendingCalls,
      cloneCalls, timerProgressed: ticked }));
    expect(pendingCalls).toBe(0);
    expect(cloneCalls).toBe(0);
    expect(ticked).toBe(true);
    expect(completionAttempts).toBe(0);
    // The structural assertions catch the regression independently of machine speed. This generous
    // ceiling catches multi-second blocking without making normal CI scheduling the correctness oracle.
    expect(elapsedMs).toBeLessThan(5000);
    await publisher.wake();
    expect(pendingCalls).toBe(0); expect(cloneCalls).toBe(0);
    expect(completionAttempts).toBe(0);
  } finally {
    clearTimeout(timer); await publisher.stopAndDrain(); journal.pending = pending; globalThis.structuredClone = clone;
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
