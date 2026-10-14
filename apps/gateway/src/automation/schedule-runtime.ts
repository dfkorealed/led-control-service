import { getActiveOccurrence } from "@led-control/automation-engine";
import {
  type AutomationExecutionFixtureResultV1,
  type AutomationSnapshotV1,
  type AutomationSnapshotV2,
  type AutomationSnapshotV3,
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
  type ManualTerminalSourceContext,
  type PersistedAutomationStateV4,
  type VehicleSensorEventIdentity
} from "./automation-state-store";
import type { DesiredLightingState } from "./automation-runtime";
import {
  VehicleEventRuntime,
  type VehicleLifecycleEvent,
  type VehicleSensorInput
} from "./vehicle-event-runtime";
import type { BioSourceHealth } from "./vehicle-event-runtime";
import { isActiveBioSourceTarget } from "./bio-source-target-guard";
import { BioPulseScheduler, type BioPulseTestProfile, type BioPulseControlCore } from "./bio-pulse-scheduler";
import { BioProductPulseController, type BioProductPulseDependencies } from "./bio-product-pulse-controller";
import {
  lifecycleTelemetryRecords,
  terminalTelemetryRecords
} from "./automation-telemetry-handoff";

export interface DesiredLightingAction {
  fixtureId: string;
  brightnessPercent: number;
  sourceType: ResolvedLightingSource;
  sourceId: string | null;
  occurrenceKey: string | null;
}

export interface ManualControlInput {
  sourceId: string;
  fixtureIds: string[];
  brightnessPercent: number;
  requestedAt: string;
}

export type ManualTerminalContext = "live" | "recovery" | ManualTerminalSourceContext;

export interface AutomationTerminalHandoff {
  revision: number;
  actions: DesiredLightingAction[];
  results: AutomationExecutionFixtureResultV1[];
  causes?: AutomationLifecycleEvent[];
}

export type AutomationLifecycleEvent = (VehicleLifecycleEvent | {
  kind: "schedule_started" | "schedule_ended";
  ruleId: string;
  occurrenceKey: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}) & { revision?: number };

export interface AutomationLifecycleHandoff {
  revision: number;
  events: AutomationLifecycleEvent[];
}

export interface ScheduleRuntimeOptions {
  store: FileAutomationStateStore;
  wallClock?: () => Date;
  monotonicClock?: () => number;
  clockTrust: ClockTrustProvider;
  execute: (actions: DesiredLightingAction[]) => Promise<AutomationExecutionFixtureResultV1[]>;
  requestFixtureObservation?: (fixtureIds: string[]) => Promise<void> | void;
  allowManualStateInitialization?: boolean;
  onLifecycleEvents?: (handoff: AutomationLifecycleHandoff) => Promise<void>;
  onTerminalResults?: (handoff: AutomationTerminalHandoff) => Promise<void>;
  flushTelemetryHandoffs?: () => Promise<void>;
  onError?: (error: unknown) => void;
  onDiagnostic?: (diagnostic: ManualOverridePrepareDiagnostic) => void;
  manualOverrideSlowThresholdMs?: number;
  tickIntervalMs?: number;
  bioPulseTestProfile?: BioPulseTestProfile;
  bioProductPulse?: BioProductPulseDependencies;
}

type SchedulerSnapshot = AutomationSnapshotV1 | AutomationSnapshotV2;

export interface ManualOverridePrepareDiagnostic {
  event: "manual_override_prepare_slow";
  sourceId: string;
  stage: "waiting_for_serialization" | "persisting_state";
  activationPending: boolean;
  elapsedMs: number;
}

interface ComputedDesiredState {
  desired: DesiredLightingState;
  actions: Map<string, DesiredLightingAction>;
  lifecycleEvents: AutomationLifecycleEvent[];
}

interface ActivationCheckpoint {
  snapshot: SchedulerSnapshot | null;
  state: PersistedAutomationStateV4;
  vehicleHoldDeadlines: Array<[string, number]>;
  bioProduct?: ReturnType<BioProductPulseController["checkpoint"]>;
}

const DEFAULT_TICK_INTERVAL_MS = 1_000;

export class ScheduleRuntime {
  private readonly queue = new SerialTaskQueue();
  private readonly wallClock: () => Date;
  private readonly monotonicClock: () => number;
  private readonly vehicleRuntime: VehicleEventRuntime;
  private readonly bio: BioPulseControlCore | null;
  private readonly bioProduct: BioProductPulseController | null;
  private readonly bioArrivals = new Set<{ input: Extract<VehicleSensorInput, { type: "pulse" }>;
    activations: Map<string, number> }>();
  private snapshot: SchedulerSnapshot | null = null;
  private initialized = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly pendingObservationFixtures = new Set<string>();
  private activationCheckpoint: ActivationCheckpoint | null = null;
  private activationSettled: Promise<void> = Promise.resolve();
  private settleActivation: (() => void) | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly acceptedOperations = new Set<Promise<unknown>>();
  private pendingActivationLifecycle: AutomationLifecycleEvent[] = [];

  constructor(private readonly options: ScheduleRuntimeOptions) {
    this.wallClock = options.wallClock ?? (() => new Date());
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
    if (options.bioPulseTestProfile && options.bioProductPulse) throw new Error("bio_pulse_dependency_conflict");
    this.bioProduct = options.bioProductPulse ? new BioProductPulseController(options.bioProductPulse, options.store,
      this.wallClock, this.monotonicClock, activationId => this.bioArrivalBlocksRelease(activationId)) : null;
    this.bio = this.bioProduct ?? (options.bioPulseTestProfile
      ? new BioPulseScheduler(options.bioPulseTestProfile, options.store, this.wallClock, this.monotonicClock,
        activationId => this.bioArrivalBlocksRelease(activationId)) : null);
    this.vehicleRuntime = new VehicleEventRuntime({
      wallClock: this.wallClock,
      monotonicClock: this.monotonicClock,
      bioConnection: () => this.bio?.connection() ?? null,
      bioSourceHealth: source => this.bio?.health(source) ?? null
    });
  }

  initialize() {
    return this.enqueue(async () => {
      if (this.initialized) return this.state();
      const state = await this.options.store.initialize();
      for (const fixtureId of Object.keys(state.unverifiedDesiredByFixture)) {
        this.pendingObservationFixtures.add(fixtureId);
      }
      for (const [fixtureId, transition] of Object.entries(state.transitionsByFixture)) {
        if (transition.phase === "pending") this.pendingObservationFixtures.add(fixtureId);
      }
      this.initialized = true;
      await this.flushTelemetryHandoffs();
      return state;
    });
  }

  state() {
    return this.options.store.read();
  }

  isBioSourceTarget(fixtureIds: readonly string[]): boolean {
    return isActiveBioSourceTarget(this.snapshot, fixtureIds);
  }

  pendingObservationFixtureIds() {
    return [...this.pendingObservationFixtures];
  }

  get currentSnapshot() {
    // The synthetic seam must not masquerade as an authenticated configuration.
    // Product V2 retains its version so BlueZ peers still receive source refresh.
    return this.options.bioPulseTestProfile && this.snapshot?.schemaVersion === 2 ? null : structuredClone(this.snapshot);
  }

  recompute(snapshot: SchedulerSnapshot | AutomationSnapshotV3, degradedBioRecovery = false): Promise<DesiredLightingState> {
    return this.enqueue(async () => {
      // V3 admission is not legacy V2 execution. The next integration owns verified
      // holiday/current-config installation; reject before changing any active state.
      if (snapshot.schemaVersion === 3) throw new Error("bio_v3_runtime_unavailable");
      await this.ensureInitialized();
      if (this.options.bioPulseTestProfile && this.snapshot?.schemaVersion === 2) throw new Error("bio_test_snapshot_change_unavailable");
      // Protocol support is configuration ability only. Product BIO pulse
      // activation still needs the later independent authority/HIL integration.
      if (!this.bioProduct && snapshot.schemaVersion === 2 && snapshot.vehicleEventRules.some(rule =>
        rule.sensorProtocol === "bio-usb-pulse" && rule.status === "enabled")) {
        throw new Error("bio_pulse_control_unavailable");
      }
      if (this.activationCheckpoint) throw new Error("automation config activation is already pending");
      const bioCheckpoint = this.bioProduct?.checkpoint();
      if (degradedBioRecovery) this.bioProduct?.recoverDegraded(snapshot);
      else await this.bioProduct?.prepare(snapshot);
      this.beginActivation(bioCheckpoint);
      const computed = await this.reconcile(snapshot);
      this.pendingActivationLifecycle = computed.lifecycleEvents;
      this.snapshot = snapshot;
      return computed.desired;
    });
  }

  async preflightBioSnapshot(snapshot: SchedulerSnapshot): Promise<void> {
    if (!this.bioProduct || this.stopping) throw new Error("bio_pulse_control_unavailable");
    await this.bioProduct.validate(snapshot);
  }

  recordQualifiedBioPulse(input: Extract<VehicleSensorInput, { type: "pulse" }>): Promise<void> {
    if (!this.bioProduct || this.stopping) return Promise.reject(new Error("bio_pulse_control_unavailable"));
    const authority = this.options.bioProductPulse!.source.sourceAuthority(input.sourceFixtureId);
    if (!authority?.independentlyQualified || authority.observation.health !== "healthy"
      || authority.connection.epoch !== input.receipt.connectionEpoch || authority.connection.generation !== input.receipt.connectionGeneration) {
      return Promise.reject(new Error("bio_source_authority_unverified"));
    }
    // Reset the fault interval only from independently qualified source evidence,
    // then register the original receipt before any asynchronous reconciliation.
    this.bioProduct.setHealth(input.sourceFixtureId, "healthy", "qualified");
    return this.recordVehicleSensorInput(input);
  }

  /** Local synthetic seam only. Does not accept or emit a config/ACK wire message. */
  activateBioPulseTestSnapshot(snapshot: AutomationSnapshotV2): Promise<void> {
    return this.runExternal(async () => {
      await this.ensureInitialized();
      if (!this.bio) throw new Error("bio_pulse_control_unavailable");
      this.snapshot = this.bio.install(snapshot);
      await this.applyComputed(await this.reconcile(this.snapshot));
    });
  }

  setBioSourceHealth(sourceFixtureId: string, health: BioSourceHealth, reason: string): Promise<void> {
    // Revoke immediately, before waiting behind an asynchronous RF/GET operation.
    // A healthy hint cannot replace the independently qualified authority callback.
    if (!this.bio) return Promise.reject(new Error("bio_pulse_control_unavailable"));
    this.bio.setHealth(sourceFixtureId, health, reason);
    return this.runExternal(async () => {
      await this.ensureInitialized();
      if (this.snapshot) await this.applyComputed(await this.reconcile(this.snapshot));
    });
  }

  releaseBioEvent(ruleId: string): Promise<void> {
    return this.runExternal(async () => {
      await this.ensureInitialized();
      if (!this.bio || this.snapshot?.schemaVersion !== 2) throw new Error("bio_pulse_control_unavailable");
      let deadlines: Array<[string, number]> = [];
      await this.options.store.updateDurable(state => {
        const planned = this.vehicleRuntime.planRelease(state, ruleId);
        deadlines = planned.holdDeadlines;
        const events = this.bio!.requestRelease(state, ruleId, planned.events);
        this.appendTelemetryHandoff(state, lifecycleTelemetryRecords({ revision: this.snapshot!.revision, events }));
        return state;
      });
      this.vehicleRuntime.restore(deadlines);
      await this.applyComputed(this.computeDesired(this.snapshot, this.state()));
    });
  }

  commitActivation(): Promise<void> {
    return this.enqueue(async () => {
      this.finishActivation();
      await this.flushTelemetryHandoffs();
    }, Boolean(this.activationCheckpoint));
  }

  rollbackActivation(): Promise<void> {
    return this.enqueue(async () => {
      const checkpoint = this.activationCheckpoint;
      if (!checkpoint) return;
      try {
        await this.options.store.updateControlState(current => {
          const restored = structuredClone(checkpoint.state);
          // Temporary intake is a separate durable owner. Rolling back an
          // automatic snapshot must not rewind a later lease/result/tombstone.
          restored.temporarySessions = current.temporarySessions;
          restored.fixtureLeases = current.fixtureLeases;
          restored.temporaryResultOutbox = current.temporaryResultOutbox;
          restored.temporaryEndTombstones = current.temporaryEndTombstones;
          if (this.bioProduct) {
            restored.bioActivationsByRule = current.bioActivationsByRule;
            restored.bioTargetsByFixture = current.bioTargetsByFixture;
            restored.bioPulseInbox = current.bioPulseInbox;
            restored.pendingTelemetryHandoffs = current.pendingTelemetryHandoffs;
            for (const [id, rule] of Object.entries(restored.vehicleRules)) if (rule.sensorProtocol === "bio-usb-pulse") delete restored.vehicleRules[id];
            for (const [id, rule] of Object.entries(current.vehicleRules)) if (rule.sensorProtocol === "bio-usb-pulse") restored.vehicleRules[id] = rule;
          }
          return restored;
        });
        if (checkpoint.bioProduct) this.bioProduct?.rollback(checkpoint.bioProduct);
        this.snapshot = checkpoint.snapshot ? structuredClone(checkpoint.snapshot) : null;
        this.vehicleRuntime.restore(checkpoint.vehicleHoldDeadlines);
      } finally {
        this.finishActivation();
      }
    }, Boolean(this.activationCheckpoint));
  }

  applyDesiredState(_next: DesiredLightingState, _previous: DesiredLightingState): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      if (!this.snapshot) return;
      await this.applyComputed(this.computeDesired(
        this.snapshot,
        this.state(),
        this.pendingActivationLifecycle
      ));
      this.pendingActivationLifecycle = [];
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
    this.bioProduct?.stop();
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
      await this.updateState((state) => {
        state.currentByFixture[fixtureId] = brightness;
        // Telemetry stays current, but temporary optical output is never a new
        // automatic baseline, permanent manual success, or retirement signal.
        if (state.fixtureLeases[fixtureId]?.sessionId) return state;
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
        if (recoveredAction && recoveredResult && this.snapshot) {
          this.appendTelemetryHandoff(state, terminalTelemetryRecords({
            revision: this.snapshot.revision,
            actions: [recoveredAction],
            results: [recoveredResult]
          }));
        }
        const manual = state.pendingManualControls[fixtureId];
        if (manual && recoveredResult) {
          // This is a fresh observation, even when the pending request survived a restart.
          settleManualControl(state, fixtureId, manual.sourceId, recoveredResult, "live");
          if (recoveredResult.status === "succeeded" && recoveredResult.brightnessPercent !== null) {
            this.bio?.retireManualTargets(state, fixtureId);
          }
        }
        return state;
      });
      if (recoveredAction && recoveredResult) {
        this.pendingObservationFixtures.delete(fixtureId);
        await this.flushTelemetryHandoffs();
        await this.handoff([recoveredAction], [recoveredResult]);
      }
      if (!this.snapshot) return;
      await this.captureMissingBases(this.snapshot);
      await this.applyComputed(this.computeDesired(this.snapshot, this.state()));
    });
  }

  prepareManualControl(input: ManualControlInput): Promise<void> {
    const startedAt = this.monotonicClock();
    let stage: ManualOverridePrepareDiagnostic["stage"] = "waiting_for_serialization";
    const slowThresholdMs = this.options.manualOverrideSlowThresholdMs ?? 1_000;
    const diagnosticTimer = setTimeout(() => {
      this.options.onDiagnostic?.({
        event: "manual_override_prepare_slow",
        sourceId: input.sourceId,
        stage,
        activationPending: this.activationCheckpoint !== null,
        elapsedMs: Math.max(0, Math.floor(this.monotonicClock() - startedAt))
      });
    }, slowThresholdMs);
    diagnosticTimer.unref();
    return this.runExternal(async () => {
      await this.ensureInitialized();
      validateManualControl(input);
      if (this.isBioSourceTarget(input.fixtureIds)) {
        throw new Error("bio_source_target_forbidden");
      }
      stage = "persisting_state";
      await this.updateState((state) => {
        for (const fixtureId of input.fixtureIds) {
          if (state.fixtureLeases[fixtureId]?.sessionId) throw new Error("temporary_fixture_lease_conflict");
          const base = state.baseBrightnessByFixture[fixtureId] ??
            state.currentByFixture[fixtureId] ?? state.lastDesiredByFixture[fixtureId] ?? null;
          if (base === null && !this.options.allowManualStateInitialization && !this.bio?.hasTarget(fixtureId)) {
            throw new ScheduleRuntimeError("automation_current_state_unavailable");
          }
          state.pendingManualControls[fixtureId] = {
            sourceId: input.sourceId,
            brightnessPercent: input.brightnessPercent,
            requestedAt: input.requestedAt,
            // BIO sensor mode has no observed LED brightness before its first manual command.
            // Retain a provisional value only in pending state; failure never promotes it to baseline.
            preBrightness: base ?? input.brightnessPercent
          };
          const previous = state.transitionsByFixture[fixtureId];
          state.transitionsByFixture[fixtureId] = {
            phase: "pending",
            brightnessPercent: input.brightnessPercent,
            sourceType: "manual_override",
            sourceId: input.sourceId,
            occurrenceKey: null,
            attempt: previous?.sourceId === input.sourceId ? previous.attempt + 1 : 1,
            startedAt: input.requestedAt,
            status: null,
            terminalAt: null
          };
        }
        return state;
      });
    }).finally(() => clearTimeout(diagnosticTimer));
  }

  abortManualControl(sourceId: string, fixtureIds: string[]): Promise<void> {
    return this.runExternal(async () => {
      await this.ensureInitialized();
      const cleared: string[] = [];
      // The command journal may acknowledge abort only after this mutation is
      // durable. The normal control path's ENOSPC memory-only fallback would
      // resurrect pending ownership on restart after its replay intent is gone.
      await this.options.store.updateDurable((state) => {
        for (const fixtureId of fixtureIds) {
          // Only the journal owner can release its prepare. A delayed replay must
          // not remove a newer command or an unrelated local automation transition.
          if (state.pendingManualControls[fixtureId]?.sourceId !== sourceId) continue;
          delete state.pendingManualControls[fixtureId];
          const transition = state.transitionsByFixture[fixtureId];
          if (transition?.sourceType === "manual_override" && transition.sourceId === sourceId && transition.phase === "pending") {
            delete state.transitionsByFixture[fixtureId];
            cleared.push(fixtureId);
          }
        }
        return state;
      });
      for (const fixtureId of cleared) {
        if (this.state().unverifiedDesiredByFixture[fixtureId] === undefined) this.pendingObservationFixtures.delete(fixtureId);
      }
    });
  }

  captureManualTerminalContext(sourceId: string, results: AutomationExecutionFixtureResultV1[]): ManualTerminalSourceContext {
    // Capture synchronously at hardware success, before journal fsync or another
    // queued activation can change the sources that this manual result supersedes.
    const state = this.state();
    return { suppressions: Object.fromEntries(results
      .filter((result) => result.status === "succeeded" && result.brightnessPercent !== null)
      .map((result) => [result.fixtureId, manualSuppressionAtTerminal(state, result.fixtureId, sourceId, result.occurredAt, "live")])) };
  }

  handoffManualTerminal(
    sourceId: string,
    results: AutomationExecutionFixtureResultV1[],
    context: ManualTerminalContext = "live"
  ): Promise<void> {
    return this.runExternal(async () => {
      await this.ensureInitialized();
      const actions: DesiredLightingAction[] = [];
      const settledFixtures: string[] = [];
      const settledResults: AutomationExecutionFixtureResultV1[] = [];
      await this.updateState((state) => {
        for (const result of results) {
          const manual = state.pendingManualControls[result.fixtureId];
          if (manual?.sourceId !== sourceId) continue;
          actions.push({
            fixtureId: result.fixtureId, brightnessPercent: manual.brightnessPercent,
            sourceType: "manual_override", sourceId, occurrenceKey: null
          });
          settleManualControl(state, result.fixtureId, sourceId, result, context);
          if (result.status === "succeeded" && result.brightnessPercent !== null) {
            this.bio?.retireManualTargets(state, result.fixtureId);
          }
          settledFixtures.push(result.fixtureId);
          settledResults.push(result);
        }
        // Replay may occur after the recorded occurrence/activation ended. Exact
        // identities must never suppress its replacement, even if UTC rolled back.
        if (this.snapshot) pruneManualSuppressions(state, this.snapshot);
        if (this.snapshot) {
          this.appendTelemetryHandoff(state, terminalTelemetryRecords({
            revision: this.snapshot.revision,
            actions,
            results: settledResults
          }));
        }
        return state;
      });
      for (const fixtureId of settledFixtures) this.pendingObservationFixtures.delete(fixtureId);
      await this.flushTelemetryHandoffs();
      await this.handoff(actions, settledResults);
    });
  }

  recordVehicleSensorState(sourceFixtureId: string, active: boolean): Promise<void> {
    return this.recordVehicleSensorInput({ type: "current-state", sourceFixtureId, active });
  }

  recordVehicleSensorInput(input: VehicleSensorInput): Promise<void> {
    // BIO RF execution remains closed until independent source health and target
    // mode restoration are integrated. Candidate intake alone is not readiness.
    if (input.type === "pulse") return this.recordBioPulse(input).then(() => undefined);
    return this.runExternal(async () => {
      await this.ensureInitialized();
      if (!this.snapshot) return;
      let lifecycleEvents: VehicleLifecycleEvent[] = [];
      let holdDeadlines: Array<[string, number]> | undefined;
      await this.updateState((state) => {
        const planned = this.vehicleRuntime.planRecordInput(state, this.snapshot!, input);
        lifecycleEvents = planned.events;
        holdDeadlines = planned.holdDeadlines;
        pruneManualSuppressions(state, this.snapshot!);
        this.appendTelemetryHandoff(state, lifecycleTelemetryRecords({
          revision: this.snapshot!.revision,
          events: lifecycleEvents
        }));
        return state;
      });
      this.vehicleRuntime.restore(holdDeadlines!);
      await this.captureMissingBases(this.snapshot);
      await this.applyComputed(this.computeDesired(this.snapshot, this.state(), lifecycleEvents));
    });
  }

  recordVehicleSensorEvent(
    input: Exclude<VehicleSensorInput, { type: "current-state" }>,
    identity: VehicleSensorEventIdentity
  ): Promise<boolean> {
    if (input.type === "pulse") return this.recordBioPulse(input);
    return this.runExternal(async () => {
      await this.ensureInitialized();
      if (!this.snapshot) return false;
      let lifecycleEvents: VehicleLifecycleEvent[] = [];
      let holdDeadlines: Array<[string, number]> | undefined;
      const result = await this.options.store.updateVehicleSensorEvent(identity, (state) => {
        const planned = this.vehicleRuntime.planRecordInput(state, this.snapshot!, input);
        lifecycleEvents = planned.events;
        holdDeadlines = planned.holdDeadlines;
        pruneManualSuppressions(state, this.snapshot!);
        this.appendTelemetryHandoff(state, lifecycleTelemetryRecords({
          revision: this.snapshot!.revision,
          events: lifecycleEvents
        }));
        return state;
      });
      if (!result.applied) return false;
      this.vehicleRuntime.restore(holdDeadlines!);
      await this.captureMissingBases(this.snapshot);
      await this.applyComputed(this.computeDesired(this.snapshot, this.state(), lifecycleEvents));
      return true;
    });
  }

  private recordBioPulse(input: Extract<VehicleSensorInput, { type: "pulse" }>): Promise<boolean> {
    if (!this.bio) return Promise.reject(new Error("bio_pulse_control_unavailable"));
    const exact = structuredClone(input);
    let arrival: ReturnType<ScheduleRuntime["registerBioArrival"]>;
    try { arrival = this.registerBioArrival(exact); } catch (error) { return Promise.reject(error); }
    const pendingArrivalActivations = new Set(arrival?.activations.keys());
    return this.runExternal(async () => {
      await this.ensureInitialized();
      this.bio!.assertPulse(exact);
      // Classify against receipt time before reconciling the later processing
      // clock. A queued, on-time pulse still belongs to its original activation
      // (and manual suppression), even when the old deadline passed in the queue.
      const previewState = this.state();
      this.bio!.resumeAutomaticReleases(previewState, exact, pendingArrivalActivations);
      const preview = this.vehicleRuntime.planRecordInput(previewState, this.snapshot!, exact);
      if (!preview.events.some(event => event.kind === "vehicle_detected")) return false;
      const expired = new Set(preview.events.filter(event => event.kind === "event_ended" &&
        event.payload.reason === "hold_expired").map(event => event.ruleId));
      if (expired.size) {
        const remainingDeadlines = this.vehicleRuntime.checkpoint().filter(([ruleId]) => !expired.has(ruleId));
        await this.options.store.updateDurable(state => {
          const releases = [...expired].flatMap(ruleId => this.vehicleRuntime.planRelease(state, ruleId).events)
            .map(event => ({ ...event, payload: { ...event.payload, reason: "hold_expired" } }));
          const projected = this.bio!.stage(state, releases);
          this.appendTelemetryHandoff(state, lifecycleTelemetryRecords({ revision: this.snapshot!.revision, events: projected }));
          return state;
        });
        this.vehicleRuntime.restore(remainingDeadlines);
        // Only close rules whose own deadline expired before this receipt.
        // Another rule on this source may instead be renewing a pending release;
        // it must not restore/reapply before that renewal is durably committed.
        await this.bio!.apply(expired);
        await this.flushTelemetryHandoffs();
        if ([...expired].some(ruleId => !this.state().bioActivationsByRule[ruleId]?.completed)) {
          throw new Error("bio_release_pending");
        }
      }
      this.bio!.assertPulse(exact);
      let events: VehicleLifecycleEvent[] = [];
      let deadlines: Array<[string, number]> = [];
      await this.options.store.updateDurable(state => {
        this.bio!.assertPulse(exact);
        const previous = structuredClone(state);
        const resumed = this.bio!.resumeAutomaticReleases(state, exact, pendingArrivalActivations);
        const planned = this.vehicleRuntime.planRecordInput(state, this.snapshot!, exact);
        if (!planned.events.some(event => event.kind === "vehicle_detected")) {
          deadlines = this.vehicleRuntime.checkpoint();
          return previous;
        }
        deadlines = planned.holdDeadlines;
        events = this.bio!.stage(state, [...resumed, ...planned.events]);
        pruneManualSuppressions(state, this.snapshot!);
        this.appendTelemetryHandoff(state, lifecycleTelemetryRecords({ revision: this.snapshot!.revision, events }));
        return state;
      });
      this.vehicleRuntime.restore(deadlines);
      if (events.length) await this.applyComputed(this.computeDesired(this.snapshot!, this.state(), events));
      return events.some(event => event.kind === "vehicle_detected");
    }).finally(() => { if (arrival) this.bioArrivals.delete(arrival); });
  }

  private registerBioArrival(input: Extract<VehicleSensorInput, { type: "pulse" }>) {
    if (!this.initialized || !this.snapshot) return null;
    this.bio!.assertPulse(input);
    const state = this.state();
    this.bio!.resumeAutomaticReleases(state, input);
    const preview = this.vehicleRuntime.planRecordInput(state, this.snapshot, input);
    const activations = new Map<string, number>();
    for (const event of preview.events) {
      if (event.kind !== "vehicle_detected") continue;
      const activation = this.state().bioActivationsByRule[event.ruleId];
      const rule = this.snapshot.vehicleEventRules.find(rule => rule.id === event.ruleId);
      if (rule && activation && !activation.completed && event.occurrenceKey === activation.activationId) {
        activations.set(activation.activationId, input.receivedMonotonicMs + rule.holdSeconds * 1000);
      }
    }
    if (!activations.size) return null;
    // Arrival is only a bounded expiry veto, never an accepted receipt, durable
    // occurrence or RF authority. An in-flight async tick may have started before
    // this on-time pulse; the serialized worker must still validate+commit it.
    if (this.bioArrivals.size >= 256) throw new Error("bio_pulse_arrival_capacity");
    const arrival = { input, activations };
    this.bioArrivals.add(arrival);
    return arrival;
  }

  private bioArrivalBlocksRelease(activationId: string) {
    for (const arrival of this.bioArrivals) {
      if ((arrival.activations.get(activationId) ?? -Infinity) <= this.monotonicClock()) continue;
      try { this.bio!.assertPulse(arrival.input); } catch { continue; }
      const connection = this.bio!.connection();
      const health = this.bio!.health(arrival.input.sourceFixtureId);
      if (arrival.input.receipt.connectionEpoch !== connection?.epoch ||
        arrival.input.receipt.connectionGeneration !== connection?.generation || !health ||
        arrival.input.receivedMonotonicMs < health.healthySinceMonotonicMs) continue;
      return true;
    }
    return false;
  }

  private updateState(mutation: (state: PersistedAutomationStateV4) => PersistedAutomationStateV4) {
    // BIO receipt/status/manual retirement must never enter the V1 ENOSPC memory fallback.
    return this.snapshot?.schemaVersion === 2 ? this.options.store.updateDurable(mutation)
      : this.options.store.updateControlState(mutation);
  }

  private async reconcile(snapshot: SchedulerSnapshot): Promise<ComputedDesiredState> {
    const previousSnapshot = this.snapshot;
    const now = this.wallClock();
    const trusted = await this.options.clockTrust.isTrusted(now);
    const lifecycleEvents: AutomationLifecycleEvent[] = [];
    let vehicleHoldDeadlines: Array<[string, number]> | undefined;
    await this.updateState((state) => {
      const vehicle = this.vehicleRuntime.planReconcile(state, snapshot, trusted);
      vehicleHoldDeadlines = vehicle.holdDeadlines;
      lifecycleEvents.push(...(this.bio?.stage(state, vehicle.events) ?? vehicle.events));
      lifecycleEvents.push(...reconcileSchedules(state, snapshot, now, trusted));
      pruneManualSuppressions(state, snapshot);
      const tagged = lifecycleEvents.map((event) => tagLifecycleRevision(event, snapshot, previousSnapshot));
      this.appendTelemetryHandoff(state, lifecycleTelemetryRecords({ revision: snapshot.revision, events: tagged }));
      return state;
    });
    this.vehicleRuntime.restore(vehicleHoldDeadlines!);
    await this.captureMissingBases(snapshot);
    return this.computeDesired(
      snapshot,
      this.state(),
      lifecycleEvents.map((event) => tagLifecycleRevision(event, snapshot, previousSnapshot))
    );
  }

  private async captureMissingBases(snapshot: SchedulerSnapshot) {
    await this.updateState((state) => {
      for (const [scheduleId, occurrence] of Object.entries(state.activeOccurrences)) {
        const schedule = snapshot.schedules.find((candidate) => candidate.id === scheduleId);
        if (!schedule) continue;
        for (const fixtureId of schedule.fixtureIds) {
          const base = captureBase(state, fixtureId);
          if (base !== null) occurrence.preBrightness[fixtureId] = base;
        }
      }
      for (const vehicle of Object.values(state.vehicleRules)) {
        if (vehicle.sensorProtocol === "bio-usb-pulse") continue;
        for (const fixtureId of vehicle.targetFixtureIds) {
          const base = captureBase(state, fixtureId);
          if (base !== null) vehicle.preBrightness[fixtureId] = base;
        }
      }
      return state;
    });
  }

  private computeDesired(
    snapshot: SchedulerSnapshot,
    state: PersistedAutomationStateV4,
    lifecycleEvents: AutomationLifecycleEvent[] = []
  ): ComputedDesiredState {
    const actions = new Map<string, DesiredLightingAction>();
    const desired: Record<string, number> = {};
    const fixtures = relevantFixtures(snapshot, state);

    for (const fixtureId of fixtures) {
      if (state.fixtureLeases[fixtureId]?.sessionId) continue;
      if (this.bio?.ownsFixture(state, fixtureId)) continue;
      const events = Object.entries(state.vehicleRules)
        .filter(([ruleId, vehicle]) => vehicle.targetFixtureIds.includes(fixtureId) &&
          // Retirement is the durable suppression authority even when a pending
          // automatic release temporarily removed the occurrence from the arbiter.
          !state.bioActivationsByRule[ruleId]?.retiredFixtureIds.includes(fixtureId))
        .map(([ruleId, vehicle]) => ({
          sourceId: ruleId, startedAt: vehicle.startedAt, brightness: vehicle.brightnessPercent
        }));
      const schedules = activeScheduleCandidates(snapshot, state, fixtureId);
      const hasSource = events.length > 0 || schedules.length > 0;
      // A verified BIO configuration restore does not settle later schedule/base
      // changes. Reapply an independently known baseline when arbitration needs
      // it, but never invent optical brightness from a sensor configuration GET.
      if (!hasSource && this.bio?.hasTarget(fixtureId) && state.baseBrightnessByFixture[fixtureId] === undefined) continue;
      if (hasSource && state.baseBrightnessByFixture[fixtureId] === undefined) continue;
      const current = state.baseBrightnessByFixture[fixtureId]
        ?? state.currentByFixture[fixtureId] ?? state.lastDesiredByFixture[fixtureId] ?? null;
      const resolved = resolveDesiredState({
        events, schedules, current, suppression: state.manualAutomationSuppressions[fixtureId]
      });
      desired[fixtureId] = resolved.brightness;
      actions.set(fixtureId, toAction(fixtureId, resolved));
    }

    return {
      desired: Object.fromEntries(Object.entries(desired).sort(([left], [right]) => left.localeCompare(right))),
      actions,
      lifecycleEvents
    };
  }

  private async applyComputed(computed: ComputedDesiredState) {
    const alreadyCompleted = new Set(Object.values(this.state().bioActivationsByRule)
      .filter(activation => activation.completed).map(activation => activation.activationId));
    await this.bio?.apply();
    if (this.bio && this.snapshot) computed = this.computeDesired(this.snapshot, this.state(), computed.lifecycleEvents);
    const terminalCauses = [...(this.bio?.completedRestorationCauses(alreadyCompleted) ?? []), ...computed.lifecycleEvents];
    const state = this.state();
    const changed = [...computed.actions.values()].map(action => {
      if (!this.bio || (action.sourceType !== "current" && action.sourceType !== "default")) return action;
      const cause = [...terminalCauses].reverse().find(event =>
        (event.kind === "event_ended" || event.kind === "schedule_ended") &&
        Array.isArray(event.payload.targetFixtureIds) && event.payload.targetFixtureIds.includes(action.fixtureId));
      if (cause) return { ...action, sourceType: cause.kind === "event_ended" ? "vehicle_event_rule" as const : "schedule" as const,
        sourceId: cause.ruleId, occurrenceKey: cause.occurrenceKey };
      const previous = state.transitionsByFixture[action.fixtureId];
      // Carry the exact failed/pending restoration cause through durable retries,
      // including restart. An arbitrary historical completed BIO event is not it.
      if (previous && previous.status !== "succeeded" && previous.brightnessPercent === action.brightnessPercent) {
        return { ...action, sourceType: previous.sourceType, sourceId: previous.sourceId, occurrenceKey: previous.occurrenceKey };
      }
      return action;
    }).filter((action) =>
      state.lastDesiredByFixture[action.fixtureId] !== action.brightnessPercent &&
      !this.pendingObservationFixtures.has(action.fixtureId) &&
      !state.pendingManualControls[action.fixtureId]
    );
    if (changed.length === 0) {
      await this.flushTelemetryHandoffs();
      await this.handoffLifecycle(computed.lifecycleEvents);
      return;
    }
    const pendingAt = this.wallClock().toISOString();
    await this.updateState((next) => {
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
      return next;
    });
    let results: AutomationExecutionFixtureResultV1[];
    try {
      if (this.isBioSourceTarget(changed.map(action => action.fixtureId))) throw new Error("bio_source_target_forbidden");
      results = validateTerminalResults(changed, await this.options.execute(changed));
    } catch (error) {
      results = failedResults(changed, this.wallClock(), error);
    }

    try {
      await this.updateState((next) => {
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
        }
        this.appendTelemetryHandoff(next, terminalTelemetryRecords({
          revision: this.snapshot!.revision,
          actions: changed,
          results,
          causes: terminalCauses
        }));
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
    await this.flushTelemetryHandoffs();
    await this.handoffLifecycle(computed.lifecycleEvents);
    await this.handoff(changed, results, terminalCauses);
  }

  private async handoffLifecycle(events: AutomationLifecycleEvent[]) {
    if (!this.options.onLifecycleEvents || !this.snapshot || events.length === 0) return;
    try {
      await this.options.onLifecycleEvents({ revision: this.snapshot.revision, events });
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private appendTelemetryHandoff(
    state: PersistedAutomationStateV4,
    records: Parameters<FileAutomationStateStore["createTelemetryHandoff"]>[0]
  ) {
    const handoff = this.options.store.createTelemetryHandoff(records);
    if (handoff) state.pendingTelemetryHandoffs.push(handoff);
  }

  private async flushTelemetryHandoffs() {
    if (!this.options.flushTelemetryHandoffs) return;
    try {
      await this.options.flushTelemetryHandoffs();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private async handoff(
    actions: DesiredLightingAction[],
    results: AutomationExecutionFixtureResultV1[],
    causes: AutomationLifecycleEvent[] = []
  ) {
    if (!this.options.onTerminalResults || !this.snapshot || actions.length === 0) return;
    try {
      await this.options.onTerminalResults({ revision: this.snapshot.revision, actions, results, causes });
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private async ensureInitialized() {
    if (!this.initialized) await this.options.store.initialize();
    this.initialized = true;
  }

  private beginActivation(bioProduct?: ReturnType<BioProductPulseController["checkpoint"]>) {
    this.activationCheckpoint = {
      snapshot: this.snapshot ? structuredClone(this.snapshot) : null,
      state: this.state(),
      vehicleHoldDeadlines: this.vehicleRuntime.checkpoint(),
      ...(bioProduct ? { bioProduct } : {})
    };
    this.activationSettled = new Promise<void>((resolve) => { this.settleActivation = resolve; });
  }

  private finishActivation() {
    this.activationCheckpoint = null;
    this.pendingActivationLifecycle = [];
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
  previous: PersistedAutomationStateV4["transitionsByFixture"][string],
  action: DesiredLightingAction
) {
  return previous.brightnessPercent === action.brightnessPercent && previous.sourceType === action.sourceType &&
    previous.sourceId === action.sourceId && previous.occurrenceKey === action.occurrenceKey;
}

export class ScheduleRuntimeError extends Error {
  constructor(readonly code: "automation_current_state_unavailable") {
    super(code);
    this.name = "ScheduleRuntimeError";
  }
}

function reconcileSchedules(
  state: PersistedAutomationStateV4,
  snapshot: SchedulerSnapshot,
  now: Date,
  trusted: boolean
) {
  const events: AutomationLifecycleEvent[] = [];
  const schedules = new Map(snapshot.schedules.map((schedule) => [schedule.id, schedule]));
  for (const scheduleId of Object.keys(state.activeOccurrences)) {
    const occurrence = state.activeOccurrences[scheduleId]!;
    const schedule = schedules.get(scheduleId);
    if (!schedule || schedule.status !== "enabled") {
      delete state.activeOccurrences[scheduleId];
      events.push(scheduleLifecycle("schedule_ended", scheduleId, occurrence, now, "configuration_changed"));
      continue;
    }
    if (!trusted) continue;
    const active = getActiveOccurrence(schedule, now.getTime(), snapshot.timeZone);
    if (!active || active.key !== occurrence.key) {
      delete state.activeOccurrences[scheduleId];
      events.push(scheduleLifecycle("schedule_ended", scheduleId, occurrence, now, "occurrence_ended"));
    }
  }
  if (!trusted) return events;

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
    events.push(scheduleLifecycle(
      "schedule_started",
      schedule.id,
      state.activeOccurrences[schedule.id]!,
      now,
      "occurrence_started"
    ));
  }
  return events;
}

function settleManualControl(
  state: PersistedAutomationStateV4,
  fixtureId: string,
  sourceId: string,
  result: AutomationExecutionFixtureResultV1,
  context: ManualTerminalContext
) {
  const manual = state.pendingManualControls[fixtureId];
  if (manual?.sourceId !== sourceId) return;
  state.transitionsByFixture[fixtureId] = {
    phase: "terminal", brightnessPercent: manual.brightnessPercent,
    sourceType: "manual_override", sourceId, occurrenceKey: null,
    attempt: state.transitionsByFixture[fixtureId]?.attempt ?? 1,
    startedAt: manual.requestedAt, status: result.status, terminalAt: result.occurredAt
  };
  if (result.status === "succeeded" && result.brightnessPercent !== null) {
    state.currentByFixture[fixtureId] = result.brightnessPercent;
    state.lastDesiredByFixture[fixtureId] = result.brightnessPercent;
    state.baseBrightnessByFixture[fixtureId] = result.brightnessPercent;
    delete state.unverifiedDesiredByFixture[fixtureId];
    // New journal records carry causal source identities from hardware success.
    // Old journals have no such evidence and retain the historical UTC fallback.
    const suppression = typeof context === "string"
      ? manualSuppressionAtTerminal(state, fixtureId, sourceId, result.occurredAt, context)
      : context.suppressions[fixtureId];
    if (suppression && (suppression.schedules.length || suppression.vehicleEvents.length)) {
      state.manualAutomationSuppressions[fixtureId] = structuredClone(suppression);
    } else delete state.manualAutomationSuppressions[fixtureId];
  }
  delete state.pendingManualControls[fixtureId];
}

function manualSuppressionAtTerminal(
  state: PersistedAutomationStateV4,
  fixtureId: string,
  sourceId: string,
  appliedAt: string,
  context: "live" | "recovery"
) {
  const appliedAtMs = Date.parse(appliedAt);
  const schedules = Object.entries(state.activeOccurrences)
    .filter(([, occurrence]) => Object.hasOwn(occurrence.preBrightness, fixtureId) &&
      (context === "live" || (Date.parse(occurrence.startedAt) <= appliedAtMs && appliedAtMs < Date.parse(occurrence.endsAt))))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([scheduleId, occurrence]) => ({ scheduleId, occurrenceKey: occurrence.key }));
  const vehicleEvents = Object.entries(state.vehicleRules)
    .filter(([, vehicle]) => vehicle.targetFixtureIds.includes(fixtureId) &&
      (context === "live" || (Date.parse(vehicle.startedAt) <= appliedAtMs &&
        (vehicle.holdUntil === null || appliedAtMs < Date.parse(vehicle.holdUntil)))))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([ruleId, vehicle]) => ({ ruleId, startedAt: vehicle.startedAt }));
  // Manual commands can own a target when expiry requests restoration. Preserve
  // the exact pending activation until durable release finishes, including replay.
  for (const [ruleId, activation] of Object.entries(state.bioActivationsByRule)) {
    if (!activation.completed && activation.targetFixtureIds.includes(fixtureId) &&
      (context === "live" || Date.parse(activation.startedAt) <= appliedAtMs) &&
      !vehicleEvents.some(identity => identity.ruleId === ruleId && identity.startedAt === activation.startedAt)) {
      vehicleEvents.push({ ruleId, startedAt: activation.startedAt });
    }
  }
  vehicleEvents.sort((a, b) => a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.startedAt.localeCompare(b.startedAt));
  return { sourceId, appliedAt, schedules, vehicleEvents };
}

function pruneManualSuppressions(state: PersistedAutomationStateV4, snapshot: SchedulerSnapshot) {
  for (const [fixtureId, suppression] of Object.entries(state.manualAutomationSuppressions)) {
    suppression.schedules = suppression.schedules.filter((identity) =>
      state.activeOccurrences[identity.scheduleId]?.key === identity.occurrenceKey &&
      snapshot.schedules.some((schedule) => schedule.id === identity.scheduleId && schedule.fixtureIds.includes(fixtureId))
    );
    suppression.vehicleEvents = suppression.vehicleEvents.filter((identity) => {
      const vehicle = state.vehicleRules[identity.ruleId];
      return vehicle?.startedAt === identity.startedAt && vehicle.targetFixtureIds.includes(fixtureId);
    });
    if (!suppression.schedules.length && !suppression.vehicleEvents.length) {
      delete state.manualAutomationSuppressions[fixtureId];
    }
  }
}

function scheduleLifecycle(
  kind: "schedule_started" | "schedule_ended",
  ruleId: string,
  occurrence: PersistedAutomationStateV4["activeOccurrences"][string],
  now: Date,
  reason: string
): AutomationLifecycleEvent {
  return {
    kind,
    ruleId,
    occurrenceKey: occurrence.key,
    occurredAt: now.toISOString(),
    payload: {
      startedAt: occurrence.startedAt,
      endsAt: occurrence.endsAt,
      targetFixtureIds: Object.keys(occurrence.preBrightness).sort(),
      reason
    }
  };
}

function tagLifecycleRevision(
  event: AutomationLifecycleEvent,
  snapshot: SchedulerSnapshot,
  previousSnapshot: SchedulerSnapshot | null
): AutomationLifecycleEvent {
  const configurationEnded = (event.kind === "event_ended" || event.kind === "schedule_ended") &&
    event.payload.reason === "configuration_changed";
  return {
    ...event,
    revision: configurationEnded && previousSnapshot ? previousSnapshot.revision : snapshot.revision
  };
}

function activeScheduleCandidates(
  snapshot: SchedulerSnapshot,
  state: PersistedAutomationStateV4,
  fixtureId: string
) {
  const candidates = [];
  for (const [scheduleId, occurrence] of Object.entries(state.activeOccurrences)) {
    const schedule = snapshot.schedules.find((candidate) =>
      candidate.id === scheduleId && candidate.fixtureIds.includes(fixtureId)
    );
    if (schedule) {
      candidates.push({
        sourceId: scheduleId,
        occurrenceKey: occurrence.key,
        brightness: actionBrightness(schedule)
      });
    }
  }
  return candidates;
}

function actionBrightness(rule: LightingScheduleSnapshotV1 | VehicleEventRuleSnapshotV1) {
  return rule.action.dimmingEnabled ? rule.action.brightnessPercent : 100;
}

function captureBase(state: PersistedAutomationStateV4, fixtureId: string): number | null {
  const existing = state.baseBrightnessByFixture[fixtureId];
  if (existing !== undefined) return existing;
  if (state.fixtureLeases[fixtureId]?.sessionId) return null;
  const current = state.currentByFixture[fixtureId] ?? state.lastDesiredByFixture[fixtureId];
  if (current === undefined) return null;
  state.baseBrightnessByFixture[fixtureId] = current;
  return current;
}

function relevantFixtures(snapshot: SchedulerSnapshot, state: PersistedAutomationStateV4) {
  const fixtures = new Set([
    ...Object.keys(state.currentByFixture),
    ...Object.keys(state.baseBrightnessByFixture),
    ...Object.keys(state.lastDesiredByFixture),
    ...Object.keys(state.unverifiedDesiredByFixture),
    ...Object.keys(state.pendingManualControls),
    ...snapshot.schedules.flatMap((schedule) => schedule.fixtureIds),
    ...Object.values(state.vehicleRules).flatMap((vehicle) => vehicle.targetFixtureIds)
  ]);
  return [...fixtures].sort();
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

function validateManualControl(input: ManualControlInput) {
  validateBrightness(input.brightnessPercent);
  if (input.fixtureIds.length === 0 || new Set(input.fixtureIds).size !== input.fixtureIds.length) {
    throw new Error("manual control fixtures must be non-empty and unique");
  }
  if (!Number.isFinite(Date.parse(input.requestedAt))) throw new Error("invalid manual request timestamp");
}

function validateBrightness(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("invalid brightness");
}
