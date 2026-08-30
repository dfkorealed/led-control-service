import type { AutomationSnapshotV1, VehicleEventRuleSnapshotV1 } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import { emptyAutomationState } from "./automation-state-store";
import { automationSnapshot } from "./automation-test-fixtures";
import { VehicleEventRuntime } from "./vehicle-event-runtime";

const targetFixtureId = "00000000-0000-4000-8000-000000000101";
const sourceA = "00000000-0000-4000-8000-000000000102";
const sourceB = "00000000-0000-4000-8000-000000000103";
const ruleId = "00000000-0000-4000-8000-000000000104";

describe("VehicleEventRuntime", () => {
  it("keeps a rule active while any source is High and never ages out a High", () => {
    const clock = fakeClocks("2026-08-30T01:00:00.000Z");
    const runtime = new VehicleEventRuntime(clock);
    const state = stateWithCurrent(20);
    const snapshot = rulesSnapshot([vehicleRule(80, 60, [sourceA, sourceB])]);

    runtime.recordInput(state, snapshot, { type: "detected", sourceFixtureId: sourceA });
    runtime.recordInput(state, snapshot, { type: "detected", sourceFixtureId: sourceB });
    runtime.recordInput(state, snapshot, { type: "cleared", sourceFixtureId: sourceA });
    clock.advance(24 * 60 * 60 * 1_000);
    runtime.reconcile(state, snapshot, true);

    expect(state.vehicleRules[ruleId]).toMatchObject({
      activeSourceFixtureIds: [sourceB],
      brightnessPercent: 80,
      holdUntil: null
    });
    expect(runtime.desiredBrightness(state, targetFixtureId)).toBe(80);
  });

  it("starts hold on the last Low and cancels it when another source retriggers", () => {
    const clock = fakeClocks("2026-08-30T01:00:00.000Z");
    const runtime = new VehicleEventRuntime(clock);
    const state = stateWithCurrent(20);
    const snapshot = rulesSnapshot([vehicleRule(80, 60, [sourceA, sourceB])]);

    runtime.recordInput(state, snapshot, { type: "detected", sourceFixtureId: sourceA });
    runtime.recordInput(state, snapshot, { type: "cleared", sourceFixtureId: sourceA });
    clock.advance(30_000);
    const retrigger = runtime.recordInput(state, snapshot, { type: "current-state", sourceFixtureId: sourceB, active: true });
    clock.advance(60_001);
    runtime.reconcile(state, snapshot, false);

    expect(state.vehicleRules[ruleId]?.activeSourceFixtureIds).toEqual([sourceB]);
    expect(state.vehicleRules[ruleId]?.holdUntil).toBeNull();
    expect(retrigger.map((event) => event.kind)).toEqual(["vehicle_detected", "event_extended"]);

    runtime.recordInput(state, snapshot, { type: "cleared", sourceFixtureId: sourceB });
    clock.advance(59_999);
    runtime.reconcile(state, snapshot, false);
    expect(state.vehicleRules[ruleId]).toBeDefined();

    clock.advance(2);
    const ended = runtime.reconcile(state, snapshot, false);
    expect(state.vehicleRules[ruleId]).toBeUndefined();
    expect(ended).toEqual([
      expect.objectContaining({ kind: "event_ended", ruleId, occurrenceKey: expect.any(String) })
    ]);
  });

  it("uses trusted UTC only to recover a persisted hold after restart", () => {
    const firstClock = fakeClocks("2026-08-30T01:00:00.000Z");
    const first = new VehicleEventRuntime(firstClock);
    const state = stateWithCurrent(20);
    const snapshot = rulesSnapshot([vehicleRule(80, 60, [sourceA])]);
    first.recordInput(state, snapshot, { type: "detected", sourceFixtureId: sourceA });
    first.recordInput(state, snapshot, { type: "cleared", sourceFixtureId: sourceA });

    const restartClock = fakeClocks("2026-08-30T01:00:30.000Z");
    const restarted = new VehicleEventRuntime(restartClock);
    restarted.reconcile(state, snapshot, false);
    restartClock.advance(90_000);
    restarted.reconcile(state, snapshot, false);
    expect(state.vehicleRules[ruleId]).toBeDefined();

    restarted.reconcile(state, snapshot, true);
    restartClock.advance(30_001);
    restarted.reconcile(state, snapshot, false);
    expect(state.vehicleRules[ruleId]).toBeUndefined();
  });

  it("returns maximum brightness across active rules and the captured base after the last event", () => {
    const clock = fakeClocks("2026-08-30T01:00:00.000Z");
    const runtime = new VehicleEventRuntime(clock);
    const state = stateWithCurrent(25);
    const secondRuleId = "00000000-0000-4000-8000-000000000105";
    const snapshot = rulesSnapshot([
      vehicleRule(45, 5, [sourceA]),
      { ...vehicleRule(90, 5, [sourceB]), id: secondRuleId }
    ]);

    runtime.recordInput(state, snapshot, { type: "detected", sourceFixtureId: sourceA });
    runtime.recordInput(state, snapshot, { type: "detected", sourceFixtureId: sourceB });
    expect(runtime.desiredBrightness(state, targetFixtureId)).toBe(90);
    expect(state.baseBrightnessByFixture[targetFixtureId]).toBe(25);

    runtime.recordInput(state, snapshot, { type: "cleared", sourceFixtureId: sourceB });
    clock.advance(5_001);
    runtime.reconcile(state, snapshot, false);
    expect(runtime.desiredBrightness(state, targetFixtureId)).toBe(45);

    runtime.recordInput(state, snapshot, { type: "cleared", sourceFixtureId: sourceA });
    clock.advance(5_001);
    runtime.reconcile(state, snapshot, false);
    expect(runtime.desiredBrightness(state, targetFixtureId)).toBeNull();
    expect(state.baseBrightnessByFixture[targetFixtureId]).toBe(25);
  });
});

function stateWithCurrent(brightness: number) {
  const state = emptyAutomationState();
  state.currentByFixture[targetFixtureId] = brightness;
  state.lastDesiredByFixture[targetFixtureId] = brightness;
  return state;
}

function rulesSnapshot(vehicleEventRules: VehicleEventRuleSnapshotV1[]): AutomationSnapshotV1 {
  return automationSnapshot(1, { vehicleEventRules });
}

function vehicleRule(
  brightnessPercent: number,
  holdSeconds: number,
  sourceFixtureIds: string[]
): VehicleEventRuleSnapshotV1 {
  return {
    id: ruleId,
    name: "Garage entry",
    status: "enabled",
    sourceFixtureIds,
    targetFixtureIds: [targetFixtureId],
    action: { dimmingEnabled: true, brightnessPercent },
    holdSeconds
  };
}

function fakeClocks(initial: string) {
  let wallMs = Date.parse(initial);
  let monotonicMs = 1_000;
  return {
    wallClock: () => new Date(wallMs),
    monotonicClock: () => monotonicMs,
    advance(ms: number) {
      wallMs += ms;
      monotonicMs += ms;
    }
  };
}
