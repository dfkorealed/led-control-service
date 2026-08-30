import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicJsonCommitUncertainError, writeJsonAtomic } from "../mesh/mesh-store-file";
import {
  StorageHeadroomManager,
  type StorageHeadroomBackgroundTask
} from "../storage/storage-headroom-manager";
import {
  AutomationStateCommitUncertainError,
  FileAutomationStateStore,
  emptyAutomationState,
  type PersistedAutomationStateV4
} from "./automation-state-store";
import { automationTelemetryRecordsHash } from "./automation-telemetry-handoff";
import { AutomationTelemetryGapJournal } from "./automation-telemetry-gap-journal";

const directories: string[] = [];
const fixtureId = "00000000-0000-4000-8000-000000000101";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileAutomationStateStore", () => {
  it("atomically persists source pre-state and desired suppression across restart", async () => {
    const path = await statePath();
    const store = new FileAutomationStateStore(path);
    await store.initialize();

    await store.update((state) => ({
      ...state,
      activeOccurrences: {
        "schedule-1": {
          key: "schedule-1:2026-08-30",
          startedAt: "2026-08-30T01:00:00.000Z",
          endsAt: "2026-08-30T02:00:00.000Z",
          preBrightness: { [fixtureId]: 20 }
        }
      },
      baseBrightnessByFixture: { [fixtureId]: 20 },
      lastDesiredByFixture: { [fixtureId]: 40 }
    }));

    const restarted = new FileAutomationStateStore(path);
    await expect(restarted.initialize()).resolves.toMatchObject({
      schemaVersion: 4,
      activeOccurrences: {
        "schedule-1": {
          key: "schedule-1:2026-08-30",
          preBrightness: { [fixtureId]: 20 }
        }
      },
      baseBrightnessByFixture: { [fixtureId]: 20 },
      lastDesiredByFixture: { [fixtureId]: 40 }
    });
  });

  it("migrates Task 12 v1 lastDesired into observation-required state instead of completion evidence", async () => {
    const path = await statePath();
    await writeJsonAtomic(path, {
      schemaVersion: 1,
      activeOccurrences: {},
      manualOverrides: {},
      vehicleRules: {},
      currentByFixture: { [fixtureId]: 20 },
      baseBrightnessByFixture: {},
      lastDesiredByFixture: { [fixtureId]: 20 }
    });

    await expect(new FileAutomationStateStore(path).initialize()).resolves.toEqual({
      ...emptyAutomationState(),
      currentByFixture: { [fixtureId]: 20 },
      unverifiedDesiredByFixture: { [fixtureId]: 20 }
    });
  });

  it("requires observation for a v2 desired without successful terminal evidence", async () => {
    const path = await statePath();
    const v2 = {
      schemaVersion: 2,
      activeOccurrences: {},
      manualOverrides: {},
      vehicleRules: {},
      currentByFixture: { [fixtureId]: 20 },
      baseBrightnessByFixture: {},
      lastDesiredByFixture: { [fixtureId]: 40 },
      transitionsByFixture: {},
      telemetryGap: null
    };
    await writeJsonAtomic(path, v2);

    await expect(new FileAutomationStateStore(path).initialize()).resolves.toEqual({
      ...emptyAutomationState(),
      currentByFixture: { [fixtureId]: 20 },
      unverifiedDesiredByFixture: { [fixtureId]: 40 }
    });
  });

  it("fails closed instead of replacing a corrupt durable state", async () => {
    const path = await statePath();
    await writeFile(path, JSON.stringify({ schemaVersion: 1, activeOccurrences: [] }), "utf8");

    const store = new FileAutomationStateStore(path);

    await expect(store.initialize()).rejects.toMatchObject({ code: "automation_state_corrupt" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schemaVersion: 1, activeOccurrences: [] });
  });

  it("rejects unknown persisted fields instead of silently discarding a newer schema", async () => {
    const path = await statePath();
    await writeJsonAtomic(path, { ...emptyAutomationState(), futureSourceState: {} });

    await expect(new FileAutomationStateStore(path).initialize()).rejects.toMatchObject({
      code: "automation_state_corrupt"
    });
  });

  it("restores the previous visible state and reports commit uncertainty before memory can advance", async () => {
    const path = await statePath();
    const initial = emptyAutomationState();
    initial.currentByFixture[fixtureId] = 20;
    await writeJsonAtomic(path, initial);
    let writes = 0;
    const store = new FileAutomationStateStore(path, async (target, value) => {
      writes += 1;
      if (writes === 1) {
        await writeJsonAtomic(target, value, {
          syncParentDirectory: async () => { throw new Error("injected parent fsync failure"); }
        });
        return;
      }
      await writeJsonAtomic(target, value);
    });
    await store.initialize();

    await expect(store.update((state) => ({
      ...state,
      lastDesiredByFixture: { [fixtureId]: 80 }
    }))).rejects.toBeInstanceOf(AutomationStateCommitUncertainError);

    expect(store.read()).toEqual(initial);
    await expect(new FileAutomationStateStore(path).initialize()).resolves.toEqual(initial);
  });

  it("commits in memory after exhausted ENOSPC, journals only the exact new handoff, and later reconciles durability", async () => {
    const path = await statePath();
    const initial = emptyAutomationState();
    initial.currentByFixture[fixtureId] = 20;
    await writeJsonAtomic(path, initial);
    const journal = new AutomationTelemetryGapJournal(`${path}.gap`, () => "33333333-3333-4333-8333-333333333333");
    await journal.initialize();
    const headroom = new StorageHeadroomManager(`${path}.reserve`, 8_192, {
      preallocate: async (_target, bytes) => bytes,
      release: async () => undefined,
      scheduleBackground: () => 1,
      cancelBackground: () => undefined
    });
    await headroom.initialize();
    let diskFull = true;
    let writes = 0;
    const durability: string[] = [];
    const store = new FileAutomationStateStore(
      path,
      async (target, value) => {
        writes += 1;
        if (diskFull) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        await writeJsonAtomic(target, value);
      },
      () => "11111111-1111-4111-8111-111111111111",
      {
        headroom,
        gapJournal: journal,
        onDurabilityChange: (mode) => { durability.push(mode); }
      }
    );
    await store.initialize();
    const records = [
      {
        revision: 7,
        ruleId: "22222222-2222-4222-8222-222222222222",
        occurrenceKey: "occurrence-1",
        kind: "event_started" as const,
        occurredAt: "2026-08-30T01:00:00.000Z",
        payload: { targetFixtureIds: [fixtureId] }
      },
      {
        revision: 7,
        ruleId: "22222222-2222-4222-8222-222222222222",
        occurrenceKey: "occurrence-1",
        kind: "action_result" as const,
        occurredAt: "2026-08-30T01:00:01.000Z",
        payload: { results: [] }
      }
    ];
    const handoff = store.createTelemetryHandoff(records)!;

    await expect(store.update((state) => {
      state.currentByFixture[fixtureId] = 40;
      state.pendingTelemetryHandoffs.push(handoff);
      return state;
    })).resolves.toMatchObject({ currentByFixture: { [fixtureId]: 40 }, pendingTelemetryHandoffs: [] });

    expect(writes).toBe(2);
    expect(store.durability()).toEqual({ mode: "degraded", reason: "ENOSPC" });
    await expect(journal.read()).resolves.toMatchObject({
      lastSourceHandoffId: handoff.handoffId,
      lastSourceRecordsHash: handoff.recordsHash,
      lastSourceDroppedCount: 2,
      droppedCount: 2,
      provenance: "automation_state_storage"
    });
    expect((await new FileAutomationStateStore(path).initialize()).currentByFixture[fixtureId]).toBe(20);

    diskFull = false;
    await store.update((state) => state);

    expect(store.durability()).toEqual({ mode: "ready", reason: null });
    expect(durability).toEqual(["degraded", "ready"]);
    await expect(new FileAutomationStateStore(path).initialize()).resolves.toMatchObject({
      currentByFixture: { [fixtureId]: 40 },
      pendingTelemetryHandoffs: []
    });
    headroom.stop();
  });

  it("reconciles a rename-visible target and preserves typed uncertainty when headroom rollback and replenish fail", async () => {
    const path = await statePath();
    const initial = emptyAutomationState();
    initial.currentByFixture[fixtureId] = 20;
    await writeJsonAtomic(path, initial);
    const tasks: StorageHeadroomBackgroundTask[] = [];
    let allocations = 0;
    const headroom = new StorageHeadroomManager(`${path}.reserve`, 8_192, {
      preallocate: async (_target, bytes) => {
        allocations += 1;
        if (allocations > 1) throw Object.assign(new Error("replenish full"), { code: "ENOSPC" });
        return bytes;
      },
      release: async () => undefined,
      getFreeBytes: async () => 32_768,
      scheduleBackground: (task) => { tasks.push(task); return tasks.length; },
      cancelBackground: () => undefined
    });
    await headroom.initialize();
    let writes = 0;
    const store = new FileAutomationStateStore(path, async (target, value) => {
      writes += 1;
      if (writes !== 2) {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      await writeJsonAtomic(target, value, {
        syncParentDirectory: async () => { throw new Error("injected directory fsync failure"); }
      });
    }, undefined, { headroom });
    await store.initialize();

    const error = await store.update((state) => ({
      ...state,
      lastDesiredByFixture: { [fixtureId]: 80 }
    })).catch((caught) => caught);
    await expect(tasks[0]!()).resolves.toBeUndefined();

    expect(error).toBeInstanceOf(AutomationStateCommitUncertainError);
    expect(error.cause).toBeInstanceOf(AtomicJsonCommitUncertainError);
    expect(store.read().lastDesiredByFixture[fixtureId]).toBe(80);
    expect(store.durability()).toEqual({ mode: "degraded", reason: "atomic_json_commit_uncertain" });
    await expect(new FileAutomationStateStore(path).initialize()).resolves.toMatchObject({
      lastDesiredByFixture: { [fixtureId]: 80 }
    });
    headroom.stop();
  });

  it("returns defensive snapshots so callers cannot bypass durable updates", async () => {
    const path = await statePath();
    const store = new FileAutomationStateStore(path);
    await store.initialize();

    const leaked = store.read() as PersistedAutomationStateV4;
    leaked.lastDesiredByFixture[fixtureId] = 99;

    expect(store.read().lastDesiredByFixture).toEqual({});
  });

  it("durably merges dropped terminal telemetry into one bounded gap", async () => {
    const path = await statePath();
    const store = new FileAutomationStateStore(path);
    await store.initialize();

    await store.recordTelemetryGap("2026-08-30T01:00:02.000Z", 2);
    await store.recordTelemetryGap("2026-08-30T01:00:01.000Z", 3);

    await expect(new FileAutomationStateStore(path).initialize()).resolves.toMatchObject({
      schemaVersion: 4,
      telemetryGap: {
        firstDroppedAt: "2026-08-30T01:00:01.000Z",
        lastDroppedAt: "2026-08-30T01:00:02.000Z",
        droppedCount: 5
      }
    });
  });

  it("clears a handed-off telemetry gap only when no newer drop was merged", async () => {
    const path = await statePath();
    const store = new FileAutomationStateStore(path);
    await store.initialize();
    await store.recordTelemetryGap("2026-08-30T01:00:00.000Z", 2);
    const handedOff = store.read().telemetryGap!;
    await store.recordTelemetryGap("2026-08-30T01:01:00.000Z", 1);

    await expect(store.clearTelemetryGap(handedOff)).resolves.toBe(false);
    expect(store.read().telemetryGap?.droppedCount).toBe(3);

    await expect(store.clearTelemetryGap(store.read().telemetryGap!)).resolves.toBe(true);
    expect(store.read().telemetryGap).toBeNull();
  });

  it("restores schema v4 pending telemetry handoffs with exact identity and records", async () => {
    const path = await statePath();
    const records = [{
      revision: 7,
      ruleId: "22222222-2222-4222-8222-222222222222",
      occurrenceKey: "occurrence-1",
      kind: "event_started" as const,
      occurredAt: "2026-08-30T01:00:00.000Z",
      payload: { targetFixtureIds: [fixtureId] }
    }];
    const handoff = {
      handoffId: "11111111-1111-4111-8111-111111111111",
      recordsHash: automationTelemetryRecordsHash(records),
      records
    };
    await writeJsonAtomic(path, {
      ...emptyAutomationState(),
      schemaVersion: 4,
      pendingTelemetryHandoffs: [handoff]
    });

    const store = new FileAutomationStateStore(path);
    await expect(store.initialize()).resolves.toMatchObject({
      schemaVersion: 4,
      pendingTelemetryHandoffs: [handoff]
    });
    await expect(store.completeTelemetryHandoff(handoff.handoffId, handoff.recordsHash)).resolves.toBe(true);
    expect(store.read().pendingTelemetryHandoffs).toEqual([]);
  });

  it("migrates a v3 telemetry gap to stable handoff identity and provenance across restarts", async () => {
    const path = await statePath();
    await writeJsonAtomic(path, {
      schemaVersion: 3,
      activeOccurrences: {},
      manualOverrides: {},
      vehicleRules: {},
      currentByFixture: {},
      baseBrightnessByFixture: {},
      lastDesiredByFixture: {},
      unverifiedDesiredByFixture: {},
      transitionsByFixture: {},
      telemetryGap: {
        firstDroppedAt: "2026-08-30T01:00:00.000Z",
        lastDroppedAt: "2026-08-30T01:00:03.000Z",
        droppedCount: 4
      }
    });

    const first = await new FileAutomationStateStore(path).initialize();
    const second = await new FileAutomationStateStore(path).initialize();

    expect(first.telemetryGap).toMatchObject({
      handoffId: expect.stringMatching(/^legacy-gap-/),
      provenance: "fixture_state_outbox",
      droppedCount: 4
    });
    expect(second.telemetryGap?.handoffId).toBe(first.telemetryGap?.handoffId);
  });
});

async function statePath() {
  const directory = await mkdtemp(join(tmpdir(), "automation-state-"));
  directories.push(directory);
  return join(directory, "state.json");
}
