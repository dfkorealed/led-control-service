import { PrismaService } from "../prisma/prisma.service";
import { FixtureStateIngestionService } from "./fixture-state-ingestion.service";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { MqttService } from "../mqtt/mqtt.service";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const databaseUrl = process.env.FIXTURE_STATE_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("fixture-state PostgreSQL atomic ingestion", () => {
  const ids = {
    organizationId: "21000000-0000-4000-8000-000000000001",
    siteId: "21000000-0000-4000-8000-000000000002",
    floorId: "21000000-0000-4000-8000-000000000003",
    gatewayId: "21000000-0000-4000-8000-000000000004",
    meshNodeId: "21000000-0000-4000-8000-000000000005",
    fixtureId: "21000000-0000-4000-8000-000000000006",
    energyFixtureId: "21000000-0000-4000-8000-000000000008"
  };
  let prisma: PrismaService;
  let service: FixtureStateIngestionService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new FixtureStateIngestionService(prisma);
    await prisma.organization.upsert({
      where: { id: ids.organizationId },
      create: { id: ids.organizationId, name: "Energy integration", type: "customer" },
      update: {}
    });
    await prisma.site.upsert({
      where: { id: ids.siteId },
      create: {
        id: ids.siteId,
        organizationId: ids.organizationId,
        name: "Energy site",
        address: "Test",
        tariffKwhRate: "100.00",
        timeZone: "Asia/Seoul"
      },
      update: { tariffKwhRate: "100.00", timeZone: "Asia/Seoul" }
    });
    await prisma.floor.upsert({
      where: { id: ids.floorId },
      create: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 },
      update: { siteId: ids.siteId }
    });
    await prisma.gateway.upsert({
      where: { id: ids.gatewayId },
      create: {
        id: ids.gatewayId,
        siteId: ids.siteId,
        name: "Energy gateway",
        serialNumber: "ENERGY-GW-001",
        firmwareVersion: "integration"
      },
      update: { siteId: ids.siteId }
    });
    await prisma.meshNode.upsert({
      where: { id: ids.meshNodeId },
      create: {
        id: ids.meshNodeId,
        gatewayId: ids.gatewayId,
        deviceUuid: "energy-integration-node",
        meshAddress: "0x1201",
        firmwareVersion: "integration"
      },
      update: { gatewayId: ids.gatewayId }
    });
  });

  beforeEach(async () => {
    await prisma.processedGatewayEvent.deleteMany({ where: { gatewayId: ids.gatewayId } });
    await prisma.fixtureEnergyDailyAggregate.deleteMany({ where: { fixtureId: ids.fixtureId } });
    await prisma.fixtureEnergyHourlyAggregate.deleteMany({ where: { energyFixtureId: ids.energyFixtureId } });
    await prisma.fixtureEnergyStateCursor.deleteMany({ where: { fixtureId: ids.fixtureId } });
    await prisma.fixture.upsert({
      where: { id: ids.fixtureId },
      create: {
        id: ids.fixtureId,
        floorId: ids.floorId,
        meshNodeId: ids.meshNodeId,
        name: "B1-L01",
        ratedWatt: "40.00",
        x: 10,
        y: 10,
        energyTrackingStartedAt: new Date("2026-08-26T00:00:00.000Z")
      },
      update: {
        meshNodeId: ids.meshNodeId,
        ratedWatt: "40.00",
        brightness: 0,
        powerOn: null,
        firstStateOccurredAt: null,
        lastStateEventId: null,
        lastStateSequence: null,
        lastStateOccurredAt: null,
        lastSeenAt: null
      }
    });
    await prisma.energyFixtureIdentity.upsert({
      where: { fixtureId: ids.fixtureId },
      create: {
        id: ids.energyFixtureId,
        siteId: ids.siteId,
        fixtureId: ids.fixtureId,
        trackingStartedAt: new Date("2026-08-26T00:00:00.000Z")
      },
      update: { retiredAt: null }
    });
  });

  afterAll(async () => prisma.$disconnect());

  it("backfills legacy ledger receipt time while leaving null hashes and historical freshness untouched", async () => {
    const migration = readFileSync(join(__dirname,
      "../../prisma/migrations/20260912090000_gateway_event_received_time/migration.sql"), "utf8");
    const rollback = new Error("rollback migration rehearsal");
    await expect(prisma.$transaction(async (tx) => {
      // A transaction-local schema models pre-change rows; rollback also removes the schema.
      const schema = `gateway_event_upgrade_${process.pid}`;
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe('CREATE TABLE "Fixture" ("lastSeenAt" TIMESTAMP(3))');
      await tx.$executeRawUnsafe('CREATE TABLE "Gateway" ("lastHeartbeatAt" TIMESTAMP(3))');
      await tx.$executeRawUnsafe('CREATE TABLE "ProcessedGatewayEvent" ("eventId" TEXT PRIMARY KEY, "payloadHash" TEXT, "createdAt" TIMESTAMP(3))');
      await tx.$executeRawUnsafe(`INSERT INTO "Fixture" VALUES ('9999-01-01T00:00:00Z')`);
      await tx.$executeRawUnsafe(`INSERT INTO "Gateway" VALUES ('9999-01-01T00:00:00Z')`);
      await tx.$executeRawUnsafe(`INSERT INTO "ProcessedGatewayEvent" VALUES
        ('fixture', NULL, '2026-08-26T00:00:01Z'), ('heartbeat', NULL, '2026-08-26T00:00:02Z')`);
      for (const statement of migration.split(";").map((sql) => sql.trim()).filter(Boolean)) {
        await tx.$executeRawUnsafe(statement);
      }
      expect(await tx.$queryRawUnsafe('SELECT * FROM "ProcessedGatewayEvent" ORDER BY "eventId"')).toEqual([
        { eventId: "fixture", payloadHash: null, createdAt: new Date("2026-08-26T00:00:01.000Z"),
          receivedAt: new Date("2026-08-26T00:00:01.000Z"), ingestionStatus: "accepted" },
        { eventId: "heartbeat", payloadHash: null, createdAt: new Date("2026-08-26T00:00:02.000Z"),
          receivedAt: new Date("2026-08-26T00:00:02.000Z"), ingestionStatus: "accepted" }
      ]);
      expect(await tx.$queryRawUnsafe('SELECT * FROM "Fixture"')).toEqual([{ lastSeenAt: new Date("9999-01-01T00:00:00.000Z") }]);
      expect(await tx.$queryRawUnsafe('SELECT * FROM "Gateway"')).toEqual([{ lastHeartbeatAt: new Date("9999-01-01T00:00:00.000Z") }]);
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it("commits ledger, aggregate, cursor and fixture once, then returns duplicate", async () => {
    const event = fixtureEvent();
    await expect(service.ingest(ids.gatewayId, event)).resolves.toMatchObject({ status: "ingested" });
    await expect(service.ingest(ids.gatewayId, event)).resolves.toMatchObject({ status: "duplicate" });

    const [fixture, aggregate, hourly, cursor, ledgerCount] = await Promise.all([
      prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } }),
      prisma.fixtureEnergyDailyAggregate.findMany({ where: { fixtureId: ids.fixtureId } }),
      prisma.fixtureEnergyHourlyAggregate.findMany({ where: { energyFixtureId: ids.energyFixtureId } }),
      prisma.fixtureEnergyStateCursor.findUniqueOrThrow({ where: { fixtureId: ids.fixtureId } }),
      prisma.processedGatewayEvent.count({ where: { fixtureId: ids.fixtureId } })
    ]);
    expect(fixture).toMatchObject({ brightness: 70, powerOn: true, lastStateSequence: 1n });
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]).toMatchObject({ knownSeconds: 0, unknownSeconds: 9 });
    expect(hourly).toHaveLength(1);
    expect(hourly[0]).toMatchObject({ knownSeconds: 0, unknownSeconds: 9 });
    expect(cursor.aggregatedThrough).toEqual(new Date("2026-08-26T00:00:09.000Z"));
    expect(ledgerCount).toBe(1);
  });

  it("returns a terminal result for concurrent exact accepted replays", async () => {
    const event = fixtureEvent();
    const results = await Promise.all([
      service.ingest(ids.gatewayId, event),
      service.ingest(ids.gatewayId, event)
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["duplicate", "ingested"]);
    expect(await prisma.processedGatewayEvent.count({ where: { fixtureId: ids.fixtureId } })).toBe(1);
  });

  it("reconciles a pre-change null-hash ledger once without rewriting historical fixture state or energy", async () => {
    const event = fixtureEvent();
    await service.ingest(ids.gatewayId, event, new Date(event.occurredAt));
    // Reconstruct the old writer's committed ledger, including the migration-default accepted status.
    await prisma.processedGatewayEvent.delete({ where: { eventId: event.eventId } });
    await prisma.processedGatewayEvent.create({ data: {
      eventId: event.eventId, gatewayId: ids.gatewayId, fixtureId: ids.fixtureId, sequence: 1n,
      eventType: "fixture_state", occurredAt: new Date(event.occurredAt)
    } });
    const before = await fixtureSnapshot();
    const ledgerBefore = await prisma.processedGatewayEvent.findUniqueOrThrow({ where: { eventId: event.eventId } });
    expect(ledgerBefore).toMatchObject({ payloadHash: null, ingestionStatus: "accepted" });

    const results = await Promise.all([service.ingest(ids.gatewayId, event), service.ingest(ids.gatewayId, event)]);
    expect(results.map((result) => result.status)).toEqual(["duplicate", "duplicate"]);
    expect(await fixtureSnapshot()).toEqual(before);
    expect(await prisma.processedGatewayEvent.findUniqueOrThrow({ where: { eventId: event.eventId } }))
      .toEqual({ ...ledgerBefore, payloadHash: canonicalPayloadHash(event) });
    await expect(service.ingest(ids.gatewayId, { ...event, brightness: 20 })).rejects.toThrow("conflict");
    expect(await fixtureSnapshot()).toEqual(before);
  });

  it("serializes competing different legacy payloads so only the first authenticated replay establishes the hash", async () => {
    const event = fixtureEvent();
    await prisma.processedGatewayEvent.create({ data: {
      eventId: event.eventId, gatewayId: ids.gatewayId, fixtureId: ids.fixtureId, sequence: 1n,
      eventType: "fixture_state", occurredAt: new Date(event.occurredAt)
    } });
    const before = await fixtureSnapshot();
    const competing = [event, { ...event, brightness: 20 }];
    const results = await Promise.allSettled(competing.map((replay) => service.ingest(ids.gatewayId, replay)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    expect(results[winnerIndex]).toMatchObject({ value: { status: "duplicate" } });
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.any(Error) });
    expect((await prisma.processedGatewayEvent.findUniqueOrThrow({ where: { eventId: event.eventId } })).payloadHash)
      .toBe(canonicalPayloadHash(competing[winnerIndex]));
    expect(await fixtureSnapshot()).toEqual(before);
  });

  it("reconciles a pre-change heartbeat while preserving historical gateway freshness and sequence", async () => {
    const event = { siteId: ids.siteId, gatewayId: ids.gatewayId,
      eventId: "21000000-0000-4000-8000-000000000011", sequence: 9,
      gatewaySerial: "ENERGY-GW-001", firmwareVersion: "legacy", occurredAt: "2026-08-26T00:00:09.000Z" };
    await prisma.gateway.update({ where: { id: ids.gatewayId }, data: {
      lastHeartbeatEventId: event.eventId, lastHeartbeatSequence: 10n,
      lastHeartbeatOccurredAt: new Date("2026-08-26T00:00:10.000Z"),
      lastHeartbeatAt: new Date("2026-08-26T00:00:10.000Z"), firmwareVersion: "newer"
    } });
    const ledgerBefore = await prisma.processedGatewayEvent.create({ data: {
      eventId: event.eventId, gatewayId: ids.gatewayId, sequence: 9n,
      eventType: "gateway_heartbeat", occurredAt: new Date(event.occurredAt)
    } });
    expect(ledgerBefore.payloadHash).toBeNull();
    const before = await prisma.gateway.findUniqueOrThrow({ where: { id: ids.gatewayId } });
    const mqtt = new MqttService(prisma, {} as never, service);
    const replay = () => mqtt.handleMessage(`sites/${ids.siteId}/gateways/${ids.gatewayId}/state/heartbeat`,
      Buffer.from(JSON.stringify(event)));
    await Promise.all([replay(), replay()]);
    expect(await prisma.gateway.findUniqueOrThrow({ where: { id: ids.gatewayId } })).toEqual(before);
    expect(await prisma.processedGatewayEvent.findUniqueOrThrow({ where: { eventId: event.eventId } }))
      .toEqual({ ...ledgerBefore, payloadHash: canonicalPayloadHash(event) });
  });

  function fixtureSnapshot() {
    return Promise.all([
      prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } }),
      prisma.fixtureEnergyDailyAggregate.findMany({ where: { fixtureId: ids.fixtureId }, orderBy: { localDate: "asc" } }),
      prisma.fixtureEnergyHourlyAggregate.findMany({ where: { energyFixtureId: ids.energyFixtureId }, orderBy: { bucketStartUtc: "asc" } }),
      prisma.fixtureEnergyStateCursor.findUnique({ where: { fixtureId: ids.fixtureId } })
    ]);
  }

  it("keeps a future poison event out of energy state, then ingests the next normal event", async () => {
    const receivedAt = new Date("2026-08-26T00:00:10.000Z");
    const poison = fixtureEvent({
      eventId: "21000000-0000-4000-8000-000000000009",
      sequence: 1,
      occurredAt: "9999-01-01T00:00:00.000Z"
    });
    const normal = fixtureEvent({
      eventId: "21000000-0000-4000-8000-000000000010",
      sequence: 2,
      occurredAt: "2026-08-26T00:00:09.000Z"
    });

    await expect(service.ingest(ids.gatewayId, poison, receivedAt)).resolves.toMatchObject({
      status: "rejected_future_timestamp"
    });
    await expect(service.ingest(ids.gatewayId, normal, receivedAt)).resolves.toMatchObject({ status: "ingested" });

    const [fixture, aggregate, hourly, cursor, ledger] = await Promise.all([
      prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } }),
      prisma.fixtureEnergyDailyAggregate.findMany({ where: { fixtureId: ids.fixtureId } }),
      prisma.fixtureEnergyHourlyAggregate.findMany({ where: { energyFixtureId: ids.energyFixtureId } }),
      prisma.fixtureEnergyStateCursor.findUniqueOrThrow({ where: { fixtureId: ids.fixtureId } }),
      prisma.processedGatewayEvent.findMany({
        where: { fixtureId: ids.fixtureId },
        orderBy: { sequence: "asc" },
        select: { sequence: true, occurredAt: true, receivedAt: true, ingestionStatus: true }
      })
    ]);
    expect(aggregate).toHaveLength(1);
    expect(hourly).toHaveLength(1);
    expect(cursor.aggregatedThrough).toEqual(new Date("2026-08-26T00:00:09.000Z"));
    expect(fixture).toMatchObject({
      lastSeenAt: receivedAt,
      lastStateOccurredAt: new Date("2026-08-26T00:00:09.000Z"),
      lastStateSequence: 2n
    });
    expect(ledger).toEqual([
      expect.objectContaining({
        sequence: 1n,
        occurredAt: new Date("9999-01-01T00:00:00.000Z"),
        receivedAt,
        ingestionStatus: "rejected_future_timestamp"
      }),
      expect.objectContaining({
        sequence: 2n,
        occurredAt: new Date("2026-08-26T00:00:09.000Z"),
        receivedAt,
        ingestionStatus: "accepted"
      })
    ]);
  });

  function fixtureEvent(overrides: { eventId?: string; sequence?: number; occurredAt?: string } = {}) {
    return {
      siteId: ids.siteId,
      gatewayId: ids.gatewayId,
      fixtureId: ids.fixtureId,
      eventId: overrides.eventId ?? "21000000-0000-4000-8000-000000000007",
      sequence: overrides.sequence ?? 1,
      occurredAt: overrides.occurredAt ?? "2026-08-26T00:00:09.000Z",
      brightness: 70,
      powerOn: true,
      status: "online" as const,
      statusReason: "reported" as const,
      rssi: -55,
      hopCount: 1
    };
  }
});
