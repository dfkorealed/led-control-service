describe("removal publication gate", () => {
  const Publisher = require("./fixture-registration-removal-publisher.service").FixtureRegistrationRemovalPublisherService;
  it("takes the membership serializer before claiming operation rows", async () => {
    let serialized = false;
    const tx = { $executeRaw: async (sql: any) => {
      if ((Array.isArray(sql) ? sql.join("") : sql.sql).includes("lock_automation_membership_mutation")) serialized = true;
    }, $queryRaw: async () => {
      if (!serialized) throw new Error("operation row lock before membership serializer");
      return [];
    } };
    const prisma = { $transaction: (fn: any) => fn(tx), fixtureRegistrationRemovalOperation: {
      updateMany: jest.fn(), findMany: async () => [] } };
    await expect(new Publisher(prisma, {}, {}, {}, {}).processBatch()).resolves.toBeUndefined();
  });
  it("does not publish before cleanup has exact applied ACKs", async () => {
    expect(Publisher).toBeDefined();
    const row = { operationId: "operation", status: "pending", lockedBy: "owner", expiresAt: new Date(Date.now() + 30_000),
      leaseExpiresAt: new Date(Date.now() + 10_000), resultHash: null };
    const tx = { fixtureRegistrationRemovalOperation: { findUniqueOrThrow: async () => row, update: jest.fn() }, $queryRaw: jest.fn() };
    const prisma = { $transaction: (fn: any) => fn(tx), fixtureRegistrationRemovalOperation: { updateMany: jest.fn() } };
    const mqtt = { publishTopic: jest.fn() }, operations = { lockCurrent: jest.fn() };
    const cleanup = { prepare: jest.fn(), isApplied: jest.fn().mockResolvedValue(false) };
    const publisher = new Publisher(prisma, mqtt, operations, cleanup, { assertHealthy: async () => new Date() });
    await publisher.deliver({ operationId: row.operationId, leaseId: "owner" });
    expect(cleanup.prepare).toHaveBeenCalled();
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });
  it("probes the exact expired command for a durable result without extending its TTL", async () => {
    const { randomUUID } = require("node:crypto");
    const { canonicalPayloadHash } = require("../automation/automation-payload-hash");
    const now = new Date(), requestedAt = new Date(now.getTime() - 60_000), expiresAt = new Date(now.getTime() - 30_000);
    const payload = { version: 1, operationId: randomUUID(), siteId: randomUUID(), gatewayId: randomUUID(), gatewaySerial: "GW",
      assignmentVersion: 1, fixtureId: randomUUID(), nodeId: randomUUID(), deviceUuid: "bio:aabbccddeeff", meshAddress: "0x0100",
      originalProvisionCommandId: randomUUID(), bindingHash: `sha256:${"a".repeat(64)}`, requestedAt: requestedAt.toISOString(), expiresAt: expiresAt.toISOString() };
    const row = { ...payload, status: "reconcile_required", lockedBy: "owner", expiresAt,
      leaseExpiresAt: new Date(now.getTime() + 10_000), resultHash: null, payload, commandHash: canonicalPayloadHash(payload) };
    const tx = { fixtureRegistrationRemovalOperation: { findUniqueOrThrow: async () => row }, $queryRaw: jest.fn() };
    const prisma = { $transaction: (fn: any) => fn(tx), fixtureRegistrationRemovalOperation: { updateMany: jest.fn() } };
    const mqtt = { publishTopic: jest.fn() }, cleanup = { prepare: jest.fn(), isApplied: jest.fn() };
    await new Publisher(prisma, mqtt, { lockCurrent: jest.fn() }, cleanup, { assertHealthy: async () => now })
      .deliver({ operationId: payload.operationId, leaseId: "owner" });
    expect(mqtt.publishTopic).toHaveBeenCalledWith(expect.any(String), payload, expect.any(Object));
    expect(cleanup.prepare).not.toHaveBeenCalled();
  });
});
