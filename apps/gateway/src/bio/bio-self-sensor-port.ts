import { bioFirmwareFingerprint, bioSensorFingerprintV1Schema, canonicalBioSensorFingerprint, type BioSensorFingerprintV1 } from "@led-control/shared";
import { isDeepStrictEqual } from "node:util";
import type { BioDongleClient, BioSelfSensorOperationControl } from "./bio-dongle-client";
import type { BioDeviceMappingStore } from "./bio-device-mapping-store";
import type { BioPulseSourcePort } from "./bio-sensor-pulse-source";
import type { BioSelfSensorIdentity, BioSelfSensorPort, BioSelfSensorRuntimeOptions } from "../automation/bio-self-sensor-runtime";

interface Options {
  client: Pick<BioDongleClient, "sensorSourceSnapshot" | "readSelfSensorConfiguration" | "configureSelfSensor" | "restoreSelfSensorConfiguration">;
  mappings: Pick<BioDeviceMappingStore, "findByFixtureId">;
  source: Pick<BioPulseSourcePort, "preflight" | "sourceAuthority" | "preflightRelease" | "releaseIdentityCurrent">;
  assignmentVersion: number;
  hasLease(fixtureId: string): boolean;
}

/** Qualified by static codec evidence and the 2026-10-16 B1-L006 native 1s
 * SET/GET, high→standby field observation and exact restore. Match the hardware
 * family, never a fixture ID/name; new registrations use this same resolver.
 * Phase/raw/brightness are still independently checked by every SDK operation. */
export function supportsBioNativeSelfControl(fingerprint: BioSensorFingerprintV1 | undefined): boolean {
  return !!fingerprint && fingerprint.deviceType === 1 && fingerprint.sensorType === 2 && fingerprint.infraredType === 1
    && fingerprint.ambientLightType === 0 && fingerprint.hardwareType === 3 && fingerprint.firmware.major === 5
    && fingerprint.firmware.minor === 5 && fingerprint.firmware.revision === 8 && fingerprint.firmware.build === 12889;
}

export function createBioSelfSensorResolver(options: Options): BioSelfSensorRuntimeOptions["resolve"] {
  return async (fixtureId, revision, release): Promise<BioSelfSensorPort> => {
    const mapping = structuredClone(await options.mappings.findByFixtureId(fixtureId));
    if (!mapping || mapping.status !== "confirmed" || mapping.fixtureId !== fixtureId) throw new Error("bio_self_identity_changed");
    let identity: BioSelfSensorIdentity;
    if (release) {
      if (release.assignmentVersion !== options.assignmentVersion || release.fixtureId !== fixtureId
        || !options.source.preflightRelease || !await options.source.preflightRelease(release.binding)) throw new Error("bio_self_identity_changed");
      identity = structuredClone(release);
    } else {
      const authority = await options.source.preflight({ sourceFixtureId: fixtureId, snapshotRevision: revision }, { requireHealthy: true });
      if (!authority?.independentlyQualified || authority.observation.health !== "healthy" || authority.binding.snapshotRevision !== revision) throw new Error("bio_self_control_unavailable");
      identity = { fixtureId, assignmentVersion: options.assignmentVersion, binding: structuredClone(authority.binding) };
    }
    const binding = identity.binding;
    // Legacy confirmed registrations predate persisted fingerprints. The current
    // independent commissioning authority (or independently verified release
    // binding) already carries the observed hardware identity. Never infer it
    // from the old firmware string or write guessed metadata into the mapping.
    let fingerprint: BioSensorFingerprintV1;
    try { fingerprint = bioSensorFingerprintV1Schema.parse(JSON.parse(binding.sensorFingerprint)); }
    catch { throw new Error("bio_self_firmware_unsupported"); }
    if (!supportsBioNativeSelfControl(fingerprint)) throw new Error("bio_self_firmware_unsupported");
    if (binding.sourceFixtureId !== fixtureId || binding.nativeUuid !== mapping.nativeUuid || binding.logicalAddress !== mapping.logicalAddress
      || binding.sensorFingerprint !== canonicalBioSensorFingerprint(fingerprint) || binding.firmwareFingerprint !== bioFirmwareFingerprint(fingerprint)
      || mapping.firmware !== binding.firmwareFingerprint
      || (mapping.fingerprint && binding.sensorFingerprint !== canonicalBioSensorFingerprint(mapping.fingerprint))) throw new Error("bio_self_identity_changed");
    const target = { kind: "unicast" as const, nativeUuid: binding.nativeUuid, logicalAddress: binding.logicalAddress, networkId: binding.networkId };
    const generation = options.client.sensorSourceSnapshot().generation;
    const current = () => {
      const connection = options.client.sensorSourceSnapshot();
      if (!connection.ready || connection.generation !== generation || options.hasLease(fixtureId)) return false;
      if (release) return options.source.releaseIdentityCurrent?.(binding) === true;
      const authority = options.source.sourceAuthority(fixtureId);
      return !!authority?.independentlyQualified && authority.observation.health === "healthy" && isDeepStrictEqual(authority.binding, binding);
    };
    const beforeWrite = async () => {
      if (!current() || !isDeepStrictEqual(mapping, await options.mappings.findByFixtureId(fixtureId)) || !current()) throw new Error("bio_self_identity_changed");
    };
    const control = (beforeSelfSensorMutation?: BioSelfSensorOperationControl["beforeSelfSensorMutation"]) => ({
      deadlineAt: Date.now() + 30_000, beforeWrite, mayStartWrite: current,
      ...(beforeSelfSensorMutation ? { beforeSelfSensorMutation } : {})
    });
    await beforeWrite();
    return { identity,
      read: () => options.client.readSelfSensorConfiguration(target, control()),
      configure: (desired, before) => options.client.configureSelfSensor(target, desired, { ...control(), beforeSelfSensorMutation: before }),
      restore: (original, expected, before) => options.client.restoreSelfSensorConfiguration(target, original, expected, { ...control(), beforeSelfSensorMutation: before }) };
  };
}
