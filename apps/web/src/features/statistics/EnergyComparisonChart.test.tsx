import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EnergyComparisonChart, comparisonChartData, forecastLineStyle } from "./EnergyComparisonChart";
import { makeEnergyComparison } from "./statistics-test-fixtures";

describe("EnergyComparisonChart", () => {
  afterEach(cleanup);

  it("keeps observed, forecast and unavailable values as separate series", () => {
    const data = comparisonChartData(makeEnergyComparison().points);

    expect(data).toEqual([
      expect.objectContaining({ observedKwh: 60, forecastKwh: null }),
      expect.objectContaining({ observedKwh: null, forecastKwh: 65 }),
      expect.objectContaining({ observedKwh: null, forecastKwh: 62 }),
      expect.objectContaining({ observedKwh: null, forecastKwh: null })
    ]);
  });

  it("renders forecast as a dashed series without connecting missing values", () => {
    render(<EnergyComparisonChart comparison={makeEnergyComparison()} />);

    expect(screen.getByRole("img", { name: "기준 대비 에너지 사용량 비교 차트" })).toBeInTheDocument();
    expect(forecastLineStyle).toEqual({ strokeDasharray: "4 4", connectNulls: false });
    expect(screen.getByText("24시간 100% · 현재 등록 조명 기준")).toBeInTheDocument();
  });

  it("provides baseline, estimate, difference and coverage to screen readers", () => {
    render(<EnergyComparisonChart comparison={makeEnergyComparison()} />);

    expect(screen.getByText("2026년 9월 2일: 기준 100 kWh, 예상 65 kWh, 절감 35 kWh, 절감률 35%, 수집률 산정 불가"))
      .toBeInTheDocument();
    expect(screen.getByText("2026년 9월 4일: 기준 100 kWh, 사용량 산정 불가, 수집률 산정 불가"))
      .toBeInTheDocument();
  });
});
