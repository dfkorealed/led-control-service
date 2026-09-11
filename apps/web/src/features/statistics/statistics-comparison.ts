import type { EnergyComparisonResponse } from "@led-control/shared";

type ComparisonSummary = EnergyComparisonResponse["summary"];

export interface ComparisonPresentation {
  label: string;
  tone: "success" | "danger" | "neutral";
  ratePercent: number | null;
  savingsKwh: number | null;
  savingsCost: number | null;
  description: string;
}

export function comparisonPresentation(summary: ComparisonSummary): ComparisonPresentation {
  const values = {
    ratePercent: summary.savingsRatePercent,
    savingsKwh: summary.savingsKwh,
    savingsCost: summary.savingsCost
  };
  if (summary.outcome === "saving") {
    return {
      label: "에너지 절감률",
      tone: "success",
      ...values,
      description: "24시간 100% 기준 대비 절감"
    };
  }
  if (summary.outcome === "overuse") {
    return {
      label: "기준 대비 초과 사용",
      tone: "danger",
      ...values,
      description: "24시간 100% 기준보다 많이 사용"
    };
  }
  return {
    label: "에너지 절감률",
    tone: "neutral",
    ...values,
    description: unavailableDescription(summary.forecastReason)
  };
}

function unavailableDescription(reason: ComparisonSummary["forecastReason"]) {
  if (reason === "no_registered_fixture") return "등록된 조명이 없어 절감률을 계산할 수 없습니다.";
  if (reason === "insufficient_state") return "조명별 1시간 이상, 현장 수집률 80% 이상이 필요합니다.";
  return "비교할 상태 기반 사용량 데이터가 없습니다.";
}
