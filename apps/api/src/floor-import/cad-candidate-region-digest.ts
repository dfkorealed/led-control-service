import { createHash } from "node:crypto";
import type { CadCandidateRegionAssignment } from "./cad-region-detector";

export type CadCandidateRegionDigestMap = Readonly<Record<string, string>>;

export function normalizeCadCandidateIdentity(value: string): string {
  return value.normalize("NFKC").toUpperCase();
}

export function computeCandidateRegionDigests(
  regionIds: readonly string[],
  assignments: readonly CadCandidateRegionAssignment[],
  expectedCandidateSourceEntityIds?: readonly string[]
): Record<string, string> {
  const identitiesByRegion = new Map<string, string[]>();
  for (const regionId of regionIds) {
    if (identitiesByRegion.has(regionId)) throw new Error("duplicate CAD region identity");
    identitiesByRegion.set(regionId, []);
  }

  const assignedIdentities = new Set<string>();
  for (const assignment of assignments) {
    const identities = identitiesByRegion.get(assignment.regionId);
    const identity = normalizeCadCandidateIdentity(assignment.sourceEntityId);
    if (!identities || assignedIdentities.has(identity)) throw new Error("invalid CAD candidate region assignment");
    identities.push(identity);
    assignedIdentities.add(identity);
  }
  if (expectedCandidateSourceEntityIds) {
    const expectedIdentities = new Set(expectedCandidateSourceEntityIds.map(normalizeCadCandidateIdentity));
    if (expectedIdentities.size !== expectedCandidateSourceEntityIds.length ||
        expectedIdentities.size !== assignedIdentities.size ||
        [...expectedIdentities].some(identity => !assignedIdentities.has(identity))) {
      throw new Error("CAD candidate region assignments do not cover the detected candidates");
    }
  }

  return Object.fromEntries([...identitiesByRegion.entries()].map(([regionId, identities]) => [
    regionId,
    createHash("sha256").update(JSON.stringify(identities.sort()), "utf8").digest("hex")
  ]));
}

export function candidateRegionDigestsEqual(
  actual: CadCandidateRegionDigestMap,
  expected: CadCandidateRegionDigestMap
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}
