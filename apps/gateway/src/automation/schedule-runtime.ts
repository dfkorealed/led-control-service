import { getActiveOccurrence } from "@led-control/automation-engine";
import {
  GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS,
  type AutomationExecutionFixtureResultV1,
  type AutomationSnapshotV1,
  type LightingScheduleSnapshotV1,
  type VehicleEventRuleSnapshotV1
} from "@led-control/shared";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import {
  resolveDesiredState,
  type ResolvedLightingState,
  type ResolvedLightingSource
} from "./automation-arbiter";
import type { ClockTrustProvider } from "./clock-trust-provider";
import {
  FileAutomationStateStore,
  type PersistedAutomationStateV3,
  type PersistedVehicleRuleState
} from "./automation-state-store";
import type { DesiredLightingState } from "./automation-runtime";

export interface DesiredLightingAction {
  fixtureId: string;
  brightnessPercent: number;
  sourceType: ResolvedLightingSource;
  sourceId: string | null;
  occurrenceKey: string | null;
}

export interface ManualOverrideInput {
  sourceId: string;
  fixtureIds: string[];
  brightnessPercent: number;
  startedAt: string;
  overrideUntil: string;
  deliveryWindowMs: number;
  overrideRemainingMs?: number;
}

export interface AutomationTerminalHandoff {
  revision: number;
  actions: DesiredLightingAction[];
  results: AutomationExecutionFixtureResultV1[];
}

export interface ScheduleRuntimeOptions {
  store: FileAutomationStateStore;
  wallClock?: () => Date;
  monotonicClock?: () => number;
  clockTrust: ClockTrustProvider;
  execute: (actions: DesiredLightingAction[]) => Promise<AutomationExecutionFixtureResultV1[]>;
  requestFixtureObservation?: (fixtureIds: string[]) => Promise<void> | void;
  onTerminalResults?: (handoff: AutomationTerminalHandoff) => Promise<void>;
  onError?: (error: unknown) => void;
  tickIntervalMs?: number;
}

interface ComputedDesiredState {
  desired: DesiredLightingState;
  actions: Map<string, DesiredLightingAction>;
}

interface ActivationCheckpoint {
  snapshot: AutomationSnapshotV1 | null;
  state: PersistedAutomationStateV3;
  vehicleHoldDeadlines: Array<[string, number]>;
  manualOverrideDeadlines: Array<[string, number]>;
  recoveredManualPendingTrust: string[];
}

const DEFAULT_TICK_INTERVAL_MS = 1_000;

export class ScheduleRuntime {
  private readonly queue = new SerialTaskQueue();
  private readonly wallClock: () => Date;
  private readonly monotonicClock: () => number;
  private snapshot: AutomationSnapshotV1 | null = null;
  private initialized = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly vehicleHoldDeadlines = new Map<string, number>();
  private readonly manualOverrideDeadlines = new Map<string, number>();
  private readonly recoveredManualPendingTrust = new Set<string>();
  private readonly manualCommandsInFlight = new Set<string>();
  private readonly pendingObservationFixtures = new Set<string>();
  private activationCheckpoint: ActivationCheckpoint | null = null;
  private activationSettled: Promise<void> = Promise.resolve();
  private settleActivation: (() => void) | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly acceptedOperations = new Set<Promise<unknown>>();

  constructor(private readonly options: ScheduleRuntimeOptions) {
    this.wallClock = options.wallClock ?? (() => new Date());
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
  }

  initialize() {
    return this.enqueue(async () => {
      if (this.initialized) return this.state();
      const state = await this.options.store.initialize();
      for (const fixtureId of Object.keys(state.manualOverrides)) {
        this.recoveredManualPendingTrust.add(fixtureId);
      }
      for (const fixtureId of Object.keys(state.unverifiedDesiredByFixture)) {
        this.pendingObservationFixtures.add(fixtureId);
      }
      for (const [fixtureId, transition] of Object.entries(state.transitionsByFixture)) {
        if (transition.phase === "pending") this.pendingObservationFixtures.add(fixtureId);
      }
      this.initialized = true;
      return state;
    });
  }

  state() {
    return this.options.store.read();
  }

  get currentSnapshot() {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  recompute(snapshot: AutomationSnapshotV1): Promise<DesiredLightingState> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      if (this.activationCheckpoint) throw new Error("automation config activation is already pending");
      this.beginActivation();
      const computed = await this.reconcile(snapshot);
      this.snapshot = snapshot;
      return computed.desired;
    });
  }

  commitActivation(): Promise<void> {
    return this.enqueue(async () => {
      this.finishActivation();
    }, Boolean(this.activationCheckpoint));
  }

  rollbackActivation(): Promise<void> {
    return this.enqueue(async () => {
      const checkpoint = this.activationCheckpoint;
      if (!checkpoint) return;
      try {
        await this.options.store.update(() => structuredClone(checkpoint.state));
        this.snapshot = checkpoint.snapshot ? structuredClone(checkpoint.snapshot) : null;
        this.vehicleHoldDeadlines.clear();
        for (const [ruleId, deadline] of checkpoint.vehicleHoldDeadlines) {
          this.vehicleHoldDeadlines.set(ruleId, deadline);
        }
        this.manualOverrideDeadlines.clear();
        for (const [fixtureId, deadline] of checkpoint.manualOverrideDeadlines) {
          this.manualOverrideDeadlines.set(fixtureId, deadline);
        }
        this.recoveredManualPendingTrust.clear();
        for (const fixtureId of checkpoint.recoveredManualPendingTrust) {
          this.recoveredManualPendingTrust.add(fixtureId);
        }
      } finally {
        this.finishActivation();
      }
    }, Boolean(this.activationCheckpoint));
  }

  applyDesiredState(_next: DesiredLightingState, _previous: DesiredLightingState): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      if (!this.snapshot) return;
      await this.applyComputed(this.computeDesired(this.snapshot, this.state()));
    }, Boolean(this.activationCheckpoint));
  }

  tick(): Promise<void> {
    if (this.activationCheckpoint || this.stopping) return Promise.resolve();
    return this.enqueue(async () => {
      await this.ensureInitialized();
      if (!this.snapshot) return;
      const computed = await this.reconcile(this.snapshot);
      await this.applyComputed(computed);
    });
  }

  start() {
    if (this.stopping) throw new Error("automation_runtime_stopping");
    if (this.timer) return;
    const interval = this.options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    if (!Number.isInteger(interval) || interval < 250) throw new Error("automation tick interval must be at least 250ms");
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.options.onError?.(error));
    }, interval);
    this.timer.unref();
  }

  stopAndDrain() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopPromise = (async () => {
      await this.activationSettled;
      while (this.acceptedOperations.size > 0) {
        await Promise.allSettled([...this.acceptedOperations]);
      }
      await this.queue.run(async () => undefined);
    })();
    return this.stopPromise;
  }

  recordFixtureState(fixtureId: string, brightness: number, observedAt = this.wallClock().toISOString()): Promise<void> {
    return this.runExternal(async () => {
      await this.ensureInitialized();
      validateBrightness(brightness);
      let recoveredAction: DesiredLightingAction | null = null;
      let recoveredResult: AutomationExecutionFixtureResultV1 | null = null;
      await this.options.store.update((state) => {
        state.currentByFixture[fixtureId] = brightness;
        const transition = state.transitionsByFixture[fixtureId];
        const legacyDesired = state.unverifiedDesiredByFixture[fixtureId];
        if (this.pendingObservationFixtures.has(fixtureId) &&
          (legacyDesired !== undefined || transition?.phase === "pending")) {
          const expected = transition?.phase === "pending" ? transition.brightnessPercent : legacyDesired!;
          const matched = brightness === expected;
          recoveredAction = transition?.phase === "pending" ? {
            fixtureId,
            brightnessPercent: transition.brightnessPercent,
            sourceType: transition.sourceType,
            sourceId: transition.sourceId,
            occurrenceKey: transition.occurrenceKey
          } : {
            fixtureId,
            brightnessPercent: expected,
            sourceType: "current",
            sourceId: null,
            occurrenceKey: null
          };
          recoveredResult = {
            fixtureId,
            status: matched ? "succeeded" : "failed",
            brightnessPercent: brightness,
            faultCode: matched ? null : "state_mismatch",
            errorCode: matched ? null : "state_mismatch",
            occurredAt: observedAt
          };
          state.transitionsByFixture[fixtureId] = {
            ...(transition?.phase === "pending" ? transition : {
              brightnessPercent: expected,
              sourceType: "current" as const,
              sourceId: null,
              occurrenceKey: null,
              attempt: 1,
              startedAt: observedAt
            }),
            phase: "terminal",
            status: matched ? "succeeded" : "failed",
            terminalAt: observedAt
          };
          delete state.unverifiedDesiredByFixture[fixtureId];
          state.lastDesiredByFixture[fixtureId] = brightness;
        } else if (!transition || (transition.phase === "terminal" && transition.status === "succeeded")) {
          state.lastDesiredByFixture[fixtureId] = brightness;
        }
        if (!hasActiveSource(state, fixtureId)) delete state.baseBrightnessByFixture[fixtureId];
        return state;
      });
      if (recoveredAction && recoveredResult) {
        this.pendingObservationFixtures.delete(fixtureId);
        await this.handoff([recoveredAction], [recoveredResult]);
      }
      if (!this.snapshot) return;
      await this.captureMissingBases(this.snapshot);
      await this.applyComputed(this.computeDesired(this.snapshot, this.state()));
    });
  }

  prepareManualOverride(input: ManualOverrideInput): Promise<void> {
    return this.runExternal(async () => {
      await this.ensureInitialized();
      validateManualOverride(input);
      const wallNow = this.wallClock();
      const monotonicNow = this.monotonicClock();
      const durationMs = Date.parse(input.overrideUntil) - Date.parse(input.startedAt);
      const trusted = await this.options.clockTrust.isTrusted(wallNow);
      const remainingMs = trusted
        ? Math.min(
          Date.parse(input.overrideUntil) - wallNow.getTime(),
          input.overrideRemainingMs ?? Number.POSITIVE_INFINITY
        )
        : input.overrideRemainingMs ?? Math.min(
          durationMs,
          input.deliveryWindowMs,
          GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS
        );
      if (remainingMs <= 0) throw new ScheduleRuntimeError("manual_override_expired");
      await this.options.store.update((state) => {
        for (const fixtureId of input.fixtureIds) {
          const base = captureBase(state, fixtureId);
          if (base === null) throw new ScheduleRuntimeError("automation_current_state_unavailable");
          state.manualOverrides[fixtureId] = {
            sourceId: input.sourceId,
            brightnessPercent: input.brightnessPercent,
            startedAt: input.startedAt,
            overrideUntil: input.overrideUntil,
            preBrightness: base
          };
          const previous = state.transitionsByFixture[fixtureId];
          state.transitionsByFixture[fixtureId] = {
            phase: "pending",
            brightnessPercent: input.brightnessPercent,
            sourceType: "manual_override",
            sourceId: input.sourceId,
            occurrenceKey: null,
            attempt: previous?.sourceId === input.sourceId ? previous.attempt + 1 : 1,
            startedAt: input.startedAt,
            status: null,
            terminalAt: null
          };
        }
        return state;
      });
      for (const fixtureId of input.fixtureIds) {
        this.recoveredManualPendingTrust.delete(fixtureId);
        this.manualCommandsInFlight.add(fixtureId);
        this.manualOverrideDeadlines.set(fixtureId, monotonicNow + remainingMs);
      }
    });
  }

  handoffManualTerminal(
    sourceId: string,
    results: AutomationExecutionFixtureResultV1[]
  ): Promise<void> {
    return this.runExternal(async () => {
      await this.ensureInitialized();
      const actions: DesiredLightingAction[] = [];
      const settledFixtures: Array<{ fixtureId: string; failed: boolean }> = [];
      await this.options.store.update((state) => {
        for (const result of results) {
          const override = state.manualOverrides[result.fixtureId];
          if (override?.sourceId !== sourceId) continue;
          actions.push({
            fixtureId: result.fixtureId,
            brightnessPercent: override.brightnessPercent,
            sourceType: "manual_override",
            sourceId,
            occurrenceKey: null
          });
          const pending = state.transitionsByFixture[result.fixtureId];
          state.transitionsByFixture[result.fixtureId] = {
            ...(pending ?? {
              brightnessPercent: override.brightnessPercent,
              sourceType: "manual_override",
              sourceId,
              occurrenceKey: null,
              attempt: 1,
              startedAt: override.startedAt
            }),
            phase: "terminal",
            status: result.status,
            terminalAt: result.occurredAt
          };
          if (result.brightnessPercent !== null) {
            state.currentByFixture[result.fixtureId] = result.brightnessPercent;
            if (result.status === "succeeded") {
              state.lastDesiredByFixture[result.fixtureId] = result.brightnessPercent;
              if (!hasActiveAutomaticSource(state, result.fixtureId)) {
                state.baseBrightnessByFixture[result.fixtureId] = result.brightnessPercent;
              }
            }
          }
          if (result.status !== "succeeded") {
            delete state.manualOverrides[result.fixtureId];
          }
          settledFixtures.push({ fixtureId: result.fixtureId, failed: result.status !== "succeeded" });
        }
        return state;
      });
      for (const settled of settledFixtures) {
        this.recoveredManualPendingTrust.delete(settled.fixtureId);
        this.manualCommandsInFlight.delete(settled.fixtureId);
        this.pendingObservationFixtures.delete(settled.fixtureId);
        if (settled.failed) this.manualOverrideDeadlines.delete(settled.fixtureId);
      }
      await this.handoff(actions, results);
    });
  }

  recordVehicleSensorState(sourceFixtureId: string, active: boolean): Promise<void> {
    return this.runExternal(async () => {
      await this.ensureInitialized();
      if (!this.snapshot) return;
      const now = this.wallClock();
      const monotonicNow = this.monotonicClock();
      const rules = this.snapshot.vehicleEventRules.filter((rule) =>
        rule.status === "enabled" && rule.sourceFixtureIds.includes(sourceFixtureId)
      );
      await this.options.store.update((state) => {
        for (const rule of rules) {
          const existing = state.vehicleRules[rule.id];
          if (!active && !existing?.activeSourceFixtureIds.includes(sourceFixtureId)) continue;
          const sources = new Set(existing?.activeSourceFixtureIds ?? []);
          if (active) sources.add(sourceFixtureId);
          else sources.delete(sourceFixtureId);

          const next = vehicleState(rule, existing, [...sources].sort(), now, state);
          if (!active && sources.size === 0) {
            next.holdUntil = new Date(now.getTime() + rule.holdSeconds * 1_000).toISOString();
            this.vehicleHoldDeadlines.set(rule.id, monotonicNow + rule.holdSeconds * 1_000);
          } else if (active) {
            next.holdUntil = null;
            this.vehicleHoldDeadlines.delete(rule.id);
          }
          state.vehicleRules[rule.id] = next;
        }
        return state;
      });
      await this.captureMissingBases(this.snapshot);
      await this.applyComputed(this.computeDesired(this.snapshot, this.state()));
    });
  }

  private async reconcile(snapshot: AutomationSnapshotV1): Promise<ComputedDesiredState> {
    const now = this.wallClock();
    const trusted = await this.options.clockTrust.isTrusted(now);
    const monotonicNow = this.monotonicClock();
    await this.options.store.update((state) => {
      reconcileManualOverrides(
        state,
        now,
        monotonicNow,
        trusted,
        this.manualOverrideDeadlines,
        this.recoveredManualPendingTrust
      );
      reconcileVehicleRules(state, snapshot, now, monotonicNow, trusted, this.vehicleHoldDeadlines);
      reconcileSchedules(state, snapshot, now, trusted);
      return state;
    });
    await this.captureMissingBases(snapshot);
    return this.computeDesired(snapshot, this.state());
  }

  private async captureMissingBases(snapshot: AutomationSnapshotV1) {
    await this.options.store.update((state) => {
      for (const [scheduleId, occurrence] of Object.entries(state.activeOccurrences)) {
        const schedule = snapshot.schedules.find((candidate) => candidate.id === scheduleId);
        if (!schedule) continue;
        for (const fixtureId of schedule.fixtureIds) {
          const base = captureBase(state, fixtureId);
          if (base !== null) occurrence.preBrightness[fixtureId] = base;
        }
      }
      for (const vehicle of Object.values(state.vehicleRules)) {
        for (const fixtureId of vehicle.targetFixtureIds) {
          const base = captureBase(state, fixtureId);
          if (base !== null) vehicle.preBrightness[fixtureId] = base;
        }
      }
      return state;
    });
  }

  private computeDesired(snapshot: AutomationSnapshotV1, state: PersistedAutomationStateV3): ComputedDesiredState {
    const actions = new Map<string, DesiredLightingAction>();
    const desired: Record<string, number> = {};
    const fixtures = relevantFixtures(snapshot, state);

    for (const fixtureId of fixtures) {
      const recoveredManual = this.recoveredManualPendingTrust.has(fixtureId)
        ? state.manualOverrides[fixtureId]
        : undefined;
      const manual = recoveredManual ? undefined : state.manualOverrides[fixtureId];
      const events = Object.entries(state.vehicleRules)
        .filter(([, vehicle]) => vehicle.targetFixtureIds.includes(fixtureId))
        .map(([ruleId, vehicle]) => ({ sourceId: ruleId, brightness: vehicle.brightnessPercent }));
      const schedule = activeScheduleCandidate(snapshot, state, fixtureId);
      const hasSource = Boolean(manual || events.length > 0 || schedule);
      if (hasSource && state.baseBrightnessByFixture[fixtureId] === undefined) continue;
      const current = (recoveredManual
        ? state.currentByFixture[fixtureId] ?? state.lastDesiredByFixture[fixtureId]
        : state.baseBrightnessByFixture[fixtureId])
        ?? state.currentByFixture[fixtureId]
        ?? state.lastDesiredByFixture[fixtureId]
        ?? null;
      const resolved = resolveDesiredState({
        manual: manual ? { sourceId: manual.sourceId, brightness: manual.brightnessPercent } : null,
        events,
        schedule,
        current
      });
      desired[fixtureId] = resolved.brightness;
      actions.set(fixtureId, toAction(fixtureId, resolved));
    }

    return {
      desired: Object.fromEntries(Object.entries(desired).sort(([left], [right]) => left.localeCompare(right))),
      actions
    };
  }

  private async applyComputed(computed: ComputedDesiredState) {
    const state = this.state();
    const changed = [...computed.actions.values()].filter((action) =>
      state.lastDesiredByFixture[action.fixtureId] !== action.brightnessPercent &&
      !this.pendingObservationFixtures.has(action.fixtureId) &&
      !(action.sourceType === "manual_override" && this.manualCommandsInFlight.has(action.fixtureId))
    );
    const settledBaseFixtures = [...computed.actions.values()]
      .filter((action) =>
        action.sourceType === "current" &&
        state.baseBrightnessByFixture[action.fixtureId] !== undefined &&
        state.lastDesiredByFixture[action.fixtureId] === action.brightnessPercent
      )
      .map((action) => action.fixtureId);

    if (changed.length === 0 && settledBaseFixtures.length === 0) return;
    const pendingAt = this.wallClock().toISOString();
    await this.options.store.update((next) => {
      for (const action of changed) {
        const previous = next.transitionsByFixture[action.fixtureId];
        next.transitionsByFixture[action.fixtureId] = {
          phase: "pending",
          brightnessPercent: action.brightnessPercent,
          sourceType: action.sourceType,
          sourceId: action.sourceId,
          occurrenceKey: action.occurrenceKey,
          attempt: previous && sameTransition(previous, action) ? previous.attempt + 1 : 1,
          startedAt: pendingAt,
          status: null,
          terminalAt: null
        };
      }
      for (const fixtureId of settledBaseFixtures) {
        if (!hasActiveSource(next, fixtureId)) delete next.baseBrightnessByFixture[fixtureId];
      }
      return next;
    });
    if (changed.length === 0) return;

    let results: AutomationExecutionFixtureResultV1[];
    try {
      results = validateTerminalResults(changed, await this.options.execute(changed));
    } catch (error) {
      results = failedResults(changed, this.wallClock(), error);
    }

    try {
      await this.options.store.update((next) => {
        for (const [index, result] of results.entries()) {
          const action = changed[index]!;
          const pending = next.transitionsByFixture[result.fixtureId];
          next.transitionsByFixture[result.fixtureId] = {
            ...(pending ?? {
              brightnessPercent: action.brightnessPercent,
              sourceType: action.sourceType,
              sourceId: action.sourceId,
              occurrenceKey: action.occurrenceKey,
              attempt: 1,
              startedAt: result.occurredAt
            }),
            phase: "terminal",
            status: result.status,
            terminalAt: result.occurredAt
          };
          if (result.brightnessPercent === null) continue;
          next.currentByFixture[result.fixtureId] = result.brightnessPercent;
          if (result.status === "succeeded") {
            next.lastDesiredByFixture[result.fixtureId] = result.brightnessPercent;
          }
          if (result.status === "succeeded" && action.sourceType === "current" && !hasActiveSource(next, result.fixtureId)) {
            delete next.baseBrightnessByFixture[result.fixtureId];
          }
        }
        return next;
      });
    } catch (error) {
      const fencedFixtureIds: string[] = [];
      for (const result of results) {
        if (result.status !== "succeeded") continue;
        this.pendingObservationFixtures.add(result.fixtureId);
        fencedFixtureIds.push(result.fixtureId);
      }
      if (fencedFixtureIds.length > 0) {
        try {
          void Promise.resolve(this.options.requestFixtureObservation?.(fencedFixtureIds))
            .catch((requestError) => this.options.onError?.(requestError));
        } catch (requestError) {
          this.options.onError?.(requestError);
        }
      }
      throw error;
    }
    await this.handoff(changed, results);
  }

  private async handoff(actions: DesiredLightingAction[], results: AutomationExecutionFixtureResultV1[]) {
    if (!this.options.onTerminalResults || !this.snapshot || actions.length === 0) return;
    try {
      await this.options.onTerminalResults({ revision: this.snapshot.revision, actions, results });
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private async ensureInitialized() {
    if (!this.initialized) await this.options.store.initialize();
    this.initialized = true;
  }

  private beginActivation() {
    this.activationCheckpoint = {
      snapshot: this.snapshot ? structuredClone(this.snapshot) : null,
      state: this.state(),
      vehicleHoldDeadlines: [...this.vehicleHoldDeadlines],
      manualOverrideDeadlines: [...this.manualOverrideDeadlines],
      recoveredManualPendingTrust: [...this.recoveredManualPendingTrust]
    };
    this.activationSettled = new Promise<void>((resolve) => { this.settleActivation = resolve; });
  }

  private finishActivation() {
    this.activationCheckpoint = null;
    this.settleActivation?.();
    this.settleActivation = null;
    this.activationSettled = Promise.resolve();
  }

  private async runExternal<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error("automation_runtime_stopping");
    return this.track(this.activationSettled.then(() => this.queue.run(operation)));
  }

  private enqueue<T>(operation: () => Promise<T>, allowWhileStopping = false) {
    if (this.stopping && !allowWhileStopping) {
      return Promise.reject(new Error("automation_runtime_stopping"));
    }
    return this.track(this.queue.run(operation));
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.acceptedOperations.add(operation);
    void operation.then(
      () => this.acceptedOperations.delete(operation),
      () => this.acceptedOperations.delete(operation)
    );
    return operation;
  }
}

function sameTransition(
  previous: PersistedAutomationStateV3["transitionsByFixture"][string],
  action: DesiredLightingAction
) {
  return previous.brightnessPercent === action.brightnessPercent && previous.sourceType === action.sourceType &&
    previous.sourceId === action.sourceId && previous.occurrenceKey === action.occurrenceKey;
}

export class ScheduleRuntimeError extends Error {
  constructor(readonly code: "automation_current_state_unavailable" | "manual_override_expired") {
    super(code);
    this.name = "ScheduleRuntimeError";
  }
}

function reconcileManualOverrides(
  state: PersistedAutomationStateV3,
  now: Date,
  monotonicNow: number,
  trusted: boolean,
  deadlines: Map<string, number>,
  recoveredPendingTrust: Set<string>
) {
  for (const [fixtureId, override] of Object.entries(state.manualOverrides)) {
    let deadline = deadlines.get(fixtureId);
    if (deadline === undefined && trusted) {
      const remaining = Date.parse(override.overrideUntil) - now.getTime();
      if (remaining <= 0) {
        delete state.manualOverrides[fixtureId];
        recoveredPendingTrust.delete(fixtureId);
        continue;
      }
      deadline = monotonicNow + remaining;
      deadlines.set(fixtureId, deadline);
      recoveredPendingTrust.delete(fixtureId);
    }
    if (deadline !== undefined && monotonicNow >= deadline) {
      delete state.manualOverrides[fixtureId];
      deadlines.delete(fixtureId);
      recoveredPendingTrust.delete(fixtureId);
    }
  }
}

function reconcileSchedules(
  state: PersistedAutomationStateV3,
  snapshot: AutomationSnapshotV1,
  now: Date,
  trusted: boolean
) {
  const schedules = new Map(snapshot.schedules.map((schedule) => [schedule.id, schedule]));
  for (const scheduleId of Object.keys(state.activeOccurrences)) {
    const schedule = schedules.get(scheduleId);
    if (!schedule || schedule.status !== "enabled") {
      delete state.activeOccurrences[scheduleId];
      continue;
    }
    if (!trusted) continue;
    const active = getActiveOccurrence(schedule, now.getTime(), snapshot.timeZone);
    if (!active || active.key !== state.activeOccurrences[scheduleId]?.key) delete state.activeOccurrences[scheduleId];
  }
  if (!trusted) return;

  for (const schedule of snapshot.schedules) {
    const active = getActiveOccurrence(schedule, now.getTime(), snapshot.timeZone);
    if (!active || state.activeOccurrences[schedule.id]?.key === active.key) continue;
    const preBrightness: Record<string, number> = {};
    let complete = true;
    for (const fixtureId of schedule.fixtureIds) {
      const base = captureBase(state, fixtureId);
      if (base === null) {
        complete = false;
        break;
      }
      preBrightness[fixtureId] = base;
    }
    if (!complete) continue;
    state.activeOccurrences[schedule.id] = {
      key: active.key,
      startedAt: new Date(active.startsAtEpochMs).toISOString(),
      endsAt: new Date(active.endsAtEpochMs).toISOString(),
      preBrightness
    };
  }
}

function reconcileVehicleRules(
  state: PersistedAutomationStateV3,
  snapshot: AutomationSnapshotV1,
  now: Date,
  monotonicNow: number,
  trusted: boolean,
  deadlines: Map<string, number>
) {
  const rules = new Map(snapshot.vehicleEventRules.map((rule) => [rule.id, rule]));
  for (const [ruleId, vehicle] of Object.entries(state.vehicleRules)) {
    const rule = rules.get(ruleId);
    if (!rule || rule.status !== "enabled") {
      delete state.vehicleRules[ruleId];
      deadlines.delete(ruleId);
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
      continue;
    }
    if (vehicle.activeSourceFixtureIds.length > 0 || vehicle.holdUntil === null) continue;
    let deadline = deadlines.get(ruleId);
    if (deadline === undefined && trusted) {
      const remaining = Date.parse(vehicle.holdUntil) - now.getTime();
      if (remaining <= 0) {
        delete state.vehicleRules[ruleId];
        continue;
      }
      deadline = monotonicNow + remaining;
      deadlines.set(ruleId, deadline);
    }
    if (deadline !== undefined && monotonicNow >= deadline) {
      delete state.vehicleRules[ruleId];
      deadlines.delete(ruleId);
    }
  }
}

function vehicleState(
  rule: VehicleEventRuleSnapshotV1,
  existing: PersistedVehicleRuleState | undefined,
  activeSourceFixtureIds: string[],
  now: Date,
  state: PersistedAutomationStateV3
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

function activeScheduleCandidate(
  snapshot: AutomationSnapshotV1,
  state: PersistedAutomationStateV3,
  fixtureId: string
) {
  for (const [scheduleId, occurrence] of Object.entries(state.activeOccurrences)) {
    const schedule = snapshot.schedules.find((candidate) =>
      candidate.id === scheduleId && candidate.fixtureIds.includes(fixtureId)
    );
    if (schedule) {
      return {
        sourceId: scheduleId,
        occurrenceKey: occurrence.key,
        brightness: actionBrightness(schedule)
      };
    }
  }
  return null;
}

function actionBrightness(rule: LightingScheduleSnapshotV1 | VehicleEventRuleSnapshotV1) {
  return rule.action.dimmingEnabled ? rule.action.brightnessPercent : 100;
}

function captureBase(state: PersistedAutomationStateV3, fixtureId: string): number | null {
  const existing = state.baseBrightnessByFixture[fixtureId];
  if (existing !== undefined) return existing;
  const current = state.currentByFixture[fixtureId] ?? state.lastDesiredByFixture[fixtureId];
  if (current === undefined) return null;
  state.baseBrightnessByFixture[fixtureId] = current;
  return current;
}

function relevantFixtures(snapshot: AutomationSnapshotV1, state: PersistedAutomationStateV3) {
  const fixtures = new Set([
    ...Object.keys(state.currentByFixture),
    ...Object.keys(state.baseBrightnessByFixture),
    ...Object.keys(state.lastDesiredByFixture),
    ...Object.keys(state.unverifiedDesiredByFixture),
    ...Object.keys(state.manualOverrides),
    ...snapshot.schedules.flatMap((schedule) => schedule.fixtureIds),
    ...Object.values(state.vehicleRules).flatMap((vehicle) => vehicle.targetFixtureIds)
  ]);
  return [...fixtures].sort();
}

function hasActiveSource(state: PersistedAutomationStateV3, fixtureId: string) {
  if (state.manualOverrides[fixtureId]) return true;
  return hasActiveAutomaticSource(state, fixtureId);
}

function hasActiveAutomaticSource(state: PersistedAutomationStateV3, fixtureId: string) {
  if (Object.values(state.activeOccurrences).some((occurrence) => occurrence.preBrightness[fixtureId] !== undefined)) return true;
  return Object.values(state.vehicleRules).some((vehicle) => vehicle.targetFixtureIds.includes(fixtureId));
}

function toAction(fixtureId: string, resolved: ResolvedLightingState): DesiredLightingAction {
  return {
    fixtureId,
    brightnessPercent: resolved.brightness,
    sourceType: resolved.sourceType,
    sourceId: resolved.sourceId,
    occurrenceKey: resolved.occurrenceKey
  };
}

function validateTerminalResults(
  actions: DesiredLightingAction[],
  results: AutomationExecutionFixtureResultV1[]
) {
  const expected = new Set(actions.map((action) => action.fixtureId));
  if (
    results.length !== expected.size ||
    results.some((result) => !expected.has(result.fixtureId)) ||
    new Set(results.map((result) => result.fixtureId)).size !== results.length
  ) {
    throw new Error("automation executor returned an invalid fixture result set");
  }
  const byFixture = new Map(results.map((result) => [result.fixtureId, result]));
  return actions.map((action) => byFixture.get(action.fixtureId)!);
}

function failedResults(actions: DesiredLightingAction[], now: Date, error: unknown): AutomationExecutionFixtureResultV1[] {
  const code = error instanceof Error && error.message.length > 0
    ? sanitizeErrorCode(error.message)
    : "automation_mesh_execution_failed";
  return actions.map((action) => ({
    fixtureId: action.fixtureId,
    status: "failed",
    brightnessPercent: null,
    faultCode: null,
    errorCode: code,
    occurredAt: now.toISOString()
  }));
}

function sanitizeErrorCode(value: string) {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 128);
  return sanitized || "automation_mesh_execution_failed";
}

function validateManualOverride(input: ManualOverrideInput) {
  validateBrightness(input.brightnessPercent);
  if (input.fixtureIds.length === 0 || new Set(input.fixtureIds).size !== input.fixtureIds.length) {
    throw new Error("manual override fixtures must be non-empty and unique");
  }
  if (Date.parse(input.startedAt) >= Date.parse(input.overrideUntil)) {
    throw new Error("manual override must end after it starts");
  }
  if (!Number.isSafeInteger(input.deliveryWindowMs) || input.deliveryWindowMs <= 0) {
    throw new Error("manual override delivery window must be a positive safe integer");
  }
  if (input.overrideRemainingMs !== undefined &&
    (!Number.isSafeInteger(input.overrideRemainingMs) || input.overrideRemainingMs <= 0)) {
    throw new Error("manual override remaining duration must be a positive safe integer");
  }
}

function validateBrightness(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("invalid brightness");
}
