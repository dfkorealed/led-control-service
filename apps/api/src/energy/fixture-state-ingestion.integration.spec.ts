import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SiteSettingsService } from "../site-settings/site-settings.service";
import {
  FixtureEnergyCheckpointService,
  FixtureStateIngestionService
} from "./fixture-state-ingestion.service";

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
    await prisma.site.update({
      where: { id: ids.siteId },
      data: { tariffKwhRate: "100.00", timeZone: "Asia/Seoul" }
    });
    await prisma.processedGatewayEvent.deleteMany({ where: { fixtureId: ids.fixtureId } });
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
        lastStateOccurredAt: null
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
        || (query.includes('FROM "Site"') && query.includes("FOR UPDATE"))
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
  });

  function fixtureEvent() {
    return {
      siteId: ids.siteId,
      gatewayId: ids.gatewayId,
      fixtureId: ids.fixtureId,
      eventId: "21000000-0000-4000-8000-000000000007",
      sequence: 1,
      occurredAt: "2026-08-26T00:00:09.000Z",
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

async function waitForBlockedQuery(prisma: PrismaService, matches: (query: string) => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ query: string }>>(Prisma.sql`
      SELECT query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `);
    if (rows.some(({ query }) => matches(query))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the expected PostgreSQL lock waiter");
}
