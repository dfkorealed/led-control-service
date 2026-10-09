import { describe, expect, it } from "vitest";
import type { BioSensorPulseCandidate } from "./bio-command-codec";
import { BioSensorPulseIntake, BIO_SENSOR_PULSE_PROFILES, type BioSensorPulseMapping, type BioSensorPulseProfile, type BioSensorPulseHealth } from "./bio-sensor-pulse-intake";

// Synthetic exact profile only: no hardware support or body semantics are asserted.
const profile: readonly BioSensorPulseProfile[] = [{ id: "test-only", firmwareFingerprint: "test-fw", sensorFingerprint: "test-sensor", bodyHex: "aabb" }];
const mapping: BioSensorPulseMapping = { status: "confirmed", nativeUuid: "001122334455", deviceUuid: "bio:001122334455", logicalAddress: 0x1234, networkId: 7, approvedProfileId: "test-only", firmwareFingerprint: "test-fw", sensorFingerprint: "test-sensor" };
const health: BioSensorPulseHealth = { transportConnected: true, protocolReady: true, independentLivenessVerified: true, generation: 3 };
function candidate(): BioSensorPulseCandidate {
  return { kind: "sensor-status-candidate", innerOpcode: 0x09, innerBody: Buffer.from("aabb", "hex"), deviceUuid: "bio:001122334455", logicalAddress: 0x1234, networkId: 7, destination: 0x01fe, rssiDbm: -42, sequence: 255, ttl: 3, control: true, receivedMonotonicMs: 125.5, generation: 3 };
}

describe("BIO pulse shadow intake", () => {
  it("rejects otherwise valid candidates with the empty production allowlist", () => {
    expect(new BioSensorPulseIntake().accept(candidate(), mapping, BIO_SENSOR_PULSE_PROFILES, health)).toEqual({ accepted: false, reason: "PROFILE_NOT_APPROVED" });
  });

  it("accepts only an explicitly injected exact profile and preserves USB receipt time", () => {
    expect(new BioSensorPulseIntake().accept(candidate(), mapping, profile, health)).toEqual({ accepted: true, reason: "ACCEPTED", receivedMonotonicMs: 125.5 });
  });

  it.each([
    { deviceUuid: "bio:aabbccddeeff" }, { logicalAddress: 0x1235 }, { networkId: 8 }
  ])("rejects packet identity mismatch %j", (change) => {
    expect(new BioSensorPulseIntake().accept({ ...candidate(), ...change }, mapping, profile, health)).toEqual({ accepted: false, reason: "IDENTITY_MISMATCH" });
  });

  it.each([
    { status: "reserved" as const }, { nativeUuid: "aabbccddeeff" }, { networkId: undefined }, { sensorFingerprint: undefined }, { firmwareFingerprint: undefined }, { approvedProfileId: undefined }
  ])("rejects missing or unconfirmed verified mapping data %j", (change) => {
    expect(new BioSensorPulseIntake().accept(candidate(), { ...mapping, ...change }, profile, health)).toEqual({ accepted: false, reason: "MAPPING_UNVERIFIED" });
  });

  it.each([
    { approvedProfileId: "other" }, { firmwareFingerprint: "other" }, { sensorFingerprint: "other" }
  ])("rejects nonallowlisted profile identity %j", (change) => {
    expect(new BioSensorPulseIntake().accept(candidate(), { ...mapping, ...change }, profile, health)).toEqual({ accepted: false, reason: "PROFILE_NOT_APPROVED" });
  });

  it.each(["", "aa", "aabc", "aabb00"])("rejects nonexact body %s without returning raw evidence", (bodyHex) => {
    expect(new BioSensorPulseIntake().accept({ ...candidate(), innerBody: Buffer.from(bodyHex, "hex") }, mapping, profile, health)).toEqual({ accepted: false, reason: "BODY_NOT_APPROVED" });
  });

  it.each([
    { transportConnected: false }, { protocolReady: false }, { independentLivenessVerified: false }, { generation: 4 }
  ])("rejects unready or changed USB health %j", (change) => {
    expect(new BioSensorPulseIntake().accept(candidate(), mapping, profile, { ...health, ...change })).toEqual({ accepted: false, reason: "LINK_UNHEALTHY" });
  });

  it.each([NaN, Infinity, -1])("rejects invalid monotonic receipt %s", (receivedMonotonicMs) => {
    expect(new BioSensorPulseIntake().accept({ ...candidate(), receivedMonotonicMs }, mapping, profile, health)).toEqual({ accepted: false, reason: "INVALID_RECEIPT" });
  });

  it("never turns alive observations into a pulse or independently proves link health", () => {
    expect(new BioSensorPulseIntake().accept({ ...candidate(), kind: "alive-status", innerOpcode: 0x0c }, mapping, profile, health)).toEqual({ accepted: false, reason: "NOT_PULSE_CANDIDATE" });
  });
});
