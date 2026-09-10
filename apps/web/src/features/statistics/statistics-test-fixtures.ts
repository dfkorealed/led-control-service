import type { EnergyComparisonResponse } from "@led-control/shared";

export function makeEnergyComparison(
  overrides: Partial<EnergyComparisonResponse> = {}
): EnergyComparisonResponse {
  const base: EnergyComparisonResponse = {
    siteId: "00000000-0000-4000-8000-000000000003",
    timeZone: "Asia/Seoul",
    source: "state_based_estimate",
    generatedAt: "2026-09-10T03:00:00.000Z",
    preset: "current_month",
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
      outcome: "saving",
      forecastReason: "available"
    },
    priorComparisons: [
      {
        kind: "previous_period",
        currentRange: { from: "2026-09-01", to: "2026-09-09" },
        comparisonRange: { from: "2026-08-23", to: "2026-08-31" },
        currentKwh: 65,
        comparisonKwh: 80,
        changeRatePercent: -18.75,
        currentCoverageRate: 0.92,
        comparisonCoverageRate: 0.8,
        historyQuality: "legacy_structure_unknown"
      },
      {
        kind: "previous_year",
        currentRange: { from: "2026-09-01", to: "2026-09-09" },
        comparisonRange: { from: "2025-09-01", to: "2025-09-09" },
        currentKwh: 65,
        comparisonKwh: 70,
        changeRatePercent: -7.14,
        currentCoverageRate: 0.92,
        comparisonCoverageRate: 0.75,
        historyQuality: "legacy_structure_unknown"
      }
    ],
    points: [
      {
        period: "2026-09-01",
        baselineKwh: 100,
        estimatedKwh: 60,
        phase: "observed",
        knownSeconds: 79_488,
        unknownSeconds: 6_912,
        coverageRate: 0.92,
        dataStatus: "partial"
      },
      {
        period: "2026-09-02",
        baselineKwh: 100,
        estimatedKwh: 65,
        phase: "forecast",
        knownSeconds: 0,
        unknownSeconds: 86_400,
        coverageRate: null,
        dataStatus: "no_data"
      },
      {
        period: "2026-09-03",
        baselineKwh: 100,
        estimatedKwh: 62,
        phase: "forecast",
        knownSeconds: 0,
        unknownSeconds: 86_400,
        coverageRate: null,
        dataStatus: "no_data"
      },
      {
        period: "2026-09-04",
        baselineKwh: 100,
        estimatedKwh: null,
        phase: "unavailable",
        knownSeconds: 0,
        unknownSeconds: 86_400,
        coverageRate: null,
        dataStatus: "no_data"
      }
    ]
  };

  return {
    ...base,
    ...overrides,
    summary: { ...base.summary, ...overrides.summary }
  };
}
