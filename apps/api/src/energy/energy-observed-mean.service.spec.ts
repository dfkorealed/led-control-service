import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { energyObservedMeanResponseSchema } from "@led-control/shared";
import { EnergyController } from "./energy.controller";
import { EnergyObservedMeanService } from "./energy-observed-mean.service";

const siteId = "31000000-0000-4000-8000-000000000001";
const fixtureId = "31000000-0000-4000-8000-000000000002";
const user = { id: "user", organizationId: "org", organizationType: "customer", role: "admin" } as never;

describe("EnergyObservedMeanService", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date("2026-11-10T06:00:00.000Z")));
  afterEach(() => jest.useRealTimers());

  it("returns 168 ordered cells and divides complete energy by eligible local dates, not UTC buckets", async () => {
    const { service, prisma } = harness([
      row(0, 1, "2", 7_200, 7_200, 1, 1, "360000"),
      row(2, 4, "0", 3_600, 3_600, 1, 1, "0")
    ]);

    const result = await service.getObservedMean(user, siteId, {
      scope: "site", identityId: siteId, metric: "energy", from: "2026-11-01", to: "2026-11-07"
    });

    expect(result.cells).toHaveLength(168);
    expect(result.cells[1]).toEqual({
      weekday: 0, hour: 1, value: 2, knownSeconds: 7_200, expectedSeconds: 7_200,
      observedLocalDays: 1, eligibleLocalDays: 1, coverageRate: 1
    });
    expect(result.cells[52].value).toBe(0);
    expect(result.cells[0]).toMatchObject({ value: null, knownSeconds: 0, expectedSeconds: 0, eligibleLocalDays: 0 });
    expect(energyObservedMeanResponseSchema.safeParse(result).success).toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.energyFixtureIdentity.findMany).not.toHaveBeenCalled();
  });

  it("distinguishes an expected-but-missing hour from fully observed zero, and weights brightness by known seconds", async () => {
    const { service } = harness([
      row(0, 1, "0", 3_600, 7_200, 0, 1, "72000"),
      row(1, 2, "0", 7_200, 7_200, 2, 2, "360000")
    ]);

    const result = await service.getObservedMean(user, siteId, {
      scope: "site", identityId: siteId, metric: "brightness", from: "2026-11-01", to: "2026-11-09"
    });

    expect(result.cells[1]).toMatchObject({ value: null, coverageRate: 0.5, observedLocalDays: 0 });
    expect(result.cells[26]).toMatchObject({ value: 50, observedLocalDays: 2, eligibleLocalDays: 2 });
  });

  it("supports 93 and 400 completed dates but rejects 401 and today before querying aggregates", async () => {
    const { service, prisma } = harness([]);
    for (const from of ["2026-08-09", "2025-10-06"]) {
      await expect(service.getObservedMean(user, siteId, {
        scope: "site", identityId: siteId, metric: "energy", from, to: "2026-11-09"
      })).resolves.toBeDefined();
    }
    await expect(service.getObservedMean(user, siteId, {
      scope: "site", identityId: siteId, metric: "energy", from: "2025-10-05", to: "2026-11-09"
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getObservedMean(user, siteId, {
      scope: "site", identityId: siteId, metric: "energy", from: "2026-11-10", to: "2026-11-10"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("authorizes the site before lookup and conceals a foreign fixture identity", async () => {
    const denied = harness([]);
    denied.siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));
    await expect(denied.service.getObservedMean(user, siteId, {
      scope: "site", identityId: siteId, metric: "energy", from: "2026-11-01", to: "2026-11-02"
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(denied.prisma.site.findUniqueOrThrow).not.toHaveBeenCalled();

    const foreign = harness([]);
    foreign.prisma.energyFixtureIdentity.findFirst.mockResolvedValue(null);
    await expect(foreign.service.getObservedMean(user, siteId, {
      scope: "fixture", identityId: fixtureId, metric: "energy", from: "2026-11-01", to: "2026-11-02"
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(foreign.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("exposes the separate observed-mean controller entry without changing the legacy heatmap handler", async () => {
    const observedMean = { getObservedMean: jest.fn().mockResolvedValue({ cells: [] }) };
    const controller = new EnergyController({} as never, undefined, undefined, undefined, undefined, observedMean as never);
    const query = { scope: "site", identityId: siteId, metric: "energy", from: "2026-11-01", to: "2026-11-07" };

    await expect(controller.getSiteObservedMean(user, siteId, query)).resolves.toEqual({ cells: [] });
    expect(observedMean.getObservedMean).toHaveBeenCalledWith(user, siteId, query);
  });
});

function row(
  weekday: number, hour: number, estimatedKwh: string, knownSeconds: number, expectedSeconds: number,
  observedLocalDays: number, eligibleLocalDays: number, brightnessWeightedSeconds: string
) {
  return {
    weekday, hour, estimatedKwh: new Prisma.Decimal(estimatedKwh), knownSeconds: BigInt(knownSeconds),
    expectedSeconds: BigInt(expectedSeconds), observedLocalDays: BigInt(observedLocalDays),
    eligibleLocalDays: BigInt(eligibleLocalDays), brightnessWeightedSeconds: new Prisma.Decimal(brightnessWeightedSeconds),
    unknownSeconds: 0n, fullyObserved: knownSeconds === expectedSeconds
  };
}

function harness(rows: ReturnType<typeof row>[]) {
  const prisma = {
    site: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: siteId, timeZone: "America/New_York" }) },
    energyFixtureIdentity: { findFirst: jest.fn().mockResolvedValue({ id: fixtureId }), findMany: jest.fn() },
    floor: { findFirst: jest.fn().mockResolvedValue({ id: fixtureId }) },
    energyGroupIdentity: { findFirst: jest.fn().mockResolvedValue({ id: fixtureId }) },
    $queryRaw: jest.fn().mockResolvedValue(rows)
  };
  const siteAccess = { assert: jest.fn().mockResolvedValue({ id: siteId }) };
  return { service: new EnergyObservedMeanService(prisma as never, siteAccess as never), prisma, siteAccess };
}
