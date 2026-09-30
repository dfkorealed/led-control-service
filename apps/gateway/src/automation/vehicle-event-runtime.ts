import type { AutomationSnapshotV1, AutomationSnapshotV2, VehicleEventRuleSnapshotV1 } from "@led-control/shared";
import {
  parseBioPulseReceipt,
  type BioPulseReceipt,
  type PersistedAutomationStateV4,
  type PersistedVehicleRuleState
} from "./automation-state-store";

type VehicleSnapshot = AutomationSnapshotV1 | AutomationSnapshotV2;
export type { BioPulseReceipt } from "./automation-state-store";

export type VehicleSensorInput =
  | { type: "detected"; sourceFixtureId: string }
  | { type: "cleared"; sourceFixtureId: string }
  | { type: "current-state"; sourceFixtureId: string; active: boolean }
  | { type: "pulse"; sourceFixtureId: string; receivedMonotonicMs: number; receipt: BioPulseReceipt };

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
  /** Trusted connection authority, never derived from the candidate packet. Default OFF. */
  bioConnection?: () => { epoch: string; generation: number } | null;
}

export class VehicleEventRuntime {
  private readonly wallClock: () => Date;
  private readonly monotonicClock: () => number;
  private readonly holdDeadlines = new Map<string, number>();

  constructor(private readonly options: VehicleEventRuntimeOptions = {}) {
    this.wallClock = options.wallClock ?? (() => new Date());
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
  }

  recordInput(
    state: PersistedAutomationStateV4,
    snapshot: VehicleSnapshot,
    input: VehicleSensorInput
  ): VehicleLifecycleEvent[] {
    const planned = this.planRecordInput(state, snapshot, input);
    this.restore(planned.holdDeadlines);
    return planned.events;
  }

  planRecordInput(
    state: PersistedAutomationStateV4,
    snapshot: VehicleSnapshot,
    input: VehicleSensorInput
  ) {
    const deadlines = new Map(this.holdDeadlines);
    const events = this.recordInputWithDeadlines(state, snapshot, input, deadlines);
    return { events, holdDeadlines: [...deadlines] as Array<[string, number]> };
  }

  private recordInputWithDeadlines(
    state: PersistedAutomationStateV4,
    snapshot: VehicleSnapshot,
    input: VehicleSensorInput,
    deadlines: Map<string, number>
  ): VehicleLifecycleEvent[] {
    const active = input.type === "detected" || (input.type === "current-state" && input.active);
    const now = this.wallClock();
    const monotonicNow = this.monotonicClock();
    const events: VehicleLifecycleEvent[] = [];
    const rules = snapshot.vehicleEventRules.filter((rule) =>
      rule.status === "enabled" && rule.sourceFixtureIds.includes(input.sourceFixtureId) &&
      ((snapshot.schemaVersion === 2 && "sensorProtocol" in rule && rule.sensorProtocol === "bio-usb-pulse") === (input.type === "pulse")) &&
      // Queued packets whose entire hold elapsed cannot briefly turn a target on.
      (input.type !== "pulse" || input.receivedMonotonicMs + rule.holdSeconds * 1_000 > monotonicNow)
    );
    if (input.type === "pulse" && (rules.length === 0 || !this.recordPulseReceipt(state, input, monotonicNow))) return [];

    for (const rule of rules) {
      let existing: PersistedVehicleRuleState | undefined = state.vehicleRules[rule.id];
      if (existing && (existing.sensorProtocol === "bio-usb-pulse") !== (input.type === "pulse")) {
        events.push(lifecycle("event_ended", rule.id, vehicleOccurrenceKey(rule.id, existing.startedAt), now, {
          reason: "configuration_changed", targetFixtureIds: existing.targetFixtureIds
        }));
        delete state.vehicleRules[rule.id];
        deadlines.delete(rule.id);
        existing = undefined;
      }
      const deadline = deadlines.get(rule.id);
      // Sensor input can arrive after hold expiry but before the next scheduler tick.
      // Close that activation first so High starts a new identity and cannot revive old manual suppression.
      // A restored hold without a monotonic deadline still requires trusted-UTC reconciliation.
      if (existing && existing.activeSourceFixtureIds.length === 0 && existing.holdUntil !== null &&
        deadline !== undefined && (input.type === "pulse" ? input.receivedMonotonicMs : monotonicNow) >= deadline) {
        events.push(lifecycle("event_ended", rule.id, vehicleOccurrenceKey(rule.id, existing.startedAt), now, {
          reason: "hold_expired", targetFixtureIds: existing.targetFixtureIds
        }));
        delete state.vehicleRules[rule.id];
        deadlines.delete(rule.id);
        existing = undefined;
      }
      if (input.type === "pulse") {
        const next = createVehicleState(rule, existing, [], now, state);
        next.sensorProtocol = "bio-usb-pulse";
        // A repeated pulse retains the activation's original target base even if
        // a subsequent manual command has established a newer current baseline.
        if (existing) next.preBrightness = { ...next.preBrightness, ...existing.preBrightness };
        const deadline = input.receivedMonotonicMs + rule.holdSeconds * 1_000;
        next.holdUntil = new Date(now.getTime() + deadline - monotonicNow).toISOString();
        deadlines.set(rule.id, deadline);
        state.vehicleRules[rule.id] = next;
        const occurrenceKey = vehicleOccurrenceKey(rule.id, next.startedAt);
        const payload = { sourceFixtureId: input.sourceFixtureId, sensorProtocol: "bio-usb-pulse", inputType: "pulse" };
        events.push(lifecycle("vehicle_detected", rule.id, occurrenceKey, now, payload));
        events.push(lifecycle(existing ? "event_extended" : "event_started", rule.id, occurrenceKey, now, {
          ...payload, holdUntil: next.holdUntil, brightnessPercent: next.brightnessPercent,
          targetFixtureIds: next.targetFixtureIds
        }));
        continue;
      }
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

  private recordPulseReceipt(
    state: PersistedAutomationStateV4,
    input: Extract<VehicleSensorInput, { type: "pulse" }>,
    monotonicNow: number
  ) {
    const connection = this.options.bioConnection?.();
    let receipt: BioPulseReceipt;
    try { receipt = parseBioPulseReceipt(input.receipt); } catch { return false; }
    if (!connection || receipt.connectionEpoch !== connection.epoch || receipt.connectionGeneration !== connection.generation ||
      !Number.isFinite(input.receivedMonotonicMs) || input.receivedMonotonicMs < 0 || input.receivedMonotonicMs > monotonicNow) return false;
    const previous = state.bioPulseInbox[input.sourceFixtureId];
    if (previous && (previous.receipt.nativeUuid !== receipt.nativeUuid || previous.receipt.logicalAddress !== receipt.logicalAddress ||
      previous.receipt.networkId !== receipt.networkId)) return false;
    const sameConnection = previous?.receipt.connectionEpoch === receipt.connectionEpoch &&
      previous.receipt.connectionGeneration === receipt.connectionGeneration;
    if (sameConnection && input.receivedMonotonicMs <= previous.lastReceivedMonotonicMs) return false;
    // A short software duplicate window, not sequence ordering or a HIL timing claim.
    // Expiring entries allows 8-bit wrap and reboot reuse; production qualification stays OFF.
    const recentReceipts = sameConnection ? previous.recentReceipts.filter(entry =>
      input.receivedMonotonicMs - entry.receivedMonotonicMs < 2_000) : [];
    if (recentReceipts.some(entry => entry.sequence === receipt.sequence)) return false;
    recentReceipts.push({ sequence: receipt.sequence, receivedMonotonicMs: input.receivedMonotonicMs });
    state.bioPulseInbox[input.sourceFixtureId] = { receipt, lastReceivedMonotonicMs: input.receivedMonotonicMs, recentReceipts };
    return true;
  }

  reconcile(
    state: PersistedAutomationStateV4,
    snapshot: VehicleSnapshot,
    trustedUtc: boolean
  ): VehicleLifecycleEvent[] {
    const planned = this.planReconcile(state, snapshot, trustedUtc);
    this.restore(planned.holdDeadlines);
    return planned.events;
  }

  planReconcile(
    state: PersistedAutomationStateV4,
    snapshot: VehicleSnapshot,
    trustedUtc: boolean
  ) {
    const deadlines = new Map(this.holdDeadlines);
    const events = this.reconcileWithDeadlines(state, snapshot, trustedUtc, deadlines);
    return { events, holdDeadlines: [...deadlines] as Array<[string, number]> };
  }

  private reconcileWithDeadlines(
    state: PersistedAutomationStateV4,
    snapshot: VehicleSnapshot,
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
      if (!rule || rule.status !== "enabled" ||
        (vehicle.sensorProtocol === "bio-usb-pulse") !== ("sensorProtocol" in rule && rule.sensorProtocol === "bio-usb-pulse")) {
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
      // Persisted BIO wall-clock deadlines cannot authorize restart expiry. Task4
      // establishes a new full observation window after independent health recovery.
      if (deadline === undefined && trustedUtc && !("sensorProtocol" in rule && rule.sensorProtocol === "bio-usb-pulse")) {
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
