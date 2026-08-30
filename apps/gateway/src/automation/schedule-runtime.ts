import { getActiveOccurrence } from "@led-control/automation-engine";
import type {
  AutomationExecutionFixtureResultV1,
  AutomationSnapshotV1,
  LightingScheduleSnapshotV1,
  VehicleEventRuleSnapshotV1
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
  type PersistedAutomationStateV1,
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
  state: PersistedAutomationStateV1;
  vehicleHoldDeadlines: Array<[string, number]>;
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
  private activationCheckpoint: ActivationCheckpoint | null = null;
  private activationSettled: Promise<void> = Promise.resolve();
  private settleActivation: (() => void) | null = null;

  constructor(private readonly options: ScheduleRuntimeOptions) {
    this.wallClock = options.wallClock ?? (() => new Date());
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
  }

  initialize() {
    return this.queue.run(async () => {
      if (this.initialized) return this.state();
      const state = await this.options.store.initialize();
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
    return this.queue.run(async () => {
      await this.ensureInitialized();
      if (this.activationCheckpoint) throw new Error("automation config activation is already pending");
      this.beginActivation();
      const computed = await this.reconcile(snapshot);
      this.snapshot = snapshot;
      return computed.desired;
    });
  }

  commitActivation(): Promise<void> {
    return this.queue.run(async () => {
      this.finishActivation();
    });
  }

  rollbackActivation(): Promise<void> {
    return this.queue.run(async () => {
      const checkpoint = this.activationCheckpoint;
      if (!checkpoint) return;
      try {
        await this.options.store.update(() => structuredClone(checkpoint.state));
        this.snapshot = checkpoint.snapshot ? structuredClone(checkpoint.snapshot) : null;
        this.vehicleHoldDeadlines.clear();
        for (const [ruleId, deadline] of checkpoint.vehicleHoldDeadlines) {
          this.vehicleHoldDeadlines.set(ruleId, deadline);
        }
      } finally {
        this.finishActivation();
      }
    });
  }

  applyDesiredState(_next: DesiredLightingState, _previous: DesiredLightingState): Promise<void> {
    return this.queue.run(async () => {
      await this.ensureInitialized();
      if (!this.snapshot) return;
      await this.applyComputed(this.computeDesired(this.snapshot, this.state()));
    });
  }

  tick(): Promise<void> {
    if (this.activationCheckpoint) return Promise.resolve();
    return this.queue.run(async () => {
      await this.ensureInitialized();
      if (!this.snapshot) return;
      const computed = await this.reconcile(this.snapshot);
      await this.applyComputed(computed);
    });
  }

  start() {
    if (this.timer) return;
    const interval = this.options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    if (!Number.isInteger(interval) || interval < 250) throw new Error("automation tick interval must be at least 250ms");
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.options.onError?.(error));
    }, interval);
    this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  recordFixtureState(fixtureId: string, brightness: number): Promise<void> {
    return this.runExternal(async () => {
      await this.ensureInitialized();
      validateBrightness(brightness);
      await this.options.store.update((state) => {
        state.currentByFixture[fixtureId] = brightness;
        state.lastDesiredByFixture[fixtureId] = brightness;
        if (!hasActiveSource(state, fixtureId)) delete state.baseBrightnessByFixture[fixtureId];
        return state;
      });
      if (!this.snapshot) return;
      await this.captureMissingBases(this.snapshot);
      await this.applyComputed(this.computeDesired(this.snapshot, this.state()));
    });
  }

  prepareManualOverride(input: ManualOverrideInput): Promise<void> {
    return this.runExternal(async () => {
      await this.ensureInitialized();
      validateManualOverride(input);
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
          // The existing manual command handler owns this RF send. Reserve its
          // desired value first so restart/config recompute cannot send it again.
          state.lastDesiredByFixture[fixtureId] = input.brightnessPercent;
        }
        return state;
      });
    });
  }

  handoffManualTerminal(
    sourceId: string,
    results: AutomationExecutionFixtureResultV1[]
  ): Promise<void> {
    return this.runExternal(async () => {
      await this.ensureInitialized();
      const actions: DesiredLightingAction[] = [];
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
          if (result.brightnessPercent !== null) {
            state.currentByFixture[result.fixtureId] = result.brightnessPercent;
            if (result.status === "succeeded") state.lastDesiredByFixture[result.fixtureId] = result.brightnessPercent;
          }
        }
        return state;
      });
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
      reconcileManualOverrides(state, now);
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

  private computeDesired(snapshot: AutomationSnapshotV1, state: PersistedAutomationStateV1): ComputedDesiredState {
    const actions = new Map<string, DesiredLightingAction>();
    const desired: Record<string, number> = {};
    const fixtures = relevantFixtures(snapshot, state);

    for (const fixtureId of fixtures) {
      const manual = state.manualOverrides[fixtureId];
      const events = Object.entries(state.vehicleRules)
        .filter(([, vehicle]) => vehicle.targetFixtureIds.includes(fixtureId))
        .map(([ruleId, vehicle]) => ({ sourceId: ruleId, brightness: vehicle.brightnessPercent }));
      const schedule = activeScheduleCandidate(snapshot, state, fixtureId);
      const hasSource = Boolean(manual || events.length > 0 || schedule);
      if (hasSource && state.baseBrightnessByFixture[fixtureId] === undefined) continue;
      const current = state.baseBrightnessByFixture[fixtureId]
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
      state.lastDesiredByFixture[action.fixtureId] !== action.brightnessPercent
    );
    const settledBaseFixtures = [...computed.actions.values()]
      .filter((action) =>
        action.sourceType === "current" &&
        state.baseBrightnessByFixture[action.fixtureId] !== undefined &&
        state.lastDesiredByFixture[action.fixtureId] === action.brightnessPercent
      )
      .map((action) => action.fixtureId);

    if (changed.length === 0 && settledBaseFixtures.length === 0) return;
    await this.options.store.update((next) => {
      for (const action of changed) next.lastDesiredByFixture[action.fixtureId] = action.brightnessPercent;
      for (const fixtureId of [...settledBaseFixtures, ...changed
        .filter((action) => action.sourceType === "current")
        .map((action) => action.fixtureId)]) {
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

    await this.options.store.update((next) => {
      for (const result of results) {
        if (result.brightnessPercent === null) continue;
        next.currentByFixture[result.fixtureId] = result.brightnessPercent;
        if (result.status !== "succeeded") next.lastDesiredByFixture[result.fixtureId] = result.brightnessPercent;
      }
      return next;
    });
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
      vehicleHoldDeadlines: [...this.vehicleHoldDeadlines]
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
    await this.activationSettled;
    return this.queue.run(operation);
  }
}

export class ScheduleRuntimeError extends Error {
  constructor(readonly code: "automation_current_state_unavailable") {
    super(code);
    this.name = "ScheduleRuntimeError";
  }
}

function reconcileManualOverrides(state: PersistedAutomationStateV1, now: Date) {
  for (const [fixtureId, override] of Object.entries(state.manualOverrides)) {
    if (Date.parse(override.overrideUntil) <= now.getTime()) delete state.manualOverrides[fixtureId];
  }
}

function reconcileSchedules(
  state: PersistedAutomationStateV1,
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
  state: PersistedAutomationStateV1,
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
  state: PersistedAutomationStateV1
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
  state: PersistedAutomationStateV1,
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

function captureBase(state: PersistedAutomationStateV1, fixtureId: string): number | null {
  const existing = state.baseBrightnessByFixture[fixtureId];
  if (existing !== undefined) return existing;
  const current = state.currentByFixture[fixtureId] ?? state.lastDesiredByFixture[fixtureId];
  if (current === undefined) return null;
  state.baseBrightnessByFixture[fixtureId] = current;
  return current;
}

function relevantFixtures(snapshot: AutomationSnapshotV1, state: PersistedAutomationStateV1) {
  const fixtures = new Set([
    ...Object.keys(state.currentByFixture),
    ...Object.keys(state.baseBrightnessByFixture),
    ...Object.keys(state.lastDesiredByFixture),
    ...Object.keys(state.manualOverrides),
    ...snapshot.schedules.flatMap((schedule) => schedule.fixtureIds),
    ...Object.values(state.vehicleRules).flatMap((vehicle) => vehicle.targetFixtureIds)
  ]);
  return [...fixtures].sort();
}

function hasActiveSource(state: PersistedAutomationStateV1, fixtureId: string) {
  if (state.manualOverrides[fixtureId]) return true;
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
}

function validateBrightness(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("invalid brightness");
}
