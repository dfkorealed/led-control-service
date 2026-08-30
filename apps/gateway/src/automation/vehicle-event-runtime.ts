import type { AutomationSnapshotV1, VehicleEventRuleSnapshotV1 } from "@led-control/shared";
import type {
  PersistedAutomationStateV4,
  PersistedVehicleRuleState
} from "./automation-state-store";

export type VehicleSensorInput =
  | { type: "detected"; sourceFixtureId: string }
  | { type: "cleared"; sourceFixtureId: string }
  | { type: "current-state"; sourceFixtureId: string; active: boolean };

export interface VehicleLifecycleEvent {
  kind: "vehicle_detected" | "event_started" | "event_extended" | "event_ended";
  ruleId: string;
  occurrenceKey: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

interface VehicleEventRuntimeOptions {
  wallClock?: () => Date;
  monotonicClock?: () => number;
}

export class VehicleEventRuntime {
  private readonly wallClock: () => Date;
  private readonly monotonicClock: () => number;
  private readonly holdDeadlines = new Map<string, number>();

  constructor(options: VehicleEventRuntimeOptions = {}) {
    this.wallClock = options.wallClock ?? (() => new Date());
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
  }

  recordInput(
    state: PersistedAutomationStateV4,
    snapshot: AutomationSnapshotV1,
    input: VehicleSensorInput
  ): VehicleLifecycleEvent[] {
    const planned = this.planRecordInput(state, snapshot, input);
    this.restore(planned.holdDeadlines);
    return planned.events;
  }

  planRecordInput(
    state: PersistedAutomationStateV4,
    snapshot: AutomationSnapshotV1,
    input: VehicleSensorInput
  ) {
    const deadlines = new Map(this.holdDeadlines);
    const events = this.recordInputWithDeadlines(state, snapshot, input, deadlines);
    return { events, holdDeadlines: [...deadlines] as Array<[string, number]> };
  }

  private recordInputWithDeadlines(
    state: PersistedAutomationStateV4,
    snapshot: AutomationSnapshotV1,
    input: VehicleSensorInput,
    deadlines: Map<string, number>
  ): VehicleLifecycleEvent[] {
    const active = input.type === "detected" || (input.type === "current-state" && input.active);
    const now = this.wallClock();
    const monotonicNow = this.monotonicClock();
    const events: VehicleLifecycleEvent[] = [];
    const rules = snapshot.vehicleEventRules.filter((rule) =>
      rule.status === "enabled" && rule.sourceFixtureIds.includes(input.sourceFixtureId)
    );

    for (const rule of rules) {
      const existing = state.vehicleRules[rule.id];
      const sources = new Set(existing?.activeSourceFixtureIds ?? []);
      const sourceWasActive = sources.has(input.sourceFixtureId);
      if (!active && !sourceWasActive) continue;
      if (active) sources.add(input.sourceFixtureId);
      else sources.delete(input.sourceFixtureId);

      const wasHolding = Boolean(existing && existing.activeSourceFixtureIds.length === 0 && existing.holdUntil);
      const next = createVehicleState(rule, existing, [...sources].sort(), now, state);
      const occurrenceKey = vehicleOccurrenceKey(rule.id, next.startedAt);

      if (active) {
        next.holdUntil = null;
        deadlines.delete(rule.id);
        if (!sourceWasActive) {
          events.push(lifecycle("vehicle_detected", rule.id, occurrenceKey, now, {
            sourceFixtureId: input.sourceFixtureId,
            inputType: input.type
          }));
        }
        if (!existing) {
          events.push(lifecycle("event_started", rule.id, occurrenceKey, now, {
            sourceFixtureId: input.sourceFixtureId,
            brightnessPercent: next.brightnessPercent,
            targetFixtureIds: next.targetFixtureIds
          }));
        } else if (wasHolding && !sourceWasActive) {
          events.push(lifecycle("event_extended", rule.id, occurrenceKey, now, {
            sourceFixtureId: input.sourceFixtureId,
            holdUntil: null,
            reason: "retriggered"
          }));
        }
      } else if (sources.size === 0) {
        next.holdUntil = new Date(now.getTime() + rule.holdSeconds * 1_000).toISOString();
        deadlines.set(rule.id, monotonicNow + rule.holdSeconds * 1_000);
        events.push(lifecycle("event_extended", rule.id, occurrenceKey, now, {
          holdUntil: next.holdUntil,
          reason: "last_source_cleared"
        }));
      }
      state.vehicleRules[rule.id] = next;
    }
    return events;
  }

  reconcile(
    state: PersistedAutomationStateV4,
    snapshot: AutomationSnapshotV1,
    trustedUtc: boolean
  ): VehicleLifecycleEvent[] {
    const planned = this.planReconcile(state, snapshot, trustedUtc);
    this.restore(planned.holdDeadlines);
    return planned.events;
  }

  planReconcile(
    state: PersistedAutomationStateV4,
    snapshot: AutomationSnapshotV1,
    trustedUtc: boolean
  ) {
    const deadlines = new Map(this.holdDeadlines);
    const events = this.reconcileWithDeadlines(state, snapshot, trustedUtc, deadlines);
    return { events, holdDeadlines: [...deadlines] as Array<[string, number]> };
  }

  private reconcileWithDeadlines(
    state: PersistedAutomationStateV4,
    snapshot: AutomationSnapshotV1,
    trustedUtc: boolean,
    deadlines: Map<string, number>
  ): VehicleLifecycleEvent[] {
    const now = this.wallClock();
    const monotonicNow = this.monotonicClock();
    const events: VehicleLifecycleEvent[] = [];
    const rules = new Map(snapshot.vehicleEventRules.map((rule) => [rule.id, rule]));

    for (const [ruleId, vehicle] of Object.entries(state.vehicleRules)) {
      const rule = rules.get(ruleId);
      const occurrenceKey = vehicleOccurrenceKey(ruleId, vehicle.startedAt);
      if (!rule || rule.status !== "enabled") {
        delete state.vehicleRules[ruleId];
        deadlines.delete(ruleId);
        events.push(lifecycle("event_ended", ruleId, occurrenceKey, now, {
          reason: "configuration_changed",
          targetFixtureIds: vehicle.targetFixtureIds
        }));
        continue;
      }

      const hadActiveSource = vehicle.activeSourceFixtureIds.length > 0;
      vehicle.activeSourceFixtureIds = vehicle.activeSourceFixtureIds
        .filter((fixtureId) => rule.sourceFixtureIds.includes(fixtureId));
      vehicle.targetFixtureIds = [...rule.targetFixtureIds];
      vehicle.brightnessPercent = actionBrightness(rule);

      if (hadActiveSource && vehicle.activeSourceFixtureIds.length === 0 && vehicle.holdUntil === null) {
        delete state.vehicleRules[ruleId];
        deadlines.delete(ruleId);
        events.push(lifecycle("event_ended", ruleId, occurrenceKey, now, {
          reason: "source_removed",
          targetFixtureIds: vehicle.targetFixtureIds
        }));
        continue;
      }

      // A real High is authoritative and intentionally has no software timeout.
      if (vehicle.activeSourceFixtureIds.length > 0 || vehicle.holdUntil === null) continue;
      let deadline = deadlines.get(ruleId);
      if (deadline === undefined && trustedUtc) {
        const remainingMs = Date.parse(vehicle.holdUntil) - now.getTime();
        if (remainingMs <= 0) {
          delete state.vehicleRules[ruleId];
          events.push(lifecycle("event_ended", ruleId, occurrenceKey, now, {
            reason: "hold_expired",
            targetFixtureIds: vehicle.targetFixtureIds
          }));
          continue;
        }
        deadline = monotonicNow + remainingMs;
        deadlines.set(ruleId, deadline);
      }
      if (deadline !== undefined && monotonicNow >= deadline) {
        delete state.vehicleRules[ruleId];
        deadlines.delete(ruleId);
        events.push(lifecycle("event_ended", ruleId, occurrenceKey, now, {
          reason: "hold_expired",
          targetFixtureIds: vehicle.targetFixtureIds
        }));
      }
    }
    return events;
  }

  desiredBrightness(state: PersistedAutomationStateV4, fixtureId: string) {
    const brightness = Object.values(state.vehicleRules)
      .filter((vehicle) => vehicle.targetFixtureIds.includes(fixtureId))
      .map((vehicle) => vehicle.brightnessPercent);
    return brightness.length > 0 ? Math.max(...brightness) : null;
  }

  checkpoint() {
    return [...this.holdDeadlines] as Array<[string, number]>;
  }

  restore(deadlines: Array<[string, number]>) {
    this.holdDeadlines.clear();
    for (const [ruleId, deadline] of deadlines) this.holdDeadlines.set(ruleId, deadline);
  }
}

function createVehicleState(
  rule: VehicleEventRuleSnapshotV1,
  existing: PersistedVehicleRuleState | undefined,
  activeSourceFixtureIds: string[],
  now: Date,
  state: PersistedAutomationStateV4
): PersistedVehicleRuleState {
  const preBrightness = { ...(existing?.preBrightness ?? {}) };
  for (const fixtureId of rule.targetFixtureIds) {
    const base = captureBase(state, fixtureId);
    if (base !== null) preBrightness[fixtureId] = base;
  }
  return {
    activeSourceFixtureIds,
    targetFixtureIds: [...rule.targetFixtureIds],
    brightnessPercent: actionBrightness(rule),
    startedAt: existing?.startedAt ?? now.toISOString(),
    holdUntil: existing?.holdUntil ?? null,
    preBrightness
  };
}

function captureBase(state: PersistedAutomationStateV4, fixtureId: string) {
  const existing = state.baseBrightnessByFixture[fixtureId];
  if (existing !== undefined) return existing;
  const current = state.currentByFixture[fixtureId] ?? state.lastDesiredByFixture[fixtureId];
  if (current === undefined) return null;
  state.baseBrightnessByFixture[fixtureId] = current;
  return current;
}

function actionBrightness(rule: VehicleEventRuleSnapshotV1) {
  return rule.action.dimmingEnabled ? rule.action.brightnessPercent : 100;
}

function vehicleOccurrenceKey(ruleId: string, startedAt: string) {
  return `${ruleId}:${startedAt}`;
}

function lifecycle(
  kind: VehicleLifecycleEvent["kind"],
  ruleId: string,
  occurrenceKey: string,
  now: Date,
  payload: Record<string, unknown>
): VehicleLifecycleEvent {
  return { kind, ruleId, occurrenceKey, occurredAt: now.toISOString(), payload };
}
