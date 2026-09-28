import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockDashboard } from "../../../test/fixtures";
import { FloorPlanSettingsView } from "./FloorPlanSettingsView";

const useDashboard = vi.hoisted(() => vi.fn());

vi.mock("../../../api/queries", () => ({ useDashboard }));

describe("FloorPlanSettingsView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("links an admin to the floor editor while preserving siteId", async () => {
    const dashboard = { ...mockDashboard, floors: [{ ...mockDashboard.floors[0], mapConfigured: true }] };
    useDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null });

    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-2"]}>
        <Routes>
          <Route path="/settings/floor-plans" element={<FloorPlanSettingsView siteId="site-2" capabilities={{ read: true, control: true, manage: true, commission: true }} />} />
          <Route path="/settings/floor-plans/:floorId/edit" element={<h2>B2 맵 편집</h2>} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("B2")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "맵 관리" })).toBeInTheDocument();
    expect(screen.getByText("맵 설정됨")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "B2 맵 편집" })).toHaveAttribute(
      "href",
      `/settings/floor-plans/${dashboard.floors[0].id}/edit?siteId=site-2`
    );

    fireEvent.click(screen.getByRole("link", { name: "B2 맵 편집" }));

    expect(await screen.findByRole("heading", { name: "B2 맵 편집" })).toBeInTheDocument();
  });

  it("keeps the floor-plan list read only without manage capability", async () => {
    const dashboard = { ...mockDashboard, floors: [{ ...mockDashboard.floors[0], mapConfigured: true }] };
    useDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null });

    render(
      <MemoryRouter>
        <FloorPlanSettingsView capabilities={{ read: true, control: true, manage: false, commission: false }} />
      </MemoryRouter>
    );

    expect(await screen.findByText("B2")).toBeInTheDocument();
    expect(screen.getByText("맵 설정됨")).toBeInTheDocument();
    expect(screen.getByText("읽기 전용")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "B2 맵 편집" })).not.toBeInTheDocument();
  });

  it("mapConfigured와 층 요약만 사용하고 초기화된 맵을 설정됨으로 오인하지 않는다", () => {
    const floor = mockDashboard.floors[0];
    const dashboard = { ...mockDashboard, floors: [
      { ...floor, floorPlan: null, mapConfigured: true, mapRevision: 4, summary: { totalFixtures: 1000, onlineFixtures: 500, faultFixtures: 0, offlineFixtures: 500 } },
      { ...floor, id: "floor-reset", name: "B1", floorPlan: null, mapConfigured: false, mapRevision: 5, summary: { totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, offlineFixtures: 0 } }
    ] };
    useDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null });
    render(<MemoryRouter><FloorPlanSettingsView siteId={dashboard.site.id} capabilities={{ read: true, control: true, manage: true, commission: true }} /></MemoryRouter>);

    const cards = screen.getAllByTestId("floor-plan-item");
    expect(cards[0]).toHaveTextContent("맵 설정됨");
    expect(cards[0]).toHaveTextContent("조명 1,000개");
    expect(cards[0]).toHaveTextContent("리비전 4");
    expect(cards[1]).toHaveTextContent("맵 미설정");
    expect(cards[1]).toHaveTextContent("리비전 5");
  });

  it("층이 없으면 샘플 카드 대신 빈 상태를 보여준다", () => {
    const dashboard = { ...mockDashboard, floors: [] };
    useDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null });
    render(<MemoryRouter><FloorPlanSettingsView siteId={dashboard.site.id} capabilities={{ read: true, control: true, manage: true, commission: true }} /></MemoryRouter>);
    expect(screen.getByText("등록된 층이 없습니다.")).toBeInTheDocument();
    expect(screen.queryByTestId("floor-plan-item")).not.toBeInTheDocument();
  });
});
