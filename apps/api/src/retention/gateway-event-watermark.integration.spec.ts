import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { FixtureStateIngestionService } from "../energy/fixture-state-ingestion.service";
import { MqttService } from "../mqtt/mqtt.service";
import { VehicleSensorCapabilityService } from "../automation/vehicle-sensor-capability.service";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";

const enabled = process.env.GATEWAY_EVENT_WATERMARK_TEST === "1";
const ids = { organizationId: randomUUID(), siteId: randomUUID(), floorId: randomUUID(), gatewayId: randomUUID(),
  meshNodeId: randomUUID(), fixtureId: randomUUID(), userId: randomUUID(), sessionId: randomUUID(), scanCorrelationId: randomUUID() };
const occurredAt = "2026-09-12T00:00:09.000Z";
const base = () => ({ siteId: ids.siteId, gatewayId: ids.gatewayId, eventId: randomUUID(), sequence: 9, occurredAt });

(enabled ? describe : describe.skip)("gateway event retention safety on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let peer: PrismaClient;
  let mqtt: MqttService;
  let fixture: FixtureStateIngestionService;
  let capability: VehicleSensorCapabilityService;
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const databaseUrl = cluster.database();
    const deployed = cluster.deploy(databaseUrl);
    expect(deployed.stderr + deployed.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    peer = new PrismaClient({ datasourceUrl: databaseUrl });
    mqtt = new MqttService(db as never, {} as never);
    fixture = new FixtureStateIngestionService(db as never);
    const clock = { now: () => new Date(occurredAt) };
    capability = new VehicleSensorCapabilityService(db as never, new AutomationSnapshotService(clock as never), clock as never);
  }, 30_000);
  afterAll(async () => { await db?.$disconnect(); await peer?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
    await db.organization.create({ data: { id: ids.organizationId, name: "Watermark test" } });
    await db.site.create({ data: { id: ids.siteId, organizationId: ids.organizationId, name: "Test", tariffKwhRate: "120", timeZone: "Asia/Seoul" } });
    await db.floor.create({ data: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 } });
    await db.gateway.create({ data: { id: ids.gatewayId, siteId: ids.siteId, name: "Gateway", serialNumber: "WM-GW", firmwareVersion: "test" } });
    await db.meshNode.create({ data: { id: ids.meshNodeId, gatewayId: ids.gatewayId, deviceUuid: randomUUID(), meshAddress: "0x1201", firmwareVersion: "test" } });
    await db.fixture.create({ data: { id: ids.fixtureId, floorId: ids.floorId, meshNodeId: ids.meshNodeId, name: "L01", ratedWatt: "40", x: 0, y: 0, energyTrackingStartedAt: new Date("2026-09-12T00:00:00Z") } });
    await db.energyFixtureIdentity.create({ data: { siteId: ids.siteId, fixtureId: ids.fixtureId, trackingStartedAt: new Date("2026-09-12T00:00:00Z") } });
    await db.user.create({ data: { id: ids.userId, organizationId: ids.organizationId, name: "Test", loginId: "watermark-test", passwordHash: "unused", role: "viewer" } });
    await db.provisioningSession.create({ data: { id: ids.sessionId, siteId: ids.siteId, floorId: ids.floorId, gatewayId: ids.gatewayId, requestedBy: ids.userId,
      scanStatus: "scanning", scanAttempt: 1, scanCorrelationId: ids.scanCorrelationId } });
  });

  it("deploys the compact stream key and keeps schema clean replay valid", async () => {
    const [row] = await db.$queryRaw<{ exists: boolean }[]>`SELECT to_regclass('"GatewayEventWatermark"') IS NOT NULL AS "exists"`;
    expect(row.exists).toBe(true);
  });

  it("rejects corrupt fixture replay and preserves energy after raw deletion", async () => {
    const event = state();
    expect(await fixture.ingest(ids.gatewayId, event)).toMatchObject({ status: "ingested" });
    const before = await db.fixtureEnergyDailyAggregate.findMany();
    await db.processedGatewayEvent.deleteMany();
    expect(await fixture.ingest(ids.gatewayId, event)).toMatchObject({ status: "duplicate" });
    await expect(fixture.ingest(ids.gatewayId, { ...event, brightness: 20 })).rejects.toThrow("conflict");
    await expect(fixture.ingest(ids.gatewayId, { ...event, eventId: randomUUID() })).rejects.toThrow("conflict");
    expect(await fixture.ingest(ids.gatewayId, { ...event, eventId: randomUUID(), sequence: 8 })).toMatchObject({ status: "stale_sequence" });
    expect(await db.fixtureEnergyDailyAggregate.findMany()).toEqual(before);
  });

  it("preserves heartbeat identity and high water through deletion, stale and corrupt replay", async () => {
    const event = { ...base(), gatewaySerial: "WM-GW", firmwareVersion: "first" };
    const topic = `sites/${ids.siteId}/gateways/${ids.gatewayId}/state/heartbeat`;
    const send = (input: typeof event) => mqtt.handleMessage(topic, Buffer.from(JSON.stringify(input)));
    await send(event);
    expect(await db.gatewayEventWatermark.findFirst()).toMatchObject({
      scopeKey: "", lastEventId: event.eventId, lastSequence: 9n, lastPayloadHash: canonicalPayloadHash(event)
    });
    await db.processedGatewayEvent.deleteMany();
    await send(event);
    await send({ ...event, firmwareVersion: "corrupt" });
    await send({ ...event, eventId: randomUUID(), sequence: 8, firmwareVersion: "stale" });
    expect(await db.gateway.findUnique({ where: { id: ids.gatewayId } })).toMatchObject({ firmwareVersion: "first", lastHeartbeatSequence: 9n });
    const next = { ...event, eventId: randomUUID(), sequence: 10, firmwareVersion: "next" };
    await send(next);
    expect(await db.gatewayEventWatermark.findFirst()).toMatchObject({ lastEventId: next.eventId, lastSequence: 10n });
  });

  it("rolls back watermark, raw ledger and energy when aggregate persistence fails", async () => {
    await db.$executeRawUnsafe(`CREATE FUNCTION reject_watermark_test_aggregate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected aggregate failure'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER watermark_test_failure BEFORE INSERT ON "FixtureEnergyDailyAggregate" FOR EACH ROW EXECUTE FUNCTION reject_watermark_test_aggregate()`);
    try {
      await expect(fixture.ingest(ids.gatewayId, state())).rejects.toThrow();
      expect(await db.gatewayEventWatermark.count()).toBe(0);
      expect(await db.processedGatewayEvent.count()).toBe(0);
      expect(await db.fixtureEnergyDailyAggregate.count()).toBe(0);
      expect((await db.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } })).lastStateSequence).toBeNull();
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER watermark_test_failure ON "FixtureEnergyDailyAggregate"');
      await db.$executeRawUnsafe('DROP FUNCTION reject_watermark_test_aggregate()');
    }
  });

  it("serializes conflicting same-sequence writes from two connections into one state commit", async () => {
    const event = state();
    const other = new FixtureStateIngestionService(peer as never);
    const results = await Promise.allSettled([
      fixture.ingest(ids.gatewayId, event),
      other.ingest(ids.gatewayId, { ...event, eventId: randomUUID(), brightness: 20 })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.gatewayEventWatermark.count()).toBe(1);
    expect(await db.processedGatewayEvent.count()).toBe(1);
    expect((await db.fixtureEnergyDailyAggregate.findFirstOrThrow()).unknownSeconds).toBe(9);
  });

  it("preserves global eventId and equal fixture sequence conflicts after raw deletion", async () => {
    const event = state();
    await fixture.ingest(ids.gatewayId, event);
    await db.processedGatewayEvent.deleteMany();
    const node = await db.meshNode.create({ data: { gatewayId: ids.gatewayId, deviceUuid: randomUUID(), meshAddress: "0x1202", firmwareVersion: "test" } });
    const nextFixture = await db.fixture.create({ data: { floorId: ids.floorId, meshNodeId: node.id, name: "L02", ratedWatt: "40", x: 0, y: 0, energyTrackingStartedAt: new Date("2026-09-12T00:00:00Z") } });
    await db.energyFixtureIdentity.create({ data: { siteId: ids.siteId, fixtureId: nextFixture.id, trackingStartedAt: new Date("2026-09-12T00:00:00Z") } });
    await expect(fixture.ingest(ids.gatewayId, { ...event, fixtureId: nextFixture.id, sequence: 10 })).rejects.toThrow("conflict");
    await expect(fixture.ingest(ids.gatewayId, { ...event, fixtureId: nextFixture.id, eventId: randomUUID() })).rejects.toThrow("conflict");
    // A lower sequence on another fixture was never gateway-wide stale. Preserve
    // its independent stream rather than silently dropping valid delayed state.
    expect(await fixture.ingest(ids.gatewayId, { ...event, fixtureId: nextFixture.id, eventId: randomUUID(), sequence: 8 })).toMatchObject({ status: "ingested" });
  });

  it.each(["completed", "failed"] as const)("replays the exact %s terminal ACK after raw and outbox deletion", async (status) => {
    const event = { ...base(), sessionId: ids.sessionId, scanCorrelationId: ids.scanCorrelationId, scanAttempt: 1,
      ...(status === "completed" ? { acceptedNodeCount: 0 } : { code: "scan_timeout", message: "timeout" }) };
    const topic = `sites/${ids.siteId}/gateways/${ids.gatewayId}/events/provisioning/scan-${status}`;
    await mqtt.handleMessage(topic, Buffer.from(JSON.stringify(event)));
    const first = await db.mqttOutbox.findFirstOrThrow();
    await db.processedGatewayEvent.deleteMany();
    await db.mqttOutbox.deleteMany();
    await db.provisioningSession.update({ where: { id: ids.sessionId }, data: { status: "completed" } });
    await mqtt.handleMessage(topic, Buffer.from(JSON.stringify(event)));
    expect((await db.mqttOutbox.findFirst())?.payload).toEqual(first.payload);
    await db.mqttOutbox.deleteMany();
    const corrupt = status === "completed" ? { acceptedNodeCount: 1 } : { message: "altered" };
    await mqtt.handleMessage(topic, Buffer.from(JSON.stringify({ ...event, ...corrupt })));
    expect(await db.mqttOutbox.count()).toBe(0);
  });

  it("rejects stale found events after raw deletion even in a different scan session", async () => {
    const event = { ...base(), sessionId: ids.sessionId, scanCorrelationId: ids.scanCorrelationId, scanAttempt: 1,
      deviceUuid: randomUUID(), serialNumber: "WM-NODE", rssi: -50, oobCapability: "none", firmwareVersion: "test" };
    const topic = `sites/${ids.siteId}/gateways/${ids.gatewayId}/events/provisioning/scan-found`;
    await mqtt.handleMessage(topic, Buffer.from(JSON.stringify(event)));
    expect(await db.discoveredMeshNode.count()).toBe(1);
    await db.processedGatewayEvent.deleteMany();
    await db.provisioningSession.update({ where: { id: ids.sessionId }, data: { status: "completed" } });
    const session = await db.provisioningSession.create({ data: { siteId: ids.siteId, floorId: ids.floorId, gatewayId: ids.gatewayId,
      requestedBy: ids.userId, scanStatus: "scanning", scanAttempt: 1, scanCorrelationId: randomUUID() } });
    await mqtt.handleMessage(topic, Buffer.from(JSON.stringify({ ...event, sessionId: session.id, scanCorrelationId: session.scanCorrelationId, eventId: randomUUID(), sequence: 8 })));
    expect(await db.discoveredMeshNode.count()).toBe(1);
  });

  it("preserves capability ACK identity and rejects equal revision with a new event after raw deletion", async () => {
    const event = { schemaVersion: 1 as const, siteId: ids.siteId, gatewayId: ids.gatewayId, meshNodeId: ids.meshNodeId,
      eventId: randomUUID(), capabilityRevision: 9, status: "supported" as const, verifiedAt: occurredAt, sensorServerBound: true, vendorVehicleEventModelBound: true };
    const first = await capability.applyReport(event);
    expect(first.status).toBe("applied");
    await db.processedGatewayEvent.deleteMany();
    expect(await capability.applyReport({ ...event, eventId: randomUUID() })).toMatchObject({ status: "rejected", errorCode: "capability_event_conflict" });
    expect(await capability.applyReport(event)).toEqual(first);
    expect(await capability.applyReport({ ...event, eventId: randomUUID(), capabilityRevision: 8 })).toMatchObject({ status: "stale" });
  });

  it("backfills gateway scan ordering without inventing missing scope or payload hashes", () => {
    const legacy = legacyDatabase();
    cluster.sql(legacy, `INSERT INTO "ProcessedGatewayEvent" ("eventId", "gatewayId", "sequence", "eventType", "occurredAt")
      VALUES ('old', 'legacy-gateway', 2, 'provisioning_scan_found', now()),
             ('latest', 'legacy-gateway', 9, 'provisioning_scan_found', now());`);
    const result = cluster.deploy(legacy);
    expect(result.status).toBe(0);
    expect(cluster.sql(legacy, `SELECT count(*) FROM information_schema.tables WHERE table_name = 'GatewayEventWatermark'`)).toBe("1");
    expect(cluster.sql(legacy, `SELECT "scopeKey" || ':' || "lastSequence" || ':' || "lastEventId" || ':' || ("lastPayloadHash" IS NULL)::text FROM "GatewayEventWatermark"`)).toBe(":9:latest:true");
    expect(cluster.sql(legacy, `SELECT count(*) FROM "ProcessedGatewayEvent" WHERE "scopeKey" IS NULL`)).toBe("2");
  }, 30_000);

  it("backfills independent capability nodes and heartbeat cursor-only baselines", () => {
    const legacy = legacyDatabase();
    cluster.sql(legacy, `INSERT INTO "MeshNode" ("id", "gatewayId", "meshAddress", "firmwareVersion", "updatedAt")
        VALUES ('node-a', 'legacy-gateway', '0x1201', 'test', now()), ('node-b', 'legacy-gateway', '0x1202', 'test', now());
      INSERT INTO "ProcessedGatewayEvent" ("eventId", "gatewayId", "meshNodeId", "sequence", "eventType", "payloadHash", "occurredAt")
        VALUES ('cap-a', 'legacy-gateway', 'node-a', 9, 'vehicle_sensor_capability', 'sha256:' || repeat('a', 64), now()),
               ('cap-b', 'legacy-gateway', 'node-b', 9, 'vehicle_sensor_capability', 'sha256:' || repeat('b', 64), now());
      INSERT INTO "ProcessedGatewayEvent" ("eventId", "gatewayId", "sequence", "eventType", "occurredAt")
        VALUES ('unknown', 'legacy-gateway', 100, 'future_event', now());
      UPDATE "Gateway" SET "lastHeartbeatEventId" = 'cursor', "lastHeartbeatSequence" = 20, "lastHeartbeatOccurredAt" = now() WHERE "id" = 'legacy-gateway';`);
    expect(cluster.deploy(legacy).status).toBe(0);
    expect(cluster.sql(legacy, `SELECT string_agg("scopeKey" || ':' || "lastSequence", ',' ORDER BY "scopeKey") FROM "GatewayEventWatermark"`)).toBe(":20,node-a:9,node-b:9");
    expect(cluster.sql(legacy, `SELECT count(*) FROM "GatewayEventWatermark" WHERE "eventType" = 'future_event'`)).toBe("0");
    expect(cluster.sql(legacy, `SELECT count(*) FROM "ProcessedGatewayEvent" WHERE "eventType" = 'future_event' AND "scopeKey" IS NULL`)).toBe("1");
  }, 30_000);

  it("preflights equal-sequence legacy conflicts before any migration mutation", () => {
    const legacy = legacyDatabase();
    // Only our temporary DB is corrupted to model a damaged/partially recovered legacy index.
    cluster.sql(legacy, `DROP INDEX "ProcessedGatewayEvent_legacy_sequence_key";
      INSERT INTO "ProcessedGatewayEvent" ("eventId", "gatewayId", "sequence", "eventType", "occurredAt")
      VALUES ('conflict-a', 'legacy-gateway', 9, 'gateway_heartbeat', now()),
             ('conflict-b', 'legacy-gateway', 9, 'gateway_heartbeat', now());`);
    expect(cluster.deploy(legacy).status).not.toBe(0);
    expect(cluster.sql(legacy, `SELECT to_regclass('"GatewayEventWatermark"') IS NULL`)).toBe("t");
    expect(cluster.sql(legacy, `SELECT count(*) FROM "ProcessedGatewayEvent"`)).toBe("2");
  }, 30_000);

  it("uses the higher fixture cursor when the legacy raw ledger is older", () => {
    const legacy = legacyFixtureDatabase();
    cluster.sql(legacy, `INSERT INTO "ProcessedGatewayEvent" ("eventId", "gatewayId", "fixtureId", "sequence", "eventType", "occurredAt")
      VALUES ('old-state', 'legacy-gateway', 'legacy-fixture', 8, 'fixture_state', '2026-09-12T00:00:08Z');`);
    expect(cluster.deploy(legacy).status).toBe(0);
    expect(cluster.sql(legacy, `SELECT "scopeKey" || ':' || "lastSequence" || ':' || "lastEventId" FROM "GatewayEventWatermark"`)).toBe("legacy-fixture:9:fixture-cursor");
  }, 30_000);

  it("rolls back the backfill when a raw event contradicts its fixture cursor identity", () => {
    const legacy = legacyFixtureDatabase();
    cluster.sql(legacy, `INSERT INTO "ProcessedGatewayEvent" ("eventId", "gatewayId", "fixtureId", "sequence", "eventType", "occurredAt")
      VALUES ('different-event', 'legacy-gateway', 'legacy-fixture', 9, 'fixture_state', '2026-09-12T00:00:09Z');`);
    expect(cluster.deploy(legacy).status).not.toBe(0);
    expect(cluster.sql(legacy, `SELECT to_regclass('"GatewayEventWatermark"') IS NULL`)).toBe("t");
    expect(cluster.sql(legacy, `SELECT count(*) FROM information_schema.columns WHERE table_name = 'ProcessedGatewayEvent' AND column_name = 'scopeKey'`)).toBe("0");
    expect(cluster.sql(legacy, `SELECT "lastStateEventId" FROM "Fixture"`)).toBe("fixture-cursor");
  }, 30_000);

  function legacyFixtureDatabase() {
    const databaseUrl = legacyDatabase();
    cluster.sql(databaseUrl, `INSERT INTO "Floor" ("id", "siteId", "name", "level", "updatedAt") VALUES ('legacy-floor', 'legacy-site', 'B1', -1, now());
      INSERT INTO "MeshNode" ("id", "gatewayId", "meshAddress", "firmwareVersion", "updatedAt") VALUES ('legacy-node', 'legacy-gateway', '0x1201', 'test', now());
      INSERT INTO "Fixture" ("id", "floorId", "meshNodeId", "name", "ratedWatt", "x", "y", "lastStateEventId", "lastStateSequence", "lastStateOccurredAt", "updatedAt")
        VALUES ('legacy-fixture', 'legacy-floor', 'legacy-node', 'L01', 40, 0, 0, 'fixture-cursor', 9, '2026-09-12T00:00:09Z', now());`);
    return databaseUrl;
  }

  function legacyDatabase() {
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl, "20260914zz").status).toBe(0);
    cluster.sql(databaseUrl, `INSERT INTO "Organization" ("id", "name", "type", "updatedAt") VALUES ('legacy-org', 'test', 'customer', now());
      INSERT INTO "Site" ("id", "organizationId", "name", "updatedAt") VALUES ('legacy-site', 'legacy-org', 'test', now());
      INSERT INTO "Gateway" ("id", "siteId", "name", "serialNumber", "firmwareVersion", "updatedAt") VALUES ('legacy-gateway', 'legacy-site', 'test', 'LEGACY-GW', 'test', now());`);
    return databaseUrl;
  }

  function state() {
    return { ...base(), fixtureId: ids.fixtureId, brightness: 70, powerOn: true, status: "online" as const, rssi: -50, hopCount: 1 };
  }
});
