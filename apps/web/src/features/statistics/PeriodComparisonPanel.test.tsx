import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PeriodComparisonPanel } from "./PeriodComparisonPanel";
import { makeEnergyComparison } from "./statistics-test-fixtures";

describe("PeriodComparisonPanel", () => {
  afterEach(cleanup);

  it("shows prior-period changes, both coverage rates and the history limitation", () => {
    render(<PeriodComparisonPanel comparisons={makeEnergyComparison().priorComparisons} />);

    const period = screen.getByRole("group", { name: "직전 동기간 비교" });
    expect(period).toHaveTextContent("18.75% 감소");
    expect(period).toHaveTextContent("현재 수집률 92%");
    expect(period).toHaveTextContent("비교 기간 수집률 80%");
    expect(screen.getByText("조명 구성 변화 미보정")).toBeInTheDocument();
  });

  it("keeps an unavailable row empty instead of presenting a zero change", () => {
    const comparison = makeEnergyComparison();
    render(<PeriodComparisonPanel comparisons={comparison.priorComparisons.map((item) => (
      item.kind === "previous_year"
        ? { ...item, currentKwh: null, comparisonKwh: null, changeRatePercent: null }
        : item
    ))} />);

    const year = screen.getByRole("group", { name: "전년 동기간 비교" });
    expect(within(year).getByText("비교 가능한 사용량 데이터가 없습니다.")).toBeInTheDocument();
    expect(year).not.toHaveTextContent("0%");
  });
});
