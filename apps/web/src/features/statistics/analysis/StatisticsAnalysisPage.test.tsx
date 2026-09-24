import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatisticsAnalysisPage } from "./StatisticsAnalysisPage";

const mocks = vi.hoisted(() => ({ hook: vi.fn(), heatmap: vi.fn() }));
vi.mock("../../../api/energy", () => ({
  useEnergyRankings: (query: unknown) => mocks.hook(query),
  useEnergyHeatmap: (query: unknown) => mocks.heatmap(query)
}));

describe("StatisticsAnalysisPage", () => {
  afterEach(cleanup);
  beforeEach(() => {
    mocks.hook.mockReset();
    mocks.heatmap.mockReset();
    mocks.hook.mockReturnValue({ data: response, isLoading: false, isError: false, refetch: vi.fn() });
    mocks.heatmap.mockReturnValue({ data: heatmapResponse, isLoading: false, isError: false, refetch: vi.fn() });
  });

  it("shows ranked usage and opens a dimension detail", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "사용량 분석" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "사용량 순위" })).toHaveTextContent("B1 주차장");
    expect(screen.getByRole("complementary", { name: "B1 주차장 상세" })).toHaveTextContent("12.5 kWh");
    expect(screen.getByRole("img", { name: "B1 주차장 일별 사용량 차트" })).toBeInTheDocument();
  });

  it("labels the ranking selection as a site-local range separate from the completed heatmap window", () => {
    renderPage();

    expect(screen.getByText(/분석 선택 기간 2026-09-01 ~ 2026-09-10 · America\/Los_Angeles/)).toBeInTheDocument();
    expect(screen.getByText(/순위·상세에 적용/)).toBeInTheDocument();
    expect(screen.getByText(/히트맵은 별도 완료 기간/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "시간대별 사용량" })).toHaveTextContent("2026-08-14 ~ 2026-09-10");
    expect(screen.getByRole("complementary", { name: "B1 주차장 상세" })).toHaveTextContent("세로축 kWh");
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

  it("explains overlapping group totals and excluded legacy history", () => {
    mocks.hook.mockReturnValue({
      data: { ...response, dimension: "group", overlappingMemberships: true, legacyExcludedBefore: "2026-09-01" },
      isLoading: false, isError: false, refetch: vi.fn()
    });
    renderPage();

    expect(screen.getByText(/그룹 중복 소속/)).toBeInTheDocument();
    expect(screen.getByText(/2026-09-01 이전 구조 이력/)).toBeInTheDocument();
  });

  it("only enables the first heatmap request after resolving its site-local 28 completed-day window", async () => {
    renderPage();

    await waitFor(() => expect(mocks.heatmap).toHaveBeenCalled());
    expect(mocks.heatmap.mock.calls.map(([request]) => request)).toEqual([expect.objectContaining({
      enabled: true, siteId: response.siteId, scope: "floor", identityId: response.ranked[0].identityId,
      metric: "energy", from: "2026-08-12", to: "2026-09-08"
    })]);
    fireEvent.click(screen.getByRole("button", { name: "그룹" }));
    await waitFor(() => expect(mocks.heatmap).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "group" })));
  });
});

function renderPage() {
  return render(
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
  range: { from: "2026-09-01", to: "2026-09-10" },
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
      { period: "2026-09-09", estimatedKwh: 1.2, dataStatus: "available" },
      { period: "2026-09-10", estimatedKwh: 1.3, dataStatus: "available" }
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
  range: { from: "2026-08-14", to: "2026-09-10" },
  cells: Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24, value: 1 }))
};
