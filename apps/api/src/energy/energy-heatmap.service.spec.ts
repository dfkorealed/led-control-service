import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { energyHeatmapResponseSchema } from "@led-control/shared";
import { EnergyController } from "./energy.controller";
import { EnergyHeatmapService } from "./energy-heatmap.service";

const siteId = "31000000-0000-4000-8000-000000000001";
const fixtureIdentityId = "31000000-0000-4000-8000-000000000002";
const floorId = "31000000-0000-4000-8000-000000000003";
const groupIdentityId = "31000000-0000-4000-8000-000000000004";
const otherFixtureIdentityId = "31000000-0000-4000-8000-000000000005";
const user = { id: "user", organizationId: "org", organizationType: "customer", role: "admin" } as never;

describe("EnergyHeatmapService", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date("2026-11-10T00:00:00.000Z")));
  afterEach(() => jest.useRealTimers());

  it("resolves UTC buckets before folding and excludes a bucket crossing a membership change", async () => {
    const selected = fixture(fixtureIdentityId, [
      Object.assign(hourly("2026-09-02", 9, "1", 3600, 20), { bucketStartUtc: new Date("2026-09-02T13:00:00Z") }),
      Object.assign(hourly("2026-09-02", 12, "8", 3600, 20), { bucketStartUtc: new Date("2026-09-02T16:00:00Z") }),
      Object.assign(hourly("2026-09-02", 15, "2", 3600, 20), { bucketStartUtc: new Date("2026-09-02T19:00:00Z") })
    ]);
    selected.dimensionVersions = [
      { floorId, effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: new Date("2026-09-02T16:30:00Z") },
      { floorId: otherFixtureIdentityId, effectiveFrom: new Date("2026-09-02T16:30:00Z"), effectiveTo: null }
    ] as typeof selected.dimensionVersions;
    const { service } = harness([selected]);
    const result = await service.getHeatmap(user, siteId, {
      scope: "floor", identityId: floorId, metric: "energy", from: "2026-09-02", to: "2026-09-02"
    });
    expect(result.cells[81].value).toBe(1);
    expect(result.cells[84].value).toBeNull();
    expect(result.cells[87].value).toBeNull();
  });

  it("returns 168 ordered cells with summed energy, weighted brightness, DST repeats, zero, and missing values", async () => {
    const { service } = harness([
      fixture(fixtureIdentityId, [
        hourly("2026-11-01", 1, "0.75", 3_600, 20),
        hourly("2026-11-01", 1, "1.25", 3_600, 80),
        hourly("2026-11-03", 4, "0", 3_600, 0)
      ])
    ]);

    const energy = await service.getHeatmap(user, siteId, {
      scope: "fixture", identityId: fixtureIdentityId, metric: "energy", from: "2026-11-01", to: "2026-11-07"
    });
    const brightness = await service.getHeatmap(user, siteId, {
      scope: "fixture", identityId: fixtureIdentityId, metric: "brightness", from: "2026-11-01", to: "2026-11-07"
    });

    expect(energy.cells).toHaveLength(168);
    expect(energy.cells[0]).toEqual({ weekday: 0, hour: 0, value: null });
    expect(energy.cells[1]).toEqual({ weekday: 0, hour: 1, value: 2 });
    expect(energy.cells[52]).toEqual({ weekday: 2, hour: 4, value: 0 });
    expect(energy.cells.at(-1)).toEqual({ weekday: 6, hour: 23, value: null });
    expect(brightness.cells[1]).toEqual({ weekday: 0, hour: 1, value: 50 });
    expect(brightness.cells[52]).toEqual({ weekday: 2, hour: 4, value: 0 });
    expect(energyHeatmapResponseSchema.safeParse(energy).success).toBe(true);
  });

  it("uses fixture, floor, and group dimension history that was valid at each aggregate date", async () => {
    const selected = fixture(fixtureIdentityId, [
      hourly("2026-11-01", 3, "1", 3_600, 25),
      hourly("2026-11-03", 3, "2", 3_600, 25)
    ], [{ floorId, effectiveFrom: "2026-11-02T05:00:00.000Z" }], [{ groupId: groupIdentityId, effectiveFrom: "2026-11-02T05:00:00.000Z" }]);
    const other = fixture(
      otherFixtureIdentityId,
      [hourly("2026-11-03", 3, "4", 3_600, 50)],
      [{ floorId: "31000000-0000-4000-8000-000000000006", effectiveFrom: "2026-01-01" }]
    );
    const { service } = harness([selected, other]);

    const fixtureResult = await service.getHeatmap(user, siteId, {
      scope: "fixture", identityId: fixtureIdentityId, metric: "energy", from: "2026-11-01", to: "2026-11-07"
    });
    const floorResult = await service.getHeatmap(user, siteId, {
      scope: "floor", identityId: floorId, metric: "energy", from: "2026-11-01", to: "2026-11-07"
    });
    const groupResult = await service.getHeatmap(user, siteId, {
      scope: "group", identityId: groupIdentityId, metric: "energy", from: "2026-11-01", to: "2026-11-07"
    });

    expect(fixtureResult.cells[3].value).toBe(1);
    expect(fixtureResult.cells[51].value).toBe(2);
    expect(floorResult.cells[3].value).toBeNull();
    expect(floorResult.cells[51].value).toBe(2);
    expect(groupResult.cells[3].value).toBeNull();
    expect(groupResult.cells[51].value).toBe(2);
  });

  it("authorizes site access before querying and conceals foreign identities", async () => {
    const { service, prisma, siteAccess } = harness([]);
    siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));

    await expect(service.getHeatmap(user, "31000000-0000-4000-8000-000000000099", {
      scope: "site", identityId: "31000000-0000-4000-8000-000000000099", metric: "energy", from: "2026-11-01", to: "2026-11-01"
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.site.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.energyFixtureIdentity.findMany).not.toHaveBeenCalled();

    const foreign = harness([]);
    await expect(foreign.service.getHeatmap(user, siteId, {
      scope: "fixture", identityId: otherFixtureIdentityId, metric: "energy", from: "2026-11-01", to: "2026-11-01"
    })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects unsupported metrics and ranges over 92 inclusive local dates", async () => {
    const { service, prisma } = harness([]);

    await expect(service.getHeatmap(user, siteId, {
      scope: "site", identityId: siteId, metric: "carbon", from: "2026-01-01", to: "2026-04-03"
    })).rejects.toThrow();
    expect(prisma.energyFixtureIdentity.findMany).not.toHaveBeenCalled();
  });

  it("delegates the endpoint query without bypassing the shared-contract service boundary", async () => {
    const heatmap = { getHeatmap: jest.fn().mockResolvedValue({ cells: [] }) };
    const controller = new EnergyController({} as never, heatmap as never);
    const query = { scope: "site", identityId: siteId, metric: "energy", from: "2026-11-01", to: "2026-11-01" };

    await expect(controller.getSiteHeatmap(user, siteId, query)).resolves.toEqual({ cells: [] });
    expect(heatmap.getHeatmap).toHaveBeenCalledWith(user, siteId, query);
  });
});

function hourly(localDate: string, localHour: number, estimatedKwh: string, knownSeconds: number, brightness: number) {
  return {
    bucketStartUtc: new Date(`${localDate}T${String(localHour + 5).padStart(2, "0")}:00:00.000Z`),
    localDate: new Date(`${localDate}T00:00:00.000Z`), localHour, estimatedKwh: new Prisma.Decimal(estimatedKwh), knownSeconds,
    unknownSeconds: 0, brightnessWeightedSeconds: new Prisma.Decimal(knownSeconds * brightness)
  };
}

function fixture(
  id: string,
  hourlyAggregates: ReturnType<typeof hourly>[],
  dimensionVersions: Array<{ floorId: string; effectiveFrom: string }> = [{ floorId, effectiveFrom: "2026-01-01" }],
  groupMemberships: Array<{ groupId: string; effectiveFrom: string }> = []
) {
  return {
    id, siteId, trackingStartedAt: new Date("2026-01-01T00:00:00.000Z"), retiredAt: null, hourlyAggregates,
    dimensionVersions: dimensionVersions.map((version) => ({
      floorId: version.floorId, effectiveFrom: effectiveDate(version.effectiveFrom), effectiveTo: null
    })),
    groupMemberships: groupMemberships.map((membership) => ({
      energyGroupId: membership.groupId, effectiveFrom: effectiveDate(membership.effectiveFrom), effectiveTo: null,
      energyGroup: {
        trackingStartedAt: effectiveDate(membership.effectiveFrom), retiredAt: null,
        dimensionVersions: [{ effectiveFrom: effectiveDate(membership.effectiveFrom), effectiveTo: null }]
      }
    }))
  };
}

function effectiveDate(value: string) {
  return new Date(value.includes("T") ? value : `${value}T00:00:00.000Z`);
}

function harness(identities: ReturnType<typeof fixture>[]) {
  const prisma = {
    site: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: siteId, timeZone: "America/New_York" }) },
    energyFixtureIdentity: {
      findFirst: jest.fn().mockImplementation(({ where }) => Promise.resolve(
        identities.some((identity) => identity.id === where.id) ? { id: where.id } : null
      )),
      findMany: jest.fn().mockResolvedValue(identities)
    },
    floor: { findFirst: jest.fn().mockResolvedValue({ id: floorId }) },
    energyGroupIdentity: { findFirst: jest.fn().mockResolvedValue({ id: groupIdentityId }) }
  };
  const siteAccess = { assert: jest.fn().mockResolvedValue({ id: siteId }) };
  return { service: new EnergyHeatmapService(prisma as never, siteAccess as never), prisma, siteAccess };
}
