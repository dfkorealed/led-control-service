import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { EnergyObservedMeanService } from "./energy-observed-mean.service";

const enabled = process.env.ENERGY_OBSERVED_MEAN_TEST === "1";
(enabled ? describe : describe.skip)("observed mean heatmap on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let siteId: string;
  let floorId: string;
  let fixtureIdentityId: string;
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
    const organizationId = randomUUID(); siteId = randomUUID(); floorId = randomUUID(); fixtureIdentityId = randomUUID();
    await db.organization.create({ data: { id: organizationId, name: "Observed mean" } });
    await db.site.create({ data: { id: siteId, organizationId, name: "DST site", timeZone: "America/New_York" } });
    await db.floor.create({ data: { id: floorId, siteId, name: "B1", level: -1 } });
    await db.energyFixtureIdentity.create({ data: {
      id: fixtureIdentityId, siteId, trackingStartedAt: new Date("2026-01-01T00:00:00.000Z"),
      dimensionVersions: { create: {
        name: "L-1", floorId, floorName: "B1", ratedWatt: "40", effectiveFrom: new Date("2026-01-01T00:00:00.000Z")
      } }
    } });
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] })
      .setSystemTime(new Date("2026-11-10T06:00:00.000Z"));
  });

  function service() {
    return new EnergyObservedMeanService(db as never, { assert: async () => ({ id: siteId }) } as never);
  }

  it("folds the two fall-back UTC buckets into one eligible local hour and excludes skipped spring hour", async () => {
    await db.fixtureEnergyHourlyAggregate.createMany({ data: [
      row("2026-11-01T05:00:00.000Z", "2026-11-01", 1, -240, "0.75", 20),
      row("2026-11-01T06:00:00.000Z", "2026-11-01", 1, -300, "1.25", 80)
    ] });

    const fall = await service().getObservedMean(user, siteId, {
      scope: "fixture", identityId: fixtureIdentityId, metric: "energy", from: "2026-11-01", to: "2026-11-01"
    });
    expect(fall.cells[1]).toMatchObject({ value: 2, expectedSeconds: 7_200, knownSeconds: 7_200,
      eligibleLocalDays: 1, observedLocalDays: 1, coverageRate: 1 });

    const spring = await service().getObservedMean(user, siteId, {
      scope: "fixture", identityId: fixtureIdentityId, metric: "energy", from: "2026-03-08", to: "2026-03-08"
    });
    expect(spring.cells[2]).toMatchObject({ value: null, expectedSeconds: 0, eligibleLocalDays: 0 });
  }, 20_000);

  it("counts an entirely missing hourly row as expected, then distinguishes a fully observed zero", async () => {
    const query = { scope: "site", identityId: siteId, metric: "energy", from: "2026-11-03", to: "2026-11-03" };
    const missing = await service().getObservedMean(user, siteId, query);
    expect(missing.cells[52]).toMatchObject({ value: null, expectedSeconds: 3_600, knownSeconds: 0, coverageRate: 0 });

    await db.fixtureEnergyHourlyAggregate.create({ data: row("2026-11-03T09:00:00.000Z", "2026-11-03", 4, -300, "0", 0) });
    const observed = await service().getObservedMean(user, siteId, query);
    expect(observed.cells[52]).toMatchObject({ value: 0, expectedSeconds: 3_600, knownSeconds: 3_600,
      eligibleLocalDays: 1, observedLocalDays: 1 });
  }, 20_000);

  it("uses full-bucket floor/group history without multiplying group membership", async () => {
    const otherFloorId = randomUUID(); const groupId = randomUUID();
    await db.floor.create({ data: { id: otherFloorId, siteId, name: "B2", level: -2 } });
    await db.energyFixtureDimensionVersion.updateMany({ where: { energyFixtureId: fixtureIdentityId }, data: { effectiveTo: new Date("2026-09-02T16:30:00.000Z") } });
    await db.energyFixtureDimensionVersion.create({ data: {
      energyFixtureId: fixtureIdentityId, name: "L-1", floorId: otherFloorId, floorName: "B2", ratedWatt: "40",
      effectiveFrom: new Date("2026-09-02T16:30:00.000Z")
    } });
    await db.energyGroupIdentity.create({ data: {
      id: groupId, siteId, trackingStartedAt: new Date("2026-01-01T00:00:00.000Z"),
      dimensionVersions: { create: { name: "Group", effectiveFrom: new Date("2026-01-01T00:00:00.000Z") } },
      memberships: { create: { energyFixtureId: fixtureIdentityId, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") } }
    } });
    await db.fixtureEnergyHourlyAggregate.createMany({ data: [
      row("2026-09-02T13:00:00.000Z", "2026-09-02", 9, -240, "1", 20),
      row("2026-09-02T16:00:00.000Z", "2026-09-02", 12, -240, "8", 20)
    ] });

    const floor = await service().getObservedMean(user, siteId, {
      scope: "floor", identityId: floorId, metric: "energy", from: "2026-09-02", to: "2026-09-02"
    });
    const group = await service().getObservedMean(user, siteId, {
      scope: "group", identityId: groupId, metric: "energy", from: "2026-09-02", to: "2026-09-02"
    });
    expect(floor.cells[81]).toMatchObject({ value: 1, expectedSeconds: 3_600 });
    expect(floor.cells[84]).toMatchObject({ value: null, expectedSeconds: 0 });
    expect(group.cells[81]).toMatchObject({ value: 1, expectedSeconds: 3_600 });
  }, 20_000);

  it("excludes an ambiguous floor hour when two same-floor dimension versions overlap", async () => {
    await db.energyFixtureDimensionVersion.create({ data: {
      energyFixtureId: fixtureIdentityId, name: "L-1 duplicate", floorId, floorName: "B1", ratedWatt: "40",
      effectiveFrom: new Date("2026-09-02T12:00:00.000Z"),
      effectiveTo: new Date("2026-09-02T18:00:00.000Z")
    } });
    await db.fixtureEnergyHourlyAggregate.create({ data: row("2026-09-02T13:00:00.000Z", "2026-09-02", 9, -240, "1", 20) });

    const floor = await service().getObservedMean(user, siteId, {
      scope: "floor", identityId: floorId, metric: "energy", from: "2026-09-02", to: "2026-09-02"
    });

    expect(floor.cells[81]).toMatchObject({ value: null, expectedSeconds: 0, knownSeconds: 0 });
  }, 20_000);

  (process.env.ENERGY_OBSERVED_MEAN_PERF_TEST === "1" ? it : it.skip)(
    "keeps a 1,000-fixture × 400-day site query bounded to 168 result rows",
    async () => {
      const start = new Date("2025-01-01T00:00:00.000Z");
      await db.energyFixtureIdentity.update({ where: { id: fixtureIdentityId }, data: { trackingStartedAt: start } });
      await db.energyFixtureIdentity.createMany({ data: Array.from({ length: 999 }, () => ({
        id: randomUUID(), siteId, trackingStartedAt: start
      })) });
      const beforeRss = process.resourceUsage().maxRSS;
      const startedAt = performance.now();
      const result = await service().getObservedMean(user, siteId, {
        scope: "site", identityId: siteId, metric: "energy", from: "2025-10-06", to: "2026-11-09"
      });
      const elapsedMs = Math.round(performance.now() - startedAt);
      const maxRssDeltaKiB = Math.max(0, process.resourceUsage().maxRSS - beforeRss);
      expect(result.cells).toHaveLength(168);
      expect(result.cells[0].value).toBeNull();
      expect(elapsedMs).toBeLessThan(10_000);
      console.info(`observed-mean 1000x400: ${elapsedMs}ms, Node maxRSS delta ${maxRssDeltaKiB}KiB, result ${result.cells.length} cells`);
    },
    120_000
  );

  function row(bucket: string, date: string, localHour: number, utcOffsetMinutes: number, kwh: string, brightness: number) {
    return {
      energyFixtureId: fixtureIdentityId, bucketStartUtc: new Date(bucket), localDate: new Date(`${date}T00:00:00.000Z`),
      localHour, utcOffsetMinutes, estimatedKwh: new Prisma.Decimal(kwh), knownSeconds: 3_600,
      unknownSeconds: 0, brightnessWeightedSeconds: new Prisma.Decimal(brightness * 3_600)
    };
  }
});
