import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bioProfileKey, type BioSensorPreparationCommandV1 } from "@led-control/shared";
import type { BioDongleClient } from "./bio-dongle-client";
import type { BioDeviceMappingStore } from "./bio-device-mapping-store";
import { approvedBioProfile, type BioPulseCatalogPort, type BioSensorScope } from "./bio-sensor-profile-catalog";
import { matchesPreparationMapping, type BioSensorCommission } from "../commands/bio-sensor-preparation-handler";
import type { BioSourceBinding } from "../automation/automation-state-store";

export interface BioNodeLinkProof {
  commission: BioSensorCommission;
  healthEpoch: string;
  healthySinceMonotonicMs: number;
  verifiedMonotonicMs: number;
  verifiedAt: string;
  maxAgeMs: number;
}
interface Options { client: BioDongleClient; mappings: BioDeviceMappingStore; catalog: BioPulseCatalogPort;
  scope?: BioSensorScope;
  monotonic?: () => number; onProbe?: (proof: BioNodeLinkProof) => Promise<void> }
/** GET shares the client's sole RF queue. Alive/pulse traffic never updates this owner. */
export class BioNodeLinkMonitor {
  private readonly commissions = new Map<string, BioSensorCommission>();
  private readonly health = new Map<string, BioNodeLinkProof>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly releaseTasks = new Set<Promise<boolean>>();
  private readonly due = new Map<string, number>();
  private readonly listeners = new Set<(fixtureId?: string) => void>();
  private readonly abort = new AbortController();
  private readonly releases: (() => void)[];
  private timer?: ReturnType<typeof setInterval>;
  private revision = 0;
  private readonly sourceRevisions = new Map<string, number>();
  private readonly restorationIdentities = new Map<string, BioSensorPreparationCommandV1>();
  private readonly releaseProofs = new Map<string, { binding: BioSourceBinding; mapping: BioSensorCommission["mapping"]; generation: number; revision: string; verifiedAt: number; maxAgeMs: number }>();
  private readonly monotonic: () => number;
  constructor(private readonly options: Options) {
    this.monotonic = options.monotonic ?? (() => performance.now());
    let generation = options.client.sensorSourceSnapshot().generation;
    this.releases = [options.catalog.onChange(() => this.invalidate()), options.mappings.onChange(() => this.invalidate()),
      options.client.onSensorSourceState(() => {
        const state = options.client.sensorSourceSnapshot();
        if (generation !== state.generation || !state.ready || !state.transportConnected || !state.protocolReady) this.invalidate();
        generation = state.generation;
      }), options.client.onEvent(event => { if (event.kind === "invalid-notification") this.invalidate(); })];
  }
  onChange(listener: (fixtureId?: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Historical attribution is restoration-only: never commission, health, or ACK authority. */
  retainRestorationIdentity(command: BioSensorPreparationCommandV1) {
    const scope = this.options.scope;
    if (scope && (command.siteId !== scope.siteId || command.gatewayId !== scope.gatewayId || command.assignmentVersion !== scope.assignmentVersion)) return;
    this.restorationIdentities.set(command.fixtureId, structuredClone(command));
  }
  commission(value: BioSensorCommission) {
    this.retainRestorationIdentity(value.command);
    this.invalidate(value.command.fixtureId); this.commissions.set(value.command.fixtureId, structuredClone(value)); this.due.set(value.command.fixtureId, 0);
  }
  invalidate(fixtureId?: string) {
    this.bump(fixtureId);
    if (fixtureId) { this.health.delete(fixtureId); this.commissions.delete(fixtureId); this.due.delete(fixtureId); }
    else { this.health.clear(); this.commissions.clear(); this.due.clear(); }
    this.notify(fixtureId);
  }
  snapshot(fixtureId: string): BioNodeLinkProof | null {
    const value = this.health.get(fixtureId), state = this.options.client.sensorSourceSnapshot();
    if (!value) return null;
    if (this.abort.signal.aborted || !state.ready || !state.protocolReady || !state.transportConnected
      || state.generation !== value.commission.report.connectionGeneration
      || this.monotonic() - value.verifiedMonotonicMs >= value.maxAgeMs || this.monotonic() < value.verifiedMonotonicMs) {
      this.health.delete(fixtureId); this.bump(fixtureId); this.notify(fixtureId); return null;
    }
    return structuredClone(value);
  }
  start() {
    if (this.timer || this.abort.signal.aborted) return;
    this.timer = setInterval(() => {
      for (const fixtureId of this.commissions.keys()) {
        this.snapshot(fixtureId);
        if ((this.due.get(fixtureId) ?? 0) <= this.monotonic()) void this.probe(fixtureId);
      }
    }, 25); this.timer.unref();
  }
  /** Explicit restoration proves identity only, even if mode is not sensor. It
   * never populates health, live capability, pins, or a pulse authority cache. */
  preflightRelease(binding: BioSourceBinding, refresh = true): Promise<boolean> {
    const task = this.preflightReleaseOwned(binding, refresh).finally(() => { this.releaseTasks.delete(task); });
    this.releaseTasks.add(task); return task;
  }
  private async preflightReleaseOwned(binding: BioSourceBinding, refresh: boolean): Promise<boolean> {
    if (!refresh) {
      const proof = this.releaseProofs.get(binding.sourceFixtureId);
      return !!proof && this.releaseIdentityCurrent(binding)
        && isDeepStrictEqual(proof.mapping, await this.options.mappings.findByFixtureId(binding.sourceFixtureId))
        && this.releaseIdentityCurrent(binding);
    }
    this.releaseProofs.delete(binding.sourceFixtureId);
    const identity = this.restorationIdentities.get(binding.sourceFixtureId), revision = this.token(binding.sourceFixtureId);
    if (!identity) return false;
    const generation = this.options.client.sensorSourceSnapshot().generation;
    const current = () => {
      const state = this.options.client.sensorSourceSnapshot();
      return !this.abort.signal.aborted && this.token(binding.sourceFixtureId) === revision && this.restorationIdentities.get(binding.sourceFixtureId) === identity
        && state.ready && state.protocolReady && state.transportConnected && state.generation === generation;
    };
    try {
      const mapping = await this.options.mappings.findByFixtureId(binding.sourceFixtureId);
      if (!mapping || !matchesPreparationMapping(mapping, identity) || mapping.nativeUuid !== binding.nativeUuid
        || mapping.logicalAddress !== binding.logicalAddress || !current()) return false;
      const guard = async () => { if (!current() || !isDeepStrictEqual(mapping, await this.options.mappings.findByFixtureId(binding.sourceFixtureId)) || !current()) throw new Error("BIO_RELEASE_IDENTITY_CHANGED"); };
      const control = { signal: this.abort.signal, deadlineAt: Date.now() + 10000, beforeWrite: guard, mayStartWrite: current };
      await guard(); const observations = await this.options.client.scanObservations(control); await guard();
      const exact = observations.filter(d => d.nativeUuid === binding.nativeUuid);
      if (!exact.length || exact.some(d => d.logicalAddress !== binding.logicalAddress || d.networkId !== binding.networkId)
        || observations.some(d => d.logicalAddress === binding.logicalAddress && d.nativeUuid !== binding.nativeUuid)) return false;
      const get = await this.options.client.readDeviceInfo({ kind: "unicast", nativeUuid: binding.nativeUuid,
        logicalAddress: binding.logicalAddress, networkId: binding.networkId }, control); await guard();
      if (get.deviceUuid !== mapping.deviceUuid || get.logicalAddress !== binding.logicalAddress || get.networkId !== binding.networkId) return false;
      this.releaseProofs.set(binding.sourceFixtureId, { binding: structuredClone(binding), mapping: structuredClone(mapping), generation, revision,
        verifiedAt: this.monotonic(), maxAgeMs: 10000 }); return true;
    } catch { return false; }
  }
  releaseIdentityCurrent(binding: BioSourceBinding) {
    const proof = this.releaseProofs.get(binding.sourceFixtureId), state = this.options.client.sensorSourceSnapshot();
    return !!proof && !this.abort.signal.aborted && proof.revision === this.token(binding.sourceFixtureId) && state.ready && state.transportConnected && state.protocolReady
      && proof.generation === state.generation && this.monotonic() >= proof.verifiedAt && this.monotonic() - proof.verifiedAt < proof.maxAgeMs
      && isDeepStrictEqual(proof.binding, binding);
  }
  probe(fixtureId: string): Promise<void> {
    const running = this.pending.get(fixtureId); if (running) return running;
    const run = this.probeOwned(fixtureId).finally(() => { this.pending.delete(fixtureId); }); this.pending.set(fixtureId, run); return run;
  }
  private async probeOwned(fixtureId: string) {
    this.snapshot(fixtureId);
    const commission = this.commissions.get(fixtureId); if (!commission || this.abort.signal.aborted) return;
    const revision = this.token(fixtureId), { catalog, client, mappings } = this.options;
    const approved = approvedBioProfile(catalog.snapshot(), commission.report.fingerprint);
    if (!approved || bioProfileKey(approved) !== commission.report.profileKey || catalog.snapshot()?.catalogRevision !== commission.command.catalogRevision) { this.invalidate(fixtureId); return; }
    const current = () => !this.abort.signal.aborted && revision === this.token(fixtureId) && this.commissions.get(fixtureId) === commission
      && client.sensorSourceSnapshot().ready && client.sensorSourceSnapshot().generation === commission.report.connectionGeneration;
    const guard = async () => { if (!current() || !isDeepStrictEqual(commission.mapping, await mappings.findByFixtureId(fixtureId)) || !current()) throw new Error("BIO_LINK_CHANGED"); };
    this.due.set(fixtureId, this.monotonic() + approved.linkPolicy.probeIntervalMs);
    try {
      await guard();
      const observed = await client.readDeviceInfo({ kind: "unicast", nativeUuid: commission.mapping.nativeUuid,
        logicalAddress: commission.mapping.logicalAddress, networkId: commission.networkId },
      { signal: this.abort.signal, deadlineAt: Date.now() + approved.linkPolicy.maxAgeMs, beforeWrite: guard, mayStartWrite: current });
      await guard();
      if (observed.mode !== "sensor" || observed.deviceUuid !== commission.mapping.deviceUuid
        || observed.logicalAddress !== commission.mapping.logicalAddress || observed.networkId !== commission.networkId) throw new Error("BIO_LINK_MISMATCH");
      const previous = this.health.get(fixtureId), time = this.monotonic();
      // A continuous healthy interval intentionally keeps authority byte-for-byte stable.
      const proof: BioNodeLinkProof = { commission: structuredClone(commission), healthEpoch: previous?.healthEpoch ?? randomUUID(),
        healthySinceMonotonicMs: previous?.healthySinceMonotonicMs ?? time, verifiedMonotonicMs: time,
        verifiedAt: new Date().toISOString(), maxAgeMs: approved.linkPolicy.maxAgeMs };
      this.health.set(fixtureId, proof);
      if (!previous) this.notify(fixtureId);
      await this.options.onProbe?.(structuredClone(proof));
    } catch {
      if (this.health.delete(fixtureId)) { this.bump(fixtureId); this.notify(fixtureId); }
    }
  }
  async stopAndDrain() { this.abort.abort(); clearInterval(this.timer); this.invalidate(); for (const release of this.releases) release(); await Promise.all([...this.pending.values(), ...this.releaseTasks]); }
  private token(fixtureId: string) { return `${this.revision}:${this.sourceRevisions.get(fixtureId) ?? 0}`; }
  private bump(fixtureId?: string) {
    if (fixtureId) { this.sourceRevisions.set(fixtureId, (this.sourceRevisions.get(fixtureId) ?? 0) + 1); this.releaseProofs.delete(fixtureId); }
    else { this.revision++; this.releaseProofs.clear(); }
  }
  private notify(fixtureId?: string) { for (const fn of this.listeners) { try { fn(fixtureId); } catch { /* Consumers cannot mint health by throwing. */ } } }
}
