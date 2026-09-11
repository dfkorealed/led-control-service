import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatisticsAnalysisPage } from "./StatisticsAnalysisPage";

const mocks = vi.hoisted(() => ({ hook: vi.fn() }));
vi.mock("../../../api/energy", () => ({ useEnergyRankings: (query: unknown) => mocks.hook(query) }));

describe("StatisticsAnalysisPage", () => {
  afterEach(cleanup);
  beforeEach(() => {
    mocks.hook.mockReset();
    mocks.hook.mockReturnValue({ data: response, isLoading: false, isError: false, refetch: vi.fn() });
  });

  it("shows ranked usage and opens a dimension detail", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "사용량 분석" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "사용량 순위" })).toHaveTextContent("B1 주차장");
    expect(screen.getByRole("complementary", { name: "B1 주차장 상세" })).toHaveTextContent("12.5 kWh");
    expect(screen.getByRole("img", { name: "B1 주차장 일별 사용량 차트" })).toBeInTheDocument();
  });

  it("changes dimension and metric through accessible controls", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "그룹" }));
    fireEvent.change(screen.getByLabelText("순위 기준"), { target: { value: "per_fixture_average" } });

    expect(mocks.hook).toHaveBeenLastCalledWith(expect.objectContaining({
      siteId: response.siteId, dimension: "group", metric: "per_fixture_average"
    }));
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

const response = {
  siteId: "30000000-0000-4000-8000-000000000001",
  timeZone: "Asia/Seoul",
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
