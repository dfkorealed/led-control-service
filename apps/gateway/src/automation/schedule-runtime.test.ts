import type {
  AutomationExecutionFixtureResultV1,
  AutomationSnapshotV1,
  LightingScheduleSnapshotV1,
  VehicleEventRuleSnapshotV1
} from "@led-control/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAutomationStateStore } from "./automation-state-store";
import { automationSnapshot } from "./automation-test-fixtures";
import {
  ScheduleRuntime,
  type DesiredLightingAction,
  type ManualOverrideInput
} from "./schedule-runtime";

const directories: string[] = [];
const fixtureId = "00000000-0000-4000-8000-000000000101";
const sourceFixtureId = "00000000-0000-4000-8000-000000000102";
const scheduleId = "00000000-0000-4000-8000-000000000103";
const vehicleRuleId = "00000000-0000-4000-8000-000000000104";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ScheduleRuntime", () => {
  it("starts a common-engine occurrence and restores its persisted pre-state at the end", async () => {
    const test = await runtimeFixture("2026-08-30T00:59:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ schedules: [dailySchedule()] }));

    test.wall.set("2026-08-30T01:00:00.000Z");
    await test.runtime.tick();

    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({
        fixtureId,
        brightnessPercent: 40,
        sourceType: "schedule",
        sourceId: scheduleId,
        occurrenceKey: `${scheduleId}:2026-08-30`
      })
    ]);
    expect(test.store.read().activeOccurrences[scheduleId]).toMatchObject({
      key: `${scheduleId}:2026-08-30`,
      preBrightness: { [fixtureId]: 20 }
    });

    test.wall.set("2026-08-30T02:00:00.000Z");
    await test.runtime.tick();

    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
    expect(test.store.read()).toMatchObject({
      activeOccurrences: {},
      baseBrightnessByFixture: {},
      lastDesiredByFixture: { [fixtureId]: 20 }
    });
  });

  it("does not issue a duplicate mesh action when restarting inside the same occurrence", async () => {
    const test = await runtimeFixture("2026-08-30T01:30:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    const activeSnapshot = snapshot({ schedules: [dailySchedule()] });
    await activate(test.runtime, activeSnapshot);
    expect(test.execute).toHaveBeenCalledTimes(1);

    const restartedExecute = vi.fn(executeSuccessfully);
    const restarted = new ScheduleRuntime({
      store: new FileAutomationStateStore(test.path),
      wallClock: test.wall.now,
      monotonicClock: test.monotonic.now,
      clockTrust: test.trust,
      execute: restartedExecute
    });
    await restarted.initialize();
    await activate(restarted, activeSnapshot);

    expect(restartedExecute).not.toHaveBeenCalled();
    expect(restarted.state().activeOccurrences[scheduleId]?.key).toBe(`${scheduleId}:2026-08-30`);
  });

  it("freezes only new schedule boundaries while the wall clock is untrusted", async () => {
    const test = await runtimeFixture("2026-08-30T00:59:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ schedules: [dailySchedule()] }));

    test.trust.trusted = false;
    test.wall.set("2026-08-30T01:10:00.000Z");
    await test.runtime.tick();

    expect(test.execute).not.toHaveBeenCalled();
    expect(test.store.read().activeOccurrences).toEqual({});

    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:30:00.000Z"));
    expect(test.store.read().manualOverrides[fixtureId]).toMatchObject({ brightnessPercent: 60 });
    expect(test.store.read().lastDesiredByFixture[fixtureId]).toBe(60);
  });

  it("expires vehicle hold from monotonic time even while the wall clock is untrusted", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 60)] }));

    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 80, sourceType: "vehicle_event_rule" })
    ]);
    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);

    test.trust.trusted = false;
    test.monotonic.advance(59_000);
    await test.runtime.tick();
    expect(test.execute).toHaveBeenCalledTimes(1);

    test.monotonic.advance(1_001);
    await test.runtime.tick();
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
  });

  it("ignores an initial or repeated vehicle Low instead of creating or extending a hold", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 5)] }));

    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);
    expect(test.execute).not.toHaveBeenCalled();
    expect(test.runtime.state().vehicleRules).toEqual({});

    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);
    test.monotonic.advance(4_000);
    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);
    test.monotonic.advance(1_001);
    await test.runtime.tick();

    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
  });

  it("expires a timed manual override while schedule boundaries are clock-untrusted", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 60)] }));
    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:00:10.000Z"));
    test.execute.mockClear();

    test.trust.trusted = false;
    test.wall.set("2026-08-30T01:00:10.000Z");
    await test.runtime.tick();

    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 80, sourceType: "vehicle_event_rule" })
    ]);
  });

  it("returns to an active event when manual expires and then to the first persisted pre-state", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 5)] }));
    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:00:10.000Z"));
    test.execute.mockClear();

    test.wall.set("2026-08-30T01:00:10.000Z");
    await test.runtime.tick();
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 80, sourceType: "vehicle_event_rule" })
    ]);

    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);
    test.monotonic.advance(5_001);
    await test.runtime.tick();
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
  });

  it("ends an active vehicle state when hot reload removes its High source", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 60)] }));
    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    test.execute.mockClear();

    await activate(test.runtime, snapshot({ vehicleEventRules: [{
      ...vehicleRule(80, 60),
      sourceFixtureIds: ["00000000-0000-4000-8000-000000000106"]
    }] }));

    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
    expect(test.runtime.state().vehicleRules).toEqual({});
  });

  it("restores the scheduler snapshot and source state when config activation rolls back", async () => {
    const test = await runtimeFixture("2026-08-30T01:30:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    const active = snapshot({ schedules: [dailySchedule()] });
    await activate(test.runtime, active);
    const before = test.runtime.state();

    await test.runtime.recompute(snapshot({ schedules: [{ ...dailySchedule(), status: "disabled" }] }));
    await test.runtime.rollbackActivation();

    expect(test.runtime.state()).toEqual(before);
    expect(test.runtime.currentSnapshot?.schedules[0]?.status).toBe("enabled");
  });

  it("recovers a persisted UTC vehicle expiry into a new process monotonic deadline", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    const rules = snapshot({ vehicleEventRules: [vehicleRule(80, 60)] });
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, rules);
    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);

    test.wall.set("2026-08-30T01:00:30.000Z");
    const restartedExecute = vi.fn(executeSuccessfully);
    const restarted = new ScheduleRuntime({
      store: new FileAutomationStateStore(test.path),
      wallClock: test.wall.now,
      monotonicClock: test.monotonic.now,
      clockTrust: test.trust,
      execute: restartedExecute
    });
    await restarted.initialize();
    await activate(restarted, rules);
    expect(restartedExecute).not.toHaveBeenCalled();

    test.monotonic.advance(30_001);
    await restarted.tick();
    expect(restartedExecute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
  });

  it("does not let a schedule end overwrite a still-active manual source", async () => {
    const test = await runtimeFixture("2026-08-30T01:30:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ schedules: [dailySchedule()] }));
    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T02:10:00.000Z"));
    test.execute.mockClear();

    test.wall.set("2026-08-30T02:00:00.000Z");
    await test.runtime.tick();

    expect(test.execute).not.toHaveBeenCalled();
    expect(test.runtime.state().manualOverrides[fixtureId]).toMatchObject({ brightnessPercent: 60 });
    expect(test.runtime.state().lastDesiredByFixture[fixtureId]).toBe(60);
  });
});

async function runtimeFixture(initialWall: string) {
  const directory = await mkdtemp(join(tmpdir(), "schedule-runtime-"));
  directories.push(directory);
  const path = join(directory, "state.json");
  const wall = fakeWall(initialWall);
  const monotonic = fakeMonotonic();
  const trust = { trusted: true, async isTrusted() { return this.trusted; } };
  const execute = vi.fn(executeSuccessfully);
  const store = new FileAutomationStateStore(path);
  const runtime = new ScheduleRuntime({
    store,
    wallClock: wall.now,
    monotonicClock: monotonic.now,
    clockTrust: trust,
    execute
  });
  await runtime.initialize();
  return { runtime, store, path, wall, monotonic, trust, execute };
}

async function activate(runtime: ScheduleRuntime, value: AutomationSnapshotV1) {
  const desired = await runtime.recompute(value);
  await runtime.applyDesiredState(desired, {});
  await runtime.commitActivation();
}

function snapshot(patch: Partial<AutomationSnapshotV1>): AutomationSnapshotV1 {
  return automationSnapshot(1, { timeZone: "UTC", ...patch });
}

function dailySchedule(): LightingScheduleSnapshotV1 {
  return {
    id: scheduleId,
    name: "Morning",
    status: "enabled",
    activeFrom: "2026-08-01T00:00:00.000Z",
    activeUntil: "2026-09-30T23:59:59.000Z",
    localStartTime: "01:00",
    localEndTime: "02:00",
    recurrence: {
      kind: "daily",
      weeklyDays: [],
      monthlyDay: null,
      yearlyMonth: null,
      yearlyDay: null
    },
    action: { dimmingEnabled: true, brightnessPercent: 40 },
    fixtureIds: [fixtureId]
  };
}

function vehicleRule(brightnessPercent: number, holdSeconds: number): VehicleEventRuleSnapshotV1 {
  return {
    id: vehicleRuleId,
    name: "Vehicle",
    status: "enabled",
    sourceFixtureIds: [sourceFixtureId],
    targetFixtureIds: [fixtureId],
    action: { dimmingEnabled: true, brightnessPercent },
    holdSeconds
  };
}

function manualOverride(brightnessPercent: number, overrideUntil: string): ManualOverrideInput {
  return {
    sourceId: "00000000-0000-4000-8000-000000000105",
    fixtureIds: [fixtureId],
    brightnessPercent,
    startedAt: "2026-08-30T01:00:01.000Z",
    overrideUntil
  };
}

async function executeSuccessfully(actions: DesiredLightingAction[]): Promise<AutomationExecutionFixtureResultV1[]> {
  return actions.map((action) => ({
    fixtureId: action.fixtureId,
    status: "succeeded",
    brightnessPercent: action.brightnessPercent,
    faultCode: null,
    errorCode: null,
    occurredAt: "2026-08-30T01:00:00.000Z"
  }));
}

function fakeWall(initial: string) {
  let value = new Date(initial);
  return {
    now: () => new Date(value),
    set: (next: string) => { value = new Date(next); }
  };
}

function fakeMonotonic() {
  let value = 0;
  return {
    now: () => value,
    advance: (milliseconds: number) => { value += milliseconds; }
  };
}
