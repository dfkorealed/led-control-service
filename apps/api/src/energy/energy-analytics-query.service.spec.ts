import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { energyComparisonResponseSchema, energyRangeComparisonResponseSchema } from "@led-control/shared";
import type { AuthenticatedUser } from "../auth/auth.types";
import { EnergyAnalyticsQueryService } from "./energy-analytics-query.service";

describe("EnergyAnalyticsQueryService comparisons", () => {
  afterEach(() => jest.useRealTimers());

  it("forecasts the current month and returns positive baseline savings", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const { service } = createService({ fixtures: [fixture({ aggregates: dailyAggregates("2026-09-01", 9, 1.2) })] });

    const result = await service.getComparison(user, SITE_ID, "current_month");

    expect(result.summary).toEqual({
      baselineKwh: 72,
      estimatedKwh: 36,
      savingsKwh: 36,
      savingsCost: 5_760,
      savingsRatePercent: 50,
      outcome: "saving",
      forecastReason: "available"
    });
    expect(result.points).toHaveLength(30);
    expect(result.points[0]).toMatchObject({ period: "2026-09-01", estimatedKwh: 1.2, phase: "observed" });
    expect(result.points[9]).toMatchObject({ period: "2026-09-10", estimatedKwh: 1.2, phase: "forecast" });
    expect(() => energyComparisonResponseSchema.parse(result)).not.toThrow();
  });

  it("does not clamp usage that exceeds the 24-hour baseline", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const { service } = createService({ fixtures: [fixture({ aggregates: dailyAggregates("2026-09-01", 9, 4) })] });

    const result = await service.getComparison(user, SITE_ID, "current_month");

    expect(result.summary).toMatchObject({
      baselineKwh: 72,
      estimatedKwh: 120,
      savingsKwh: -48,
      savingsCost: -7_680,
      savingsRatePercent: -66.67,
      outcome: "overuse"
    });
  });

  it("fails the forecast closed when a fixture has less than one known hour", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const { service } = createService({
      fixtures: [fixture({ aggregates: [aggregate("2026-09-01", 0.1, 3_599, 774_001)] })]
    });

    const result = await service.getComparison(user, SITE_ID, "current_month");

    expect(result.summary).toEqual({
      baselineKwh: 72,
      estimatedKwh: null,
      savingsKwh: null,
      savingsCost: null,
      savingsRatePercent: null,
      outcome: "unavailable",
      forecastReason: "insufficient_state"
    });
    expect(result.points[9]).toMatchObject({ estimatedKwh: null, phase: "unavailable" });
  });

  it("compares seven completed days with the prior period and prior year", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const aggregates = [
      ...dailyAggregates("2026-09-03", 7, 1),
      ...dailyAggregates("2026-08-27", 7, 2),
      ...dailyAggregates("2025-09-03", 7, 0.5)
    ];
    const { service } = createService({ fixtures: [fixture({ aggregates, startedAt: "2025-01-01T00:00:00.000Z" })] });

    const result = await service.getComparison(user, SITE_ID, "last_7_days");

    expect(result.summary).toMatchObject({
      baselineKwh: 16.8,
      estimatedKwh: 7,
      savingsKwh: 9.8,
      savingsRatePercent: 58.33,
      outcome: "saving",
      forecastReason: "not_applicable"
    });
    expect(result.priorComparisons).toEqual([
      expect.objectContaining({ kind: "previous_period", currentKwh: 7, comparisonKwh: 14, changeRatePercent: -50 }),
      expect.objectContaining({ kind: "previous_year", currentKwh: 7, comparisonKwh: 3.5, changeRatePercent: 100 })
    ]);
    expect(result.points.map((point) => point.period)).toEqual([
      "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"
    ]);
  });

  it("checks tenant access before reading the site or fixtures", async () => {
    const { service, prisma, siteAccess } = createService();
    siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));

    await expect(service.getComparison(user, "foreign-site", "current_month")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.site.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.fixture.findMany).not.toHaveBeenCalled();
  });
});

describe("EnergyAnalyticsQueryService custom completed comparisons", () => {
  afterEach(() => jest.useRealTimers());

  it("keeps observed zero and reports -100 percent only when both complete periods have known fixture-seconds", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const aggregates = [
      ...dailyAggregates("2026-09-05", 2, 2),
      ...dailyAggregates("2026-09-07", 2, 0)
    ];
    const { service } = createService({ fixtures: [fixture({ aggregates, startedAt: "2026-09-01T00:00:00.000Z" })] });

    const result = await service.getCustomComparison(user, SITE_ID, { from: "2026-09-07", to: "2026-09-08" });

    expect(result.selection).toEqual({ kind: "custom", from: "2026-09-07", to: "2026-09-08" });
    expect(result.summary).toMatchObject({ estimatedKwh: 0, forecastReason: "not_applicable" });
    expect(result.priorComparisons[0]).toMatchObject({
      kind: "previous_period", currentKwh: 0, comparisonKwh: 4,
      currentCoverageRate: 1, comparisonCoverageRate: 1, changeRatePercent: -100
    });
    expect(result.points.map((point) => point.period)).toEqual(["2026-09-07", "2026-09-08"]);
    expect(energyRangeComparisonResponseSchema.safeParse(result).success).toBe(true);
  });

  it("does not claim complete coverage when an entire expected local day has no row", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const aggregates = [...dailyAggregates("2026-09-05", 2, 2), aggregate("2026-09-07", 1, 86_400, 0)];
    const { service } = createService({ fixtures: [fixture({ aggregates })] });

    const result = await service.getCustomComparison(user, SITE_ID, { from: "2026-09-07", to: "2026-09-08" });

    expect(result.priorComparisons[0]).toMatchObject({
      currentKwh: 1, comparisonKwh: 4, currentCoverageRate: 0.5,
      comparisonCoverageRate: 1, changeRatePercent: null
    });
    expect(result.points[1]).toMatchObject({ estimatedKwh: null, phase: "unavailable" });
  });

  it("suppresses a change rate when a current fixture entered tracking after the comparison window began", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const older = fixture({ aggregates: dailyAggregates("2026-09-05", 4, 1), startedAt: "2026-09-01T00:00:00.000Z" });
    const newer = { ...fixture({ aggregates: dailyAggregates("2026-09-08", 1, 1), startedAt: "2026-09-08T00:00:00.000Z" }), id: "fixture-2" };
    const { service } = createService({ fixtures: [older, newer] });

    const result = await service.getCustomComparison(user, SITE_ID, { from: "2026-09-07", to: "2026-09-08" });

    expect(result.priorComparisons[0]).toMatchObject({
      currentKwh: 3, comparisonKwh: 2, changeRatePercent: null
    });
  });

  it("authorizes before reading site data for a custom range", async () => {
    const { service, prisma, siteAccess } = createService();
    siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));

    await expect(service.getCustomComparison(user, "foreign-site", { from: "2026-09-07", to: "2026-09-08" }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.site.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("visits dense fixture-day values once for a 400-point custom comparison", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-11-10T06:00:00.000Z"));
    const fixtures = Array.from({ length: 10 }, (_, index) => ({
      ...fixture({ startedAt: "2025-01-01T00:00:00.000Z" }), id: `fixture-${index}`
    }));
    const { service } = createService({ fixtures });
    const values = new Map<string, Map<string, any>>();
    const dailyValue = { estimatedKwh: new Prisma.Decimal(1), estimatedCost: new Prisma.Decimal(160),
      knownSeconds: 86_400, unknownSeconds: 0, hasData: true };
    let visits = 0;
    const firstDay = Date.parse("2025-10-06T00:00:00.000Z");
    for (const fixtureRow of fixtures) {
      const daily = new Map<string, any>();
      for (let index = 0; index < 400; index++) {
        daily.set(new Date(firstDay + index * 86_400_000).toISOString().slice(0, 10), dailyValue);
      }
      const iterate = daily[Symbol.iterator].bind(daily);
      Object.defineProperty(daily, Symbol.iterator, { value: function* () {
        for (const entry of iterate()) { visits++; yield entry; }
      } });
      values.set(fixtureRow.id, daily);
    }
    jest.spyOn(service as any, "buildFixtureValues").mockReturnValue(values);

    const result = await service.getCustomComparison(user, SITE_ID, { from: "2025-10-06", to: "2026-11-09" });

    expect(result.points).toHaveLength(400);
    expect(result.points[0]).toMatchObject({ estimatedKwh: 10, phase: "observed" });
    expect(result.points[399]).toMatchObject({ estimatedKwh: 10, phase: "observed" });
    expect(result.summary.estimatedKwh).toBe(4_000);
    expect(visits).toBeLessThanOrEqual(8_000);
  });
});

const user: AuthenticatedUser = {
  id: "user-1",
  organizationId: "org-1",
  organizationType: "customer",
  loginId: "fixture_user",
  name: "Admin",
  role: "admin",
  status: "active",
  mustChangePassword: false
};

const SITE_ID = "00000000-0000-4000-8000-000000000003";

function createService(input: { fixtures?: any[]; timeZone?: string; tariff?: number } = {}) {
  const prisma = {
    site: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: SITE_ID,
        timeZone: input.timeZone ?? "UTC",
        tariffKwhRate: new Prisma.Decimal(input.tariff ?? 160)
      })
    },
    fixture: { findMany: jest.fn().mockResolvedValue(input.fixtures ?? []) }
  };
  const siteAccess = {
    assert: jest.fn().mockResolvedValue({ id: SITE_ID }),
    listAccessibleSiteIds: jest.fn()
  };
  return {
    service: new EnergyAnalyticsQueryService(prisma as never, siteAccess as never),
    prisma,
    siteAccess
  };
}

function fixture(input: { aggregates?: ReturnType<typeof aggregate>[]; startedAt?: string } = {}) {
  const startedAt = new Date(input.startedAt ?? "2026-09-01T00:00:00.000Z");
  const generatedAt = new Date("2026-09-10T00:00:00.000Z");
  return {
    id: "fixture-1",
    ratedWatt: new Prisma.Decimal(100),
    energyTrackingStartedAt: startedAt,
    firstStateOccurredAt: startedAt,
    lastStateEventId: "event-1",
    lastStateSequence: 1n,
    lastStateOccurredAt: generatedAt,
    brightness: 50,
    powerOn: true,
    energyStateCursor: {
      aggregatedThrough: generatedAt,
      observedStateOccurredAt: generatedAt,
      brightness: 50,
      powerOn: true,
      ratedWatt: new Prisma.Decimal(100),
      durationRemainders: [],
      updatedAt: generatedAt
    },
    energyDailyAggregates: input.aggregates ?? []
  };
}

function dailyAggregates(from: string, count: number, kwhPerDay: number) {
  const start = new Date(`${from}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return aggregate(date.toISOString().slice(0, 10), kwhPerDay, 86_400, 0);
  });
}

function aggregate(localDate: string, kwh: number, knownSeconds: number, unknownSeconds: number) {
  return {
    localDate: new Date(`${localDate}T00:00:00.000Z`),
    estimatedKwh: new Prisma.Decimal(kwh),
    estimatedCost: new Prisma.Decimal(kwh * 160),
    knownSeconds,
    unknownSeconds,
    updatedAt: new Date(`${localDate}T12:00:00.000Z`)
  };
}
