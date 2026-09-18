import { PrismaClient } from "@prisma/client";
import { fixturePresenceCheckCommandV1Schema, mqttTopicsV2 } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import { PrismaService } from "../prisma/prisma.service";
import { MonitoringRefreshOutboxService } from "./monitoring-refresh-outbox.service";
import { MonitoringRefreshExpiryService } from "./monitoring-refresh-expiry.service";
import { MonitoringRefreshService } from "./monitoring-refresh.service";

const databaseUrl = process.env.MONITORING_REFRESH_TEST_DATABASE_URL
  ?? process.env.MONITORING_INCIDENTS_TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)("monitoring refresh PostgreSQL concurrency", () => {
  let prisma: PrismaClient;
  const cleanupSiteIds: string[] = [];
  const cleanupUserIds: string[] = [];
  const cleanupOrganizationIds: string[] = [];

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  });
  afterEach(async () => {
    await prisma.site.deleteMany({ where: { id: { in: cleanupSiteIds.splice(0) } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds.splice(0) } } });
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrganizationIds.splice(0) } } });
  });
  afterAll(async () => prisma?.$disconnect());

  it("claims only monitoring-refresh outbox ownership from the real database", async () => {
    const setup = await createRefreshFixtureSet(prisma, 1);
    const dueAt = new Date("1970-01-01T00:00:00.000Z");
    await prisma.mqttOutbox.update({
      where: { id: setup.outboxIds[0] },
      data: { nextAttemptAt: dueAt, lockedBy: null, lockedAt: null, leaseExpiresAt: null }
    });
    const command = await prisma.command.create({ data: {
      siteId: setup.siteId,
      requestedBy: setup.userId,
      clientRequestId: randomUUID(),
      requestFingerprint: "monitoring-refresh-claim-isolation",
      targetType: "fixture",
      brightness: 1
    } });
    const dispatch = await prisma.commandDispatch.create({ data: {
      commandId: command.id,
      gatewayId: setup.gatewayId,
      idempotencyKey: randomUUID(),
      sequence: 100n
    } });
    const commandOutbox = await prisma.mqttOutbox.create({ data: {
      dispatchId: dispatch.id,
      topic: "sites/test/gateways/test/commands",
      payload: { kind: "ordinary-command" },
      nextAttemptAt: dueAt
    } });
    const publisher = new MonitoringRefreshOutboxService(prisma as never, {} as never, {
      workerId: "monitoring-refresh-claim-filter"
    });

    const claimed = await publisher.claimBatch(new Date("1970-01-01T00:00:01.000Z"));

    expect(claimed.map(({ id }) => id)).toEqual(setup.outboxIds);
    expect(await prisma.mqttOutbox.findUniqueOrThrow({ where: { id: commandOutbox.id } }))
      .toMatchObject({ lockedBy: null, lockedAt: null, leaseExpiresAt: null });
    expect(await prisma.mqttOutbox.findUniqueOrThrow({ where: { id: setup.outboxIds[0] } }))
      .toMatchObject({ lockedBy: "monitoring-refresh-claim-filter" });
  });

  it("serializes simultaneous final-batch dead letters so the aggregate cannot remain pending", async () => {
    const setup = await createRefreshFixtureSet(prisma, 2);
    const at = new Date("2026-09-15T08:00:00.000Z");
    const records = await Promise.all(setup.outboxIds.map((id) => loadRecord(prisma, id)));
    const bothPublishing = barrier(2);
    const mqtt = {
      publishTopic: jest.fn(async () => {
        await bothPublishing.arrive();
        throw new Error("controlled broker failure");
      })
    };
    const publishers = setup.workerIds.map((workerId) => new MonitoringRefreshOutboxService(
      prisma as never,
      mqtt as never,
      { workerId, clock: () => at, random: () => 0 }
    ));

    await Promise.all(publishers.map((publisher, index) => publisher.publishClaimed(records[index] as never)));

    expect(await prisma.monitoringRefresh.findUniqueOrThrow({ where: { id: setup.refreshId } })).toMatchObject({
      status: "failed",
      unverifiedFixtures: 2,
      completedAt: at
    });
    expect(await prisma.monitoringRefreshFixture.count({
      where: { refreshId: setup.refreshId, status: "pending" }
    })).toBe(0);
  });

  it("rolls back the Gateway sequence and every refresh row when safe-integer validation fails", async () => {
    const setup = await createRefreshFixtureSet(prisma, 0);
    await prisma.monitoringRefresh.delete({ where: { id: setup.refreshId } });
    const unsafeBase = BigInt(Number.MAX_SAFE_INTEGER);
    await prisma.gateway.update({ where: { id: setup.gatewayId }, data: { nextCommandSequence: unsafeBase } });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: setup.userId } });
    await prisma.site.update({ where: { id: setup.siteId }, data: { adminUserId: user.id } });
    const service = new MonitoringRefreshService(
      prisma as unknown as PrismaService,
      new SiteAccessService(prisma as unknown as PrismaService),
      { clock: () => new Date("2026-09-15T08:00:00.000Z") }
    );
    const beforeRefreshes = await prisma.monitoringRefresh.count({ where: { siteId: setup.siteId } });

    await expect(service.create({ ...user, organizationType: "customer" as const }, setup.siteId, setup.floorId, {
      clientRequestId: randomUUID()
    })).rejects.toThrow("gateway command sequence exceeded safe integer range");

    expect(await prisma.gateway.findUniqueOrThrow({ where: { id: setup.gatewayId } }))
      .toMatchObject({ nextCommandSequence: unsafeBase });
    expect(await prisma.monitoringRefresh.count({ where: { siteId: setup.siteId } })).toBe(beforeRefreshes);
    expect(await prisma.monitoringRefreshRequest.count({ where: { siteId: setup.siteId } })).toBe(0);
  });

  it("lets expiry skip a parent held by dead-letter order and converges after the parent lock releases", async () => {
    const setup = await createRefreshFixtureSet(prisma, 1);
    const record = await loadRecord(prisma, setup.outboxIds[0]);
    const lockHeld = deferred<void>();
    const releaseLock = deferred<void>();
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "MonitoringRefresh" WHERE "id" = ${setup.refreshId} FOR UPDATE`;
      lockHeld.resolve();
      await releaseLock.promise;
    }, { timeout: 10_000 });
    await lockHeld.promise;

    const publisher = new MonitoringRefreshOutboxService(prisma as never, {
      publishTopic: jest.fn().mockRejectedValue(new Error("controlled failure"))
    } as never, { workerId: setup.workerIds[0], clock: () => new Date("2026-09-15T08:00:31.000Z") });
    const expiry = new MonitoringRefreshExpiryService(prisma as never);
    const publishing = publisher.publishClaimed(record as never);
    const expiryResult = await expiry.expire(new Date("2026-09-15T08:00:31.000Z"));

    expect(expiryResult).toEqual({ expired: 0 });
    releaseLock.resolve();
    await Promise.all([blocker, publishing]);
    expect(await prisma.monitoringRefresh.findUniqueOrThrow({ where: { id: setup.refreshId } }))
      .toMatchObject({ status: "expired", unverifiedFixtures: 1 });
  });

  async function createRefreshFixtureSet(client: PrismaClient, batchCount: number) {
    const organization = await client.organization.create({ data: { name: `refresh-race-${randomUUID()}`, type: "customer" } });
    cleanupOrganizationIds.push(organization.id);
    const user = await client.user.create({ data: {
      organizationId: organization.id,
      loginId: `race_${randomUUID()}`,
      name: "Race admin",
      passwordHash: "unused",
      role: "admin"
    } });
    cleanupUserIds.push(user.id);
    const site = await client.site.create({ data: { organizationId: organization.id, name: "race site" } });
    cleanupSiteIds.push(site.id);
    const floor = await client.floor.create({ data: { siteId: site.id, name: "race floor", level: 1 } });
    const gateway = await client.gateway.create({ data: {
      siteId: site.id,
      name: "race gateway",
      serialNumber: randomUUID(),
      firmwareVersion: "test"
    } });
    const startedAt = new Date("2026-09-15T08:00:00.000Z");
    const deadlineAt = new Date("2026-09-15T08:00:30.000Z");
    const refresh = await client.monitoringRefresh.create({ data: {
      siteId: site.id,
      floorId: floor.id,
      requestedById: user.id,
      clientRequestId: randomUUID(),
      totalFixtures: batchCount,
      deadlineAt,
      createdAt: startedAt
    } });
    const outboxIds: string[] = [];
    const workerIds: string[] = [];
    for (let index = 0; index < Math.max(1, batchCount); index += 1) {
      const node = await client.meshNode.create({ data: {
        gatewayId: gateway.id,
        meshAddress: (0x100 + index).toString(16).padStart(4, "0"),
        firmwareVersion: "test"
      } });
      const fixture = await client.fixture.create({ data: {
        siteId: site.id,
        floorId: floor.id,
        gatewayId: gateway.id,
        meshNodeId: node.id,
        name: `fixture-${index}`,
        ratedWatt: 20,
        x: index,
        y: 0
      } });
      if (index >= batchCount) continue;
      const batchId = randomUUID();
      const idempotencyKey = randomUUID();
      const sequence = index + 1;
      const batch = await client.monitoringRefreshBatch.create({ data: {
        id: batchId,
        refreshId: refresh.id,
        siteId: site.id,
        gatewayId: gateway.id,
        sequence,
        idempotencyKey,
        targetFixtureIds: [fixture.id]
      } });
      await client.monitoringRefreshFixture.create({ data: {
        refreshId: refresh.id,
        siteId: site.id,
        fixtureId: fixture.id,
        batchId: batch.id
      } });
      const workerId = `worker-${index}`;
      const payload = fixturePresenceCheckCommandV1Schema.parse({
        refreshId: refresh.id,
        batchId: batch.id,
        idempotencyKey,
        sequence,
        siteId: site.id,
        gatewayId: gateway.id,
        targetFixtureIds: [fixture.id],
        requestedAt: startedAt.toISOString(),
        expiresAt: deadlineAt.toISOString()
      });
      const outbox = await client.mqttOutbox.create({ data: {
        monitoringRefreshBatchId: batch.id,
        topic: mqttTopicsV2.fixturePresenceCheck(site.id, gateway.id),
        payload,
        attempts: 2,
        lockedBy: workerId,
        lockedAt: startedAt,
        leaseExpiresAt: new Date(startedAt.getTime() + 30_000)
      } });
      outboxIds.push(outbox.id);
      workerIds.push(workerId);
    }
    return {
      siteId: site.id,
      floorId: floor.id,
      gatewayId: gateway.id,
      userId: user.id,
      refreshId: refresh.id,
      outboxIds,
      workerIds
    };
  }
});

async function loadRecord(prisma: PrismaClient, id: string) {
  const row = await prisma.mqttOutbox.findUniqueOrThrow({
    where: { id },
    include: { monitoringRefreshBatch: { include: { refresh: true } } }
  });
  if (!row.monitoringRefreshBatchId || !row.monitoringRefreshBatch) throw new Error("invalid test fixture");
  return { ...row, monitoringRefreshBatchId: row.monitoringRefreshBatchId, batch: row.monitoringRefreshBatch };
}

function barrier(participants: number) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return {
    async arrive() {
      arrived += 1;
      if (arrived === participants) release();
      await ready;
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: () => resolve(undefined as T) };
}
