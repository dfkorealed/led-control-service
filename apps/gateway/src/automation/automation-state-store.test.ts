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
  parseAutomationState,
  type PersistedAutomationStateV4
} from "./automation-state-store";
import { automationTelemetryRecordsHash } from "./automation-telemetry-handoff";
import { AutomationTelemetryGapJournal } from "./automation-telemetry-gap-journal";

const directories: string[] = [];
const fixtureId = "00000000-0000-4000-8000-000000000101";
const commandId = "00000000-0000-4000-8000-000000000201";
const scheduleId = "00000000-0000-4000-8000-000000000301";
const ruleId = "00000000-0000-4000-8000-000000000401";
const requestedAt = "2026-09-01T01:00:00.000Z";
const appliedAt = "2026-09-01T01:00:01.000Z";

function manualV6State() {
  return {
    ...emptyAutomationState(),
    schemaVersion: 6,
    pendingManualControls: {
      [fixtureId]: { sourceId: commandId, brightnessPercent: 60, requestedAt, preBrightness: 30 }
    },
    manualAutomationSuppressions: {
      [fixtureId]: {
        sourceId: commandId, appliedAt,
        schedules: [{ scheduleId, occurrenceKey: "2026-09-01" }],
        vehicleEvents: [{ ruleId, startedAt: requestedAt }]
      }
    }
  };
}

function legacyV5State() {
  return {
    schemaVersion: 5,
    activeOccurrences: {}, manualOverrides: {}, vehicleRules: {},
    currentByFixture: {}, baseBrightnessByFixture: {}, lastDesiredByFixture: {},
    unverifiedDesiredByFixture: {}, transitionsByFixture: {}, telemetryGap: null,
    pendingTelemetryHandoffs: [], vehicleSensorInbox: []
  };
}

describe("V6 automation state", () => {
  it("round-trips pending controls and exact source suppressions through durable storage", async () => {
    const state = manualV6State();
    expect(parseAutomationState(state)).toEqual(state);
    const path = await statePath();
    await writeJsonAtomic(path, state);
    expect(await new FileAutomationStateStore(path).initialize()).toEqual(state);
    expect(emptyAutomationState()).toMatchObject({
      schemaVersion: 6, pendingManualControls: {}, manualAutomationSuppressions: {}
    });
    expect(emptyAutomationState()).not.toHaveProperty("manualOverrides");
  });

  it.each([
    ["unknown root field", (state: any) => { state.extra = true; }],
    ["legacy root field", (state: any) => { state.manualOverrides = {}; }],
    ["missing field", (state: any) => { delete state.pendingManualControls; }],
    ["unknown pending field", (state: any) => { state.pendingManualControls[fixtureId].extra = true; }],
    ["invalid fixture UUID", (state: any) => { state.pendingManualControls.bad = state.pendingManualControls[fixtureId]; }],
    ["invalid command UUID", (state: any) => { state.pendingManualControls[fixtureId].sourceId = "bad"; }],
    ["invalid pending timestamp", (state: any) => { state.pendingManualControls[fixtureId].requestedAt = "bad"; }],
    ["invalid brightness", (state: any) => { state.pendingManualControls[fixtureId].brightnessPercent = 101; }],
    ["invalid pre brightness", (state: any) => { state.pendingManualControls[fixtureId].preBrightness = -1; }],
    ["unknown suppression field", (state: any) => { state.manualAutomationSuppressions[fixtureId].extra = true; }],
    ["invalid suppression fixture UUID", (state: any) => { state.manualAutomationSuppressions.bad = state.manualAutomationSuppressions[fixtureId]; }],
    ["invalid suppression command UUID", (state: any) => { state.manualAutomationSuppressions[fixtureId].sourceId = "bad"; }],
    ["invalid applied timestamp", (state: any) => { state.manualAutomationSuppressions[fixtureId].appliedAt = "bad"; }],
    ["invalid schedule UUID", (state: any) => { state.manualAutomationSuppressions[fixtureId].schedules[0].scheduleId = "bad"; }],
    ["empty occurrence key", (state: any) => { state.manualAutomationSuppressions[fixtureId].schedules[0].occurrenceKey = ""; }],
    ["unknown schedule field", (state: any) => { state.manualAutomationSuppressions[fixtureId].schedules[0].extra = true; }],
    ["invalid rule UUID", (state: any) => { state.manualAutomationSuppressions[fixtureId].vehicleEvents[0].ruleId = "bad"; }],
    ["invalid event timestamp", (state: any) => { state.manualAutomationSuppressions[fixtureId].vehicleEvents[0].startedAt = "bad"; }],
    ["unknown event field", (state: any) => { state.manualAutomationSuppressions[fixtureId].vehicleEvents[0].extra = true; }],
    ["duplicate schedule", (state: any) => { state.manualAutomationSuppressions[fixtureId].schedules.push(state.manualAutomationSuppressions[fixtureId].schedules[0]); }],
    ["duplicate event", (state: any) => { state.manualAutomationSuppressions[fixtureId].vehicleEvents.push(state.manualAutomationSuppressions[fixtureId].vehicleEvents[0]); }],
    ["unsorted schedule identity", (state: any) => { state.manualAutomationSuppressions[fixtureId].schedules.push({ scheduleId, occurrenceKey: "2026-08-01" }); }],
    ["unsorted event identity", (state: any) => { state.manualAutomationSuppressions[fixtureId].vehicleEvents.push({ ruleId, startedAt: "2026-08-01T00:00:00.000Z" }); }]
  ])("rejects %s", (_name, mutate) => {
    const state = manualV6State();
    mutate(state);
    expect(() => parseAutomationState(state)).toThrow();
  });

  it("allows distinct occurrences of the same source when sorted", () => {
    const state = manualV6State();
    state.manualAutomationSuppressions[fixtureId]!.schedules.push({ scheduleId, occurrenceKey: "2026-09-02" });
    state.manualAutomationSuppressions[fixtureId]!.vehicleEvents.push({ ruleId, startedAt: appliedAt });
    expect(parseAutomationState(state)).toEqual(state);
  });

  it.each(["pendingManualControls", "manualAutomationSuppressions"] as const)("bounds %s to 10,000 fixtures", (field) => {
    const state = manualV6State();
    const entry = state[field][fixtureId];
    const fixtures = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, entry
    ]));
    expect(() => parseAutomationState({ ...state, [field]: fixtures })).not.toThrow();
    fixtures["00000000-0000-4000-8000-000000010000"] = entry;
    expect(() => parseAutomationState({ ...state, [field]: fixtures })).toThrow();
  });

  it("migrates only confirmed V5 controls, retaining pending without promoting provisional brightness", () => {
    const ids = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-00000000010${index}`);
    const [success, pending, failed, timedOut, observed, mismatch] = ids as [string, string, string, string, string, string];
    const manual = { sourceId: commandId, brightnessPercent: 60, startedAt: requestedAt,
      overrideUntil: appliedAt, preBrightness: 60 };
    const transition = { phase: "terminal", brightnessPercent: 60, sourceType: "manual_override",
      sourceId: commandId, occurrenceKey: null, attempt: 1, startedAt: requestedAt,
      status: "succeeded", terminalAt: appliedAt };
    const old = {
      ...legacyV5State(),
      manualOverrides: Object.fromEntries(ids.map((id) => [id, manual])),
      activeOccurrences: {
        [scheduleId]: { key: "2026-09-01", startedAt: requestedAt, endsAt: appliedAt,
          preBrightness: { [success]: 30, [observed]: 30 } }
      },
      vehicleRules: {
        [ruleId]: { activeSourceFixtureIds: [fixtureId], targetFixtureIds: [success, observed],
          brightnessPercent: 80, startedAt: requestedAt, holdUntil: null, preBrightness: {} }
      },
      currentByFixture: { [observed]: 60, [failed]: 60, [timedOut]: 60, [mismatch]: 20 },
      baseBrightnessByFixture: { [success]: 30, [observed]: 30, [mismatch]: 20 },
      transitionsByFixture: {
        [success]: transition,
        [pending]: { ...transition, phase: "pending", status: null, terminalAt: null },
        [failed]: { ...transition, status: "failed" },
        [timedOut]: { ...transition, status: "timed_out" }
      }
    };
    const result = parseAutomationState(old);
    expect(result.schemaVersion).toBe(6);
    expect(result.baseBrightnessByFixture).toEqual({ [success]: 60, [observed]: 60, [mismatch]: 20 });
    expect(result.pendingManualControls).toEqual({
      [pending]: { sourceId: commandId, brightnessPercent: 60, requestedAt, preBrightness: 60 }
    });
    const suppression = { sourceId: commandId, appliedAt,
      schedules: [{ scheduleId, occurrenceKey: "2026-09-01" }], vehicleEvents: [{ ruleId, startedAt: requestedAt }] };
    expect(result.manualAutomationSuppressions).toEqual({
      [success]: suppression, [observed]: { ...suppression, appliedAt: requestedAt }
    });
    expect(result).not.toHaveProperty("manualOverrides");
    expect(parseAutomationState(result)).toEqual(result);
  });

  it.each(["currentByFixture", "lastDesiredByFixture"])("accepts transition-free confirmed %s", (field) => {
    const result = parseAutomationState({
      ...legacyV5State(), [field]: { [fixtureId]: 60 },
      manualOverrides: { [fixtureId]: { sourceId: commandId, brightnessPercent: 60,
        startedAt: requestedAt, overrideUntil: appliedAt, preBrightness: 30 } }
    });
    expect(result.baseBrightnessByFixture).toEqual({ [fixtureId]: 60 });
    expect(result.manualAutomationSuppressions[fixtureId]).toEqual({
      sourceId: commandId, appliedAt: requestedAt, schedules: [], vehicleEvents: []
    });
  });

  it("validates discarded V5 entries and legacy root fields before migration", () => {
    expect(() => parseAutomationState({ ...legacyV5State(), extra: true })).toThrow();
    expect(() => parseAutomationState({ ...legacyV5State(), manualOverrides: {
      [fixtureId]: { sourceId: commandId, brightnessPercent: 60,
        startedAt: requestedAt, overrideUntil: requestedAt, preBrightness: 30 }
    } })).toThrow();
  });
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileAutomationStateStore", () => {
  it("keeps a durable current boot and bounded recent boot high-water across oscillation and restart", async () => {
    const path = await statePath();
    const store = new FileAutomationStateStore(path);
    await store.initialize();
    const mutate = (bootId: number, sequence: number) => store.updateVehicleSensorEvent(
      { sourceUnicast: 0x1201, bootId, sequence },
      (state) => {
        state.currentByFixture[fixtureId] = (state.currentByFixture[fixtureId] ?? 0) + 1;
        return state;
      }
    );

    await expect(mutate(7, 9)).resolves.toMatchObject({ applied: true });
    await expect(mutate(8, 1)).resolves.toMatchObject({ applied: true });
    await expect(mutate(7, 10)).resolves.toMatchObject({ applied: false });
    expect(store.read().currentByFixture[fixtureId]).toBe(2);

    const restarted = new FileAutomationStateStore(path);
    await restarted.initialize();
    await expect(restarted.updateVehicleSensorEvent(
      { sourceUnicast: 0x1201, bootId: 7, sequence: 11 },
      (state) => {
        state.currentByFixture[fixtureId] = 99;
        return state;
      }
    )).resolves.toMatchObject({ applied: false });
    expect(restarted.read().currentByFixture[fixtureId]).toBe(2);
    expect(restarted.read().vehicleSensorInbox[0]).toMatchObject({
      sourceUnicast: 0x1201,
      current: { bootId: 8, highWaterSequence: 1 }
    });
    expect(restarted.read().vehicleSensorInbox[0]?.recentBoots).toContainEqual({
      bootId: 7,
      highWaterSequence: 11
    });
  });

  it("adopts a rename-visible sensor transaction uncertainty without replaying after restart", async () => {
    const path = await statePath();
    await writeJsonAtomic(path, emptyAutomationState());
    let writes = 0;
    const store = new FileAutomationStateStore(path, async (target, value) => {
      writes += 1;
      await writeJsonAtomic(target, value);
      if (writes === 1) throw new AtomicJsonCommitUncertainError(target);
    });
    await store.initialize();

    await expect(store.updateVehicleSensorEvent(
      { sourceUnicast: 0x1201, bootId: 7, sequence: 9 },
      (state) => {
        state.currentByFixture[fixtureId] = 40;
        return state;
      }
    )).resolves.toMatchObject({ applied: true, durability: "durable" });

    const restarted = new FileAutomationStateStore(path);
    await restarted.initialize();
    await expect(restarted.updateVehicleSensorEvent(
      { sourceUnicast: 0x1201, bootId: 7, sequence: 9 },
      (state) => {
        state.currentByFixture[fixtureId] = 99;
        return state;
      }
    )).resolves.toMatchObject({ applied: false });
    expect(restarted.read().currentByFixture[fixtureId]).toBe(40);
  });

  it("does not accept or receipt a sensor event after a definite commit failure", async () => {
    const path = await statePath();
    await writeJsonAtomic(path, emptyAutomationState());
    let fail = true;
    const store = new FileAutomationStateStore(path, async (target, value) => {
      if (fail) throw new Error("definite sensor commit failure");
      await writeJsonAtomic(target, value);
    });
    await store.initialize();
    const operation = () => store.updateVehicleSensorEvent(
      { sourceUnicast: 0x1201, bootId: 7, sequence: 9 },
      (state) => {
        state.currentByFixture[fixtureId] = 40;
        return state;
      }
    );

    await expect(operation()).rejects.toThrow("automation_state_store_failed");
    fail = false;
    await expect(operation()).resolves.toMatchObject({ applied: true });
  });
  it("atomically persists source pre-state and desired suppression across restart", async () => {
    const path = await statePath();
    const store = new FileAutomationStateStore(path);
    await store.initialize();

    const result = await store.updateControlState((state) => ({
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

    expect(result.durability).toBe("durable");

    const restarted = new FileAutomationStateStore(path);
    await expect(restarted.initialize()).resolves.toMatchObject({
      schemaVersion: 6,
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

    await expect(store.updateControlState((state) => ({
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

    await expect(store.updateControlState((state) => {
      state.currentByFixture[fixtureId] = 40;
      state.pendingTelemetryHandoffs.push(handoff);
      return state;
    })).resolves.toMatchObject({
      durability: "memory_only",
      state: { currentByFixture: { [fixtureId]: 40 }, pendingTelemetryHandoffs: [] }
    });

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
    await expect(store.updateControlState((state) => state)).resolves.toMatchObject({
      durability: "durable"
    });

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

    const error = await store.updateControlState((state) => ({
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

  it("keeps the in-memory handoff pending when a durable-required clear is commit-uncertain", async () => {
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
    const initial = { ...emptyAutomationState(), pendingTelemetryHandoffs: [handoff] };
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
      throw Object.assign(new Error("rollback disk full"), { code: "ENOSPC" });
    });
    await store.initialize();

    await expect(store.completeTelemetryHandoff(
      handoff.handoffId,
      handoff.recordsHash
    )).rejects.toBeInstanceOf(AutomationStateCommitUncertainError);

    expect(store.read()).toEqual(initial);
    expect(store.durability()).toEqual({
      mode: "degraded",
      reason: "atomic_json_commit_uncertain"
    });
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
      schemaVersion: 6,
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

    await expect(store.clearTelemetryGap(handedOff)).resolves.toEqual({
      cleared: false,
      durability: "durable"
    });
    expect(store.read().telemetryGap?.droppedCount).toBe(3);

    await expect(store.clearTelemetryGap(store.read().telemetryGap!)).resolves.toEqual({
      cleared: true,
      durability: "durable"
    });
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
    const { vehicleSensorInbox: _vehicleSensorInbox, ...v4 } = legacyV5State();
    await writeJsonAtomic(path, {
      ...v4,
      schemaVersion: 4,
      pendingTelemetryHandoffs: [handoff]
    });

    const store = new FileAutomationStateStore(path);
    await expect(store.initialize()).resolves.toMatchObject({
      schemaVersion: 6,
      pendingTelemetryHandoffs: [handoff]
    });
    await expect(store.completeTelemetryHandoff(handoff.handoffId, handoff.recordsHash)).resolves.toEqual({
      completed: true,
      durability: "durable"
    });
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
