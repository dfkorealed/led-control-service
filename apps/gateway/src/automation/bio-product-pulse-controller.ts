import { isDeepStrictEqual } from "node:util";
import type { AutomationSnapshot } from "@led-control/shared";
import type { BioPulseSourcePort } from "../bio/bio-sensor-pulse-source";
import { BioPulseControlCore } from "./bio-pulse-scheduler";
import type { BioTargetConfigurationPort } from "./bio-target-configuration";
import { parseBioSourceBinding, type BioSourceBinding, type FileAutomationStateStore } from "./automation-state-store";
import { parseAutomationSnapshot, type AutomationScope } from "./automation-config-store";
import { lifecycleTelemetryRecords } from "./automation-telemetry-handoff";

/** Trusted local ports only. The factory's source has no approved profile/provider.
 * Neither environment flags nor the synthetic scheduler can create this authority. */
export interface BioProductPulseDependencies {
  source: BioPulseSourcePort;
  targetPort: BioTargetConfigurationPort;
  scope: AutomationScope;
}

export class BioProductPulseController extends BioPulseControlCore {
  private canonicalSnapshot: AutomationSnapshot | null = null;
  private stopped = false;

  constructor(private readonly dependencies: BioProductPulseDependencies, store: FileAutomationStateStore,
    now: () => Date, monotonic: () => number, automaticReleaseBlocked: (id: string) => boolean) {
    let owner: BioProductPulseController;
    super({ bindings: [], targetPort: dependencies.targetPort, enabledRulesOnly: true,
      ...(dependencies.source.preflightRelease && dependencies.source.releaseIdentityCurrent ? {
        preflightRelease: (binding: BioSourceBinding, refresh: boolean) => dependencies.source.preflightRelease!(binding, refresh),
        releaseIdentityCurrent: (binding: BioSourceBinding) => !owner?.stopped && dependencies.source.releaseIdentityCurrent!(binding)
      } : {}),
      sourceAuthority: id => owner?.stopped ? null : dependencies.source.sourceAuthority(id),
      preflight: async (binding, requireHealthy) => {
        if (owner?.stopped) return false;
        const authority = await dependencies.source.preflight(binding, { requireHealthy });
        if (owner?.stopped || !authority || !isDeepStrictEqual(authority.binding, binding) || !authority.independentlyQualified) return false;
        if (requireHealthy && authority.observation.health === "healthy" && authority.observation.reason === "qualified") {
          owner.setHealth(binding.sourceFixtureId, "healthy", "qualified");
        }
        return true;
      } }, store, now, monotonic, automaticReleaseBlocked);
    owner = this;
  }

  /** Called only behind AutomationRuntime's scope/hash/revision validation. Validating
   * here again prevents a direct local caller from bypassing the owned assignment. */
  async validate(value: AutomationSnapshot): Promise<{ snapshot: AutomationSnapshot; bindings: BioSourceBinding[] }> {
    const snapshot = parseAutomationSnapshot(value, this.dependencies.scope);
    if (this.canonicalSnapshot && (snapshot.revision < this.canonicalSnapshot.revision
      || (snapshot.revision === this.canonicalSnapshot.revision && snapshot.payloadHash !== this.canonicalSnapshot.payloadHash))) {
      throw new Error("snapshot_revision_conflict");
    }
    const bindings: BioSourceBinding[] = [];
    const sources = snapshot.schemaVersion === 2 || snapshot.schemaVersion === 3 ? new Set(snapshot.vehicleEventRules.filter(rule =>
      rule.sensorProtocol === "bio-usb-pulse" && rule.status === "enabled").flatMap(rule => rule.sourceFixtureIds)) : new Set<string>();
    for (const sourceFixtureId of sources) {
      const authority = await this.dependencies.source.preflight({ sourceFixtureId, snapshotRevision: snapshot.revision }, { requireHealthy: true });
      if (!authority?.independentlyQualified || authority.observation.health !== "healthy"
        || authority.observation.reason !== "qualified" || authority.binding.sourceFixtureId !== sourceFixtureId
        || authority.binding.snapshotRevision !== snapshot.revision) throw new Error("bio_pulse_control_unavailable");
      bindings.push(parseBioSourceBinding(structuredClone(authority.binding)));
    }
    // A preceding source's qualification can change during another source's await.
    for (const binding of bindings) {
      const latest = await this.dependencies.source.preflight(binding, { requireHealthy: true });
      if (!latest || !isDeepStrictEqual(latest.binding, binding)) throw new Error("bio_pulse_control_unavailable");
    }
    return { snapshot, bindings };
  }

  async prepare(value: AutomationSnapshot): Promise<void> {
    const plan = await this.validate(value);
    if (this.canonicalSnapshot && !isDeepStrictEqual(this.canonicalSnapshot, plan.snapshot)) {
      // Use the old owned snapshot/bindings until every old target is resolved. Never
      // use new bindings to restore targets captured by a previous activation.
      await this.releaseForReplacement();
    }
    // Validate again after old GET/fsync/RF, before changing the installed metadata.
    const latest = await this.validate(plan.snapshot);
    const previous = this.checkpoint();
    try {
      this.resetConfiguration(latest.bindings);
      if (latest.snapshot.schemaVersion === 2 || latest.snapshot.schemaVersion === 3) super.install(latest.snapshot);
      this.canonicalSnapshot = structuredClone(latest.snapshot);
    } catch (error) { this.rollback(previous); throw error; }
  }

  checkpoint() { return { canonical: structuredClone(this.canonicalSnapshot), core: this.configurationCheckpoint() }; }

  recoverDegraded(value: AutomationSnapshot): void {
    const snapshot = parseAutomationSnapshot(value, this.dependencies.scope);
    const saved = Object.values(this.store.read().bioActivationsByRule).filter(row => !row.completed);
    const bindings = [...new Map(saved.map(row => [row.binding.sourceFixtureId, row.binding])).values()];
    this.resetConfiguration(bindings);
    // Restoration metadata only; source authority remains unavailable and no old
    // healthy observation or receipt is rehydrated by installing this snapshot.
    if (snapshot.schemaVersion === 2 || snapshot.schemaVersion === 3) this.snapshot = structuredClone(snapshot);
    this.canonicalSnapshot = structuredClone(snapshot);
  }

  protectedSources() {
    return [...new Set([...super.protectedSources(), ...((this.canonicalSnapshot?.schemaVersion === 2 || this.canonicalSnapshot?.schemaVersion === 3)
      ? this.canonicalSnapshot.vehicleEventRules.filter(rule => rule.sensorProtocol === "bio-usb-pulse" && rule.status === "enabled").flatMap(rule => rule.sourceFixtureIds) : [])])];
  }

  rollback(checkpoint: ReturnType<BioProductPulseController["checkpoint"]>): void {
    // Metadata only. Persisted GET/RF outcome truth belongs to the state store, not
    // the configuration checkpoint; restoring it here would erase pending evidence.
    this.restoreConfigurationCheckpoint(checkpoint.core);
    this.canonicalSnapshot = structuredClone(checkpoint.canonical);
  }

  stop(): void {
    this.stopped = true;
    for (const source of this.protectedSources()) this.setHealth(source, "unverified", "health_unverified");
  }

  private async releaseForReplacement(): Promise<void> {
    const pending = Object.entries(this.store.read().bioActivationsByRule).filter(([, activation]) => !activation.completed);
    if (!pending.length) return;
    await this.store.updateDurable(state => {
      const events = pending.map(([ruleId, activation]) => {
        delete state.vehicleRules[ruleId];
        return { kind: "event_ended" as const, ruleId, occurrenceKey: activation.activationId, occurredAt: this.now().toISOString(),
          payload: { reason: activation.releaseReason === "operator_release" ? "operator_release" : "configuration_changed",
            targetFixtureIds: activation.targetFixtureIds } };
      });
      const projected = this.stage(state, events);
      const handoff = this.store.createTelemetryHandoff(lifecycleTelemetryRecords({
        revision: this.canonicalSnapshot!.revision, events: projected }));
      if (handoff) state.pendingTelemetryHandoffs.push(handoff);
      return state;
    });
    await this.apply();
    if (Object.values(this.store.read().bioActivationsByRule).some(activation => !activation.completed)) throw new Error("bio_release_pending");
  }
}
