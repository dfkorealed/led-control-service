import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type { FixtureIdentifyCommand } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { FixtureIdentifyService, identifyCompareDelete } from "./fixture-identify.service";

const databaseUrl = process.env.FIXTURE_IDENTIFY_TEST_DATABASE_URL;
const redisUrl = process.env.FIXTURE_IDENTIFY_TEST_REDIS_URL;
const run = databaseUrl && redisUrl ? describe : describe.skip;

run("fixture identify isolated PostgreSQL + Redis integration", () => {
  const organizationId = randomUUID(), userId = randomUUID(), siteId = randomUUID(), floorId = randomUUID();
  const gatewayId = randomUUID(), inventoryId = randomUUID(), fixtureId = randomUUID(), nodeId = randomUUID(), leaseToken = randomUUID();
  const user = { id: userId, organizationId, organizationType: "customer", loginId: `identify_${userId}`,
    name: "Identify integration", role: "admin", status: "active" } as const;
  let prisma: PrismaService, redis: Redis, service: FixtureIdentifyService;
  let received: FixtureIdentifyCommand[] = [];
  const mqtt = { onFixtureIdentifyResult: jest.fn(() => jest.fn()), publishTopic: jest.fn(async (_topic: string, input: unknown) => {
    const command = input as FixtureIdentifyCommand;
    received.push(command);
    await service.receiveResult({ ...command, reportedAt: new Date().toISOString(),
      status: command.action === "start" ? "attention_confirmed" : "stopped", attentionSeconds: command.action === "start" ? 9 : 0 });
  }) };
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    await prisma.$connect();
    service = new FixtureIdentifyService(prisma, new SiteAccessService(prisma), new AuditService(prisma), { getClient: () => redis } as never, mqtt as never);
    await prisma.organization.create({ data: { id: organizationId, name: "Identify test", type: "customer" } });
    await prisma.user.create({ data: { id: userId, organizationId, loginId: user.loginId, name: user.name,
      passwordHash: "integration-only-unusable", role: "admin", status: "active" } });
    await prisma.site.create({ data: { id: siteId, organizationId, adminUserId: userId, name: "Identify test", address: "Test", tariffKwhRate: "100" } });
    await prisma.floor.create({ data: { id: floorId, siteId, name: "B1", level: -1, editorLeaseHolderId: userId,
      editorLeaseHolderName: user.name, editorLeaseTokenHash: hashEditorLeaseToken(leaseToken), editorLeaseFence: 1,
      editorLeaseAcquiredAt: new Date(), editorLeaseExpiresAt: new Date(Date.now() + 90_000) } });
    await prisma.gateway.create({ data: { id: gatewayId, siteId, name: "Identify gateway", serialNumber: gatewayId,
      firmwareVersion: "integration", claimedAt: new Date(), lastHeartbeatAt: new Date() } });
    await prisma.gatewayInventory.create({ data: { id: inventoryId, serialNumber: gatewayId, claimedGatewayId: gatewayId, claimedAt: new Date() } });
    // Synthetic ledger metadata only: no certificate, key, or device credential is issued.
    await prisma.gatewayCertificate.create({ data: { inventoryId, gatewayId, purpose: "mqtt", certificateSerial: randomUUID(),
      fingerprint: randomUUID(), issuer: "identify-integration", status: "active", notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 90_000) } });
    await prisma.meshNode.create({ data: { id: nodeId, gatewayId, meshAddress: "0x0100", firmwareVersion: "integration" } });
    await prisma.fixture.create({ data: { id: fixtureId, floorId, siteId, gatewayId, meshNodeId: nodeId, name: "Fixture", ratedWatt: "40",
      x: 0, y: 0, status: "online", lastSeenAt: new Date() } });
  });
  afterAll(async () => {
    service?.onModuleDestroy();
    if (redis) {
      const keys = received.flatMap((command) => [`fixture-identify:v1:command:${command.commandId}`, `fixture-identify:v1:result:${command.commandId}`, `fixture-identify:v1:session:${command.sessionId}`]);
      keys.push(`fixture-identify:v1:active:${gatewayId}`, `fixture-identify:v1:operation:${gatewayId}`);
      await redis.del(...keys);
      await redis.quit();
    }
    if (prisma) {
      await prisma.gatewayCertificate.deleteMany({ where: { inventoryId } });
      await prisma.gatewayInventory.deleteMany({ where: { id: inventoryId } });
      await prisma.site.deleteMany({ where: { id: siteId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.auditLog.deleteMany({ where: { siteId } });
      await prisma.$disconnect();
    }
  });
  const request = (action: "start" | "stop", sessionId?: string) => service.identify(floorId, fixtureId, user,
    { action, leaseToken, leaseFence: 1, ...(sessionId ? { sessionId } : {}) });

  it("denies viewer, unassigned admin, and foreign fixture using production authorization", async () => {
    const body = { action: "start", leaseToken, leaseFence: 1 };
    await expect(service.identify(floorId, fixtureId, { ...user, role: "viewer" }, body)).rejects.toThrow();
    await expect(service.identify(floorId, fixtureId, { ...user, id: randomUUID() }, body)).rejects.toThrow();
    await expect(service.identify(floorId, randomUUID(), user, body)).rejects.toThrow("fixture not found");
    expect(received).toHaveLength(0);
  });

  it("rejects a stale gateway heartbeat before reserving or publishing", async () => {
    await prisma.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: new Date(0) } });
    await expect(request("start")).rejects.toThrow("gateway_offline");
    await prisma.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: new Date() } });
    expect(received).toHaveLength(0);
  });

  it("serializes competing starts and protects current session against stale stops", async () => {
    const outcomes = await Promise.allSettled([request("start"), request("start")]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const winner = outcomes.find((value) => value.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof request>>>;
    expect(winner.value.status).toBe("attention_confirmed");
    await expect(request("stop", randomUUID())).rejects.toThrow("stale_session");
    await expect(request("stop", winner.value.sessionId)).resolves.toMatchObject({ status: "stopped" });
    const next = await request("start");
    await expect(request("stop", winner.value.sessionId)).rejects.toThrow("stale_session");
    await expect(request("stop", next.sessionId)).resolves.toMatchObject({ status: "stopped" });
    const logs = await prisma.auditLog.findMany({ where: { actorId: userId, action: "fixture.identify.start" } });
    expect(logs).toHaveLength(2);
  });
  it("uses actual database lease expiry and refuses stale fences", async () => {
    await prisma.floor.update({ where: { id: floorId }, data: { editorLeaseExpiresAt: new Date(Date.now() - 1000) } });
    await expect(request("start")).rejects.toThrow("lease");
    await prisma.floor.update({ where: { id: floorId }, data: { editorLeaseFence: 2, editorLeaseExpiresAt: new Date(Date.now() + 90_000) } });
    await expect(request("start")).rejects.toThrow("lease");
  });
  it("Redis compare-delete cannot cancel a newer reservation and preserves bounded TTL", async () => {
    const key = `fixture-identify:v1:active:${gatewayId}`;
    await redis.set(key, "new-session", "PX", 10_000);
    expect(await redis.eval(identifyCompareDelete, 1, key, "old-session")).toBe(0);
    expect(await redis.get(key)).toBe("new-session");
    expect(await redis.pttl(key)).toBeGreaterThan(0);
    expect(await redis.pttl(key)).toBeLessThanOrEqual(10_000);
  });
});
