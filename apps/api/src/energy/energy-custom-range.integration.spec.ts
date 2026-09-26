import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { energyRangeComparisonResponseSchema } from "@led-control/shared";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { EnergyAnalyticsQueryService } from "./energy-analytics-query.service";

const enabled = process.env.ENERGY_CUSTOM_RANGE_TEST === "1";
(enabled ? describe : describe.skip)("custom energy comparison on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let siteId: string;
  let fixtureId: string;
  let identityId: string;
  const user = { id: randomUUID(), organizationType: "customer", role: "admin" } as never;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const migrated = cluster.deploy(url);
    expect(migrated.stderr + migrated.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(migrated.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
    await db.$connect();
  }, 90_000);
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });
  afterEach(() => jest.useRealTimers());

  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
    const organizationId = randomUUID(); siteId = randomUUID(); fixtureId = randomUUID(); identityId = randomUUID();
    const floorId = randomUUID();
    await db.organization.create({ data: { id: organizationId, name: "Range" } });
    await db.site.create({ data: { id: siteId, organizationId, name: "Range", timeZone: "UTC", tariffKwhRate: "160" } });
    await db.floor.create({ data: { id: floorId, siteId, name: "B1", level: -1 } });
    await db.fixture.create({ data: {
      id: fixtureId, floorId, name: "L-1", ratedWatt: "100", x: 0, y: 0,
      energyTrackingStartedAt: new Date("2026-09-01T00:00:00.000Z"),
      firstStateOccurredAt: new Date("2026-09-01T00:00:00.000Z"),
      lastStateOccurredAt: new Date("2026-09-10T00:00:00.000Z"), lastStateEventId: randomUUID(), lastStateSequence: 1n,
      brightness: 0, powerOn: true
    } });
    await db.energyFixtureIdentity.create({ data: {
      id: identityId, siteId, fixtureId, trackingStartedAt: new Date("2026-09-01T00:00:00.000Z")
    } });
    await db.fixtureEnergyStateCursor.create({ data: {
      fixtureId, aggregatedThrough: new Date("2026-09-10T00:00:00.000Z"),
      observedStateOccurredAt: new Date("2026-09-10T00:00:00.000Z"), brightness: 0, powerOn: true,
      ratedWatt: new Prisma.Decimal(100), durationRemainders: []
    } });
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
      .setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
  });

  function service() {
    return new EnergyAnalyticsQueryService(db as never, { assert: async () => ({ id: siteId }) } as never);
  }
  async function day(date: string, kwh: string, knownSeconds = 86_400) {
    await db.fixtureEnergyDailyAggregate.create({ data: {
      fixtureId, energyFixtureId: identityId, localDate: new Date(`${date}T00:00:00.000Z`),
      estimatedKwh: new Prisma.Decimal(kwh), estimatedCost: new Prisma.Decimal(kwh).mul(160),
      knownSeconds, unknownSeconds: 0
    } });
  }

  it("preserves fully observed zero and uses stored usage with a current-configuration baseline", async () => {
    await day("2026-09-05", "2"); await day("2026-09-06", "2");
    await day("2026-09-07", "0"); await day("2026-09-08", "0");

    const result = await service().getCustomComparison(user, siteId, { from: "2026-09-07", to: "2026-09-08" });

    expect(result.summary).toMatchObject({ baselineKwh: 4.8, estimatedKwh: 0, savingsKwh: 4.8,
      savingsCost: 768, forecastReason: "not_applicable" });
    expect(result.priorComparisons[0]).toMatchObject({ currentKwh: 0, comparisonKwh: 4,
      currentCoverageRate: 1, comparisonCoverageRate: 1, changeRatePercent: -100 });
    expect(energyRangeComparisonResponseSchema.safeParse(result).success).toBe(true);
  });

  it("leaves change rate null when a whole expected day has no aggregate", async () => {
    await day("2026-09-05", "2"); await day("2026-09-06", "2"); await day("2026-09-07", "1");

    const result = await service().getCustomComparison(user, siteId, { from: "2026-09-07", to: "2026-09-08" });

    expect(result.priorComparisons[0]).toMatchObject({ currentKwh: 1, comparisonKwh: 4,
      currentCoverageRate: 0.5, changeRatePercent: null });
    expect(result.points[1]).toMatchObject({ estimatedKwh: null, phase: "unavailable" });
  });

  it("uses the site's 23-hour DST day as the exact expected fixture-seconds", async () => {
    await db.site.update({ where: { id: siteId }, data: { timeZone: "America/New_York" } });
    const trackingStartedAt = new Date("2026-01-01T00:00:00.000Z");
    const checkpointAt = new Date("2026-03-10T05:00:00.000Z");
    await db.fixture.update({ where: { id: fixtureId }, data: {
      energyTrackingStartedAt: trackingStartedAt, firstStateOccurredAt: trackingStartedAt,
      lastStateOccurredAt: checkpointAt
    } });
    await db.energyFixtureIdentity.update({ where: { id: identityId }, data: { trackingStartedAt } });
    await db.fixtureEnergyStateCursor.update({ where: { fixtureId }, data: {
      aggregatedThrough: checkpointAt, observedStateOccurredAt: checkpointAt
    } });
    await day("2026-03-07", "2", 86_400);
    await day("2026-03-08", "1", 82_800);
    jest.setSystemTime(checkpointAt);

    const result = await service().getCustomComparison(user, siteId, { from: "2026-03-08", to: "2026-03-08" });

    expect(result.summary).toMatchObject({ baselineKwh: 2.3, estimatedKwh: 1 });
    expect(result.priorComparisons[0]).toMatchObject({ currentCoverageRate: 1,
      comparisonCoverageRate: 1, changeRatePercent: -50 });
  });
});
