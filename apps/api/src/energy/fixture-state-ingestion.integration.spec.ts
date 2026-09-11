import { PrismaService } from "../prisma/prisma.service";
import { FixtureStateIngestionService } from "./fixture-state-ingestion.service";

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
