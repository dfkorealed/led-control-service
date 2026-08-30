import { createHash } from "node:crypto";
import { rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicJsonCommitUncertainError, writeJsonAtomic } from "../mesh/mesh-store-file";
import {
  StorageHeadroomManager,
  type StorageHeadroomBackgroundTask
} from "../storage/storage-headroom-manager";
import { automationTelemetryRecordsHash } from "./automation-telemetry-handoff";
import {
  AutomationTelemetryGapJournal,
  type AutomationTelemetryGapJournalLike
} from "./automation-telemetry-gap-journal";
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

  it("restores a checksummed pre-round-4 journal block without cumulative source fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-legacy-gap-journal-"));
    directories.push(directory);
    const path = join(directory, "gap.bin");
    const legacyWithoutHash = {
      version: 1 as const,
      generation: 1,
      gapHandoffId: "44444444-4444-4444-8444-444444444444",
      revision: 7,
      firstDroppedAt: "2026-08-30T01:00:00.000Z",
      lastDroppedAt: "2026-08-30T01:00:02.000Z",
      droppedCount: 3,
      lastSourceHandoffId: "55555555-5555-4555-8555-555555555555",
      lastSourceRecordsHash: `sha256:${"e".repeat(64)}`,
      lastSourceDroppedCount: 3,
      provenance: "automation_state_storage" as const
    };
    const state = {
      ...legacyWithoutHash,
      gapRecordsHash: `sha256:${createHash("sha256")
        .update(JSON.stringify(legacyWithoutHash))
        .digest("hex")}`
    };
    await writeFile(path, legacyGapJournalFile(state));

    await expect(new AutomationTelemetryGapJournal(path).read()).resolves.toMatchObject({
      ...state,
      cumulativeSourceHandoffId: null,
      cumulativeSourceRecordsHash: null,
      cumulativeSourceDroppedCount: 0,
      cumulativeSourceProvenance: null,
      acceptedBaselineDroppedCount: 0,
      acceptedBaselineHandoffId: null,
      acceptedBaselineRecordsHash: null
    });
  });

  it("does not recount an imported general source after journal clear failure replaces its metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-gap-baseline-"));
    directories.push(directory);
    const path = join(directory, "outbox.json");
    const journalPath = `${path}.gap`;
    const journal = new AutomationTelemetryGapJournal(journalPath);
    let failClear = true;
    const fallibleJournal: AutomationTelemetryGapJournalLike = {
      initialize: () => journal.initialize(),
      read: () => journal.read(),
      record: (input) => journal.record(input),
      commitAcceptedBaseline: (baseline) => journal.commitAcceptedBaseline(baseline),
      clear: (handoffId, recordsHash) => failClear
        ? Promise.reject(new Error("injected journal clear failure"))
        : journal.clear(handoffId, recordsHash)
    };
    const outbox = new AutomationTelemetryOutbox(path, automationScope, {
      headroomBytes: 32_768,
      gapJournal: fallibleJournal
    });
    await outbox.initialize();
    await journal.record(gapInput("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "c", 5, "fixture_state_outbox"));
    await journal.record(gapInput("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a", 1));

    await expect(outbox.recoverGapJournal()).rejects.toThrow("injected journal clear failure");
    const accepted = (await outbox.inspect()).gap!;
    expect(accepted.droppedCount).toBe(6);
    await expect(journal.read()).resolves.toMatchObject({
      droppedCount: 6,
      acceptedBaselineDroppedCount: 6,
      acceptedBaselineHandoffId: expect.any(String),
      acceptedBaselineRecordsHash: expect.stringMatching(/^sha256:/)
    });

    await journal.record(gapInput("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "b", 1));
    failClear = false;
    const restarted = new AutomationTelemetryOutbox(path, automationScope, {
      headroomBytes: 32_768,
      gapJournal: new AutomationTelemetryGapJournal(journalPath)
    });
    await restarted.initialize();

    const pending = await restarted.pending();

    expect(pending).toHaveLength(1);
    expect(pending[0]!.event).toMatchObject({
      eventId: accepted.eventId,
      sequence: accepted.sequence,
      kind: "telemetry_gap",
      payload: { droppedCount: 7 }
    });
  });

  it.each(["previous", "next"] as const)(
    "converges after an accepted-baseline commit uncertainty with the %s journal block visible",
    async (visibility) => {
      const test = await uncertainGapImportFixture("baseline", visibility);

      await expect(test.outbox.recoverGapJournal()).rejects.toThrow("injected baseline uncertainty");
      const accepted = (await test.outbox.inspect()).gap!;
      expect(accepted.droppedCount).toBe(6);
      const postCrashJournal = new AutomationTelemetryGapJournal(test.journalPath);
      await postCrashJournal.record(gapInput("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "b", 1));

      const restarted = new AutomationTelemetryOutbox(test.path, automationScope, {
        headroomBytes: 32_768,
        gapJournal: new AutomationTelemetryGapJournal(test.journalPath)
      });
      await restarted.initialize();
      const pending = await restarted.pending();

      expect(pending).toHaveLength(1);
      expect(pending[0]!.event).toMatchObject({
        eventId: accepted.eventId,
        sequence: accepted.sequence,
        payload: { droppedCount: 7 }
      });
      const finalIdentity = telemetryIdentity(pending[0]!);
      const restartedAgain = new AutomationTelemetryOutbox(test.path, automationScope, {
        headroomBytes: 32_768,
        gapJournal: new AutomationTelemetryGapJournal(test.journalPath)
      });
      await restartedAgain.initialize();
      expect((await restartedAgain.pending()).map(telemetryIdentity)).toEqual([finalIdentity]);
    }
  );

  it.each(["previous", "next"] as const)(
    "converges after a clear commit uncertainty with the %s journal block visible",
    async (visibility) => {
      const test = await uncertainGapImportFixture("clear", visibility);

      await expect(test.outbox.recoverGapJournal()).rejects.toThrow("injected clear uncertainty");
      const accepted = (await test.outbox.inspect()).gap!;
      expect(accepted.droppedCount).toBe(6);
      const postCrashJournal = new AutomationTelemetryGapJournal(test.journalPath);
      await postCrashJournal.record(gapInput("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "b", 1));

      const restarted = new AutomationTelemetryOutbox(test.path, automationScope, {
        headroomBytes: 32_768,
        gapJournal: new AutomationTelemetryGapJournal(test.journalPath)
      });
      await restarted.initialize();
      const pending = await restarted.pending();

      expect(pending).toHaveLength(1);
      expect(pending[0]!.event).toMatchObject({
        eventId: accepted.eventId,
        sequence: accepted.sequence,
        payload: { droppedCount: 7 }
      });
      const finalIdentity = telemetryIdentity(pending[0]!);
      const restartedAgain = new AutomationTelemetryOutbox(test.path, automationScope, {
        headroomBytes: 32_768,
        gapJournal: new AutomationTelemetryGapJournal(test.journalPath)
      });
      await restartedAgain.initialize();
      expect((await restartedAgain.pending()).map(telemetryIdentity)).toEqual([finalIdentity]);
    }
  );

  it("bounds accepted receipts across 100 clear failures and converges when clear recovers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-gap-replacement-"));
    directories.push(directory);
    const path = join(directory, "outbox.json");
    const journalPath = `${path}.gap`;
    const journal = new AutomationTelemetryGapJournal(journalPath);
    let failClear = true;
    const fallibleJournal: AutomationTelemetryGapJournalLike = {
      initialize: () => journal.initialize(),
      read: () => journal.read(),
      record: (input) => journal.record(input),
      commitAcceptedBaseline: (baseline) => journal.commitAcceptedBaseline(baseline),
      clear: (handoffId, recordsHash) => failClear
        ? Promise.reject(new Error("injected repeated clear failure"))
        : journal.clear(handoffId, recordsHash)
    };
    const outbox = new AutomationTelemetryOutbox(path, automationScope, {
      headroomBytes: 32_768,
      gapJournal: fallibleJournal
    });
    await outbox.initialize();
    const before = await stat(journalPath);
    let firstEventId: string | undefined;
    let maxAcceptedReceipts = 0;

    for (let index = 0; index < 100; index += 1) {
      const hashCharacter = "0123456789abcdef"[index % 16]!;
      await journal.record(gapInput(`general-source-${index}`, hashCharacter, 1));
      await expect(outbox.recoverGapJournal()).rejects.toThrow("injected repeated clear failure");
      const snapshot = await outbox.inspect();
      firstEventId ??= snapshot.gap!.eventId;
      maxAcceptedReceipts = Math.max(
        maxAcceptedReceipts,
        Object.keys(snapshot.acceptedHandoffs).length
      );
    }

    const after = await stat(journalPath);
    expect(after).toMatchObject({
      size: AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES,
      ino: before.ino,
      blocks: before.blocks
    });
    await expect(journal.read()).resolves.toMatchObject({
      droppedCount: 100,
      acceptedBaselineDroppedCount: 100,
      lastSourceHandoffId: "general-source-99"
    });
    expect(maxAcceptedReceipts).toBeLessThanOrEqual(2);

    failClear = false;
    const pending = await outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.event).toMatchObject({
      eventId: firstEventId,
      payload: { droppedCount: 100 }
    });
  });

  it("keeps receipts bounded and the total exact across a midpoint restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-gap-restart-bound-"));
    directories.push(directory);
    const path = join(directory, "outbox.json");
    const journalPath = `${path}.gap`;
    let failClear = true;
    let journal = new AutomationTelemetryGapJournal(journalPath);
    let outbox = new AutomationTelemetryOutbox(path, automationScope, {
      headroomBytes: 32_768,
      gapJournal: controlledClearJournal(journal, () => failClear)
    });
    await outbox.initialize();
    let firstGap: Awaited<ReturnType<AutomationTelemetryOutbox["inspect"]>>["gap"] | undefined;

    for (let index = 0; index < 50; index += 1) {
      const hashCharacter = "0123456789abcdef"[index % 16]!;
      await journal.record(gapInput(`restart-source-${index}`, hashCharacter, 1));
      await expect(outbox.recoverGapJournal()).rejects.toThrow("injected clear failure");
      firstGap ??= (await outbox.inspect()).gap;
    }

    journal = new AutomationTelemetryGapJournal(journalPath);
    outbox = new AutomationTelemetryOutbox(path, automationScope, {
      headroomBytes: 32_768,
      gapJournal: controlledClearJournal(journal, () => failClear)
    });
    await outbox.initialize();
    for (let index = 50; index < 100; index += 1) {
      const hashCharacter = "0123456789abcdef"[index % 16]!;
      await journal.record(gapInput(`restart-source-${index}`, hashCharacter, 1));
      await expect(outbox.recoverGapJournal()).rejects.toThrow("injected clear failure");
    }

    const beforeRecovery = await outbox.inspect();
    expect(Object.keys(beforeRecovery.acceptedHandoffs)).toHaveLength(2);
    expect(beforeRecovery.gap).toMatchObject({
      eventId: firstGap!.eventId,
      sequence: firstGap!.sequence,
      droppedCount: 100
    });

    failClear = false;
    const pending = await outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.event).toMatchObject({
      eventId: firstGap!.eventId,
      sequence: firstGap!.sequence,
      payload: { droppedCount: 100 }
    });
    const finalIdentity = telemetryIdentity(pending[0]!);

    const restarted = new AutomationTelemetryOutbox(path, automationScope, {
      headroomBytes: 32_768,
      gapJournal: new AutomationTelemetryGapJournal(journalPath)
    });
    await restarted.initialize();
    expect((await restarted.pending()).map(telemetryIdentity)).toEqual([finalIdentity]);
  });

  it("retires only displaced general receipts while protecting active recovery identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-gap-protected-receipts-"));
    directories.push(directory);
    const path = join(directory, "outbox.json");
    const journal = new AutomationTelemetryGapJournal(`${path}.gap`);
    const outbox = new AutomationTelemetryOutbox(path, automationScope, {
      headroomBytes: 32_768,
      gapJournal: controlledClearJournal(journal, () => true)
    });
    const cumulativeSource = "cumulative-source";
    const pendingSource = "pending-source";
    const displacedSource = "displaced-source";
    const currentSource = "current-source";
    await outbox.initialize();
    await journal.record(gapInput(cumulativeSource, "c", 5, "fixture_state_outbox"));
    await journal.record(gapInput(pendingSource, "a", 1));
    await expect(outbox.recoverGapJournal([pendingSource])).rejects.toThrow("injected clear failure");
    const aggregateSource = (await journal.read())!.gapHandoffId;

    await journal.record(gapInput(displacedSource, "d", 1));
    await expect(outbox.recoverGapJournal([pendingSource])).rejects.toThrow("injected clear failure");
    await journal.record(gapInput(currentSource, "e", 1));
    await expect(outbox.recoverGapJournal([pendingSource])).rejects.toThrow("injected clear failure");

    const receipts = (await outbox.inspect()).acceptedHandoffs;
    expect(Object.keys(receipts).sort()).toEqual([
      aggregateSource,
      cumulativeSource,
      currentSource,
      pendingSource
    ].sort());
    expect(receipts[displacedSource]).toBeUndefined();
  });

  it.each(["definite", "previous", "next"] as const)(
    "recovers exact cleanup after a %s outbox commit failure",
    async (visibility) => {
      const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-gap-cleanup-commit-"));
      directories.push(directory);
      const path = join(directory, "outbox.json");
      const journalPath = `${path}.gap`;
      let failClear = true;
      const journal = new AutomationTelemetryGapJournal(journalPath);
      const initial = new AutomationTelemetryOutbox(path, automationScope, {
        headroomBytes: 32_768,
        gapJournal: controlledClearJournal(journal, () => failClear)
      });
      await initial.initialize();
      await journal.record(gapInput("cleanup-source-a", "a", 1));
      await expect(initial.recoverGapJournal()).rejects.toThrow("injected clear failure");
      const firstGap = (await initial.inspect()).gap!;
      await journal.record(gapInput("cleanup-source-b", "b", 1));

      let injected = false;
      const interrupted = new AutomationTelemetryOutbox(path, automationScope, {
        headroomBytes: 32_768,
        gapJournal: controlledClearJournal(journal, () => failClear),
        write: async (target, value) => {
          if (injected) return writeJsonAtomic(target, value);
          injected = true;
          if (visibility === "definite") throw new Error("injected cleanup failure");
          if (visibility === "next") await writeJsonAtomic(target, value);
          throw new AtomicJsonCommitUncertainError(target);
        }
      });
      await interrupted.initialize();

      await expect(interrupted.recoverGapJournal()).rejects.toThrow(
        visibility === "definite"
          ? "automation_telemetry_store_failed"
          : "automation_telemetry_commit_uncertain"
      );

      const restartedJournal = new AutomationTelemetryGapJournal(journalPath);
      const restarted = new AutomationTelemetryOutbox(path, automationScope, {
        headroomBytes: 32_768,
        gapJournal: controlledClearJournal(restartedJournal, () => failClear)
      });
      await restarted.initialize();
      await expect(restarted.recoverGapJournal()).rejects.toThrow("injected clear failure");
      const recovered = await restarted.inspect();
      expect(Object.keys(recovered.acceptedHandoffs)).toHaveLength(2);
      expect(recovered.gap).toMatchObject({
        eventId: firstGap.eventId,
        sequence: firstGap.sequence,
        droppedCount: 2
      });

      failClear = false;
      const pending = await restarted.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.event).toMatchObject({
        eventId: firstGap.eventId,
        sequence: firstGap.sequence,
        payload: { droppedCount: 2 }
      });
      const finalIdentity = telemetryIdentity(pending[0]!);
      const restartedAgain = new AutomationTelemetryOutbox(path, automationScope, {
        headroomBytes: 32_768,
        gapJournal: new AutomationTelemetryGapJournal(journalPath)
      });
      await restartedAgain.initialize();
      expect((await restartedAgain.pending()).map(telemetryIdentity)).toEqual([finalIdentity]);
    }
  );

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

function legacyGapJournalFile(state: object) {
  const blockBytes = AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES / 2;
  const magic = Buffer.from("ATGAP001", "ascii");
  const headerBytes = magic.length + 8 + 4 + 32;
  const payload = Buffer.from(JSON.stringify(state), "utf8");
  const file = Buffer.alloc(AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES);
  const block = file.subarray(0, blockBytes);

  magic.copy(block, 0);
  block.writeBigUInt64BE(1n, magic.length);
  block.writeUInt32BE(payload.length, magic.length + 8);
  createHash("sha256")
    .update(block.subarray(magic.length, magic.length + 8))
    .update(payload)
    .digest()
    .copy(block, magic.length + 12);
  payload.copy(block, headerBytes);
  return file;
}

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

async function uncertainGapImportFixture(
  stage: "baseline" | "clear",
  visibility: "previous" | "next"
) {
  const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-gap-uncertainty-"));
  directories.push(directory);
  const path = join(directory, "outbox.json");
  const journalPath = `${path}.gap`;
  const journal = new AutomationTelemetryGapJournal(journalPath);
  let injected = false;
  const uncertainJournal: AutomationTelemetryGapJournalLike = {
    initialize: () => journal.initialize(),
    read: () => journal.read(),
    record: (input) => journal.record(input),
    commitAcceptedBaseline: async (baseline) => {
      if (stage !== "baseline" || injected) return journal.commitAcceptedBaseline(baseline);
      injected = true;
      if (visibility === "next") await journal.commitAcceptedBaseline(baseline);
      throw new Error("injected baseline uncertainty");
    },
    clear: async (handoffId, recordsHash) => {
      if (stage !== "clear" || injected) return journal.clear(handoffId, recordsHash);
      injected = true;
      if (visibility === "next") await journal.clear(handoffId, recordsHash);
      throw new Error("injected clear uncertainty");
    }
  };
  const outbox = new AutomationTelemetryOutbox(path, automationScope, {
    headroomBytes: 32_768,
    gapJournal: uncertainJournal
  });
  await outbox.initialize();
  await journal.record(gapInput("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "c", 5, "fixture_state_outbox"));
  await journal.record(gapInput("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a", 1));
  return { path, journalPath, journal, outbox };
}

function controlledClearJournal(
  journal: AutomationTelemetryGapJournal,
  shouldFail: () => boolean
): AutomationTelemetryGapJournalLike {
  return {
    initialize: () => journal.initialize(),
    read: () => journal.read(),
    record: (input) => journal.record(input),
    commitAcceptedBaseline: (baseline) => journal.commitAcceptedBaseline(baseline),
    clear: (handoffId, recordsHash) => shouldFail()
      ? Promise.reject(new Error("injected clear failure"))
      : journal.clear(handoffId, recordsHash)
  };
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

function gapInput(
  handoffId: string,
  hashCharacter: string,
  droppedCount: number,
  provenance: "automation_state_storage" | "fixture_state_outbox" = "automation_state_storage"
) {
  return {
    handoffId,
    recordsHash: `sha256:${hashCharacter.repeat(64)}`,
    provenance,
    revision: 7,
    firstDroppedAt: "2026-08-30T01:00:00.000Z",
    lastDroppedAt: "2026-08-30T01:00:00.000Z",
    droppedCount
  } as const;
}

function telemetryIdentity(record: Awaited<ReturnType<AutomationTelemetryOutbox["pending"]>>[number]) {
  return {
    eventId: record.event.eventId,
    sequence: record.event.sequence,
    reportPayloadHash: record.reportPayloadHash
  };
}

function mqttClient() {
  return {
    publish: vi.fn((_topic: string, _payload: string, _options: { qos: 1 }, callback: (error?: Error) => void) => {
      callback();
      return undefined as never;
    })
  };
}
