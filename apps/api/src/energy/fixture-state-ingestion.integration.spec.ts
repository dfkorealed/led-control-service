import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { MqttService } from "../mqtt/mqtt.service";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SiteSettingsService } from "../site-settings/site-settings.service";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import {
  FixtureEnergyCheckpointService,
  FixtureStateIngestionService
} from "./fixture-state-ingestion.service";

let databaseUrl = process.env.FIXTURE_STATE_TEST_DATABASE_URL;
const selfOwnedDatabase = process.env.FIXTURE_STATE_DISPOSABLE_POSTGRES === "1";
const describeWithDatabase = databaseUrl || selfOwnedDatabase ? describe : describe.skip;

describeWithDatabase("fixture-state PostgreSQL atomic ingestion", () => {
  const ids = {
    organizationId: "21000000-0000-4000-8000-000000000001",
    siteId: "21000000-0000-4000-8000-000000000002",
    floorId: "21000000-0000-4000-8000-000000000003",
    gatewayId: "21000000-0000-4000-8000-000000000004",
    meshNodeId: "21000000-0000-4000-8000-000000000005",
    fixtureId: "21000000-0000-4000-8000-000000000006",
    energyFixtureId: "21000000-0000-4000-8000-000000000008",
    secondMeshNodeId: "21000000-0000-4000-8000-000000000015",
    secondFixtureId: "21000000-0000-4000-8000-000000000016",
    secondEnergyFixtureId: "21000000-0000-4000-8000-000000000018"
  };
  let prisma: PrismaService;
  let service: FixtureStateIngestionService;
  let cluster: Awaited<ReturnType<typeof disposablePostgres>> | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    if (selfOwnedDatabase) {
      cluster = await disposablePostgres();
      databaseUrl = cluster.database();
      const deployed = cluster.deploy(databaseUrl);
      expect(deployed.status).toBe(0);
      expect(deployed.stderr).not.toContain("Error");
    }
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
    await prisma.monitoringActivity.deleteMany({ where: { siteId: ids.siteId } });
    await prisma.site.update({
      where: { id: ids.siteId },
      data: { tariffKwhRate: "100.00", timeZone: "Asia/Seoul" }
    });
    await prisma.processedGatewayEvent.deleteMany({ where: { gatewayId: ids.gatewayId } });
    await prisma.gatewayEventWatermark.deleteMany({ where: { gatewayId: ids.gatewayId } });
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
        energyTrackingStartedAt: new Date("2026-08-26T00:00:00.000Z"),
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

  afterAll(async () => {
    await prisma?.$disconnect();
    cluster?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

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
    const activities = await prisma.monitoringActivity.findMany({ where: { siteId: ids.siteId }, orderBy: { kind: "asc" } });
    expect(activities.map(activity => activity.kind).sort()).toEqual([
      "fixture_brightness_changed", "fixture_status_changed"
    ]);
    expect(activities.every(activity => activity.sourceKey.startsWith(event.eventId))).toBe(true);
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

  it("uses settings committed while ingestion waits behind the settings fixture lock", async () => {
    const blocker = new PrismaService();
    const settingsPrisma = new PrismaService();
    const ingestionPrisma = new PrismaService();
    await Promise.all([blocker.$connect(), settingsPrisma.$connect(), ingestionPrisma.$connect()]);

    const intervalStartedAt = new Date(Date.now() - 60_000);
    const eventOccurredAt = new Date(intervalStartedAt.getTime() + 180_000);
    await prisma.fixture.update({
      where: { id: ids.fixtureId },
      data: {
        ratedWatt: "3600.00",
        brightness: 100,
        powerOn: true,
        energyTrackingStartedAt: intervalStartedAt,
        firstStateOccurredAt: intervalStartedAt,
        lastStateEventId: null,
        lastStateSequence: 1n,
        lastStateOccurredAt: intervalStartedAt
      }
    });
    await prisma.fixtureEnergyStateCursor.create({
      data: {
        fixtureId: ids.fixtureId,
        aggregatedThrough: intervalStartedAt,
        observedStateOccurredAt: intervalStartedAt,
        brightness: 100,
        powerOn: true,
        ratedWatt: "3600.00",
        durationRemainders: []
      }
    });
    const currentSite = await prisma.site.findUniqueOrThrow({ where: { id: ids.siteId } });

    const fixtureLocked = deferred();
    const releaseFixture = deferred();
    const blockerPromise = blocker.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Fixture" WHERE "id" = ${ids.fixtureId} FOR UPDATE
      `);
      fixtureLocked.resolve();
      await releaseFixture.promise;
    }, { timeout: 15_000 });
    await fixtureLocked.promise;

    const access = {
      assert: jest.fn().mockResolvedValue({ id: ids.siteId }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: ids.siteId })
    };
    const settingsService = new SiteSettingsService(
      settingsPrisma,
      access as never,
      {} as never,
      new FixtureEnergyCheckpointService()
    );
    const ingestionService = new FixtureStateIngestionService(ingestionPrisma);
    let settingsPromise: ReturnType<SiteSettingsService["updateSite"]> | undefined;
    let ingestionPromise: ReturnType<FixtureStateIngestionService["ingest"]> | undefined;

    try {
      settingsPromise = settingsService.updateSite({ id: "admin" } as never, ids.siteId, {
        expectedUpdatedAt: currentSite.updatedAt.toISOString(),
        tariffKwhRate: 200
      });
      await waitForBlockedQuery(prisma, (query) => query.includes('LEFT JOIN "FixtureEnergyStateCursor"'));

      ingestionPromise = ingestionService.ingest(ids.gatewayId, {
        ...fixtureEvent(),
        eventId: "21000000-0000-4000-8000-000000000009",
        sequence: 2,
        occurredAt: eventOccurredAt.toISOString(),
        brightness: 100
      });
      await waitForBlockedQuery(prisma, (query) =>
        query.includes('INNER JOIN "MeshNode"')
        || (query.includes('FROM "Site"') && query.includes("FOR KEY SHARE"))
      );
      releaseFixture.resolve();

      const [updatedSite, ingestion] = await Promise.all([settingsPromise, ingestionPromise]);
      expect(ingestion).toMatchObject({ status: "ingested" });

      const aggregates = await prisma.fixtureEnergyDailyAggregate.findMany({
        where: { fixtureId: ids.fixtureId }
      });
      const actualCost = aggregates.reduce((total, aggregate) => total + Number(aggregate.estimatedCost), 0);
      const changedAt = new Date(updatedSite.updatedAt);
      const oldRateCost = (changedAt.getTime() - intervalStartedAt.getTime()) / 10_000;
      const newRateCost = (eventOccurredAt.getTime() - changedAt.getTime()) / 5_000;
      expect(actualCost).toBeCloseTo(oldRateCost + newRateCost, 6);
    } finally {
      releaseFixture.resolve();
      await Promise.allSettled([
        blockerPromise,
        ...(settingsPromise ? [settingsPromise] : []),
        ...(ingestionPromise ? [ingestionPromise] : [])
      ]);
      await Promise.all([blocker.$disconnect(), settingsPrisma.$disconnect(), ingestionPrisma.$disconnect()]);
    }
  }, 20_000);

  it("allows two ingestion site locks while a settings FOR UPDATE waits", async () => {
    await prisma.processedGatewayEvent.deleteMany({ where: { fixtureId: ids.secondFixtureId } });
    await prisma.fixtureEnergyDailyAggregate.deleteMany({ where: { fixtureId: ids.secondFixtureId } });
    await prisma.fixtureEnergyHourlyAggregate.deleteMany({ where: { energyFixtureId: ids.secondEnergyFixtureId } });
    await prisma.fixtureEnergyStateCursor.deleteMany({ where: { fixtureId: ids.secondFixtureId } });
    await prisma.meshNode.upsert({
      where: { id: ids.secondMeshNodeId },
      create: {
        id: ids.secondMeshNodeId,
        gatewayId: ids.gatewayId,
        deviceUuid: "energy-integration-node-2",
        meshAddress: "0x1202",
        firmwareVersion: "integration"
      },
      update: { gatewayId: ids.gatewayId }
    });
    await prisma.fixture.upsert({
      where: { id: ids.secondFixtureId },
      create: {
        id: ids.secondFixtureId,
        floorId: ids.floorId,
        meshNodeId: ids.secondMeshNodeId,
        name: "B1-L02",
        ratedWatt: "40.00",
        x: 20,
        y: 20,
        energyTrackingStartedAt: new Date("2026-08-26T00:00:00.000Z")
      },
      update: {
        meshNodeId: ids.secondMeshNodeId,
        ratedWatt: "40.00",
        brightness: 0,
        powerOn: null,
        energyTrackingStartedAt: new Date("2026-08-26T00:00:00.000Z"),
        firstStateOccurredAt: null,
        lastStateEventId: null,
        lastStateSequence: null,
        lastStateOccurredAt: null
      }
    });
    await prisma.energyFixtureIdentity.upsert({
      where: { fixtureId: ids.secondFixtureId },
      create: {
        id: ids.secondEnergyFixtureId,
        siteId: ids.siteId,
        fixtureId: ids.secondFixtureId,
        trackingStartedAt: new Date("2026-08-26T00:00:00.000Z")
      },
      update: { retiredAt: null }
    });

    const blocker = new PrismaService();
    const firstIngestionPrisma = new PrismaService();
    const secondIngestionPrisma = new PrismaService();
    const settingsPrisma = new PrismaService();
    await Promise.all([
      blocker.$connect(),
      firstIngestionPrisma.$connect(),
      secondIngestionPrisma.$connect(),
      settingsPrisma.$connect()
    ]);
    const fixturesLocked = deferred();
    const releaseFixtures = deferred();
    const blockerPromise = blocker.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "Fixture"
        WHERE "id" IN (${ids.fixtureId}, ${ids.secondFixtureId})
        ORDER BY "id"
        FOR UPDATE
      `);
      fixturesLocked.resolve();
      await releaseFixtures.promise;
    }, { timeout: 15_000 });
    await fixturesLocked.promise;

    const firstIngestion = new FixtureStateIngestionService(firstIngestionPrisma);
    const secondIngestion = new FixtureStateIngestionService(secondIngestionPrisma);
    let firstPromise: ReturnType<FixtureStateIngestionService["ingest"]> | undefined;
    let secondPromise: ReturnType<FixtureStateIngestionService["ingest"]> | undefined;
    let settingsPromise: Promise<unknown> | undefined;

    try {
      firstPromise = firstIngestion.ingest(ids.gatewayId, {
        ...fixtureEvent(),
        eventId: "21000000-0000-4000-8000-000000000019",
        sequence: 11
      });
      secondPromise = secondIngestion.ingest(ids.gatewayId, {
        ...fixtureEvent(),
        fixtureId: ids.secondFixtureId,
        eventId: "21000000-0000-4000-8000-000000000020",
        sequence: 12
      });
      await waitForBlockedQuery(
        prisma,
        (query) => query.includes('INNER JOIN "MeshNode"') && query.includes("FOR UPDATE OF f"),
        2
      );

      settingsPromise = settingsPrisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "Site" WHERE "id" = ${ids.siteId} FOR UPDATE
        `);
      }, { timeout: 15_000 });
      await waitForBlockedQuery(
        prisma,
        (query) => query.includes('FROM "Site"') && query.includes("FOR UPDATE")
      );

      releaseFixtures.resolve();
      await expect(Promise.all([firstPromise, secondPromise])).resolves.toEqual([
        expect.objectContaining({ fixtureId: ids.fixtureId, status: "ingested" }),
        expect.objectContaining({ fixtureId: ids.secondFixtureId, status: "ingested" })
      ]);
      await expect(settingsPromise).resolves.toBeUndefined();
    } finally {
      releaseFixtures.resolve();
      await Promise.allSettled([
        blockerPromise,
        ...(firstPromise ? [firstPromise] : []),
        ...(secondPromise ? [secondPromise] : []),
        ...(settingsPromise ? [settingsPromise] : [])
      ]);
      await Promise.all([
        blocker.$disconnect(),
        firstIngestionPrisma.$disconnect(),
        secondIngestionPrisma.$disconnect(),
        settingsPrisma.$disconnect()
      ]);
    }
  }, 20_000);

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForBlockedQuery(
  prisma: PrismaService,
  matches: (query: string) => boolean,
  minimumCount = 1
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ query: string }>>(Prisma.sql`
      SELECT query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `);
    if (rows.filter(({ query }) => matches(query)).length >= minimumCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the expected PostgreSQL lock waiter");
}
