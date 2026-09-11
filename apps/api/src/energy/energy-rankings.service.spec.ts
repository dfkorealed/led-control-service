import { Prisma } from "@prisma/client";
import { NotFoundException } from "@nestjs/common";
import { energyRankingResponseSchema } from "@led-control/shared";
import { EnergyRankingsService } from "./energy-rankings.service";

const siteId = "30000000-0000-4000-8000-000000000001";
const user = { id: "user", organizationId: "org", organizationType: "customer", role: "admin" } as never;

describe("EnergyRankingsService", () => {
  it("sorts fixture usage, calculates contribution, and separates low coverage", async () => {
    const { service } = harness([
      identity("30000000-0000-4000-8000-000000000002", "30000000-0000-4000-8000-000000000012", "L-01", 2, 7_200, 0),
      identity("30000000-0000-4000-8000-000000000003", "30000000-0000-4000-8000-000000000013", "L-02", 1, 1_000, 1_000)
    ]);

    const result = await service.getRankings(user, siteId, {
      dimension: "fixture", metric: "usage", sort: "desc", limit: "10",
      from: "2026-09-01", to: "2026-09-02"
    });

    expect(result.siteTotalKwh).toBe(3);
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0]).toMatchObject({ name: "L-01", rank: 1, metricValue: 2, contributionRate: 0.6667 });
    expect(result.unranked[0]).toMatchObject({ name: "L-02", unrankedReason: "insufficient_coverage", metricValue: null });
    expect(energyRankingResponseSchema.safeParse(result).success).toBe(true);
  });

  it("marks pre-history dimensions unranked while preserving the site total", async () => {
    const legacy = identity(
      "30000000-0000-4000-8000-000000000002",
      "30000000-0000-4000-8000-000000000012",
      "L-01", 2, 7_200, 0
    );
    legacy.trackingStartedAt = new Date("2026-09-02T00:00:00.000Z");
    const { service } = harness([legacy]);

    const result = await service.getRankings(user, siteId, {
      dimension: "fixture", metric: "usage", sort: "desc", limit: 10,
      from: "2026-09-01", to: "2026-09-02"
    });

    expect(result.siteTotalKwh).toBe(2);
    expect(result.ranked).toEqual([]);
    expect(result.unranked[0]).toMatchObject({ historyQuality: "legacy_structure_unknown", unrankedReason: "legacy_structure_unknown" });
    expect(result.legacyExcludedBefore).toBe("2026-09-02");
  });

  it("ranks overlapping groups by per-fixture average without redefining the site total", async () => {
    const fixtures = [
      identity("30000000-0000-4000-8000-000000000002", "30000000-0000-4000-8000-000000000012", "L-01", 2, 7_200, 0),
      identity("30000000-0000-4000-8000-000000000003", "30000000-0000-4000-8000-000000000013", "L-02", 1, 7_200, 0)
    ];
    const group = {
      id: "30000000-0000-4000-8000-000000000030",
      groupId: "30000000-0000-4000-8000-000000000031",
      trackingStartedAt: new Date("2026-09-01T00:00:00.000Z"),
      dimensionVersions: [{ name: "출입구", effectiveFrom: new Date("2026-09-01T00:00:00.000Z"), effectiveTo: null }],
      memberships: fixtures.map((fixture) => ({
        energyFixtureId: fixture.id, effectiveFrom: new Date("2026-09-01T00:00:00.000Z"), effectiveTo: null
      }))
    };
    const { service } = harness(fixtures, [group]);

    const result = await service.getRankings(user, siteId, {
      dimension: "group", metric: "per_fixture_average", sort: "desc", limit: 10,
      from: "2026-09-01", to: "2026-09-02"
    });

    expect(result.overlappingMemberships).toBe(true);
    expect(result.siteTotalKwh).toBe(3);
    expect(result.ranked[0]).toMatchObject({ name: "출입구", fixtureCount: 2, metricValue: 1.5 });
  });

  it("asserts tenant access before reading site analytics", async () => {
    const { service, prisma, siteAccess } = harness([]);
    siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));

    await expect(service.getRankings(user, "foreign", {
      dimension: "fixture", metric: "usage", sort: "desc", limit: 10,
      from: "2026-09-01", to: "2026-09-02"
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.site.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("rejects unbounded or unknown query input through the shared contract", async () => {
    const { service } = harness([]);
    await expect(service.getRankings(user, siteId, {
      dimension: "fixture", metric: "usage", sort: "desc", limit: 101,
      from: "2025-01-01", to: "2026-09-02", unexpected: true
    })).rejects.toThrow();
  });
});

function identity(identityId: string, fixtureId: string, name: string, kwh: number, known: number, unknown: number) {
  return {
    id: identityId,
    fixtureId,
    trackingStartedAt: new Date("2026-09-01T00:00:00.000Z"),
    retiredAt: null,
    dimensionVersions: [{
      id: `${identityId}-dimension`, name, floorId: "30000000-0000-4000-8000-000000000020",
      floorName: "B1", ratedWatt: new Prisma.Decimal(40), effectiveFrom: new Date("2026-09-01T00:00:00.000Z"), effectiveTo: null
    }],
    dailyAggregates: [{
      localDate: new Date("2026-09-01T00:00:00.000Z"), estimatedKwh: new Prisma.Decimal(kwh),
      estimatedCost: new Prisma.Decimal(kwh * 160), knownSeconds: known, unknownSeconds: unknown
    }],
    groupMemberships: []
  };
}

function harness(identities: ReturnType<typeof identity>[], groups: unknown[] = []) {
  const prisma = {
    site: { findUniqueOrThrow: jest.fn().mockResolvedValue({ timeZone: "UTC", tariffKwhRate: new Prisma.Decimal(160) }) },
    energyFixtureIdentity: { findMany: jest.fn().mockResolvedValue(identities) },
    energyGroupIdentity: { findMany: jest.fn().mockResolvedValue(groups) }
  };
  const siteAccess = { assert: jest.fn().mockResolvedValue({ id: siteId }) };
  return { service: new EnergyRankingsService(prisma as never, siteAccess as never), prisma, siteAccess };
}
