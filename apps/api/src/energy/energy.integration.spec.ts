import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EnergyService } from "./energy.service";
import { EnergyAnalyticsQueryService } from "./energy-analytics-query.service";
import { energySeriesResponseSchema, energySummarySchema } from "@led-control/shared";

const databaseUrl = process.env.ENERGY_QUERY_TEST_DATABASE_URL ?? process.env.FIXTURE_STATE_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("energy statistics PostgreSQL query", () => {
  const ids = {
    organizationId: "22000000-0000-4000-8000-000000000001",
    siteId: "22000000-0000-4000-8000-000000000002",
    floorId: "22000000-0000-4000-8000-000000000003",
    fixtureId: "22000000-0000-4000-8000-000000000004"
  };
  const user = {
    id: "22000000-0000-4000-8000-000000000005",
    organizationId: ids.organizationId,
    organizationType: "customer" as const,
    loginId: "fixture_user",
    name: "Energy Admin",
    role: "admin" as const,
    status: "active" as const
  };
  let prisma: PrismaService;
  let service: EnergyService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: ids.siteId }) } as never;
    service = new EnergyService(prisma, siteAccess, new EnergyAnalyticsQueryService(prisma, siteAccess));
    await prisma.organization.upsert({
      where: { id: ids.organizationId },
      create: { id: ids.organizationId, name: "Energy query", type: "customer" },
      update: {}
    });
    await prisma.site.upsert({
      where: { id: ids.siteId },
      create: { id: ids.siteId, organizationId: ids.organizationId, name: "Energy", address: "Test", tariffKwhRate: "160", timeZone: "Asia/Seoul" },
      update: { tariffKwhRate: "160", timeZone: "Asia/Seoul" }
    });
    await prisma.floor.upsert({
      where: { id: ids.floorId },
      create: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 },
      update: { siteId: ids.siteId }
    });
  });

  beforeEach(async () => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]
    }).setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
    await prisma.fixtureEnergyDailyAggregate.deleteMany({ where: { fixtureId: ids.fixtureId } });
    await prisma.fixtureEnergyStateCursor.deleteMany({ where: { fixtureId: ids.fixtureId } });
    await prisma.fixture.upsert({
      where: { id: ids.fixtureId },
      create: {
        id: ids.fixtureId, floorId: ids.floorId, name: "B1-L01", ratedWatt: "40", x: 0, y: 0,
        energyTrackingStartedAt: new Date("2026-07-31T15:00:00.000Z"), firstStateOccurredAt: new Date("2026-07-31T15:00:00.000Z"),
        lastStateEventId: "22000000-0000-4000-8000-000000000006", lastStateSequence: 1n,
        lastStateOccurredAt: new Date("2026-08-02T00:00:00.000Z"), brightness: 50, powerOn: true
      },
      update: { ratedWatt: "40", energyTrackingStartedAt: new Date("2026-07-31T15:00:00.000Z") }
    });
    await prisma.fixtureEnergyDailyAggregate.create({
      data: {
        fixtureId: ids.fixtureId, localDate: new Date("2026-08-01T00:00:00.000Z"),
        estimatedKwh: new Prisma.Decimal("0.123456789012"), estimatedCost: new Prisma.Decimal("19.75308624"),
        knownSeconds: 118_800, unknownSeconds: 0
      }
    });
    await prisma.fixtureEnergyStateCursor.create({
      data: {
        fixtureId: ids.fixtureId, aggregatedThrough: new Date("2026-08-02T00:00:00.000Z"),
        observedStateOccurredAt: new Date("2026-08-02T00:00:00.000Z"), brightness: 50, powerOn: true,
        ratedWatt: new Prisma.Decimal(40), durationRemainders: []
      }
    });
  });

  afterEach(() => jest.useRealTimers());
  afterAll(async () => prisma.$disconnect());

  it("reads Decimal aggregates into summary and an inclusive day series", async () => {
    const summary = await service.getSiteSummary(user, ids.siteId);
    const series = await service.getSiteSeries(user, ids.siteId, {
      granularity: "day", from: "2026-08-01", to: "2026-08-02"
    });

    expect(summary.monthToDate.estimatedKwh).toBe(0.1235);
    expect(summary.monthForecast.reason).toBe("available");
    expect(series.points).toHaveLength(2);
    expect(series.points[0]).toMatchObject({ period: "2026-08-01", estimatedKwh: 0.1235, dataStatus: "available" });
    expect(series.points[1]).toMatchObject({ period: "2026-08-02", estimatedKwh: null, dataStatus: "no_data" });
    expect(energySummarySchema.safeParse(summary).success).toBe(true);
    expect(energySeriesResponseSchema.safeParse(series).success).toBe(true);
  }, 15_000);
});
