import { FixtureRegistrationRemovalCleanupService } from "./fixture-registration-removal-cleanup.service";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";

describe("removal cleanup exact convergence", () => {
  it("requires the stored catalog ACK to match its delivery identity, not only its hash", async () => {
    const payload = { eventId: "delivery", catalogRevision: 3 };
    const ackPayload = { eventId: "another-delivery", catalogRevision: 3, status: "applied" };
    const tx: any = { bioSensorCatalogState: { findUniqueOrThrow: async () => ({ revision: 3n }) },
      bioSensorCatalogDelivery: { findUnique: async () => ({ payload, payloadHash: canonicalPayloadHash(payload),
        status: "applied", appliedAt: new Date(), supersededAt: null, ackPayload, ackHash: canonicalPayloadHash(ackPayload) }) } };
    const row: any = { siteId: "site", gatewayId: "gateway", assignmentVersion: 1,
      cleanupSnapshot: { catalog: { assignmentVersion: 1, revision: 3, payloadHash: canonicalPayloadHash(payload) }, groups: [] } };
    await expect(new FixtureRegistrationRemovalCleanupService({} as any).isApplied(tx, row)).resolves.toBe(false);
  });
  it("does not reinterpret a newer global revision as the pinned cleanup revision", async () => {
    const tx: any = { bioSensorCatalogState: { findUniqueOrThrow: async () => ({ revision: 4n }) },
      bioSensorCatalogDelivery: { findUnique: async () => null } };
    const row: any = { cleanupSnapshot: { catalog: { assignmentVersion: 1, revision: 3,
      payloadHash: canonicalPayloadHash({}) }, groups: [] } };
    await expect(new FixtureRegistrationRemovalCleanupService({} as any).isApplied(tx, row)).resolves.toBe(false);
  });
});
