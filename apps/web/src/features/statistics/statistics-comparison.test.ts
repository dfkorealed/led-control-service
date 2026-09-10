import type { EnergyComparisonResponse } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import { comparisonPresentation } from "./statistics-comparison";

type Summary = EnergyComparisonResponse["summary"];

describe("comparisonPresentation", () => {
  it("uses the API savings values without recalculating them", () => {
    const presentation = comparisonPresentation(summary({
      baselineKwh: 100,
      estimatedKwh: 80,
      savingsKwh: 35,
      savingsCost: 5_600,
      savingsRatePercent: 12.34,
      outcome: "saving"
    }));

    expect(presentation).toEqual({
      label: "에너지 절감률",
      tone: "success",
      ratePercent: 12.34,
      savingsKwh: 35,
      savingsCost: 5_600,
      description: "24시간 100% 기준 대비 절감"
    });
  });

  it("labels negative savings as overuse instead of clamping them", () => {
    expect(comparisonPresentation(summary({
      estimatedKwh: 110,
      savingsKwh: -10,
      savingsCost: -1_600,
      savingsRatePercent: -10,
      outcome: "overuse"
    }))).toEqual({
      label: "기준 대비 초과 사용",
      tone: "danger",
      ratePercent: -10,
      savingsKwh: -10,
      savingsCost: -1_600,
      description: "24시간 100% 기준보다 많이 사용"
    });
  });

  it("explains unavailable forecasts without creating zero savings", () => {
    expect(comparisonPresentation(summary({
      estimatedKwh: null,
      savingsKwh: null,
      savingsCost: null,
      savingsRatePercent: null,
      outcome: "unavailable",
      forecastReason: "insufficient_state"
    }))).toEqual({
      label: "에너지 절감률",
      tone: "neutral",
      ratePercent: null,
      savingsKwh: null,
      savingsCost: null,
      description: "조명별 1시간 이상, 현장 수집률 80% 이상이 필요합니다."
    });
  });
});

function summary(overrides: Partial<Summary>): Summary {
  return {
    baselineKwh: 100,
    estimatedKwh: 65,
    savingsKwh: 35,
    savingsCost: 5_600,
    savingsRatePercent: 35,
    outcome: "saving",
    forecastReason: "available",
    ...overrides
  } as Summary;
}
