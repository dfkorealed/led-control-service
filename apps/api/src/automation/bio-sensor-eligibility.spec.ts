import { loadBioSensorEligibility } from "./bio-sensor-eligibility";
import { bioSensorDiscoveryCatalogMatch, hasCurrentBioPreparationEvidence } from "./bio-sensor-preparation-evidence";

const fingerprint = { deviceType: 1, firmware: { major: 1, minor: 2, revision: 3, build: 4 }, sensorType: 1,
  infraredType: 0, ambientLightType: 0, hardwareType: 2 };
const profile: any = { profileId: "00000000-0000-4000-8000-000000000001", revision: 1, status: "approved", fingerprint,
  bodyHexes: ["0001020304050607"], linkPolicy: { kind: "mode-get", probeIntervalMs: 1000, maxAgeMs: 5000 },
  evidenceDigest: `sha256:${"a".repeat(64)}`, reuseScope: "synthetic-test-only" };
describe("common BIO qualification/projection", () => {
  it("batches fixtures once and returns only bounded sanitized DTO fields", async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ fixtureId: "a", status: "ready", commandId: "c", profileKey: "p@1",
      observedAt: "2026-10-08T00:00:00.000Z", blockedReasons: [], preparationCandidate: true }]) };
    const result = await loadBioSensorEligibility(tx as never, ["a", "b"]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.get("a")).toEqual({ status: "ready", commandId: "c", profileKey: "p@1", observedAt: "2026-10-08T00:00:00.000Z",
      blockedReasons: [], preparationCandidate: true });
    expect(JSON.stringify([...result.values()])).not.toMatch(/fingerprint|bodyHex|deviceUuid|meshAddress|Hash/);
  });
  it("matches only a current unique exact full fingerprint, never guesses unsupported", () => {
    expect(bioSensorDiscoveryCatalogMatch(fingerprint, [profile])).toEqual({ status: "matched", profileKey: `${profile.profileId}@1` });
    for (const profiles of [[], [profile, { ...profile, profileId: "other" }], [{ ...profile, status: "revoked" }]]) {
      expect(bioSensorDiscoveryCatalogMatch(fingerprint, profiles)).toEqual({ status: "unverified", profileKey: null });
    }
    expect(bioSensorDiscoveryCatalogMatch({ ...fingerprint, hardwareType: 3 }, [profile]).status).toBe("unverified");
    expect(bioSensorDiscoveryCatalogMatch(null, [profile]).status).toBe("unverified");
    const report: any = { status: "ready", modeVerified: true, linkVerified: true, fingerprint, profileKey: `${profile.profileId}@1` };
    expect(hasCurrentBioPreparationEvidence(report, [profile, { ...profile, profileId: "other" }])).toBe(false);
  });
});
