import { describe, expect, it } from "vitest";
import {
  energyRankingQuerySchema,
  energyRankingResponseSchema
} from "./energy-analytics-contracts";

const rankedItem = {
  identityId: "11111111-1111-4111-8111-111111111111",
  operationalId: "22222222-2222-4222-8222-222222222222",
  name: "B2 입구",
  rank: 1,
  fixtureCount: 2,
  estimatedKwh: 24.5,
  estimatedCost: 3920,
  contributionRate: 0.245,
  perFixtureAverageKwh: 12.25,
  metricValue: 24.5,
  knownSeconds: 1209600,
  unknownSeconds: 0,
  coverageRate: 1,
  dataStatus: "available" as const,
  historyQuality: "observed" as const,
  unrankedReason: null,
  previousPeriod: { estimatedKwh: 20, changeRatePercent: 22.5, rank: 2 },
  dailyPoints: [{ period: "2026-09-10", estimatedKwh: 3.5, dataStatus: "available" as const }],
  fixtures: [{ identityId: "33333333-3333-4333-8333-333333333333", name: "입구등 01", estimatedKwh: 12.25 }]
};

describe("energy analytics contracts", () => {
  it("coerces and validates a bounded ranking query", () => {
    expect(energyRankingQuerySchema.parse({
      dimension: "floor",
      metric: "usage",
      from: "2026-09-01",
      to: "2026-09-10",
      sort: "desc",
      limit: "10"
    })).toEqual({
      dimension: "floor",
      metric: "usage",
      from: "2026-09-01",
      to: "2026-09-10",
      sort: "desc",
      limit: 10
    });
  });

  it("rejects inverted, oversized and non-strict ranking queries", () => {
    expect(() => energyRankingQuerySchema.parse({
      dimension: "fixture", metric: "cost", from: "2026-09-11", to: "2026-09-10"
    })).toThrow();
    expect(() => energyRankingQuerySchema.parse({
      dimension: "fixture", metric: "cost", from: "2025-01-01", to: "2026-09-10"
    })).toThrow();
    expect(() => energyRankingQuerySchema.parse({
      dimension: "floor", metric: "usage", from: "2026-09-01", to: "2026-09-10", extra: true
    })).toThrow();
  });

  it("accepts ranked and explicitly unranked dimension results", () => {
    const result = energyRankingResponseSchema.parse({
      siteId: "00000000-0000-4000-8000-000000000003",
      timeZone: "Asia/Seoul",
      source: "state_based_estimate",
      generatedAt: "2026-09-11T00:00:00.000Z",
      dimension: "floor",
      metric: "usage",
      sort: "desc",
      range: { from: "2026-09-01", to: "2026-09-10" },
      siteTotalKwh: 100,
      siteTotalCost: 16000,
      overlappingMemberships: false,
      legacyExcludedBefore: "2026-09-01",
      ranked: [rankedItem],
      unranked: [{
        ...rankedItem,
        identityId: "44444444-4444-4444-8444-444444444444",
        rank: null,
        metricValue: null,
        dataStatus: "partial",
        coverageRate: 0.4,
        unrankedReason: "insufficient_coverage"
      }]
    });

    expect(result.ranked[0].rank).toBe(1);
    expect(result.unranked[0].unrankedReason).toBe("insufficient_coverage");
  });

  it("rejects ranked rows without a metric value", () => {
    expect(() => energyRankingResponseSchema.parse({
      siteId: "00000000-0000-4000-8000-000000000003",
      timeZone: "Asia/Seoul",
      source: "state_based_estimate",
      generatedAt: "2026-09-11T00:00:00.000Z",
      dimension: "floor",
      metric: "usage",
      sort: "desc",
      range: { from: "2026-09-01", to: "2026-09-10" },
      siteTotalKwh: 100,
      siteTotalCost: 16000,
      overlappingMemberships: false,
      legacyExcludedBefore: null,
      ranked: [{ ...rankedItem, metricValue: null }],
      unranked: []
    })).toThrow();
  });
});
