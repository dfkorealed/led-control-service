import { bioFirmwareFingerprint, canonicalBioSensorFingerprint, type AutomationSnapshot } from "@led-control/shared";
import type { BioPulseAuthorityProvider } from "./bio-sensor-pulse-source";
import type { BioSourceAuthority } from "../automation/bio-pulse-scheduler";
import { parseAutomationSnapshot } from "../automation/automation-config-store";
import type { BioPulseCatalogPort, BioSensorScope } from "./bio-sensor-profile-catalog";
import type { BioNodeLinkMonitor } from "./bio-node-link-monitor";
import type { BioCapabilityDeliveryController } from "./bio-capability-delivery";
import type { BioSourceBinding } from "../automation/automation-state-store";

export interface ValidatedBioSnapshotContext { readonly snapshot: AutomationSnapshot }
export interface BioSnapshotLifecycle {
  stage(snapshot: AutomationSnapshot): void;
  commit(snapshot: AutomationSnapshot): void;
  rollback(snapshot: AutomationSnapshot): void;
  retain?(snapshot: AutomationSnapshot): void;
}
/** Snapshot contexts originate only at the runtime's scope/hash/revision validation
 * boundary. A preflight request cannot manufacture context from a numeric revision. */
export class CommissionedBioPulseAuthorityProvider implements BioPulseAuthorityProvider, BioSnapshotLifecycle {
  private readonly contexts = new Map<number, ValidatedBioSnapshotContext>();
  private readonly committed = new Set<number>();
  private readonly executable = new Set<number>();
  private readonly pins = new Map<string, { capabilityRevision: number; healthEpoch: string; reportEventId: string }>();
  private currentRevision?: number;
  private readonly listeners = new Set<() => void>();
  private readonly releases: (() => void)[];
  constructor(private readonly options: { scope: BioSensorScope; catalog: BioPulseCatalogPort; monitor: BioNodeLinkMonitor; delivery: BioCapabilityDeliveryController }) {
    const changed = () => { this.pins.clear(); options.delivery.releaseSnapshotPins(); for (const fn of this.listeners) fn(); };
    this.releases = [options.catalog.onChange(changed), options.monitor.onChange(changed), options.delivery.onChange(changed)];
  }
  onChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  stage(raw: AutomationSnapshot) {
    const snapshot = parseAutomationSnapshot(raw, this.options.scope);
    const existing = this.contexts.get(snapshot.revision);
    if (existing && existing.snapshot.payloadHash !== snapshot.payloadHash) throw new Error("BIO_SNAPSHOT_CONFLICT");
    if (!existing) this.contexts.set(snapshot.revision, { snapshot: structuredClone(snapshot) });
    this.executable.add(snapshot.revision);
  }
  retain(raw: AutomationSnapshot) { const snapshot = parseAutomationSnapshot(raw, this.options.scope); this.contexts.set(snapshot.revision, { snapshot }); this.executable.delete(snapshot.revision); }
  commit(snapshot: AutomationSnapshot) { if (!this.contexts.has(snapshot.revision)) throw new Error("BIO_SNAPSHOT_UNSTAGED"); this.committed.add(snapshot.revision); this.currentRevision = snapshot.revision; }
  rollback(snapshot: AutomationSnapshot) {
    if (this.committed.has(snapshot.revision)) return;
    this.contexts.delete(snapshot.revision);
    this.executable.delete(snapshot.revision);
    for (const key of this.pins.keys()) if (key.startsWith(`${snapshot.revision}:`)) this.pins.delete(key);
    // Earlier committed contexts remain available for already-persisted restoration.
  }
  pinSnapshotBinding(context: ValidatedBioSnapshotContext, fixtureId: string) {
    const revision = context.snapshot.revision;
    if (!this.executable.has(revision) || this.contexts.get(revision) !== context || context.snapshot.schemaVersion !== 2
      || !context.snapshot.vehicleEventRules.some(rule => rule.sensorProtocol === "bio-usb-pulse" && rule.status === "enabled" && rule.sourceFixtureIds.includes(fixtureId))) return null;
    const key = `${revision}:${fixtureId}`, health = this.options.monitor.snapshot(fixtureId);
    if (!health) return null;
    const pinned = this.pins.get(key);
    if (pinned && pinned.healthEpoch === health.healthEpoch && pinned.reportEventId === health.commission.report.eventId) return { ...pinned };
    const accepted = this.options.delivery.acknowledgedCommissionProof(fixtureId);
    if (!accepted || accepted.healthEpoch !== health.healthEpoch || accepted.reportEventId !== health.commission.report.eventId) return null;
    if (!this.options.delivery.retainAcknowledgedRevision(fixtureId, accepted.capabilityRevision)) return null;
    this.pins.set(key, accepted); return { ...accepted };
  }
  read(fixtureId: string, connection: { epoch: string; generation: number }, request?: { snapshotRevision: number; requireHealthy: boolean }): BioSourceAuthority | null {
    const revision = request?.snapshotRevision ?? this.currentRevision;
    if (revision === undefined || !this.options.catalog.snapshot()?.executionPolicy.enabled) return null;
    const context = this.contexts.get(revision); if (!context) return null;
    const health = this.options.monitor.snapshot(fixtureId), pin = this.pinSnapshotBinding(context, fixtureId);
    if (!health || !pin || connection.generation !== health.commission.report.connectionGeneration) return null;
    const { mapping, report, networkId } = health.commission;
    if (!report.fingerprint || !report.profileKey) return null;
    return { independentlyQualified: true, connection: { ...connection },
      binding: { sourceFixtureId: fixtureId, nativeUuid: mapping.nativeUuid, logicalAddress: mapping.logicalAddress, networkId,
        capabilityRevision: pin.capabilityRevision, snapshotRevision: revision, profileId: report.profileKey,
        firmwareFingerprint: bioFirmwareFingerprint(report.fingerprint), sensorFingerprint: canonicalBioSensorFingerprint(report.fingerprint) },
      observation: { health: "healthy", reason: "qualified", connectionEpoch: connection.epoch, connectionGeneration: connection.generation,
        healthySinceMonotonicMs: health.healthySinceMonotonicMs } };
  }
  async preflightRelease(binding: BioSourceBinding, refresh = true): Promise<boolean> {
    return this.releaseContext(binding) && await this.options.monitor.preflightRelease(binding, refresh);
  }
  releaseIdentityCurrent(binding: BioSourceBinding) { return this.releaseContext(binding) && this.options.monitor.releaseIdentityCurrent(binding); }
  private releaseContext(binding: BioSourceBinding) {
    const snapshot = this.contexts.get(binding.snapshotRevision)?.snapshot;
    return snapshot?.schemaVersion === 2 && snapshot.vehicleEventRules.some(rule => rule.sensorProtocol === "bio-usb-pulse" && rule.sourceFixtureIds.includes(binding.sourceFixtureId));
  }
  stop() { this.pins.clear(); for (const release of this.releases) release(); for (const fn of this.listeners) fn(); this.listeners.clear(); }
}
