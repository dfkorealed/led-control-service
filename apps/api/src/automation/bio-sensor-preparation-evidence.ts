import { bioProfileKey, canonicalBioSensorFingerprint, bioSensorFingerprintV1Schema, bioSensorProfileV1Schema,
  type BioSensorPreparationReportV1, type BioSensorProfileV1 } from "@led-control/shared";
import type { Prisma } from "@prisma/client";

export async function loadCurrentBioSensorProfiles(tx: Prisma.TransactionClient): Promise<BioSensorProfileV1[]> {
  const rows = await tx.bioSensorProfileRevision.findMany({ orderBy: [{ profileId: "asc" }, { revision: "desc" }] });
  const selected = new Set<string>();
  return rows.filter(row => { if (selected.has(row.profileId)) return false; selected.add(row.profileId); return true; })
    .map(({ actorId: _a, createdAt: _c, ...row }) => bioSensorProfileV1Schema.parse({ ...row, revision: Number(row.revision) }));
}

/** Discovery matching is informational; absence/unknown sensor numbers are not
 * unsupported transport, classification, mode, live health or SET authority. */
export function bioSensorDiscoveryCatalogMatch(value: unknown, profiles: BioSensorProfileV1[]) {
  const parsed = bioSensorFingerprintV1Schema.safeParse(value);
  const matches = parsed.success ? profiles.filter(profile => profile.status === "approved"
    && canonicalBioSensorFingerprint(profile.fingerprint) === canonicalBioSensorFingerprint(parsed.data)) : [];
  return { status: matches.length === 1 ? "matched" as const : "unverified" as const,
    profileKey: matches.length === 1 ? bioProfileKey(matches[0]) : null };
}

/** Preparation is a checkpoint, not live health or permission to execute a rule. */
export function hasCurrentBioPreparationEvidence(report: BioSensorPreparationReportV1, profiles: BioSensorProfileV1[]) {
  if (report.status !== "ready") return true;
  const matching = report.fingerprint === null ? [] : profiles.filter(profile => profile.status === "approved"
    && canonicalBioSensorFingerprint(profile.fingerprint) === canonicalBioSensorFingerprint(report.fingerprint));
  return report.modeVerified && report.linkVerified && matching.length === 1 && bioProfileKey(matching[0]) === report.profileKey;
}
