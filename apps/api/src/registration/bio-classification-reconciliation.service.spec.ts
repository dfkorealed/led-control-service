import { BioClassificationReconciliationService, reconcileBioClassificationInputSchema } from "./bio-classification-reconciliation.service";
import type { AuthenticatedUser } from "../auth/auth.types";

const input = { siteId: "10000000-0000-4000-8000-000000000001", gatewayId: "10000000-0000-4000-8000-000000000002",
  fixtureIds: ["10000000-0000-4000-8000-000000000003"], expectedAssignmentVersion: 2,
  requestId: "10000000-0000-4000-8000-000000000004" };

describe("BIO reconciliation API-local input boundary", () => {
  it("accepts only explicit selected identifiers and expected assignment", () => {
    expect(reconcileBioClassificationInputSchema.parse(input)).toEqual(input);
  });
  it.each([
    { ...input, actorId: "forged" }, { ...input, protocol: "bio_usb_pulse" }, { ...input, readiness: "ready" },
    { ...input, deviceUuid: "bio:aabbccddeeff" }, { ...input, brightness: 100 }, { ...input, fixtureIds: [] },
    { ...input, fixtureIds: [...input.fixtureIds, ...input.fixtureIds] }, { ...input, fixtureIds: Array(11).fill(input.fixtureIds[0]) },
    { ...input, expectedAssignmentVersion: 0 }, { ...input, expectedAssignmentVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, requestId: "not-a-uuid" }, { ...input, expectedAssignmentVersion: "2" }, null
  ])("rejects malformed or caller-controlled state before touching a database: %j", async invalid => {
    const transaction = jest.fn();
    const service = new BioClassificationReconciliationService({ $transaction: transaction } as never,
      {} as never, {} as never, {} as never);
    await expect(service.reconcile({} as AuthenticatedUser, invalid)).rejects.toMatchObject({ status: 400 });
    expect(transaction).not.toHaveBeenCalled();
  });
});
