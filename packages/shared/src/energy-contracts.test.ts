import { describe, expect, it } from "vitest";
import {
  energyComparisonPointSchema,
  energyComparisonPresetSchema,
  energyComparisonResponseSchema
} from "./energy-contracts";

const validComparison = {
  siteId: "00000000-0000-4000-8000-000000000003",
  timeZone: "Asia/Seoul",
  source: "state_based_estimate" as const,
  generatedAt: "2026-09-10T03:00:00.000Z",
  preset: "current_month" as const,
  range: {
    from: "2026-09-01",
    to: "2026-09-30",
    completedThrough: "2026-09-09"
  },
  summary: {
    baselineKwh: 100,
    estimatedKwh: 65,
    savingsKwh: 35,
    savingsCost: 5_600,
    savingsRatePercent: 35,
    outcome: "saving" as const,
    forecastReason: "available" as const
  },
  priorComparisons: [{
    kind: "previous_period" as const,
    currentRange: { from: "2026-09-01", to: "2026-09-09" },
    comparisonRange: { from: "2026-08-01", to: "2026-08-09" },
    currentKwh: 18,
    comparisonKwh: 20,
    changeRatePercent: -10,
    currentCoverageRate: 0.9,
    comparisonCoverageRate: 0.85,
    historyQuality: "legacy_structure_unknown" as const
  }],
  points: [{
    period: "2026-09-01",
    baselineKwh: 4,
    estimatedKwh: 2.5,
    phase: "observed" as const,
    knownSeconds: 86_400,
    unknownSeconds: 0,
    coverageRate: 1,
    dataStatus: "available" as const
  }]
};

describe("energy comparison contracts", () => {
  it("accepts the three supported presets and rejects unknown presets", () => {
    expect(energyComparisonPresetSchema.options).toEqual(["last_7_days", "current_month", "current_year"]);
    expect(energyComparisonPresetSchema.safeParse("custom").success).toBe(false);
  });

  it("accepts a complete saving response and rejects unknown fields", () => {
    expect(energyComparisonResponseSchema.parse(validComparison).summary.savingsRatePercent).toBe(35);
    expect(energyComparisonResponseSchema.safeParse({ ...validComparison, unexpected: true }).success).toBe(false);
  });

  it("requires every saving value when the outcome is saving", () => {
    expect(energyComparisonResponseSchema.safeParse({
      ...validComparison,
      summary: { ...validComparison.summary, savingsRatePercent: null }
    }).success).toBe(false);
  });

  it("preserves negative savings when usage exceeds the baseline", () => {
    const parsed = energyComparisonResponseSchema.parse({
      ...validComparison,
      summary: {
        ...validComparison.summary,
        estimatedKwh: 110,
        savingsKwh: -10,
        savingsCost: -1_600,
        savingsRatePercent: -10,
        outcome: "overuse"
      }
    });

    expect(parsed.summary).toMatchObject({
      savingsKwh: -10,
      savingsCost: -1_600,
      savingsRatePercent: -10,
      outcome: "overuse"
    });
  });

  it("requires every savings value to be null when the outcome is unavailable", () => {
    expect(energyComparisonResponseSchema.parse({
      ...validComparison,
      summary: {
        ...validComparison.summary,
        estimatedKwh: null,
        savingsKwh: null,
        savingsCost: null,
        savingsRatePercent: null,
        outcome: "unavailable",
        forecastReason: "insufficient_state"
      }
    }).summary.outcome).toBe("unavailable");

    expect(energyComparisonResponseSchema.safeParse({
      ...validComparison,
      summary: {
        ...validComparison.summary,
        estimatedKwh: null,
        savingsKwh: 0,
        savingsCost: null,
        savingsRatePercent: null,
        outcome: "unavailable",
        forecastReason: "insufficient_state"
      }
    }).success).toBe(false);
  });

  it("keeps a missing point distinct from a real zero-use point", () => {
    expect(energyComparisonPointSchema.parse({
      period: "2026-09-02",
      baselineKwh: 4,
      estimatedKwh: null,
      phase: "unavailable",
      knownSeconds: 0,
      unknownSeconds: 86_400,
      coverageRate: 0,
      dataStatus: "partial"
    }).estimatedKwh).toBeNull();

    expect(energyComparisonPointSchema.parse({
      period: "2026-09-03",
      baselineKwh: 4,
      estimatedKwh: 0,
      phase: "observed",
      knownSeconds: 86_400,
      unknownSeconds: 0,
      coverageRate: 1,
      dataStatus: "available"
    }).estimatedKwh).toBe(0);
  });

  it("rejects invalid prior comparison coverage and history quality", () => {
    expect(energyComparisonResponseSchema.safeParse({
      ...validComparison,
      priorComparisons: [{
        ...validComparison.priorComparisons[0],
        comparisonCoverageRate: 1.01
      }]
    }).success).toBe(false);
    expect(energyComparisonResponseSchema.safeParse({
      ...validComparison,
      priorComparisons: [{
        ...validComparison.priorComparisons[0],
        historyQuality: "corrected"
      }]
    }).success).toBe(false);
  });
});
