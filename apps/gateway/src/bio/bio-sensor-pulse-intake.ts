import type { BioAliveStatus, BioSensorPulseCandidate } from "./bio-command-codec";

/**
 * Future caller must join confirmed fixture identity with independently verified network
 * and HIL profile evidence. The durable mapping store alone does not contain these fields;
 * neither discovery nor the candidate body by itself authorizes this input.
 */
export interface BioSensorPulseMapping {
  status: "reserved" | "confirmed";
  nativeUuid?: string;
  deviceUuid?: string;
  logicalAddress?: number;
  networkId?: number;
  approvedProfileId?: string;
  firmwareFingerprint?: string;
  sensorFingerprint?: string;
}
export interface BioSensorPulseProfile {
  id: string;
  firmwareFingerprint: string;
  sensorFingerprint: string;
  /** Entire exact body, excluding opcode. No wildcard or inferred state byte. */
  bodyHex: string;
}
export interface BioSensorPulseHealth {
  transportConnected: boolean;
  protocolReady: boolean;
  independentLivenessVerified: boolean;
  generation: number;
}
/** No firmware/body combination has passed the required HIL gate. */
export const BIO_SENSOR_PULSE_PROFILES: readonly BioSensorPulseProfile[] = Object.freeze([]);

export class BioSensorPulseIntake {
  accept(
    candidate: BioSensorPulseCandidate | BioAliveStatus,
    mapping: BioSensorPulseMapping,
    profiles: readonly BioSensorPulseProfile[],
    health: BioSensorPulseHealth
  ): { accepted: boolean; reason: string; receivedMonotonicMs?: number } {
    // Stateless shadow validation only. Durable duplicate/replay ownership belongs to
    // source runtime; accepting here must never publish supported capability or control RF.
    if (candidate.kind !== "sensor-status-candidate" || candidate.innerOpcode !== 0x09) {
      return { accepted: false, reason: "NOT_PULSE_CANDIDATE" };
    }
    if (mapping.status !== "confirmed"
      || !mapping.nativeUuid || !/^[0-9a-f]{12}$/.test(mapping.nativeUuid)
      || mapping.deviceUuid !== `bio:${mapping.nativeUuid}`
      || !Number.isInteger(mapping.logicalAddress) || mapping.logicalAddress! < 1 || mapping.logicalAddress! > 0x7fff
      || !Number.isInteger(mapping.networkId) || mapping.networkId! < 0 || mapping.networkId! > 0xffff
      || !mapping.approvedProfileId || !mapping.firmwareFingerprint || !mapping.sensorFingerprint) {
      return { accepted: false, reason: "MAPPING_UNVERIFIED" };
    }
    if (candidate.deviceUuid !== mapping.deviceUuid || candidate.logicalAddress !== mapping.logicalAddress
      || candidate.networkId !== mapping.networkId) {
      return { accepted: false, reason: "IDENTITY_MISMATCH" };
    }
    if (!health.transportConnected || !health.protocolReady || !health.independentLivenessVerified
      || !Number.isInteger(candidate.generation) || candidate.generation < 1
      || candidate.generation !== health.generation) {
      return { accepted: false, reason: "LINK_UNHEALTHY" };
    }
    if (!Number.isFinite(candidate.receivedMonotonicMs) || candidate.receivedMonotonicMs < 0) {
      return { accepted: false, reason: "INVALID_RECEIPT" };
    }
    const matchingProfiles = profiles.filter((profile) => profile.id === mapping.approvedProfileId
      && profile.firmwareFingerprint === mapping.firmwareFingerprint
      && profile.sensorFingerprint === mapping.sensorFingerprint);
    if (matchingProfiles.length === 0) return { accepted: false, reason: "PROFILE_NOT_APPROVED" };
    // Whole-body equality checks length and every fixed byte, with no guessed wildcard.
    // Validate hex before decoding: Buffer.from otherwise silently truncates invalid hex.
    if (!matchingProfiles.some((profile) => /^(?:[0-9a-f]{2})+$/.test(profile.bodyHex)
      && candidate.innerBody.equals(Buffer.from(profile.bodyHex, "hex")))) {
      return { accepted: false, reason: "BODY_NOT_APPROVED" };
    }
    // Return only reason and monotonic receipt; raw identity/body never enter normal logs.
    return { accepted: true, reason: "ACCEPTED", receivedMonotonicMs: candidate.receivedMonotonicMs };
  }
}
