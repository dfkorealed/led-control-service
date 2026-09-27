import { describe, expect, it } from "vitest";
import { energyRangeComparisonQuerySchema, energyRangeComparisonResponseSchema } from "./energy-range-contracts";

const response = {
  siteId: "00000000-0000-4000-8000-000000000001",
  timeZone: "Asia/Seoul",
  source: "state_based_estimate",
  generatedAt: "2026-09-25T00:00:00.000Z",
  selection: { kind: "custom", from: "2026-09-01", to: "2026-09-02" },
  range: { from: "2026-09-01", to: "2026-09-02", completedThrough: "2026-09-02" },
  summary: {
    baselineKwh: 10, estimatedKwh: 0, savingsKwh: 10, savingsCost: 1000,
    savingsRatePercent: 100, outcome: "saving", forecastReason: "not_applicable"
  },
  priorComparisons: [],
  points: [{
    period: "2026-09-01", baselineKwh: 5, estimatedKwh: 0, phase: "observed",
    knownSeconds: 86400, unknownSeconds: 0, coverageRate: 1, dataStatus: "available"
  }]
};

describe("custom range comparison contracts", () => {
  it("accepts 400 inclusive dates and rejects 401, reversed and impossible dates", () => {
    expect(energyRangeComparisonQuerySchema.safeParse({ from: "2026-09-25", to: "2026-09-25" }).success).toBe(true);
    expect(energyRangeComparisonQuerySchema.safeParse({ from: "2025-08-22", to: "2026-09-25" }).success).toBe(true);
    expect(energyRangeComparisonQuerySchema.safeParse({ from: "2025-08-21", to: "2026-09-25" }).success).toBe(false);
    expect(energyRangeComparisonQuerySchema.safeParse({ from: "2026-09-26", to: "2026-09-25" }).success).toBe(false);
    expect(energyRangeComparisonQuerySchema.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success).toBe(false);
    expect(energyRangeComparisonQuerySchema.safeParse({ from: "2026-09-25" }).success).toBe(false);
    expect(energyRangeComparisonQuerySchema.safeParse({ from: "2026-09-25", to: "2026-09-25", preset: "current_month" }).success).toBe(false);
  });

  it("keeps custom and no-forecast separate from preset responses", () => {
    expect(energyRangeComparisonResponseSchema.parse(response)).toEqual(response);
    expect(energyRangeComparisonResponseSchema.safeParse({ ...response, preset: "current_month" }).success).toBe(false);
    expect(energyRangeComparisonResponseSchema.safeParse({ ...response, summary: { ...response.summary, forecastReason: "available" } }).success).toBe(false);
  });

  it("preserves observed energy while leaving change rate null for incomplete coverage", () => {
    const prior = {
      kind: "previous_period", currentRange: { from: "2026-09-01", to: "2026-09-02" },
      comparisonRange: { from: "2026-08-30", to: "2026-08-31" },
      currentKwh: 1, comparisonKwh: 4, changeRatePercent: null,
      currentCoverageRate: 0.5, comparisonCoverageRate: 1,
      historyQuality: "legacy_structure_unknown"
    };
    expect(energyRangeComparisonResponseSchema.safeParse({ ...response, priorComparisons: [prior] }).success).toBe(true);
    expect(energyRangeComparisonResponseSchema.safeParse({ ...response, priorComparisons: [{ ...prior,
      currentCoverageRate: 1, changeRatePercent: null }] }).success).toBe(true);
    expect(energyRangeComparisonResponseSchema.safeParse({ ...response, priorComparisons: [{ ...prior,
      changeRatePercent: 50 }] }).success).toBe(false);
  });
});
