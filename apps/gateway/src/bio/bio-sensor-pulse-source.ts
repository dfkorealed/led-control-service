import type { BioSourceAuthority } from "../automation/bio-pulse-scheduler";
import type { VehicleSensorInput } from "../automation/vehicle-event-runtime";
import type { BioDongleClient } from "./bio-dongle-client";
import type { BioDeviceMappingStore } from "./bio-device-mapping-store";
import type { BioSensorPulseProfile } from "./bio-sensor-pulse-intake";
import { BIO_SENSOR_PULSE_PROFILES, BioSensorPulseIntake } from "./bio-sensor-pulse-intake";
import type { BioSensorPulseCandidate } from "./bio-command-codec";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseBioSourceBinding } from "../automation/automation-state-store";
import type { BioDeviceMapping } from "./bio-device-mapping-store";

export type BioPulseInput = Extract<VehicleSensorInput, { type: "pulse" }>;
export interface BioPulseAuthorityProvider {
  /** Trusted independent evidence. Every authority/health/profile/decoder revision change
   * must also notify onChange, including changes while identity lookup is pending. */
  read(sourceFixtureId: string, connection: { epoch: string; generation: number }): BioSourceAuthority | null;
  onChange(listener: () => void): () => void;
}
export interface BioPulseSourcePort {
  subscribe(listener: (pulse: BioPulseInput) => void): () => void;
  sourceAuthority(sourceFixtureId: string): BioSourceAuthority | null;
  onRevoked(listener: (sourceFixtureId: string, reason: string) => void): () => void;
}
interface BioPulseSourceOptions {
  client: Pick<BioDongleClient, "onSensorPulseCandidate" | "onSensorSourceState" | "sensorSourceSnapshot" | "onEvent">;
  mappings: Pick<BioDeviceMappingStore, "findByNativeUuid" | "onChange">;
  /** Local trusted integration seam. Production factory never accepts profiles/providers from env. */
  authority?: BioPulseAuthorityProvider;
  profiles?: readonly BioSensorPulseProfile[];
}

export class BioSensorPulseSource implements BioPulseSourcePort {
  private readonly epoch = randomUUID();
  private revision = 0;
  private readonly nativeRevisions = new Map<string, number>();
  private stopped = false;
  private decoderFaultGeneration: number | null = null;
  private readonly intake = new BioSensorPulseIntake();
  private readonly profiles: readonly BioSensorPulseProfile[];
  private readonly listeners = new Set<(pulse: BioPulseInput) => void>();
  private readonly revocations = new Set<(fixtureId: string, reason: string) => void>();
  private readonly authorities = new Map<string, BioSourceAuthority>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly options: BioPulseSourceOptions) {
    this.profiles = Object.freeze((options.profiles ?? BIO_SENSOR_PULSE_PROFILES).map(profile => Object.freeze({ ...profile })));
    let previous = options.client.sensorSourceSnapshot();
    try {
      this.unsubscribers.push(options.client.onSensorPulseCandidate(candidate => {
        // Copy at receipt, then yield: filesystem/authority work must never delay ACK/GET
        // dispatch in the USB notification stack, or inherit a later connection generation.
        const received = { ...candidate, innerBody: Buffer.from(candidate.innerBody) };
        const revision = this.revision;
        const nativeUuid = received.deviceUuid.replace(/^bio:/, "");
        const nativeRevision = this.nativeRevisions.get(nativeUuid) ?? 0;
        void this.consume(received, revision, nativeRevision).catch(() => this.revoke("authority_failed", nativeUuid));
      }));
      this.unsubscribers.push(options.client.onSensorSourceState(state => {
        if (state.generation !== previous.generation || !state.ready || !state.transportConnected || !state.protocolReady) {
          this.revoke("connection_changed");
        }
        previous = { ...state };
      }));
      this.unsubscribers.push(options.client.onEvent(event => {
        if (event.kind === "invalid-notification") {
          this.decoderFaultGeneration = options.client.sensorSourceSnapshot().generation;
          this.revoke("decoder_failed");
        }
      }));
      this.unsubscribers.push(options.mappings.onChange(() => this.revoke("mapping_changed")));
      if (options.authority) this.unsubscribers.push(options.authority.onChange(() => this.revoke("authority_changed")));
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  subscribe(listener: (pulse: BioPulseInput) => void): () => void {
    if (this.stopped) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onRevoked(listener: (sourceFixtureId: string, reason: string) => void): () => void {
    if (this.stopped) return () => {};
    this.revocations.add(listener);
    return () => { this.revocations.delete(listener); };
  }

  sourceAuthority(sourceFixtureId: string): BioSourceAuthority | null {
    const cached = this.authorities.get(sourceFixtureId);
    if (!cached || this.stopped) return null;
    try {
      const current = this.readAuthority(sourceFixtureId, cached.connection.generation);
      if (current && isDeepStrictEqual(current, cached)) return structuredClone(current);
    } catch { /* A throwing provider is never authority. */ }
    this.revoke("authority_changed");
    return null;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.revoke("stopped");
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try { unsubscribe(); } catch { /* Release all observers even if one release fails. */ }
    }
    this.listeners.clear();
    this.revocations.clear();
  }

  private revoke(reason: string, nativeUuid?: string): void {
    const fixtures = [...this.authorities.entries()]
      .filter(([, authority]) => nativeUuid === undefined || authority.binding.nativeUuid === nativeUuid)
      .map(([fixtureId]) => fixtureId);
    // A missing/unreadable unknown candidate must not invalidate a different source.
    // Known-source faults cancel its queued receipts as well as its cached authority.
    if (nativeUuid !== undefined) {
      if (!fixtures.length) return;
      this.nativeRevisions.set(nativeUuid, (this.nativeRevisions.get(nativeUuid) ?? 0) + 1);
    } else this.revision++;
    for (const fixtureId of fixtures) this.authorities.delete(fixtureId);
    for (const fixtureId of fixtures) for (const listener of this.revocations) {
      try { listener(fixtureId, reason); } catch { /* Does not affect transport/command ownership. */ }
    }
  }

  private current(revision: number, generation: number): boolean {
    const state = this.options.client.sensorSourceSnapshot();
    return !this.stopped && this.revision === revision && state.generation === generation
      && state.ready && state.transportConnected && state.protocolReady && this.decoderFaultGeneration !== generation;
  }

  private readAuthority(fixtureId: string, generation: number): BioSourceAuthority | null {
    const revision = this.revision;
    if (!this.current(revision, generation)) return null;
    const supplied = this.options.authority?.read(fixtureId, { epoch: this.epoch, generation });
    if (!this.current(revision, generation) || !supplied || !supplied.independentlyQualified) return null;
    const value = structuredClone(supplied);
    const binding = parseBioSourceBinding(value.binding);
    const observation = value.observation;
    if (binding.sourceFixtureId !== fixtureId || binding.capabilityRevision < 1 || binding.snapshotRevision < 1
      || value.connection.epoch !== this.epoch || value.connection.generation !== generation
      || observation.health !== "healthy" || observation.reason !== "qualified"
      || observation.connectionEpoch !== this.epoch || observation.connectionGeneration !== generation
      || !Number.isFinite(observation.healthySinceMonotonicMs) || observation.healthySinceMonotonicMs < 0) return null;
    // An independently healthy source still has no pulse authority without an approved
    // exact firmware/sensor/body profile. Production's registry deliberately remains empty.
    if (!this.profiles.some(profile => profile.id === binding.profileId
      && profile.firmwareFingerprint === binding.firmwareFingerprint && profile.sensorFingerprint === binding.sensorFingerprint)) return null;
    return { ...value, binding };
  }

  private accepts(candidate: BioSensorPulseCandidate, mapping: BioDeviceMapping, authority: BioSourceAuthority): boolean {
    const binding = authority.binding;
    if (mapping.fixtureId !== binding.sourceFixtureId || mapping.nativeUuid !== binding.nativeUuid
      || mapping.logicalAddress !== binding.logicalAddress
      || authority.observation.healthySinceMonotonicMs > candidate.receivedMonotonicMs) return false;
    return this.intake.accept(candidate, { ...mapping, networkId: binding.networkId, approvedProfileId: binding.profileId,
      firmwareFingerprint: binding.firmwareFingerprint, sensorFingerprint: binding.sensorFingerprint }, this.profiles,
    { transportConnected: true, protocolReady: true, independentLivenessVerified: true, generation: authority.connection.generation }).accepted;
  }

  private async consume(candidate: BioSensorPulseCandidate, revision: number, nativeRevision: number): Promise<void> {
    const nativeUuid = candidate.deviceUuid.replace(/^bio:/, "");
    const current = () => this.current(revision, candidate.generation)
      && (this.nativeRevisions.get(nativeUuid) ?? 0) === nativeRevision;
    if (!current()) return;
    const suppliedMapping = await this.options.mappings.findByNativeUuid(nativeUuid);
    if (!current()) return;
    const known = [...this.authorities.values()].filter(value => value.binding.nativeUuid === nativeUuid);
    if (!suppliedMapping || known.some(({ binding }) => suppliedMapping.status !== "confirmed"
      || suppliedMapping.fixtureId !== binding.sourceFixtureId || suppliedMapping.nativeUuid !== binding.nativeUuid
      || suppliedMapping.deviceUuid !== `bio:${binding.nativeUuid}` || suppliedMapping.logicalAddress !== binding.logicalAddress)) {
      this.revoke("mapping_changed", nativeUuid);
      return;
    }
    const mapping = structuredClone(suppliedMapping);
    const authority = this.readAuthority(mapping.fixtureId, candidate.generation);
    if (!authority) { this.revoke("authority_changed", nativeUuid); return; }
    // Reject packet/body mismatches without degrading a still-qualified known source.
    if (!this.accepts(candidate, mapping, authority)) return;
    // Re-read durable identity, then recheck every qualification field after the await.
    // Store notifications revoke immediately; external edits are caught on these reads.
    const latestMapping = await this.options.mappings.findByNativeUuid(nativeUuid);
    if (!current()) return;
    const latestAuthority = this.readAuthority(mapping.fixtureId, candidate.generation);
    if (!latestMapping || !latestAuthority || !isDeepStrictEqual(mapping, latestMapping)
      || !isDeepStrictEqual(authority, latestAuthority) || !this.accepts(candidate, latestMapping, latestAuthority)) {
      this.revoke("authority_changed", nativeUuid);
      return;
    }
    this.authorities.set(mapping.fixtureId, structuredClone(latestAuthority));
    const pulse: BioPulseInput = { type: "pulse", sourceFixtureId: mapping.fixtureId, receivedMonotonicMs: candidate.receivedMonotonicMs,
      receipt: { nativeUuid, logicalAddress: candidate.logicalAddress, networkId: candidate.networkId, sequence: candidate.sequence,
        connectionEpoch: this.epoch, connectionGeneration: candidate.generation } };
    for (const listener of this.listeners) {
      // A previous callback may stop/revoke the source or change the provider synchronously.
      if (!current() || !this.sourceAuthority(mapping.fixtureId)) break;
      try { listener(structuredClone(pulse)); } catch { /* One consumer cannot suppress another or break ACK handling. */ }
    }
  }
}
