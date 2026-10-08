import { bioProfileKey, canonicalBioSensorFingerprint, type BioSensorPreparationReportV1, type BioSensorProfileV1 } from "@led-control/shared";

/** Preparation is a checkpoint, not live health or permission to execute a rule. */
export function hasCurrentBioPreparationEvidence(report: BioSensorPreparationReportV1, profiles: BioSensorProfileV1[]) {
  if (report.status !== "ready") return true;
  return report.modeVerified && report.linkVerified && report.fingerprint !== null && profiles.some(profile =>
    profile.status === "approved" && bioProfileKey(profile) === report.profileKey &&
    canonicalBioSensorFingerprint(profile.fingerprint) === canonicalBioSensorFingerprint(report.fingerprint));
}
