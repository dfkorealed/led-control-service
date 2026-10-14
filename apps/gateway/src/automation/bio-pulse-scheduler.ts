import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { automationSnapshotV2Schema, type AutomationSnapshotV2 } from "@led-control/shared";
import { BioTargetConfigurationRuntime, type BioTargetConfigurationPort } from "./bio-target-configuration";
import { parseBioSourceBinding, type BioSourceBinding, type FileAutomationStateStore,
  type PersistedAutomationStateV4, type PersistedBioActivation } from "./automation-state-store";
import { lifecycleTelemetryRecords, type AutomationTelemetryRecordInput } from "./automation-telemetry-handoff";
import type { BioSourceHealth, BioSourceHealthObservation, VehicleLifecycleEvent, VehicleSensorInput } from "./vehicle-event-runtime";

export interface BioSourceAuthority {
  binding: BioSourceBinding;
  independentlyQualified: boolean;
  connection: { epoch: string; generation: number };
  observation: BioSourceHealthObservation;
}

/** Deliberately not wired to bootstrap, MQTT or a candidate/alive subscriber.
 * Task 5/8 must establish authenticated V2 activation and real qualification
 * before replacing this explicit synthetic-only integration seam.
 */
export interface BioPulseTestProfile {
  kind: "synthetic-test-only";
  bindings: BioSourceBinding[];
  sourceAuthority: (sourceFixtureId: string) => BioSourceAuthority | null;
  targetPort: BioTargetConfigurationPort;
}

/** Local execution core, not a product qualification or configuration authority. */
export interface BioPulseControlDependencies extends Omit<BioPulseTestProfile, "kind"> {
  preflightRelease?: (binding: BioSourceBinding, refresh: boolean) => Promise<boolean>;
  releaseIdentityCurrent?: (binding: BioSourceBinding) => boolean;
  preflight?: (binding: BioSourceBinding, requireHealthy: boolean) => Promise<boolean>;
  enabledRulesOnly?: boolean;
}

export class BioPulseControlCore {
  protected snapshot: AutomationSnapshotV2 | null = null;
  protected readonly bindings: Map<string, BioSourceBinding>;
  private readonly signals = new Map<string, { health: BioSourceHealth; reason: string }>();
  private readonly recoveredAt = new Map<string, number>();
  private readonly targets: BioTargetConfigurationRuntime;
  private transition: { activation: PersistedBioActivation; release: boolean } | null = null;

  constructor(protected readonly profile: BioPulseControlDependencies, protected readonly store: FileAutomationStateStore,
    protected readonly now: () => Date, private readonly monotonic: () => number,
    private readonly automaticReleaseBlocked: (activationId: string) => boolean = () => false) {
    this.bindings = new Map(profile.bindings.map(raw => {
      const binding = parseBioSourceBinding(structuredClone(raw));
      if (binding.sourceFixtureId !== binding.sourceFixtureId.toLowerCase()) throw new Error("bio_source_authority_unverified");
      return [binding.sourceFixtureId, binding];
    }));
    if (this.bindings.size !== profile.bindings.length) throw new Error("bio_source_authority_unverified");
    this.targets = new BioTargetConfigurationRuntime(store, {
      readBioState: async id => {
        await this.preflightTransition();
        const observed = await profile.targetPort.readBioState(id, profile.preflight ? this.transitionControl() : undefined);
        await this.preflightTransition();
        return observed;
      },
      restoreBioState: async (id, target, configuration) => {
        if (this.store.read().fixtureLeases[id]?.sessionId) throw new Error("temporary_fixture_lease_conflict");
        // Read again immediately before each RF call: authority may change while a
        // preceding asynchronous GET/fsync is in flight. Packet metadata is not authority.
        const operation = this.transition;
        if (!operation || !this.canTransition(operation.activation, operation.release)) {
          throw new Error("bio_source_authority_unverified");
        }
        await this.preflightTransition();
        return profile.targetPort.restoreBioState(id, target, configuration,
          this.transitionControl(id));
      }
    }, now);
  }

  /** Only the production lifecycle owner may replace metadata, after old targets
   * are fully restored. This changes no persisted outcome or telemetry evidence. */
  protected resetConfiguration(bindings: BioSourceBinding[]): void {
    this.snapshot = null;
    this.bindings.clear();
    for (const raw of bindings) {
      const binding = parseBioSourceBinding(structuredClone(raw));
      if (this.bindings.has(binding.sourceFixtureId)) throw new Error("bio_source_authority_unverified");
      this.bindings.set(binding.sourceFixtureId, binding);
    }
    this.signals.clear();
    this.recoveredAt.clear();
  }

  protected configurationCheckpoint() {
    return { snapshot: structuredClone(this.snapshot), bindings: structuredClone([...this.bindings.values()]) };
  }

  protected restoreConfigurationCheckpoint(checkpoint: ReturnType<BioPulseControlCore["configurationCheckpoint"]>): void {
    this.resetConfiguration(checkpoint.bindings);
    this.snapshot = structuredClone(checkpoint.snapshot);
  }

  private async preflightTransition(): Promise<void> {
    if (!this.profile.preflight) return;
    const operation = this.transition;
    if (operation?.release && operation.activation.releaseReason === "operator_release" && this.profile.preflightRelease) {
      // Already inside the target's serial RF guard: only recheck identity here.
      // A nested scan/GET would deadlock the sole client queue.
      if (!await this.profile.preflightRelease(operation.activation.binding, false) || !this.canTransition(operation.activation, true)) throw new Error("bio_release_identity_unverified");
      return;
    }
    if (!operation || !await this.profile.preflight(operation.activation.binding,
      !(operation.release && operation.activation.releaseReason === "operator_release"))
      || !this.canTransition(operation.activation, operation.release)) throw new Error("bio_source_authority_unverified");
  }

  private transitionControl(fixtureId?: string) {
    return { beforeWrite: async () => {
      if (fixtureId && this.store.read().fixtureLeases[fixtureId]?.sessionId) throw new Error("temporary_fixture_lease_conflict");
      await this.preflightTransition();
      if (fixtureId && this.store.read().fixtureLeases[fixtureId]?.sessionId) throw new Error("temporary_fixture_lease_conflict");
    }, mayStartWrite: () => {
      const operation = this.transition;
      return Boolean(operation && this.canTransition(operation.activation, operation.release) &&
        (!fixtureId || !this.store.read().fixtureLeases[fixtureId]?.sessionId));
    } };
  }

  install(value: AutomationSnapshotV2) {
    const snapshot = automationSnapshotV2Schema.parse(value) as AutomationSnapshotV2;
    const { payloadHash, ...payload } = snapshot;
    if (payloadHash !== hash(payload)) throw new Error("snapshot_hash_mismatch");
    if (this.snapshot) {
      if (!isDeepStrictEqual(this.snapshot, snapshot)) throw new Error("bio_test_snapshot_change_unavailable");
      return structuredClone(snapshot);
    }
    const sources = new Set(this.bindings.keys());
    const targets = new Set<string>();
    for (const rule of snapshot.vehicleEventRules) {
      if (rule.sensorProtocol !== "bio-usb-pulse" || (this.profile.enabledRulesOnly && rule.status !== "enabled")) continue;
      const binding = this.bindings.get(rule.sourceFixtureIds[0]!);
      if (rule.sourceFixtureIds.length !== 1 || !binding || binding.snapshotRevision !== snapshot.revision) {
        throw new Error("bio_source_authority_unverified");
      }
      // Concurrent BIO/BlueZ ownership needs the versioned product arbiter contract.
      // This staged seam rejects overlapping event targets instead of guessing a base.
      for (const target of rule.targetFixtureIds) {
        if (target !== target.toLowerCase() || sources.has(target) || targets.has(target) ||
          snapshot.vehicleEventRules.some(other => other.id !== rule.id
            // Product disabled rules reserve no target. The synthetic legacy
            // seam intentionally retains its original all-rules ownership check.
            && (!this.profile.enabledRulesOnly || other.status === "enabled") && other.targetFixtureIds.includes(target))) {
          throw new Error("bio_target_activation_conflict");
        }
        targets.add(target);
      }
    }
    if (snapshot.schedules.some(schedule => schedule.fixtureIds.some(id => sources.has(id.toLowerCase()))) ||
      snapshot.vehicleEventRules.some(rule => rule.targetFixtureIds.some(id => sources.has(id.toLowerCase())))) {
      throw new Error("bio_source_target_forbidden");
    }
    const state = this.store.read();
    for (const [ruleId, vehicle] of Object.entries(state.vehicleRules)) {
      if (vehicle.sensorProtocol === "bio-usb-pulse" && !state.bioActivationsByRule[ruleId]) {
        // Historical V7/V8 occurrences have no qualified source binding. Migration
        // preserves evidence but cannot manufacture authorization for that base.
        throw new Error("bio_source_authority_unverified");
      }
    }
    for (const activation of Object.values(state.bioActivationsByRule)) {
      if (!activation.completed && (activation.snapshotHash !== snapshot.payloadHash ||
        !isDeepStrictEqual(this.bindings.get(activation.binding.sourceFixtureId), activation.binding))) {
        throw new Error("bio_source_authority_unverified");
      }
    }
    this.snapshot = snapshot;
    for (const source of this.bindings.keys()) this.recoveredAt.set(source, this.monotonic());
    return structuredClone(snapshot);
  }

  connection() {
    const connections = [...this.bindings.keys()].map(id => this.profile.sourceAuthority(id)?.connection);
    const connection = connections[0];
    return connection && connections.every(other => isDeepStrictEqual(other, connection)) ? connection : null;
  }

  health(source: string): BioSourceHealthObservation | null {
    const binding = this.bindings.get(source);
    const authority = binding ? this.authorized(binding, false) : null;
    return authority ? this.effectiveObservation(source, authority) : null;
  }

  private effectiveObservation(source: string, authority: BioSourceAuthority): BioSourceHealthObservation {
    const observation = authority.observation;
    if (observation.connectionEpoch !== authority.connection.epoch ||
      observation.connectionGeneration !== authority.connection.generation) {
      return { ...observation, health: "degraded", reason: "connection_changed" };
    }
    if (!Number.isFinite(observation.healthySinceMonotonicMs) || observation.healthySinceMonotonicMs < 0 ||
      observation.healthySinceMonotonicMs > this.monotonic()) {
      return { ...observation, health: "unverified", reason: "health_unverified" };
    }
    const signal = this.signals.get(source);
    if (signal && signal.health !== "healthy") return { ...observation, ...signal };
    return { ...observation, healthySinceMonotonicMs: Math.max(observation.healthySinceMonotonicMs,
      this.recoveredAt.get(source) ?? 0) };
  }

  setHealth(source: string, health: BioSourceHealth, reason: string) {
    if (!this.bindings.has(source)) throw new Error("bio_source_authority_unverified");
    if (health === "healthy" && this.signals.get(source)?.health !== "healthy") this.recoveredAt.set(source, this.monotonic());
    this.signals.set(source, { health, reason: safeReason(reason) });
  }

  assertPulse(input: Extract<VehicleSensorInput, { type: "pulse" }>) {
    const binding = this.bindings.get(input.sourceFixtureId);
    if (!this.snapshot || !binding || !this.authorized(binding, true) ||
      input.receipt.nativeUuid !== binding.nativeUuid || input.receipt.logicalAddress !== binding.logicalAddress ||
      input.receipt.networkId !== binding.networkId) throw new Error("bio_source_authority_unverified");
    const previous = Object.values(this.store.read().bioActivationsByRule).find(row =>
      row.binding.sourceFixtureId === input.sourceFixtureId && row.releaseReason !== null &&
      row.releaseReason !== "hold_expired" && !row.completed);
    if (previous) throw new Error("bio_release_pending");
  }

  /** Draft mutation only: caller commits this together with a newly accepted
   * receipt, or discards the entire draft if receipt validation rejects it. */
  resumeAutomaticReleases(state: PersistedAutomationStateV4, input: Extract<VehicleSensorInput, { type: "pulse" }>,
    pendingArrivalActivations: ReadonlySet<string> = new Set()): VehicleLifecycleEvent[] {
    const events: VehicleLifecycleEvent[] = [];
    for (const [ruleId, activation] of Object.entries(state.bioActivationsByRule)) {
      const rule = this.snapshot?.vehicleEventRules.find(candidate => candidate.id === ruleId);
      if (activation.binding.sourceFixtureId !== input.sourceFixtureId ||
        (activation.completed && !pendingArrivalActivations.has(activation.activationId)) || activation.releaseReason !== "hold_expired" ||
        !rule || input.receivedMonotonicMs + rule.holdSeconds * 1000 <= this.monotonic()) continue;
      const previousRestores = activation.targetFixtureIds.flatMap(fixtureId => {
        const target = state.bioTargetsByFixture[fixtureId];
        if (activation.retiredFixtureIds.includes(fixtureId) || target?.activationId !== activation.activationId || !target.restoreResult) return [];
        const previous = { fixtureId, status: target.restoreResult.status, configuration: target.restoreResult.observed };
        // A partial batch may already have restored B1 while B2 is unknown. Keep
        // both original identities/bases, durably reopen only the automatic phase,
        // and require the helper's fresh identity+GET before any reapply. Retired
        // manual targets and explicit operator releases never enter this branch.
        target.restoreResult = null;
        target.applyResult = { status: target.preState ? "pending" : "failed", observed: null,
          attempt: target.applyResult.attempt + 1, at: this.now().toISOString() };
        return [previous];
      });
      // A token can only have been minted while the authoritative store still
      // held this activation pending. If its final fsync won the race, retain the
      // truthful completed handoff and durably reopen this tombstone with the
      // receipt, instead of giving retired manual targets a new activation.
      const wasCompleted = activation.completed;
      activation.completed = false;
      activation.releaseReason = null;
      activation.reportedResults = "";
      state.vehicleRules[ruleId] = { sensorProtocol: "bio-usb-pulse", activeSourceFixtureIds: [],
        targetFixtureIds: [...activation.targetFixtureIds], brightnessPercent: activation.brightnessPercent,
        startedAt: activation.startedAt, holdUntil: this.now().toISOString(), preBrightness: {} };
      events.push({ kind: "event_extended", ruleId, occurrenceKey: activation.activationId, occurredAt: this.now().toISOString(),
        payload: { sensorProtocol: "bio-usb-pulse", reason: wasCompleted ? "bio_completed_release_reopened" : "bio_automatic_release_cancelled", targetFixtureIds: activation.targetFixtureIds,
          previousRestores, restorationPending: false } });
    }
    return events;
  }

  protectedSources() { return [...this.bindings.keys()]; }

  requestRelease(state: PersistedAutomationStateV4, ruleId: string, events: VehicleLifecycleEvent[]) {
    const activation = state.bioActivationsByRule[ruleId];
    if (!events.length && activation && !activation.completed && activation.releaseReason !== "operator_release") {
      // An operator can explicitly release a restore already frozen by a new fault.
      events.push({ kind: "event_ended", ruleId, occurrenceKey: activation.activationId, occurredAt: this.now().toISOString(),
        payload: { reason: "operator_release", targetFixtureIds: activation.targetFixtureIds } });
    }
    return this.stage(state, events);
  }

  /** Runs inside the same durable mutation as receipt, occurrence and handoff. */
  stage(state: PersistedAutomationStateV4, events: VehicleLifecycleEvent[]) {
    if (!this.snapshot) return events;
    const projected: VehicleLifecycleEvent[] = [];
    for (const event of events) {
      const rule = this.snapshot.vehicleEventRules.find(rule => rule.id === event.ruleId);
      let activation = state.bioActivationsByRule[event.ruleId];
      if (rule?.sensorProtocol !== "bio-usb-pulse" && !activation) { projected.push(event); continue; }
      const vehicle = state.vehicleRules[event.ruleId];
      if (vehicle && (!activation || activation.startedAt !== vehicle.startedAt)) {
        if (activation && !activation.completed) throw new Error("bio_release_pending");
        const binding = this.bindings.get(rule!.sourceFixtureIds[0]!)!;
        activation = { activationId: event.occurrenceKey, startedAt: vehicle.startedAt, binding: structuredClone(binding),
          snapshotHash: this.snapshot.payloadHash,
          targetFixtureIds: [...vehicle.targetFixtureIds], brightnessPercent: vehicle.brightnessPercent,
          health: "healthy", healthReason: "qualified", releaseReason: null, completed: false,
          retiredFixtureIds: [], reportedResults: "" };
        state.bioActivationsByRule[event.ruleId] = activation;
      }
      if (!activation) continue;
      if (event.kind === "event_ended") {
        activation.releaseReason = event.payload.reason === "operator_release" ? "operator_release"
          : event.payload.reason === "hold_expired" ? "hold_expired" : "configuration_changed";
        projected.push({ ...event, kind: "event_extended", payload: { ...event.payload,
          sensorProtocol: "bio-usb-pulse", reason: "bio_release_pending", releaseReason: activation.releaseReason, restorationPending: true } });
      } else if (event.payload.reason === "bio_source_degraded" || event.payload.reason === "bio_health_recovered") {
        const health = event.payload.health as BioSourceHealth;
        const reason = health === "healthy" ? "qualified" : safeDegradedReason(String(event.payload.healthReason));
        if (activation.health !== health || activation.healthReason !== reason) {
          activation.health = health; activation.healthReason = reason;
          projected.push({ ...event, payload: { ...event.payload, healthReason: reason } });
        }
      } else projected.push(event);
    }
    return projected;
  }

  ownsFixture(state: PersistedAutomationStateV4, fixtureId: string) {
    return Object.values(state.bioActivationsByRule).some(row => row.targetFixtureIds.includes(fixtureId) &&
      !row.retiredFixtureIds.includes(fixtureId) && !row.completed);
  }

  hasTarget(fixtureId: string) {
    return this.snapshot?.vehicleEventRules.some(rule => rule.sensorProtocol === "bio-usb-pulse"
      && (!this.profile.enabledRulesOnly || rule.status === "enabled") && rule.targetFixtureIds.includes(fixtureId)) ?? false;
  }

  completedRestorationCauses(alreadyCompleted: ReadonlySet<string>) {
    // Correlation only for the normal executor's later baseline results/retries.
    // These are never republished as lifecycle events or configuration read-backs.
    return Object.entries(this.store.read().bioActivationsByRule).filter(([, activation]) =>
      activation.completed && !alreadyCompleted.has(activation.activationId))
      .map(([ruleId, activation]) => ({ kind: "event_ended" as const, ruleId, occurrenceKey: activation.activationId,
        revision: activation.binding.snapshotRevision, occurredAt: this.now().toISOString(),
        payload: { reason: activation.releaseReason, targetFixtureIds: activation.targetFixtureIds
          .filter(id => !activation.retiredFixtureIds.includes(id)) } }));
  }

  async apply(ruleIds?: ReadonlySet<string>) {
    if (!this.snapshot) return;
    for (const [ruleId, activation] of Object.entries(this.store.read().bioActivationsByRule)) {
      if (ruleIds && !ruleIds.has(ruleId)) continue;
      if (activation.completed) continue;
      const release = activation.releaseReason !== null;
      const explicitRelease = release && activation.releaseReason === "operator_release";
      const verified = explicitRelease && this.profile.preflightRelease ? await this.profile.preflightRelease(activation.binding, true)
        : !this.profile.preflight || await this.profile.preflight(activation.binding, !explicitRelease);
      if (!verified) {
        await this.store.updateDurable(state => { this.refreshHealth(state, ruleId); return state; });
        continue;
      }
      if (!this.canTransition(activation, release)) {
        await this.store.updateDurable(state => { this.refreshHealth(state, ruleId); return state; });
        continue;
      }
      const state = this.store.read();
      const targetFixtureIds = activation.targetFixtureIds.filter(id => !activation.retiredFixtureIds.includes(id) &&
        !state.pendingManualControls[id] && !state.fixtureLeases[id]?.sessionId);
      this.transition = { activation, release };
      try {
        if (targetFixtureIds.length) {
          const request = { activationId: activation.activationId, sourceFixtureId: activation.binding.sourceFixtureId,
            targetFixtureIds, brightnessPercent: activation.brightnessPercent, protectedSourceFixtureIds: this.protectedSources() };
          await (release ? this.targets.restore(request) : this.targets.apply(request));
        }
      } finally { this.transition = null; }
      await this.store.updateDurable(next => {
        const current = next.bioActivationsByRule[ruleId]!;
        this.refreshHealth(next, ruleId);
        const results = current.targetFixtureIds.map(fixtureId => {
          const retired = current.retiredFixtureIds.includes(fixtureId);
          const row = next.bioTargetsByFixture[fixtureId];
          const result = row?.activationId === current.activationId ? (release ? row.restoreResult : row.applyResult) : null;
          return { fixtureId, status: retired ? "superseded" : result?.status ?? "pending",
            configuration: retired ? null : result?.observed ?? null };
        });
        const resultHash = hash({ release, results });
        if (current.reportedResults !== resultHash) {
          this.append(next, [{ revision: current.binding.snapshotRevision, ruleId, occurrenceKey: current.activationId,
            kind: "action_result", occurredAt: this.now().toISOString(), payload: { sensorProtocol: "bio-usb-pulse",
              verification: "configuration_readback", phase: release ? "restore" : "apply", results } }]);
          current.reportedResults = resultHash;
        }
        // A qualified pulse can arrive after the last RF dispatch while its
        // verified read-back is still pending. Keep that evidence, but leave the
        // automatic activation pending for durable same-activation renewal.
        const renewalPending = current.releaseReason === "hold_expired" && this.automaticReleaseBlocked(current.activationId);
        if (release && !renewalPending && results.every(result => result.status === "succeeded" || result.status === "superseded")) {
          current.completed = true;
          this.append(next, lifecycleTelemetryRecords({ revision: current.binding.snapshotRevision, events: [{
            kind: "event_ended", ruleId, occurrenceKey: current.activationId, occurredAt: this.now().toISOString(),
            payload: { reason: current.releaseReason, targetFixtureIds: current.targetFixtureIds,
              sensorProtocol: "bio-usb-pulse", restorationPending: false }
          }] }));
        }
        return next;
      });
    }
  }

  retireManualTargets(state: PersistedAutomationStateV4, fixtureId: string) {
    const suppression = state.manualAutomationSuppressions[fixtureId];
    for (const [ruleId, activation] of Object.entries(state.bioActivationsByRule)) {
      if (!activation.targetFixtureIds.includes(fixtureId) || activation.completed ||
        !suppression?.vehicleEvents.some(item => item.ruleId === ruleId && item.startedAt === activation.startedAt)) continue;
      if (!activation.retiredFixtureIds.includes(fixtureId)) activation.retiredFixtureIds.push(fixtureId);
      const target = state.bioTargetsByFixture[fixtureId];
      if (target?.activationId === activation.activationId) delete state.bioTargetsByFixture[fixtureId];
    }
  }

  private canTransition(activation: PersistedBioActivation, release: boolean) {
    const explicitRelease = release && activation.releaseReason === "operator_release";
    if (explicitRelease && this.profile.releaseIdentityCurrent) {
      // Saved revisions attribute restoration only. The distinct proof cannot
      // authorize pulses, extension, hold expiry, or a new activation.
      const saved = Object.values(this.store.read().bioActivationsByRule).find(row => row.activationId === activation.activationId);
      return !!saved && !saved.completed && saved.releaseReason === "operator_release" && isDeepStrictEqual(saved.binding, activation.binding)
        && this.profile.releaseIdentityCurrent(activation.binding);
    }
    if (!this.authorized(activation.binding, !explicitRelease)) return false;
    if (release && !explicitRelease && (!this.profile.enabledRulesOnly || activation.releaseReason === "hold_expired")) {
      if (this.automaticReleaseBlocked(activation.activationId)) return false;
      const health = this.health(activation.binding.sourceFixtureId);
      const rule = this.snapshot?.vehicleEventRules.find(rule => rule.id + ":" + activation.startedAt === activation.activationId);
      // A health fault between the expiry commit and RF must freeze restoration
      // too. Restart/recovery gives this pending release a fresh full hold window.
      if (!health || !rule || this.monotonic() < health.healthySinceMonotonicMs + rule.holdSeconds * 1000) return false;
    }
    return true;
  }

  private refreshHealth(state: PersistedAutomationStateV4, ruleId: string) {
    const activation = state.bioActivationsByRule[ruleId]!;
    const observation = this.health(activation.binding.sourceFixtureId);
    const health = observation?.health ?? "unverified";
    const reason = health === "healthy" ? "qualified" : safeDegradedReason(observation?.reason ?? "health_unverified");
    if (activation.health === health && activation.healthReason === reason) return;
    activation.health = health; activation.healthReason = reason;
    this.append(state, lifecycleTelemetryRecords({ revision: activation.binding.snapshotRevision, events: [{
      kind: "event_extended", ruleId, occurrenceKey: activation.activationId, occurredAt: this.now().toISOString(),
      payload: { reason: health === "healthy" ? "bio_health_recovered" : "bio_source_degraded", health,
        healthReason: reason, sensorProtocol: "bio-usb-pulse", targetFixtureIds: activation.targetFixtureIds,
        restorationPending: true }
    }] }));
  }

  private authorized(binding: BioSourceBinding, healthy: boolean): BioSourceAuthority | null {
    const authority = this.profile.sourceAuthority(binding.sourceFixtureId);
    if (!this.snapshot || !authority?.independentlyQualified || binding.snapshotRevision !== this.snapshot.revision ||
      !isDeepStrictEqual(authority.binding, binding) || !isDeepStrictEqual(this.bindings.get(binding.sourceFixtureId), binding)) return null;
    if (healthy) {
      if (this.effectiveObservation(binding.sourceFixtureId, authority).health !== "healthy") return null;
    }
    return authority;
  }

  private append(state: PersistedAutomationStateV4, records: AutomationTelemetryRecordInput[]) {
    const handoff = this.store.createTelemetryHandoff(records);
    if (handoff) state.pendingTelemetryHandoffs.push(handoff);
  }
}

/** Preserve the explicit local synthetic seam; it is never the production factory. */
export class BioPulseScheduler extends BioPulseControlCore {
  constructor(profile: BioPulseTestProfile, store: FileAutomationStateStore, now: () => Date,
    monotonic: () => number, automaticReleaseBlocked: (activationId: string) => boolean = () => false) {
    if (profile.kind !== "synthetic-test-only") throw new Error("bio_pulse_control_unavailable");
    super(profile, store, now, monotonic, automaticReleaseBlocked);
  }
}

function safeReason(reason: string) {
  return ["qualified", "usb_disconnected", "identity_changed", "liveness_failed", "decoder_failed", "fingerprint_changed", "connection_changed"]
    .includes(reason) ? reason : "health_unverified";
}

function safeDegradedReason(reason: string) {
  // An authority may revoke health before replacing its old reason. Never label
  // that degraded observation as qualified in the strict telemetry contract.
  return reason === "qualified" ? "health_unverified" : safeReason(reason);
}

function hash(value: unknown): `sha256:${string}` {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object"
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : input;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}
