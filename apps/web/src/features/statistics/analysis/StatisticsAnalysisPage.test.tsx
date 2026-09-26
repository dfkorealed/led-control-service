import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatisticsAnalysisPage } from "./StatisticsAnalysisPage";

const mocks = vi.hoisted(() => ({ hook: vi.fn(), heatmap: vi.fn(), summary: vi.fn() }));
vi.mock("../../../api/energy", () => ({
  useEnergySummary: () => mocks.summary(),
  useEnergyRankings: (query: unknown) => mocks.hook(query),
  useEnergyObservedMeanHeatmap: (query: unknown) => mocks.heatmap(query)
}));

describe("StatisticsAnalysisPage", () => {
  afterEach(cleanup);
  beforeEach(() => {
    mocks.hook.mockReset();
    mocks.heatmap.mockReset();
    mocks.summary.mockReset();
    mocks.summary.mockReturnValue({ data: { generatedAt: response.generatedAt, timeZone: response.timeZone }, isLoading: false, isError: false, refetch: vi.fn() });
    mocks.hook.mockImplementation((request: { dimension: string; metric: string; sort: string }) => ({
      data: { ...response, dimension: request.dimension, metric: request.metric, sort: request.sort },
      isLoading: false, isError: false, refetch: vi.fn()
    }));
    mocks.heatmap.mockReturnValue({ data: heatmapResponse, isLoading: false, isError: false, refetch: vi.fn() });
  });

  it("shows ranked usage and opens a dimension detail", () => {
    renderPage();

    expect(screen.queryByRole("heading", { name: "사용량 분석" })).not.toBeInTheDocument();
    expect(screen.queryByText("분석 기준")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "사용량 순위" })).toHaveTextContent("B1 주차장");
    expect(screen.getByRole("complementary", { name: "B1 주차장 상세" })).toHaveTextContent("12.5 kWh");
    expect(screen.getByRole("img", { name: "B1 주차장 일별 사용량 차트" })).toBeInTheDocument();
  });

  it("retains the available ranking and completed heatmap data without a redundant context strip", () => {
    renderPage();

    expect(screen.queryByText(/분석 선택 기간 2026-09-01 ~ 2026-09-10/)).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "시작일" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "종료일" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "시간대별 사용량" })).toHaveTextContent("2026-09-01 ~ 2026-09-08");
    expect(screen.getByRole("complementary", { name: "B1 주차장 상세" })).toHaveTextContent("세로축 kWh");
  });

  it("does not present a response for another completed period under the selected dates", () => {
    mocks.hook.mockReturnValue({
      data: { ...response, range: { from: "2026-08-01", to: "2026-08-31" } },
      isLoading: false, isError: false, refetch: vi.fn()
    });
    renderPage();

    expect(screen.queryByRole("group", { name: "현장 사용량" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "사용량 순위" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "B1 주차장 상세" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "시간대별 사용량" })).not.toBeInTheDocument();
    expect(screen.getByText("선택 기간의 분석 응답이 일치하지 않습니다.")).toBeInTheDocument();
  });

  it("does not present an old heatmap beneath a matching ranking", () => {
    mocks.heatmap.mockReturnValue({
      data: { ...heatmapResponse, range: { from: "2026-08-01", to: "2026-08-31" } },
      isLoading: false, isError: false, refetch: vi.fn()
    });
    renderPage();

    expect(screen.getByRole("group", { name: "현장 사용량" })).toHaveTextContent("20 kWh");
    expect(screen.queryByRole("region", { name: "시간대별 사용량" })).not.toBeInTheDocument();
    expect(screen.getByText("시간대별 사용량을 불러오지 못했습니다.")).toBeInTheDocument();
  });

  it("hides same-period cached results after a background refresh fails", () => {
    const view = renderPage();
    expect(screen.getByRole("group", { name: "현장 사용량" })).toHaveTextContent("20 kWh");
    expect(screen.getByRole("region", { name: "시간대별 사용량" })).toBeInTheDocument();

    const refetch = vi.fn();
    mocks.hook.mockReturnValue({ data: response, isLoading: false, isError: true, refetch });
    view.rerender(analysisPage());

    expect(screen.getByText("사용량 분석을 불러오지 못했습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "현장 사용량" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "사용량 순위" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "B1 주차장 상세" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "시간대별 사용량" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("changes dimension and metric through accessible controls", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "그룹" }));
    await chooseSelect("순위 기준", "조명당 평균");

    expect(mocks.hook).toHaveBeenLastCalledWith(expect.objectContaining({
      siteId: response.siteId, dimension: "group", metric: "per_fixture_average"
    }));
  });

  it("exposes ranking filters through design-system selectors and date pickers", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "순위 기준" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "시작일" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "종료일" })).toBeInTheDocument();
  });

  it("labels persisted ranking costs with their historical tariff basis", async () => {
    renderPage();

    expect(screen.getAllByRole("group", { name: "저장 비용" })).toHaveLength(2);
    expect(screen.getByText("비용 합계와 순위는 당시 적용 단가의 저장 비용입니다.")).toBeInTheDocument();
    await chooseSelect("순위 기준", "저장 비용");
    expect(screen.getByRole("region", { name: "사용량 순위" })).toHaveTextContent(
      "당시 적용 단가의 저장 비용"
    );
  });

  it("keeps overlapping group and excluded legacy explanations in contextual warnings", async () => {
    mocks.hook.mockReturnValue({
      data: { ...response, overlappingMemberships: true, legacyExcludedBefore: "2026-09-01" },
      isLoading: false, isError: false, refetch: vi.fn()
    });
    renderPage();

    expect(screen.queryByText(/그룹 중복 소속 조명은 각 그룹에 포함됩니다/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "그룹 중복 안내" }));
    const overlapDetails = await screen.findByRole("dialog", { name: "그룹 중복 안내" });
    expect(overlapDetails).toHaveTextContent("그룹 합계는 현장 총계와 다를 수 있습니다.");
    fireEvent.keyDown(overlapDetails, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "그룹 중복 안내" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "과거 이력 제외 안내" }));
    expect(await screen.findByRole("dialog", { name: "과거 이력 제외 안내" })).toHaveTextContent("2026-09-01 이전 구조 이력은 순위에서 제외하고 현장 총계에만 포함했습니다.");
  });

  it("uses the same site-local completed date range for rankings and observed mean heatmap", async () => {
    renderPage();

    await waitFor(() => expect(mocks.heatmap).toHaveBeenCalled());
    expect(mocks.heatmap.mock.calls.map(([request]) => request)).toEqual([expect.objectContaining({
      enabled: true, siteId: response.siteId, scope: "floor", identityId: response.ranked[0].identityId,
      metric: "energy", from: "2026-09-01", to: "2026-09-08"
    })]);
    expect(mocks.hook).toHaveBeenCalledWith(expect.objectContaining({ from: "2026-09-01", to: "2026-09-08" }));
    fireEvent.click(screen.getByRole("button", { name: "그룹" }));
    await waitFor(() => expect(mocks.heatmap).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "group" })));
  });
});

function renderPage() {
  return render(analysisPage());
}

function analysisPage() {
  return (
    <MemoryRouter initialEntries={["/statistics/analysis"]}>
      <Routes>
        <Route path="/statistics" element={<Outlet context={{ siteId: response.siteId }} />}>
          <Route path="analysis" element={<StatisticsAnalysisPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

async function chooseSelect(label: string, option: string) {
  const trigger = screen.getByRole("button", { name: label });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const choice = await screen.findByRole("option", { name: option });
  fireEvent.keyDown(choice, { key: "Enter" });
  fireEvent.keyUp(document.activeElement!, { key: "Enter" });
}

const response = {
  siteId: "30000000-0000-4000-8000-000000000001",
  timeZone: "America/Los_Angeles",
  source: "state_based_estimate",
  generatedAt: "2026-09-10T03:00:00.000Z",
  dimension: "floor",
  metric: "usage",
  sort: "desc",
  range: { from: "2026-09-01", to: "2026-09-08" },
  siteTotalKwh: 20,
  siteTotalCost: 3200,
  overlappingMemberships: false,
  legacyExcludedBefore: null,
  ranked: [{
    identityId: "30000000-0000-4000-8000-000000000020",
    operationalId: "30000000-0000-4000-8000-000000000020",
    name: "B1 주차장",
    rank: 1,
    fixtureCount: 8,
    estimatedKwh: 12.5,
    estimatedCost: 2000,
    contributionRate: 0.625,
    perFixtureAverageKwh: 1.5625,
    metricValue: 12.5,
    knownSeconds: 691200,
    unknownSeconds: 0,
    coverageRate: 1,
    dataStatus: "available",
    historyQuality: "observed",
    unrankedReason: null,
    previousPeriod: { estimatedKwh: 14, changeRatePercent: -10.71, rank: 1 },
    dailyPoints: [
      { period: "2026-09-07", estimatedKwh: 1.2, dataStatus: "available" },
      { period: "2026-09-08", estimatedKwh: 1.3, dataStatus: "available" }
    ],
    fixtures: [{ identityId: "30000000-0000-4000-8000-000000000002", name: "B1-L01", estimatedKwh: 2.1 }]
  }],
  unranked: []
} as const;

const heatmapResponse = {
  siteId: response.siteId,
  timeZone: "Asia/Seoul",
  generatedAt: "2026-09-11T03:00:00.000Z",
  metric: "energy" as const,
  scope: "floor" as const,
  identityId: response.ranked[0].identityId,
  range: { from: "2026-09-01", to: "2026-09-08" },
  cells: Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24, value: 1,
    knownSeconds: 3600, expectedSeconds: 3600, observedLocalDays: 1, eligibleLocalDays: 1, coverageRate: 1 }))
};
