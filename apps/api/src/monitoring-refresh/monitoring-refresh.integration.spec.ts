import { PrismaClient } from "@prisma/client";
import { mqttTopicsV2 } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { FixturePresenceIngestionService } from "../fixtures/fixture-presence-ingestion.service";
import { FixtureStateIngestionService } from "../energy/fixture-state-ingestion.service";
import { MonitoringRefreshIngestionService } from "./monitoring-refresh-ingestion.service";
import { MonitoringRefreshExpiryService } from "./monitoring-refresh-expiry.service";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { DataRetentionService } from "../retention/data-retention.service";
import { disposableMosquitto } from "../../test/support/disposable-mosquitto";
import { MqttService } from "../mqtt/mqtt.service";
import mqtt from "mqtt";

let databaseUrl = process.env.MONITORING_REFRESH_TEST_DATABASE_URL ?? process.env.MONITORING_INCIDENTS_TEST_DATABASE_URL;
const selfOwnedDatabase = process.env.MONITORING_REFRESH_DISPOSABLE_POSTGRES === "1";
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 8, 0, seconds));

(databaseUrl || selfOwnedDatabase ? describe : describe.skip)("monitoring refresh PostgreSQL lifecycle (requires test URL or explicit disposable opt-in)", () => {
  let prisma: PrismaClient;
  let cluster: Awaited<ReturnType<typeof disposablePostgres>> | undefined;
  const siteIds: string[] = [], organizationIds: string[] = [];
  beforeAll(async () => {
    if (selfOwnedDatabase) {
      cluster = await disposablePostgres();
      databaseUrl = cluster.database();
      const deployed = cluster.deploy(databaseUrl);
      expect(deployed.status).toBe(0);
    }
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  }, 40_000);
  afterEach(async () => {
    await prisma.site.deleteMany({ where: { id: { in: siteIds.splice(0) } } });
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds.splice(0) } } });
  });
  afterAll(async () => { await prisma?.$disconnect(); cluster?.stop(); });

  it("seeds a published batch satisfying the deployed lifecycle CHECK", async () => {
    const setup = await seed();
    expect(await prisma.monitoringRefreshBatch.findUniqueOrThrow({ where: { id: setup.scope.batchId } }))
      .toMatchObject({ status: "published", publishedAt: at(1), completedAt: null });
  });

  it("commits early completion before publisher PUBACK persistence without violating the lifecycle CHECK", async () => {
    const setup = await seed();
    await prisma.monitoringRefreshBatch.update({ where: { id: setup.scope.batchId }, data: { status: "pending", publishedAt: null } });
    await prisma.monitoringRefreshFixture.updateMany({ where: { refreshId: setup.scope.refreshId }, data: { status: "online", observedAt: at(2) } });
    const result = await new MonitoringRefreshIngestionService(prisma as never).completeBatch(setup.completionTopic, setup.completed(), at(4));
    expect(result).toEqual({ ack: setup.scope });
    expect(await prisma.monitoringRefreshBatch.findUniqueOrThrow({ where: { id: setup.scope.batchId } }))
      .toMatchObject({ status: "completed", publishedAt: at(4), completedAt: at(4) });
    expect(await prisma.mqttOutbox.count({ where: { monitoringRefreshBatchId: setup.scope.batchId } })).toBe(0);
  });

  it.each(["presence", "state"])("converges %s success plus unreachable and recovers without a correlation", async (kind) => {
    const setup = await seed();
    const service = new MonitoringRefreshIngestionService(prisma as never);
    const completed = setup.completed();
    await expect(service.completeBatch(setup.completionTopic, completed, at(1))).resolves.toEqual({ ack: null });
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
    expect(await prisma.monitoringRefreshBatch.findUniqueOrThrow({ where: { id: setup.scope.batchId } }))
      .toMatchObject({ status: "completed", publishedAt: at(1) });
    expect(await prisma.monitoringRefresh.findUniqueOrThrow({ where: { id: setup.scope.refreshId } })).toMatchObject({
      status: "completed", onlineFixtures: 1, offlineFixtures: 1, unverifiedFixtures: 0
    });
    expect(await prisma.monitoringActivity.findMany({ where: { siteId: setup.scope.siteId,
      sourceType: "monitoring_refresh", kind: "monitoring_refresh_result" },
      select: { sourceKey: true, refreshStatus: true } })).toEqual([{
      sourceKey: `${setup.scope.refreshId}:completed`, refreshStatus: "completed"
    }]);
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: setup.fixtures[1].id } })).toMatchObject({
      status: "offline", statusReason: "fixture_stale", lastUnreachableAt: at(3), brightness: 70, reportedStatus: "online"
    });
    expect(await prisma.monitoringActivity.findMany({ where: { siteId: setup.scope.siteId,
      sourceType: "monitoring_refresh", sourceKey: `${unreachable.eventId}:fixture_offline` },
      select: { kind: true, fixtureId: true, status: true } })).toEqual([{
      kind: "fixture_offline", fixtureId: setup.fixtures[1].id, status: "offline"
    }]);
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
    const completed = setup.completed();
    await expect(service.completeBatch(setup.completionTopic, completed, at(32))).resolves.toEqual({ ack: setup.scope });
    await expect(service.completeBatch(setup.completionTopic, completed, at(33))).resolves.toEqual({ ack: setup.scope });
    expect(await prisma.monitoringRefresh.findUniqueOrThrow({ where: { id: setup.scope.refreshId } })).toMatchObject({ status: "expired", unverifiedFixtures: 2 });
    expect(await prisma.fixture.count({ where: { siteId: setup.scope.siteId, status: "online", lastUnreachableAt: null } })).toBe(2);
  });

  it("drains presence, state, unreachable and completion after real retention without modifying fixture or energy", async () => {
    const setup = await seed();
    await new MonitoringRefreshExpiryService(prisma as never).expire(at(31));
    const fixtureBefore = await prisma.fixture.findMany({ where: { siteId: setup.scope.siteId }, orderBy: { id: "asc" } });
    const later = new Date(at(31).getTime() + 8 * 86_400_000);
    expect((await new DataRetentionService(prisma as never).prune(later)).monitoringRefreshes).toBe(1);
    expect(await prisma.monitoringRefreshBatch.count({ where: { id: setup.scope.batchId } })).toBe(0);
    const service = new MonitoringRefreshIngestionService(prisma as never);
    const event = { ...setup.scope, fixtureId: setup.fixtures[0].id, eventId: randomUUID(), sequence: 1,
      occurredAt: at(2).toISOString(), rssi: -42, hopCount: null };
    await expect(new FixturePresenceIngestionService(prisma as never).ingest(setup.scope.gatewayId, {
      ...event, controlMode: "sensor", rawHighBrightness: 127, configuredBrightness: null
    }, later)).resolves.toMatchObject({ status: "duplicate" });
    await expect(new FixtureStateIngestionService(prisma as never).ingest(setup.scope.gatewayId, {
      ...event, eventId: randomUUID(), brightness: 0, powerOn: false, status: "online"
    }, later)).resolves.toMatchObject({ status: "duplicate" });
    await expect(service.ingestUnreachable(setup.unreachableTopic, setup.unreachable(), later)).resolves.toMatchObject({ status: "duplicate" });
    await expect(service.completeBatch(setup.completionTopic, setup.completed(), later)).resolves.toEqual({ ack: setup.scope });
    expect(await prisma.fixture.findMany({ where: { siteId: setup.scope.siteId }, orderBy: { id: "asc" } })).toEqual(fixtureBefore);
    expect(await prisma.processedGatewayEvent.count({ where: { gatewayId: setup.scope.gatewayId } })).toBe(0);
    expect(await prisma.fixtureEnergyStateCursor.count({ where: { fixtureId: { in: setup.fixtures.map((fixture) => fixture.id) } } })).toBe(0);
    // A later ordinary state must still ingest: retired results cannot advance the event watermark.
    const { refreshId: _, batchId: __, ...ordinary } = event;
    await expect(new FixtureStateIngestionService(prisma as never).ingest(setup.scope.gatewayId, {
      ...ordinary, eventId: randomUUID(), occurredAt: later.toISOString(), brightness: 30, powerOn: true, status: "online"
    }, later)).resolves.toMatchObject({ status: "ingested" });
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: event.fixtureId } })).toMatchObject({ brightness: 30, powerOn: true });
  });

  (process.env.MONITORING_REFRESH_DISPOSABLE_MQTT === "1" ? it : it.skip)("keeps the real MQTT parser moving through early completion and retired results", async () => {
    const setup = await seed(), clock = new Date();
    await prisma.monitoringRefresh.update({ where: { id: setup.scope.refreshId }, data: {
      createdAt: clock, deadlineAt: new Date(clock.getTime() + 30_000)
    } });
    await prisma.gateway.update({ where: { id: setup.scope.gatewayId }, data: { lastHeartbeatAt: clock } });
    const broker = await disposableMosquitto();
    const service = new MqttService(prisma as never, {} as never);
    const api = mqtt.connect(broker.url, { protocolVersion: 5, clean: false, clientId: `refresh-api-${randomUUID()}`,
      reconnectPeriod: 0, customHandleAcks: (service as any).createCustomHandleAcks() });
    const peer = mqtt.connect(broker.url, { protocolVersion: 5, reconnectPeriod: 0 });
    (service as any).client = api; service.onModuleInit();
    const received: Array<{ topic: string; event: any }> = [];
    const pubacks: number[] = []; let closed = false;
    api.on("close", () => { closed = true; });
    api.on("packetsend", (packet) => { if (packet.cmd === "puback" && packet.messageId !== undefined) pubacks.push(packet.messageId); });
    peer.on("message", (topic, payload) => received.push({ topic, event: JSON.parse(payload.toString()) }));
    const publish = (topic: string, event: unknown) => peer.publishAsync(topic, JSON.stringify(event), { qos: 1 });
    const stateAckTopic = mqttTopicsV2.stateIngestedAck(setup.scope.siteId, setup.scope.gatewayId);
    const completedAckTopic = mqttTopicsV2.fixturePresenceCheckCompletedAck(setup.scope.siteId, setup.scope.gatewayId);
    try {
      await until(() => api.connected && peer.connected);
      // Await the same subscriptions as onModuleInit; overlapping exact subscriptions would
      // intentionally make Mosquitto deliver duplicate copies and obscure the parser ordering.
      await api.subscribeAsync(["sites/+/gateways/+/events/fixture-presence-check-completed", mqttTopicsV2.fixtureUnreachable("+", "+"),
        "sites/+/gateways/+/state/fixture-presence", "sites/+/gateways/+/state/fixtures"], { qos: 1 });
      await peer.subscribeAsync([stateAckTopic, completedAckTopic], { qos: 1 });
      const completed = { ...setup.completed(), occurredAt: clock.toISOString() };
      await publish(setup.completionTopic, completed);
      await until(() => pubacks.length === 1);
      expect(received).toEqual([]); expect(closed).toBe(false);
      const successful = { ...setup.scope, fixtureId: setup.fixtures[0].id, eventId: randomUUID(), sequence: 1,
        occurredAt: clock.toISOString(), rssi: -42, hopCount: null, controlMode: "sensor", configuredBrightness: null, rawHighBrightness: 127 };
      const unreachable = { ...setup.unreachable(), occurredAt: clock.toISOString() };
      await publish(mqttTopicsV2.fixturePresence(setup.scope.siteId, setup.scope.gatewayId), successful);
      await publish(setup.unreachableTopic, unreachable);
      await until(() => received.filter((row) => row.topic === stateAckTopic).length === 2);
      await publish(setup.completionTopic, completed);
      await until(() => received.some((row) => row.topic === completedAckTopic));
      expect(await prisma.monitoringRefresh.findUniqueOrThrow({ where: { id: setup.scope.refreshId } }))
        .toMatchObject({ status: "completed", onlineFixtures: 1, offlineFixtures: 1 });
      const fixtureBefore = await prisma.fixture.findMany({ where: { siteId: setup.scope.siteId }, orderBy: { id: "asc" } });
      await new DataRetentionService(prisma as never).prune(new Date(clock.getTime() + 8 * 86_400_000));
      const retiredState = { ...setup.scope, fixtureId: setup.fixtures[0].id, eventId: randomUUID(), sequence: 30,
        occurredAt: clock.toISOString(), brightness: 0, powerOn: false, status: "online", rssi: -42, hopCount: null };
      await publish(mqttTopicsV2.fixtureState(setup.scope.siteId, setup.scope.gatewayId), retiredState);
      await publish(setup.unreachableTopic, { ...unreachable, eventId: randomUUID(), sequence: 31 });
      await publish(setup.completionTopic, { ...completed, eventId: randomUUID(), sequence: 32 });
      await until(() => received.length === 6);
      expect(await prisma.fixture.findMany({ where: { siteId: setup.scope.siteId }, orderBy: { id: "asc" } })).toEqual(fixtureBefore);
      const { refreshId: _, batchId: __, ...ordinary } = retiredState;
      const normal = { ...ordinary, eventId: randomUUID(), sequence: 33, brightness: 30, powerOn: true };
      await publish(mqttTopicsV2.fixtureState(setup.scope.siteId, setup.scope.gatewayId), normal);
      await until(() => received.some((row) => row.event.eventId === normal.eventId));
      expect(received.find((row) => row.event.eventId === normal.eventId)?.event.status).toBe("ingested");
      expect(await prisma.fixture.findUniqueOrThrow({ where: { id: ordinary.fixtureId } })).toMatchObject({ brightness: 30 });
      expect(closed).toBe(false);
    } finally { await service.stopInboundAndDrain(); await service.close(); await peer.endAsync(true); await broker.stop(); }
  }, 20_000);

  async function seed() {
    const organization = await prisma.organization.create({ data: { name: "refresh ingestion test", type: "customer" } });
    organizationIds.push(organization.id);
    const site = await prisma.site.create({ data: { organizationId: organization.id, name: "refresh test", timeZone: "Asia/Seoul", tariffKwhRate: 120 } }); siteIds.push(site.id);
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
      sequence: 1, idempotencyKey: randomUUID(), targetFixtureIds: fixtures.map(({ id }) => id), status: "published", publishedAt: at(1) } });
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

async function until(condition: () => boolean) {
  const expires = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > expires) throw new Error("MQTT integration observation timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
