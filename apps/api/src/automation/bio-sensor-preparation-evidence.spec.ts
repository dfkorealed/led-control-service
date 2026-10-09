import { randomUUID } from "node:crypto";
import { bioSensorPreparationReportV1Schema } from "@led-control/shared";
import { hasCurrentBioPreparationEvidence } from "./bio-sensor-preparation-evidence";

const fingerprint = { deviceType: 1, firmware: { major: 1, minor: 2, revision: 3, build: 4 }, sensorType: 1,
  infraredType: 0, ambientLightType: 0, hardwareType: 2 };
const profileId = randomUUID();
const profile = { profileId, revision: 1, status: "approved", fingerprint, bodyHexes: ["0001020304050607"],
  linkPolicy: { kind: "mode-get", probeIntervalMs: 1000, maxAgeMs: 5000 }, evidenceDigest: `sha256:${"a".repeat(64)}`, reuseScope: "synthetic-test-only" };
const report = { schemaVersion: 1, commandId: randomUUID(), siteId: randomUUID(), gatewayId: randomUUID(), fixtureId: randomUUID(),
  nodeId: randomUUID(), assignmentVersion: 1, deviceIdentityHash: "a".repeat(64), meshAddress: "0x0001", operation: "query",
  catalogRevision: 1, eventId: randomUUID(), commandPayloadHash: `sha256:${"b".repeat(64)}`, fingerprint, profileKey: `${profileId}@1`,
  connectionGeneration: 1, observedAt: "2026-10-08T00:00:02.000Z", status: "ready", modeVerified: true, linkVerified: true, errorCode: null };

describe("BIO preparation current evidence", () => {
  it("requires both mode and independent link evidence for ready (mode-only is rejected)", () => {
    expect(bioSensorPreparationReportV1Schema.safeParse({ ...report, linkVerified: false }).success).toBe(false);
  });
  it("only accepts the exact approved profile fingerprint and revision", () => {
    const validate = (value: unknown, profiles: unknown[]) => hasCurrentBioPreparationEvidence(bioSensorPreparationReportV1Schema.parse(value),
      profiles as Parameters<typeof hasCurrentBioPreparationEvidence>[1]);
    expect(validate(report, [profile])).toBe(true);
    expect(validate(report, [])).toBe(false);
    expect(validate(report, [{ ...profile, status: "revoked" }])).toBe(false);
    expect(validate(report, [{ ...profile, revision: 2 }])).toBe(false);
    expect(validate({ ...report, fingerprint: { ...fingerprint, hardwareType: 99 } }, [profile])).toBe(false);
  });
});
