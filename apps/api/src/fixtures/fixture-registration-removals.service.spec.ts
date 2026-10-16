import { randomUUID } from "node:crypto";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";

const Service: any = require("./fixture-registration-removals.service").FixtureRegistrationRemovalsService;

describe("fixture registration removal HTTP boundary", () => {
  const siteId = randomUUID(), floorId = randomUUID(), fixtureId = randomUUID(), actorId = randomUUID();
  const scope = { siteId, floorId, fixtureId };
  const user = { id: actorId, role: "admin", status: "active", organizationType: "customer" };
  const request = { clientRequestId: randomUUID(), expectedUpdatedAt: "2026-10-16T01:00:00.000Z" };
  function setup() {
    const prior = { operationId: randomUUID(), ...scope, requestedById: actorId,
      clientRequestId: request.clientRequestId, expectedUpdatedAt: new Date(request.expectedUpdatedAt),
      requestHash: canonicalPayloadHash({ ...scope, ...request }), status: "pending", errorCode: null,
      createdAt: new Date(request.expectedUpdatedAt), completedAt: null };
    const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn().mockResolvedValue([]),
      fixtureRegistrationRemovalOperation: { findUnique: jest.fn().mockResolvedValue(prior),
        findFirst: jest.fn().mockResolvedValue(prior) },
      fixture: { findFirst: jest.fn().mockRejectedValue(new Error("replay must not re-admit fixture")) } };
    const access = { assertManageInTransaction: jest.fn() };
    const prisma = { $transaction: jest.fn((fn: any) => fn(tx)) };
    const service = Service && new Service(prisma, access, { assertHealthy: jest.fn() }, {}, {});
    return { service, tx, access, prior };
  }
  it("exports the production HTTP service", () => expect(Service).toBeDefined());
  it("authorizes before exact replay and does not reject its own pending operation", async () => {
    const { service, access, tx, prior } = setup();
    expect(service).toBeDefined();
    const result = await service.create(user, scope, request);
    expect(access.assertManageInTransaction).toHaveBeenCalledWith(tx, user, siteId);
    expect(access.assertManageInTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      tx.fixtureRegistrationRemovalOperation.findUnique.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ operationId: prior.operationId, status: "pending" });
    expect(tx.fixture.findFirst).not.toHaveBeenCalled();
  });
  it("rejects reuse of a request ID with a different body", async () => {
    const { service } = setup(); expect(service).toBeDefined();
    await expect(service.create(user, scope, { ...request, expectedUpdatedAt: "2026-10-16T01:00:01.000Z" }))
      .rejects.toMatchObject({ status: 409 });
  });
  it("does not reveal retained operations to a revoked admin", async () => {
    const { service, access, tx } = setup(); expect(service).toBeDefined();
    access.assertManageInTransaction.mockRejectedValue(Object.assign(new Error("site not found"), { status: 404 }));
    await expect(service.byRequest(user, scope, request.clientRequestId)).rejects.toMatchObject({ status: 404 });
    expect(tx.fixtureRegistrationRemovalOperation.findFirst).not.toHaveBeenCalled();
  });
  it("scopes by-request lookup to the exact actor, fixture, floor and site and returns null", async () => {
    const { service, tx } = setup(); expect(service).toBeDefined();
    tx.fixtureRegistrationRemovalOperation.findFirst.mockResolvedValue(null);
    await expect(service.byRequest(user, scope, request.clientRequestId)).resolves.toBeNull();
    expect(tx.fixtureRegistrationRemovalOperation.findFirst).toHaveBeenCalledWith({ where: {
      ...scope, requestedById: actorId, clientRequestId: request.clientRequestId } });
  });
});
