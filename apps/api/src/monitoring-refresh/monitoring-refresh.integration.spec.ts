import { PrismaClient } from "@prisma/client";
import { mqttTopicsV2 } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { FixturePresenceIngestionService } from "../fixtures/fixture-presence-ingestion.service";
import { FixtureStateIngestionService } from "../energy/fixture-state-ingestion.service";
import { MonitoringRefreshIngestionService } from "./monitoring-refresh-ingestion.service";
import { MonitoringRefreshExpiryService } from "./monitoring-refresh-expiry.service";

const databaseUrl = process.env.MONITORING_REFRESH_TEST_DATABASE_URL ?? process.env.MONITORING_INCIDENTS_TEST_DATABASE_URL;
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 8, 0, seconds));

(databaseUrl ? describe : describe.skip)("monitoring refresh PostgreSQL lifecycle (requires MONITORING_REFRESH_TEST_DATABASE_URL)", () => {
  let prisma: PrismaClient;
  const siteIds: string[] = [], organizationIds: string[] = [];
  beforeAll(() => { prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } }); });
  afterEach(async () => {
    await prisma.site.deleteMany({ where: { id: { in: siteIds.splice(0) } } });
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds.splice(0) } } });
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it.each(["presence", "state"])("converges %s success plus unreachable and recovers without a correlation", async (kind) => {
    const setup = await seed();
    const service = new MonitoringRefreshIngestionService(prisma as never);
    const completed = setup.completed();
    await expect(service.completeBatch(setup.completionTopic, completed, at(1))).rejects.toThrow("pending");
    const successful = { ...setup.scope, fixtureId: setup.fixtures[0].id, eventId: randomUUID(), sequence: 1, occurredAt: at(2).toISOString(), rssi: -42, hopCount: null };
    if (kind === "presence") {
      await new FixturePresenceIngestionService(prisma as never).ingest(setup.scope.gatewayId, {
        ...successful, controlMode: "sensor", configuredBrightness: null, rawHighBrightness: 127
      }, at(2));
    } else {
      await new FixtureStateIngestionService(prisma as never).ingest(setup.scope.gatewayId, {
        ...successful, brightness: 70, powerOn: true, status: "online"
      }, at(2));
    }
    const unreachable = setup.unreachable();
    await Promise.all([service.ingestUnreachable(setup.unreachableTopic, unreachable, at(3)), service.ingestUnreachable(setup.unreachableTopic, unreachable, at(3))]);
    await service.completeBatch(setup.completionTopic, completed, at(4));
    await service.completeBatch(setup.completionTopic, completed, at(5));
    expect(await prisma.monitoringRefresh.findUniqueOrThrow({ where: { id: setup.scope.refreshId } })).toMatchObject({
      status: "completed", onlineFixtures: 1, offlineFixtures: 1, unverifiedFixtures: 0
    });
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: setup.fixtures[1].id } })).toMatchObject({
      status: "offline", statusReason: "fixture_stale", lastUnreachableAt: at(3), brightness: 70, reportedStatus: "online"
    });
    expect(await prisma.mqttOutbox.count({ where: { monitoringRefreshBatchId: setup.scope.batchId } })).toBe(0);
    await new FixturePresenceIngestionService(prisma as never).ingest(setup.scope.gatewayId, {
      siteId: setup.scope.siteId, gatewayId: setup.scope.gatewayId, fixtureId: setup.fixtures[1].id,
      eventId: randomUUID(), sequence: 2, occurredAt: at(6).toISOString(), rssi: -42, hopCount: null,
      controlMode: "sensor", configuredBrightness: null, rawHighBrightness: 127
    }, at(6));
    expect(await prisma.fixture.count({ where: { siteId: setup.scope.siteId, status: "online", lastUnreachableAt: null } })).toBe(2);
  });

  it("keeps newer presence online when unreachable races it", async () => {
    const setup = await seed(); const service = new MonitoringRefreshIngestionService(prisma as never);
    const input = { ...setup.scope, fixtureId: setup.fixtures[1].id, eventId: randomUUID(), sequence: 1,
      occurredAt: at(5).toISOString(), rssi: -42, hopCount: null, controlMode: "sensor" as const, configuredBrightness: null, rawHighBrightness: 127 };
    await Promise.all([
      new FixturePresenceIngestionService(prisma as never).ingest(setup.scope.gatewayId, input, at(5)),
      service.ingestUnreachable(setup.unreachableTopic, setup.unreachable(), at(4))
    ]);
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: input.fixtureId } })).toMatchObject({ status: "online", lastUnreachableAt: null });
    expect(await prisma.monitoringRefreshFixture.findUniqueOrThrow({ where: { refreshId_fixtureId: {
      refreshId: input.refreshId, fixtureId: input.fixtureId
    } } })).toMatchObject({ status: "online" });
  });

  it("serializes expiry against late unreachable and completion without applying offline", async () => {
    const setup = await seed(); const service = new MonitoringRefreshIngestionService(prisma as never);
    await Promise.all([
      new MonitoringRefreshExpiryService(prisma as never).expire(at(31)),
      service.ingestUnreachable(setup.unreachableTopic, setup.unreachable(), at(31))
    ]);
    await service.completeBatch(setup.completionTopic, setup.completed(), at(32));
    expect(await prisma.monitoringRefresh.findUniqueOrThrow({ where: { id: setup.scope.refreshId } })).toMatchObject({ status: "expired", unverifiedFixtures: 2 });
    expect(await prisma.fixture.count({ where: { siteId: setup.scope.siteId, status: "online", lastUnreachableAt: null } })).toBe(2);
  });

  async function seed() {
    const organization = await prisma.organization.create({ data: { name: "refresh ingestion test", type: "customer" } });
    organizationIds.push(organization.id);
    const site = await prisma.site.create({ data: { organizationId: organization.id, name: "refresh test" } }); siteIds.push(site.id);
    const floor = await prisma.floor.create({ data: { siteId: site.id, name: "floor", level: 1 } });
    const gateway = await prisma.gateway.create({ data: { siteId: site.id, name: "gateway", serialNumber: randomUUID(), firmwareVersion: "test", lastHeartbeatAt: at(0) } });
    const fixtures: Array<{ id: string }> = [];
    for (let i = 0; i < 2; i++) {
      const node = await prisma.meshNode.create({ data: { gatewayId: gateway.id, meshAddress: `0x010${i}`, firmwareVersion: "test" } });
      const fixture = await prisma.fixture.create({ data: { siteId: site.id, floorId: floor.id, gatewayId: gateway.id, meshNodeId: node.id,
        name: `fixture ${i}`, ratedWatt: 20, x: i, y: 0, brightness: 70, status: "online", reportedStatus: "online",
        statusReason: "reported", reportedStatusReason: "reported", lastSeenAt: at(-1), energyTrackingStartedAt: at(-2) } });
      await prisma.energyFixtureIdentity.create({ data: { siteId: site.id, fixtureId: fixture.id, trackingStartedAt: at(-2) } });
      fixtures.push(fixture);
    }
    const refresh = await prisma.monitoringRefresh.create({ data: { siteId: site.id, floorId: floor.id, clientRequestId: randomUUID(),
      totalFixtures: 2, deadlineAt: at(30), createdAt: at(0) } });
    const batch = await prisma.monitoringRefreshBatch.create({ data: { refreshId: refresh.id, siteId: site.id, gatewayId: gateway.id,
      sequence: 1, idempotencyKey: randomUUID(), targetFixtureIds: fixtures.map(({ id }) => id), status: "published" } });
    await prisma.monitoringRefreshFixture.createMany({ data: fixtures.map(({ id }) => ({ refreshId: refresh.id, batchId: batch.id, fixtureId: id, siteId: site.id })) });
    await prisma.mqttOutbox.create({ data: { monitoringRefreshBatchId: batch.id, topic: "test", payload: {} } });
    const scope = { siteId: site.id, gatewayId: gateway.id, refreshId: refresh.id, batchId: batch.id };
    return { scope, fixtures,
      unreachableTopic: mqttTopicsV2.fixtureUnreachable(site.id, gateway.id), completionTopic: mqttTopicsV2.fixturePresenceCheckCompleted(site.id, gateway.id),
      unreachable: () => ({ ...scope, fixtureId: fixtures[1].id, eventId: randomUUID(), sequence: 1, occurredAt: at(3).toISOString(), reason: "not_found" }),
      completed: () => ({ ...scope, eventId: randomUUID(), sequence: 2, occurredAt: at(4).toISOString(), targetFixtureIds: fixtures.map(({ id }) => id) })
    };
  }
});
