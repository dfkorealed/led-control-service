import type { AutomationSnapshotV1, AutomationSnapshotV2, VehicleEventRuleSnapshotV1 } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import { emptyAutomationState } from "./automation-state-store";
import { automationSnapshot } from "./automation-test-fixtures";
import { VehicleEventRuntime, type VehicleSensorInput } from "./vehicle-event-runtime";

const targetFixtureId = "00000000-0000-4000-8000-000000000101";
const sourceA = "00000000-0000-4000-8000-000000000102";
const sourceB = "00000000-0000-4000-8000-000000000103";
const ruleId = "00000000-0000-4000-8000-000000000104";

describe("BIO pulse occurrence", () => {
  function setup(holdSeconds = 60) {
    const clock = fakeClocks("2026-09-30T01:00:00.000Z");
    const connection = { epoch: "process-one", generation: 1 };
    const health = { health: "healthy" as "healthy" | "degraded" | "unverified", reason: "verified",
      connectionEpoch: connection.epoch, connectionGeneration: connection.generation, healthySinceMonotonicMs: 1000 };
    const runtime = new VehicleEventRuntime({ ...clock, bioConnection: () => connection, bioSourceHealth: () => health });
    const state = stateWithCurrent(20);
    const snapshot: AutomationSnapshotV2 = {
      ...rulesSnapshot([]), schemaVersion: 2,
      vehicleEventRules: [{ ...vehicleRule(80, holdSeconds, [sourceA]), sensorProtocol: "bio-usb-pulse" }]
    };
    const pulse = (sequence: number, receivedMonotonicMs = clock.monotonicClock()): VehicleSensorInput => ({
      type: "pulse", sourceFixtureId: sourceA, receivedMonotonicMs,
      receipt: { nativeUuid: "aabbccddeeff", logicalAddress: 1, networkId: 2, sequence,
        connectionEpoch: connection.epoch, connectionGeneration: connection.generation }
    });
    return { clock, connection, health, runtime, state, snapshot, pulse };
  }

  it("requires independent health even with valid connection and pulse identity", () => {
    const t = setup();
    const runtime = new VehicleEventRuntime({ ...t.clock, bioConnection: () => t.connection });
    expect(runtime.recordInput(t.state, t.snapshot, t.pulse(1))).toEqual([]);
    expect(t.state.bioPulseInbox).toEqual({});
    expect(t.state.vehicleRules).toEqual({});
  });

  it.each(["usb_disconnected", "identity_changed", "liveness_failed"])("freezes before and beyond expiry for %s", reason => {
    const t = setup(10);
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    const occurrence = structuredClone(t.state.vehicleRules[ruleId]);
    t.clock.advance(9000);
    t.health.health = "degraded";
    t.health.reason = reason;
    const events = t.runtime.reconcile(t.state, t.snapshot, true);
    expect(events).toMatchObject([{ kind: "event_extended", payload: { reason: "bio_source_degraded", health: "degraded" } }]);
    expect(t.runtime.checkpoint()).toEqual([]);
    t.clock.advance(100_000);
    expect(t.runtime.recordInput(t.state, t.snapshot, t.pulse(2))).toEqual([]);
    expect(t.runtime.reconcile(t.state, t.snapshot, true).some(event => event.kind === "event_ended")).toBe(false);
    expect(t.state.vehicleRules[ruleId]).toEqual(occurrence);
    expect(t.state.bioPulseInbox[sourceA]?.receipt.sequence).toBe(1);
  });

  it("freezes when degradation is first observed after the old deadline", () => {
    const t = setup(10);
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    t.clock.advance(20_000);
    t.health.health = "degraded";
    expect(t.runtime.reconcile(t.state, t.snapshot, true)).not.toContainEqual(expect.objectContaining({ kind: "event_ended" }));
    expect(t.state.vehicleRules[ruleId]).toBeDefined();
  });

  it.each([1, 10, 60, 1800])("observes a full %ss after recovery, including an outage between ticks", hold => {
    const t = setup(hold);
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    t.clock.advance(hold * 1000 + 5000);
    // Independent authority reports the start of this continuous healthy interval.
    t.health.healthySinceMonotonicMs = t.clock.monotonicClock();
    expect(t.runtime.reconcile(t.state, t.snapshot, true).some(event => event.kind === "event_ended")).toBe(false);
    t.clock.advance(hold * 1000 - 1);
    expect(t.runtime.reconcile(t.state, t.snapshot, true).some(event => event.kind === "event_ended")).toBe(false);
    t.clock.advance(1);
    expect(t.runtime.reconcile(t.state, t.snapshot, true)).toMatchObject([{ kind: "event_ended", payload: { reason: "hold_expired" } }]);
  });

  it("restarts with no expiry authority and observes full hold after independent recovery", () => {
    const t = setup(10);
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    const restartClock = fakeClocks("2027-01-01T00:00:00.000Z");
    t.connection.epoch = "new-process";
    t.health.health = "unverified";
    const runtime = new VehicleEventRuntime({ ...restartClock, bioConnection: () => t.connection, bioSourceHealth: () => t.health });
    expect(runtime.reconcile(t.state, t.snapshot, true).some(event => event.kind === "event_ended")).toBe(false);
    restartClock.advance(50_000);
    Object.assign(t.health, { health: "healthy", connectionEpoch: "new-process", healthySinceMonotonicMs: restartClock.monotonicClock() });
    expect(runtime.reconcile(t.state, t.snapshot, true)).toMatchObject([{ kind: "event_extended", payload: { reason: "bio_health_recovered" } }]);
    restartClock.advance(9999);
    expect(runtime.reconcile(t.state, t.snapshot, true)).toEqual([]);
    restartClock.advance(1);
    expect(runtime.reconcile(t.state, t.snapshot, true)).toMatchObject([{ kind: "event_ended", payload: { reason: "hold_expired" } }]);
  });

  it("rejects old connection health and queued pre-recovery pulses", () => {
    const t = setup(10);
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    t.clock.advance(2000);
    t.connection.generation++;
    expect(t.runtime.recordInput(t.state, t.snapshot, t.pulse(2))).toEqual([]);
    expect(t.runtime.reconcile(t.state, t.snapshot, true)).toMatchObject([{ payload: { reason: "bio_source_degraded" } }]);
    Object.assign(t.health, { connectionGeneration: 2, healthySinceMonotonicMs: t.clock.monotonicClock() });
    expect(t.runtime.recordInput(t.state, t.snapshot, t.pulse(3, 2000))).toEqual([]);
    expect(t.runtime.recordInput(t.state, t.snapshot, t.pulse(4))).toHaveLength(2);
  });

  it("separates explicit operator release from healthy hold expiry", () => {
    const t = setup();
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    t.health.health = "degraded";
    const planned = t.runtime.planRelease(t.state, ruleId);
    expect(planned.events).toMatchObject([{ kind: "event_ended", payload: { reason: "operator_release" } }]);
    expect(t.state.vehicleRules[ruleId]).toBeUndefined();
    expect(planned.holdDeadlines).toEqual([]);
  });

  it.each([NaN, Infinity, -1, 1001])("rejects invalid independent health time %s", healthySinceMonotonicMs => {
    const t = setup();
    t.health.healthySinceMonotonicMs = healthySinceMonotonicMs;
    expect(t.runtime.recordInput(t.state, t.snapshot, t.pulse(1))).toEqual([]);
    expect(t.state.bioPulseInbox).toEqual({});
  });

  it("keeps planned freeze and operator release checkpoints isolated until committed", () => {
    const t = setup();
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    const before = t.runtime.checkpoint();
    t.health.health = "degraded";
    t.health.reason = "raw aabbccddeeff credential=secret";
    const planned = t.runtime.planReconcile(structuredClone(t.state), t.snapshot, true);
    expect(planned.holdDeadlines).toEqual([]);
    expect(t.runtime.checkpoint()).toEqual(before);
    expect(JSON.stringify(planned.events)).not.toMatch(/aabbccddeeff|secret/);
    expect(planned.events[0]?.payload.healthReason).toBe("health_unverified");
    t.runtime.planRelease(structuredClone(t.state), ruleId);
    expect(t.runtime.checkpoint()).toEqual(before);
    expect(t.state.vehicleRules[ruleId]).toBeDefined();
    t.runtime.restore(planned.holdDeadlines);
    expect(t.runtime.checkpoint()).toEqual([]);
  });

  it("extends the recovered observation window on a fresh pulse without replacing the occurrence", () => {
    const t = setup(10);
    const first = t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    t.health.health = "degraded";
    t.runtime.reconcile(t.state, t.snapshot, false);
    t.clock.advance(20_000);
    t.health.health = "healthy";
    t.health.healthySinceMonotonicMs = t.clock.monotonicClock();
    t.runtime.reconcile(t.state, t.snapshot, false);
    t.clock.advance(9000);
    const next = t.runtime.recordInput(t.state, t.snapshot, t.pulse(2));
    expect(next[1]?.occurrenceKey).toBe(first[1]?.occurrenceKey);
    t.clock.advance(1000);
    expect(t.runtime.reconcile(t.state, t.snapshot, false)).toEqual([]);
    t.clock.advance(9000);
    expect(t.runtime.reconcile(t.state, t.snapshot, false)).toMatchObject([{ payload: { reason: "hold_expired" } }]);
  });

  it("starts a pulse hold without a latched High and extends the same occurrence without recapturing base", () => {
    const t = setup();
    const first = t.runtime.recordInput(t.state, t.snapshot, t.pulse(255));
    expect(first.map(event => event.kind)).toEqual(["vehicle_detected", "event_started"]);
    expect(first[0]?.payload).toMatchObject({ sensorProtocol: "bio-usb-pulse", inputType: "pulse" });
    expect(JSON.stringify(first)).not.toContain("aabbccddeeff");
    expect(t.state.vehicleRules[ruleId]).toMatchObject({ activeSourceFixtureIds: [], holdUntil: "2026-09-30T01:01:00.000Z", preBrightness: { [targetFixtureId]: 20 } });
    t.clock.advance(1_000);
    t.state.currentByFixture[targetFixtureId] = 80;
    t.state.baseBrightnessByFixture[targetFixtureId] = 45;
    const extended = t.runtime.recordInput(t.state, t.snapshot, t.pulse(0));
    expect(extended.map(event => event.kind)).toEqual(["vehicle_detected", "event_extended"]);
    expect(extended[1]?.occurrenceKey).toBe(first[1]?.occurrenceKey);
    expect(t.state.vehicleRules[ruleId]?.holdUntil).toBe("2026-09-30T01:01:01.000Z");
    expect(t.state.vehicleRules[ruleId]?.preBrightness[targetFixtureId]).toBe(20);
  });

  it.each([1, 10, 60, 1800])("expires at the monotonic receipt deadline for %s seconds", hold => {
    const t = setup(hold);
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    t.clock.advance(hold * 1000 - 1);
    expect(t.runtime.reconcile(t.state, t.snapshot, false)).toEqual([]);
    t.clock.advance(1);
    expect(t.runtime.reconcile(t.state, t.snapshot, false)).toMatchObject([{ kind: "event_ended", payload: { reason: "hold_expired" } }]);
  });

  it("extends a one-second hold from the last pulse without recapturing its base", () => {
    const t = setup(1);
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    const startedAt = t.state.vehicleRules[ruleId]!.startedAt;
    t.clock.advance(750);
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(2));
    expect(t.state.vehicleRules[ruleId]).toMatchObject({ startedAt, preBrightness: { [targetFixtureId]: 20 } });
    t.clock.advance(999);
    expect(t.runtime.reconcile(t.state, t.snapshot, false)).toEqual([]);
    t.clock.advance(1);
    expect(t.runtime.reconcile(t.state, t.snapshot, false)).toMatchObject([{ kind: "event_ended", payload: { reason: "hold_expired" } }]);
  });

  it("uses receipt time rather than delayed processing time", () => {
    const t = setup(10);
    const input = t.pulse(1);
    t.clock.advance(3_000);
    t.runtime.recordInput(t.state, t.snapshot, input);
    expect(t.state.vehicleRules[ruleId]?.holdUntil).toBe("2026-09-30T01:00:10.000Z");
    t.clock.advance(7_000);
    expect(t.runtime.reconcile(t.state, t.snapshot, false)).toHaveLength(1);
  });

  it("keeps a pulse received before expiry in the same occurrence even if processing is delayed", () => {
    const t = setup(10);
    const first = t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    t.clock.advance(9_000);
    const next = t.pulse(2);
    t.clock.advance(2_000);
    const events = t.runtime.recordInput(t.state, t.snapshot, next);
    expect(events.map(event => event.kind)).toEqual(["vehicle_detected", "event_extended"]);
    expect(events[1]?.occurrenceKey).toBe(first[1]?.occurrenceKey);
  });

  it.each([10_000, 10_001])("does not start already-expired queued pulse at %sms processing delay", delay => {
    const t = setup(10);
    const input = t.pulse(1);
    t.clock.advance(delay);
    expect(t.runtime.recordInput(t.state, t.snapshot, input)).toEqual([]);
    expect(t.state.vehicleRules).toEqual({});
    expect(t.state.bioPulseInbox).toEqual({});
  });

  it("rejects exact duplicates, old generation and nonmonotonic receipts without extending", () => {
    const t = setup();
    const old = t.pulse(7);
    t.runtime.recordInput(t.state, t.snapshot, old);
    const before = structuredClone(t.state);
    t.clock.advance(500);
    expect(t.runtime.recordInput(t.state, t.snapshot, t.pulse(7))).toEqual([]);
    expect(t.runtime.recordInput(t.state, t.snapshot, t.pulse(8, 999))).toEqual([]);
    const lateOldGeneration = t.pulse(8);
    t.connection.generation = 2;
    expect(t.runtime.recordInput(t.state, t.snapshot, old)).toEqual([]);
    // Fresh time and unused sequence ensure only the connection authority can reject this packet.
    expect(t.runtime.recordInput(t.state, t.snapshot, lateOldGeneration)).toEqual([]);
    expect(t.state).toEqual(before);
    t.health.connectionGeneration = 2;
    expect(t.runtime.recordInput(t.state, t.snapshot, t.pulse(7))).toHaveLength(2);
  });

  it("accepts a reused sequence after the bounded duplicate window and a fresh process epoch", () => {
    const t = setup();
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(7));
    t.clock.advance(3_000);
    expect(t.runtime.recordInput(t.state, t.snapshot, t.pulse(7))).toHaveLength(2);
    t.connection.epoch = "process-two";
    t.health.connectionEpoch = "process-two";
    const restartClock = fakeClocks("2026-09-30T01:00:05.000Z");
    const restarted = new VehicleEventRuntime({ ...restartClock, bioConnection: () => t.connection, bioSourceHealth: () => t.health });
    expect(restarted.recordInput(t.state, t.snapshot, t.pulse(7, 1000))).toHaveLength(2);
  });

  it("never recovers BIO expiry from wall-clock state, even with trusted UTC", () => {
    const t = setup(10);
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    t.clock.advance(60_000);
    const restarted = new VehicleEventRuntime(t.clock);
    expect(restarted.reconcile(t.state, t.snapshot, true)).toMatchObject([{ payload: { reason: "bio_source_degraded", health: "unverified" } }]);
    expect(t.state.vehicleRules[ruleId]).toBeDefined();
  });

  it("keeps V1 and V2 input protocols isolated and defaults pulse connection authority OFF", () => {
    const t = setup();
    expect(t.runtime.recordInput(t.state, rulesSnapshot([vehicleRule(80, 60, [sourceA])]), t.pulse(1))).toEqual([]);
    expect(t.runtime.recordInput(t.state, t.snapshot, { type: "detected", sourceFixtureId: sourceA })).toEqual([]);
    expect(new VehicleEventRuntime(t.clock).recordInput(t.state, t.snapshot, t.pulse(1))).toEqual([]);
    expect(t.state.vehicleRules).toEqual({});
  });

  it("records protocol durably so a V1 replacement ends BIO as configuration change, never hold expiry", () => {
    const t = setup(10);
    t.runtime.recordInput(t.state, t.snapshot, t.pulse(1));
    expect(t.state.vehicleRules[ruleId]).toMatchObject({ sensorProtocol: "bio-usb-pulse" });
    t.clock.advance(60_000);
    const restarted = new VehicleEventRuntime(t.clock);
    expect(restarted.reconcile(t.state, rulesSnapshot([vehicleRule(80, 10, [sourceA])]), true))
      .toMatchObject([{ kind: "event_ended", payload: { reason: "configuration_changed" } }]);
  });
});

describe("VehicleEventRuntime", () => {
  it.each([5_000, 5_001])("ends an elapsed hold before processing High at %sms without a tick", (elapsed) => {
    const clock = fakeClocks("2026-08-30T01:00:00.000Z");
    const runtime = new VehicleEventRuntime(clock);
    const state = stateWithCurrent(20);
    const snapshot = rulesSnapshot([vehicleRule(80, 5, [sourceA])]);
    runtime.recordInput(state, snapshot, { type: "detected", sourceFixtureId: sourceA });
    runtime.recordInput(state, snapshot, { type: "cleared", sourceFixtureId: sourceA });
    clock.advance(elapsed);
    const events = runtime.recordInput(state, snapshot, { type: "detected", sourceFixtureId: sourceA });
    expect(events.map((event) => event.kind)).toEqual(["event_ended", "vehicle_detected", "event_started"]);
    expect(events[0]).toMatchObject({ occurrenceKey: `${ruleId}:2026-08-30T01:00:00.000Z`, payload: { reason: "hold_expired" } });
    expect(state.vehicleRules[ruleId]).toMatchObject({ startedAt: clock.wallClock().toISOString(), holdUntil: null });
    expect(events[2]?.occurrenceKey).toBe(`${ruleId}:${clock.wallClock().toISOString()}`);
    expect(runtime.checkpoint()).toEqual([]);
    expect(runtime.reconcile(state, snapshot, true)).toEqual([]);
  });
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
