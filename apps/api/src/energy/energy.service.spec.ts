import { EnergyService } from "./energy.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { EnergyAnalyticsQueryService } from "./energy-analytics-query.service";

describe("EnergyService", () => {
  afterEach(() => jest.useRealTimers());
  it("delegates state-based reads and comparisons to the analytics read model", async () => {
    const analytics = {
      getSiteSummary: jest.fn().mockResolvedValue({ siteId: "site-1" }),
      getSiteSeries: jest.fn().mockResolvedValue({ siteId: "site-1", points: [] }),
      getComparison: jest.fn().mockResolvedValue({ siteId: "site-1", preset: "current_month" })
    };
    const service = new EnergyService({} as never, {} as never, analytics as never);

    await expect(service.getSiteSummary(user, "site-1")).resolves.toEqual({ siteId: "site-1" });
    await expect(service.getSiteSeries(user, "site-1", {
      granularity: "day", from: "2026-09-01", to: "2026-09-02"
    })).resolves.toEqual({ siteId: "site-1", points: [] });
    await expect(service.getSiteComparisons(user, "site-1", "current_month")).resolves.toEqual({
      siteId: "site-1", preset: "current_month"
    });
  });

  it("estimates kWh and cost from rated watt, brightness, hours, and tariff", () => {
    const service = new EnergyService({} as never, {} as never, {} as never);
    const result = service.calculateEstimatedUsage({
      ratedWatt: 40,
      brightness: 50,
      hours: 10,
      tariffKwhRate: 160
    });

    expect(result.kwh).toBe(0.2);
    expect(result.cost).toBe(32);
  });

  it("estimates energy only from the authenticated user's accessible default site", async () => {
    const prisma = {
      site: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          tariffKwhRate: "160.00",
          floors: [{ fixtures: [{ ratedWatt: "40.00", brightness: 50 }] }]
        })
      }
    };
    const user: AuthenticatedUser = {
      id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "fixture_user", name: "Admin", role: "admin", mustChangePassword: false, status: "active"
    };
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      listAccessibleSiteIds: jest.fn().mockResolvedValue(["site-1"])
    };
    const service = new (EnergyService as any)(prisma, siteAccess);

    await service.getDefaultSiteEstimate(user);

    expect(siteAccess.assert).toHaveBeenCalledWith(user, "site-1", "read");
    expect(prisma.site.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "site-1" },
      include: { floors: { include: { fixtures: true } } }
    });
  });

  it("uses a deterministic sorted accessible-site fallback when no siteId is selected", async () => {
    const prisma = {
      site: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          tariffKwhRate: "160.00",
          floors: [{ fixtures: [{ ratedWatt: "40.00", brightness: 50 }] }]
        })
      }
    };
    const user: AuthenticatedUser = {
      id: "user-1", organizationId: "org-1", organizationType: "service_provider", loginId: "fixture_user", name: "Operator", role: "operator", mustChangePassword: false, status: "active"
    };
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: "site-a" }),
      listAccessibleSiteIds: jest.fn().mockResolvedValue(["site-b", "site-a"])
    };
    const service = new (EnergyService as any)(prisma, siteAccess);

    await service.getDefaultSiteEstimate(user);

    expect(siteAccess.assert).toHaveBeenCalledWith(user, "site-a", "read");
    expect(prisma.site.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "site-a" },
      include: { floors: { include: { fixtures: true } } }
    });
  });

  it("does not query fixtures for an unauthorized site-scoped estimate", async () => {
    const user: AuthenticatedUser = {
      id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "fixture_user", name: "Viewer", role: "viewer", mustChangePassword: false, status: "active"
    };
    const prisma = { site: { findFirstOrThrow: jest.fn() } };
    const siteAccess = {
      listAccessibleSiteIds: jest.fn(),
      assert: jest.fn().mockRejectedValue(new NotFoundException("site not found"))
    };
    const service = new EnergyService(prisma as never, siteAccess as never, {} as never);

    await expect(service.getSiteEstimate(user, "site-foreign")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.site.findFirstOrThrow).not.toHaveBeenCalled();
  });

  it("does not return an estimate when the user has no accessible site", async () => {
    const user: AuthenticatedUser = {
      id: "user-1", organizationId: "org-1", organizationType: "service_provider", loginId: "fixture_user", name: "Operator", role: "operator", mustChangePassword: false, status: "active"
    };
    const prisma = { site: { findFirstOrThrow: jest.fn() } };
    const siteAccess = { listAccessibleSiteIds: jest.fn().mockResolvedValue([]), assert: jest.fn() };

    await expect(new EnergyService(prisma as never, siteAccess as never, {} as never).getDefaultSiteEstimate(user)).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(prisma.site.findFirstOrThrow).not.toHaveBeenCalled();
  });

  it("rejects cost estimates when a pending site has no tariff", async () => {
    const user: AuthenticatedUser = {
      id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "fixture_user", name: "Admin", role: "admin", mustChangePassword: false, status: "active"
    };
    const prisma = {
      site: { findFirstOrThrow: jest.fn().mockResolvedValue({ tariffKwhRate: null, floors: [] }) }
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new EnergyService(prisma as never, siteAccess as never, {} as never);

    await expect(service.getSiteEstimate(user, "site-1")).rejects.toMatchObject({ status: 409 });
  });

  it("returns an empty state-based summary without registered fixtures", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-26T03:00:00.000Z"));
    const { service } = createStateBasedService({ fixtures: [] });

    await expect(service.getSiteSummary(user, "site-1")).resolves.toMatchObject({
      siteId: "site-1",
      timeZone: "Asia/Seoul",
      source: "state_based_estimate",
      today: { estimatedKwh: 0, dataStatus: "no_data" },
      monthForecast: { estimatedKwh: null, reason: "no_registered_fixture" },
      baseline24Hours: { fixtureCount: 0, daysInMonth: 31 },
      estimatedSavings: { kwh: null, cost: null }
    });
  });

  it("uses the actual timezone month duration for a DST baseline", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-03-15T12:00:00.000Z"));
    const fixture = stateFixture({
      ratedWatt: "40",
      energyTrackingStartedAt: new Date("2026-03-01T05:00:00.000Z")
    });
    const { service } = createStateBasedService({ timeZone: "America/New_York", fixtures: [fixture] });

    const result = await service.getSiteSummary(user, "site-1");

    expect(result.baseline24Hours).toEqual({
      estimatedKwh: 29.72,
      estimatedCost: 4755.2,
      fixtureCount: 1,
      daysInMonth: 31
    });
  });

  it("returns exact forecast, baseline, and savings after coverage gates pass", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
    const fixture = stateFixture({
      energyTrackingStartedAt: new Date("2026-07-31T15:00:00.000Z"),
      aggregates: [{
        localDate: new Date("2026-08-01T00:00:00.000Z"),
        estimatedKwh: new Prisma.Decimal("0.8"),
        estimatedCost: new Prisma.Decimal("128"),
        knownSeconds: 118_800,
        unknownSeconds: 0,
        updatedAt: new Date("2026-08-02T00:00:00.000Z")
      }],
      cursor: stateCursor(new Date("2026-08-02T00:00:00.000Z"))
    });
    const { service } = createStateBasedService({ fixtures: [fixture] });

    const result = await service.getSiteSummary(user, "site-1");

    expect(result.monthForecast).toEqual({
      estimatedKwh: 18.0364,
      estimatedCost: 2_885.82,
      observedKnownSeconds: 118_800,
      reason: "available"
    });
    expect(result.baseline24Hours).toEqual({
      estimatedKwh: 29.76,
      estimatedCost: 4_761.6,
      fixtureCount: 1,
      daysInMonth: 31
    });
    expect(result.estimatedSavings).toEqual({ kwh: 11.7236, cost: 1_875.78 });
  });

  it("returns negative savings when forecast usage exceeds the current 24-hour baseline", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
    const fixture = stateFixture({
      ratedWatt: "40",
      energyTrackingStartedAt: new Date("2026-07-31T15:00:00.000Z"),
      aggregates: [aggregate("2026-08-01", 2, 118_800, 0)],
      cursor: stateCursor(new Date("2026-08-02T00:00:00.000Z"))
    });
    const { service } = createStateBasedService({ fixtures: [fixture] });

    const result = await service.getSiteSummary(user, "site-1");

    expect(result.monthForecast).toEqual({
      estimatedKwh: 45.0909,
      estimatedCost: 7_214.55,
      observedKnownSeconds: 118_800,
      reason: "available"
    });
    expect(result.baseline24Hours).toEqual({
      estimatedKwh: 29.76,
      estimatedCost: 4_761.6,
      fixtureCount: 1,
      daysInMonth: 31
    });
    expect(result.estimatedSavings).toEqual({ kwh: -15.3309, cost: -2_452.95 });
  });

  it("fails the forecast closed when one fixture has less than one hour of known state", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-01T17:00:00.000Z"));
    const fixtures = [
      stateFixture({ aggregates: [aggregate("2026-08-01", 1, 7_000, 0)] }),
      stateFixture({ id: "fixture-2", aggregates: [aggregate("2026-08-01", 0.1, 3_599, 0)] })
    ];
    const { service } = createStateBasedService({ fixtures });

    const result = await service.getSiteSummary(user, "site-1");

    expect(result.monthForecast).toMatchObject({ estimatedKwh: null, estimatedCost: null, reason: "insufficient_state" });
    expect(result.estimatedSavings).toEqual({ kwh: null, cost: null });
  });

  it("fails closed at 79.99% site coverage even when every fixture has at least one known hour", async () => {
    const generatedAt = new Date("2026-08-01T05:40:00.000Z");
    jest.useFakeTimers().setSystemTime(generatedAt);
    const fixtures = coverageBoundaryFixtures(generatedAt, 4_399);
    const { service } = createStateBasedService({ timeZone: "America/New_York", fixtures });

    const result = await service.getSiteSummary(user, "site-1");

    expect(result.monthToDate).toMatchObject({ knownSeconds: 7_999, unknownSeconds: 2_001, dataStatus: "partial" });
    expect(result.monthForecast).toEqual({
      estimatedKwh: null,
      estimatedCost: null,
      observedKnownSeconds: 7_999,
      reason: "insufficient_state"
    });
    expect(result.estimatedSavings).toEqual({ kwh: null, cost: null });
  });

  it("allows forecast at exactly 80% site coverage with different fixture tracking starts", async () => {
    const generatedAt = new Date("2026-08-01T05:40:00.000Z");
    jest.useFakeTimers().setSystemTime(generatedAt);
    const fixtures = coverageBoundaryFixtures(generatedAt, 4_400);
    const { service } = createStateBasedService({ timeZone: "America/New_York", fixtures });

    const result = await service.getSiteSummary(user, "site-1");

    expect(result.monthToDate).toMatchObject({ knownSeconds: 8_000, unknownSeconds: 2_000, dataStatus: "partial" });
    expect(result.monthForecast).toMatchObject({
      observedKnownSeconds: 8_000,
      reason: "available"
    });
    expect(result.monthForecast.estimatedKwh).not.toBeNull();
    expect(result.monthForecast.estimatedCost).not.toBeNull();
    expect(result.estimatedSavings.kwh).not.toBeNull();
    expect(result.estimatedSavings.cost).not.toBeNull();
  });

  it("returns every day in an inclusive series range and keeps empty points null", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    const fixture = stateFixture({
      aggregates: [aggregate("2026-08-01", 1.25, 3600, 0), aggregate("2026-08-03", 0.5, 1800, 60)],
      cursor: stateCursor(new Date("2026-08-04T00:00:00.000Z"))
    });
    const { service } = createStateBasedService({ fixtures: [fixture] });

    const result = await service.getSiteSeries(user, "site-1", {
      granularity: "day", from: "2026-08-01", to: "2026-08-03"
    });

    expect(result).toMatchObject({ granularity: "day", from: "2026-08-01", to: "2026-08-03" });
    expect(result.points.map((point: any) => [point.period, point.estimatedKwh, point.dataStatus])).toEqual([
      ["2026-08-01", 1.25, "available"],
      ["2026-08-02", null, "no_data"],
      ["2026-08-03", 0.5, "partial"]
    ]);
  });

  it("checks tenant access before loading state-based statistics", async () => {
    const { service, prisma, siteAccess } = createStateBasedService();
    siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));

    await expect(service.getSiteSummary(user, "foreign-site")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.site.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.fixture.findMany).not.toHaveBeenCalled();
  });

  it("projects the open interval with the checkpoint watt snapshot after rated-watt changes", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-01T00:01:00.000Z"));
    const cursor = stateCursor(new Date("2026-08-01T00:00:00.000Z"));
    const fixture = stateFixture({
      ratedWatt: "40",
      cursor,
      aggregates: [aggregate("2026-08-01", 0.000166666667, 60, 0)]
    });
    const { service } = createStateBasedService({ timeZone: "UTC", fixtures: [fixture] });

    const result = await service.getSiteSummary(user, "site-1");

    expect(result.today).toMatchObject({ estimatedKwh: 0.0005, knownSeconds: 120, unknownSeconds: 0, dataStatus: "available" });
    expect(result.baseline24Hours.estimatedKwh).toBe(29.76);
  });

  it("returns all months in an inclusive year series with Decimal totals", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
    const fixture = stateFixture({
      aggregates: [aggregate("2026-01-01", 0.1, 3600, 0), aggregate("2026-12-31", 0.2, 3600, 0)],
      cursor: stateCursor(new Date("2027-01-01T00:00:00.000Z"))
    });
    const { service } = createStateBasedService({ timeZone: "UTC", fixtures: [fixture] });

    const result = await service.getSiteSeries(user, "site-1", {
      granularity: "month", from: "2026-01-01", to: "2026-12-01"
    });

    expect(result.points).toHaveLength(12);
    expect(result.points[0]).toMatchObject({ period: "2026-01", estimatedKwh: 0.1 });
    expect(result.points[11]).toMatchObject({ period: "2026-12", estimatedKwh: 0.2 });
  });

  it("rejects malformed, reversed, and unbounded series ranges", async () => {
    const { service } = createStateBasedService();

    await expect(service.getSiteSeries(user, "site-1", { granularity: "day", from: "2026-02-30", to: "2026-03-01" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.getSiteSeries(user, "site-1", { granularity: "day", from: "2026-08-02", to: "2026-08-01" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.getSiteSeries(user, "site-1", { granularity: "day", from: "2020-01-01", to: "2026-01-01" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("does not draw an apparent zero-use point when only unknown time was observed", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
    const fixture = stateFixture({
      firstStateOccurredAt: null,
      lastStateEventId: null,
      aggregates: [aggregate("2026-08-01", 0, 0, 3_600)],
      cursor: stateCursor(new Date("2026-08-02T00:00:00.000Z"))
    });
    const { service } = createStateBasedService({ fixtures: [fixture] });

    const result = await service.getSiteSeries(user, "site-1", {
      granularity: "day", from: "2026-08-01", to: "2026-08-01"
    });

    expect(result.points[0]).toMatchObject({ estimatedKwh: null, estimatedCost: null, dataStatus: "partial" });
  });
});

const user: AuthenticatedUser = {
  id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "fixture_user", name: "Admin", role: "admin", mustChangePassword: false, status: "active"
};

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

function stateCursor(at: Date) {
  return {
    aggregatedThrough: at,
    observedStateOccurredAt: at,
    brightness: 50,
    powerOn: true,
    ratedWatt: new Prisma.Decimal(40),
    durationRemainders: [],
    updatedAt: at
  };
}

function stateFixture(input: Record<string, any> = {}) {
  const startedAt = input.energyTrackingStartedAt ?? new Date("2026-08-01T00:00:00.000Z");
  return {
    id: input.id ?? "fixture-1",
    ratedWatt: new Prisma.Decimal(input.ratedWatt ?? 40),
    energyTrackingStartedAt: startedAt,
    firstStateOccurredAt: input.firstStateOccurredAt ?? startedAt,
    lastStateEventId: "event-1",
    lastStateSequence: 1n,
    lastStateOccurredAt: input.cursor?.observedStateOccurredAt ?? null,
    brightness: 50,
    powerOn: true,
    energyStateCursor: input.cursor ?? null,
    energyDailyAggregates: input.aggregates ?? []
  };
}

function coverageBoundaryFixtures(generatedAt: Date, firstFixtureKnownSeconds: number) {
  return [
    stateFixture({
      id: "fixture-coverage-1",
      energyTrackingStartedAt: new Date("2026-08-01T04:00:00.000Z"),
      aggregates: [aggregate("2026-08-01", 0.1, firstFixtureKnownSeconds, 6_000 - firstFixtureKnownSeconds)],
      cursor: stateCursor(generatedAt)
    }),
    stateFixture({
      id: "fixture-coverage-2",
      energyTrackingStartedAt: new Date("2026-08-01T04:33:20.000Z"),
      aggregates: [aggregate("2026-08-01", 0.1, 3_600, 400)],
      cursor: stateCursor(generatedAt)
    })
  ];
}

function createStateBasedService(input: { timeZone?: string; fixtures?: any[] } = {}) {
  const prisma = {
    site: { findUniqueOrThrow: jest.fn().mockResolvedValue({
      id: "site-1", timeZone: input.timeZone ?? "Asia/Seoul", tariffKwhRate: new Prisma.Decimal(160)
    }) },
    fixture: { findMany: jest.fn().mockResolvedValue(input.fixtures ?? []) }
  };
  const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }), listAccessibleSiteIds: jest.fn() };
  const analytics = new EnergyAnalyticsQueryService(prisma as never, siteAccess as never);
  return { service: new EnergyService(prisma as never, siteAccess as never, analytics), prisma, siteAccess };
}
