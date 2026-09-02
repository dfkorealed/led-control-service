import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EnergySeriesResponse, EnergySummary } from "@led-control/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatisticsView } from "./StatisticsView";
import { getEnergySeriesRanges } from "./statistics-periods";

const mocks = vi.hoisted(() => ({
  summary: {} as ReturnType<typeof queryResult>,
  day: {} as ReturnType<typeof queryResult>,
  month: {} as ReturnType<typeof queryResult>
}));

vi.mock("../../api/energy", () => ({
  useEnergySummary: () => mocks.summary,
  useEnergySeries: ({ granularity }: { granularity: "day" | "month" }) => mocks[granularity]
}));

function queryResult<T>(data?: T) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn()
  };
}

const summary: EnergySummary = {
  siteId: "00000000-0000-4000-8000-000000000003",
  timeZone: "Asia/Seoul",
  source: "state_based_estimate",
  generatedAt: "2026-08-26T00:00:00.000Z",
  today: { estimatedKwh: 4.25, estimatedCost: 680, knownSeconds: 43_200, unknownSeconds: 0, dataStatus: "available" },
  monthToDate: { estimatedKwh: 120.5, estimatedCost: 19_280, knownSeconds: 2_073_600, unknownSeconds: 7_200, dataStatus: "partial" },
  yearToDate: { estimatedKwh: 900, estimatedCost: 144_000, knownSeconds: 20_000_000, unknownSeconds: 7_200, dataStatus: "partial" },
  monthForecast: { estimatedKwh: 160, estimatedCost: 25_600, observedKnownSeconds: 2_073_600, reason: "available" },
  baseline24Hours: { estimatedKwh: 297.6, estimatedCost: 47_616, fixtureCount: 10, daysInMonth: 31 },
  estimatedSavings: { kwh: 137.6, cost: 22_016 },
  lastAggregatedAt: "2026-08-26T00:00:00.000Z"
};

const daySeries: EnergySeriesResponse = {
  siteId: summary.siteId,
  timeZone: summary.timeZone,
  source: "state_based_estimate",
  generatedAt: summary.generatedAt,
  granularity: "day",
  from: "2026-08-01",
  to: "2026-08-31",
  points: [
    { source: "state_based_estimate", period: "2026-08-25", estimatedKwh: 4.1, estimatedCost: 656, knownSeconds: 86_400, unknownSeconds: 0, dataStatus: "available" },
    { source: "state_based_estimate", period: "2026-08-26", estimatedKwh: 4.25, estimatedCost: 680, knownSeconds: 79_200, unknownSeconds: 7_200, dataStatus: "partial" },
    { source: "state_based_estimate", period: "2026-08-27", estimatedKwh: null, estimatedCost: null, knownSeconds: 0, unknownSeconds: 86_400, dataStatus: "no_data" }
  ]
};

const monthSeries: EnergySeriesResponse = {
  ...daySeries,
  granularity: "month",
  from: "2026-01-01",
  to: "2026-12-01",
  points: [
    { source: "state_based_estimate", period: "2026-07-01", estimatedKwh: 140, estimatedCost: 22_400, knownSeconds: 2_678_400, unknownSeconds: 0, dataStatus: "available" },
    { source: "state_based_estimate", period: "2026-08-01", estimatedKwh: 120.5, estimatedCost: 19_280, knownSeconds: 2_073_600, unknownSeconds: 7_200, dataStatus: "partial" }
  ]
};

function renderView() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <StatisticsView siteId={summary.siteId} />
    </QueryClientProvider>
  );
}

describe("StatisticsView", () => {
  beforeEach(() => {
    mocks.summary = queryResult(summary);
    mocks.day = queryResult(daySeries);
    mocks.month = queryResult(monthSeries);
  });

  afterEach(cleanup);

  it("derives the inclusive month and year ranges in the site timezone", () => {
    expect(getEnergySeriesRanges("2026-08-31T15:30:00.000Z", "Asia/Seoul")).toEqual({
      day: { from: "2026-09-01", to: "2026-09-30" },
      month: { from: "2026-01-01", to: "2026-12-01" }
    });
  });

  it("shows today, month and year estimates with coverage text", () => {
    renderView();

    expect(screen.getByRole("heading", { name: "에너지 리포트" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "오늘 전력 사용량" })).toHaveTextContent("4.25kWh");
    expect(screen.getByRole("group", { name: "이번 달 누적 전력 사용량" })).toHaveTextContent("120.5kWh");
    expect(screen.getByRole("group", { name: "올해 누적 전력 사용량" })).toHaveTextContent("900kWh");
    expect(screen.getByText("수집 완료")).toBeInTheDocument();
    expect(screen.getAllByText("수집 공백 있음")).toHaveLength(2);
    expect(screen.getByText("수집 공백이 있어 일부 기간은 추정값이 불완전할 수 있습니다.")).toBeInTheDocument();
  });

  it("uses the shared report hierarchy for estimates and the chart", () => {
    renderView();

    expect(screen.getByRole("heading", { name: "에너지 리포트" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "오늘 전력 사용량" })).toHaveTextContent("kWh");
    expect(screen.getByRole("group", { name: "이번 달 누적 전력 사용량" })).toHaveTextContent("원");
    expect(screen.getByText("상태 기반 추정")).toBeVisible();
    expect(screen.getByRole("img", { name: /상태 기반 추정 전력 사용량 꺾은선 차트/ })).toBeInTheDocument();
  });

  it("switches accessible day and month series without turning null points into zero", () => {
    renderView();

    expect(screen.getByRole("button", { name: "일별" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("2026년 8월 27일: 수집 데이터 없음")).toBeInTheDocument();
    expect(screen.queryByText("2026년 8월 27일: 0 kWh")).not.toBeInTheDocument();
    expect(screen.getByText(/2026년 8월 26일: 4.25 kWh, 680원, 수집 공백 2시간 0분/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "월별" }));
    expect(screen.getByRole("button", { name: "월별" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/2026년 7월: 140 kWh/)).toBeInTheDocument();
    expect(screen.queryByText(/2026년 8월 27일/)).not.toBeInTheDocument();
  });

  it("shows forecast, 24-hour baseline and unclamped savings", () => {
    mocks.summary = queryResult({
      ...summary,
      estimatedSavings: { kwh: -2.5, cost: -400 }
    });
    renderView();

    expect(screen.getByText("25,600원")).toBeInTheDocument();
    expect(screen.getByText("47,616원")).toBeInTheDocument();
    expect(screen.getByText("-2.5 kWh")).toBeInTheDocument();
    expect(screen.getByText("-400원")).toBeInTheDocument();
    expect(screen.getByText(/현재 등록 조명 10개 · 해당 월 31일 전체 · 24시간 · 100% 밝기 · 현재 단가 기준/)).toBeInTheDocument();
  });

  it("uses an empty state instead of zero KPIs when no state has been collected", () => {
    const noDataPeriod = { estimatedKwh: 0, estimatedCost: 0, knownSeconds: 0, unknownSeconds: 86_400, dataStatus: "no_data" as const };
    mocks.summary = queryResult({
      ...summary,
      today: noDataPeriod,
      monthToDate: noDataPeriod,
      yearToDate: noDataPeriod,
      monthForecast: { estimatedKwh: null, estimatedCost: null, observedKnownSeconds: 0, reason: "insufficient_state" as const },
      estimatedSavings: { kwh: null, cost: null }
    });
    renderView();

    expect(screen.getByText("아직 상태 기반 사용량을 표시할 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("조명 상태가 수집되면 통계가 표시됩니다.")).toBeInTheDocument();
    expect(screen.queryByText("0 kWh")).not.toBeInTheDocument();
  });

  it("explains why forecast and savings are unavailable", () => {
    mocks.summary = queryResult({
      ...summary,
      monthForecast: { estimatedKwh: null, estimatedCost: null, observedKnownSeconds: 900, reason: "insufficient_state" as const },
      estimatedSavings: { kwh: null, cost: null }
    });
    renderView();
    expect(screen.getByText("상태 수집 시간이 부족하여 예상 비용과 절감액을 계산할 수 없습니다.")).toBeInTheDocument();

    mocks.summary = queryResult({
      ...summary,
      monthForecast: { estimatedKwh: null, estimatedCost: null, observedKnownSeconds: 0, reason: "no_registered_fixture" as const },
      estimatedSavings: { kwh: null, cost: null }
    });
    const view = renderView();
    expect(screen.getByText("등록된 조명이 없어 예상 비용과 절감액을 계산할 수 없습니다.")).toBeInTheDocument();
    view.unmount();
  });

  it("retries summary errors and keeps KPI data visible for a series error", () => {
    const summaryRetry = vi.fn();
    mocks.summary = { ...queryResult<EnergySummary>(), isError: true, error: new Error("failed"), refetch: summaryRetry };
    const first = renderView();
    fireEvent.click(screen.getByRole("button", { name: "전력 통계 다시 시도" }));
    expect(summaryRetry).toHaveBeenCalledOnce();
    first.unmount();

    const seriesRetry = vi.fn();
    mocks.summary = queryResult(summary);
    mocks.day = { ...queryResult<EnergySeriesResponse>(), isError: true, error: new Error("failed"), refetch: seriesRetry };
    renderView();
    expect(screen.getByRole("group", { name: "오늘 전력 사용량" })).toHaveTextContent("4.25kWh");
    expect(screen.getByRole("alert")).toHaveTextContent("사용량 추이를 불러오지 못했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "사용량 추이 다시 시도" }));
    expect(seriesRetry).toHaveBeenCalledOnce();
  });
});
