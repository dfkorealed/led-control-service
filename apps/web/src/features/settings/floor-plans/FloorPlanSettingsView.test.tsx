import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockDashboard } from "../../../test/fixtures";
import { FloorPlanSettingsView } from "./FloorPlanSettingsView";

const { useDashboard, useFloorMapSnapshot } = vi.hoisted(() => ({ useDashboard: vi.fn(), useFloorMapSnapshot: vi.fn(() => ({ isLoading: true, refetch: vi.fn() })) }));

vi.mock("../../../api/queries", () => ({ useDashboard, useFloorMapSnapshot }));

describe("FloorPlanSettingsView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("only activates two visible configured previews and disables them offscreen", () => {
    let notify: IntersectionObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback) { notify = callback; } observe() {} disconnect = disconnect; });
    const floor = mockDashboard.floors[0];
    const dashboard = { ...mockDashboard, floors: [0, 1, 2].map(index => ({ ...floor, id: `floor-${index}`, name: `층 ${index}`, mapConfigured: true })) };
    useDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null });
    const { unmount } = render(<MemoryRouter><FloorPlanSettingsView siteId={dashboard.site.id} capabilities={{ read: true, control: false, manage: false, commission: false }} /></MemoryRouter>);
    const cards = screen.getAllByTestId("floor-plan-item");
    act(() => notify!(cards.map(target => ({ target, isIntersecting: true })) as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(screen.getAllByRole("img", { name: /도면 미리보기$/ })).toHaveLength(2);
    expect(useFloorMapSnapshot).toHaveBeenCalledWith("floor-0", dashboard.site.id);
    expect(useFloorMapSnapshot).not.toHaveBeenCalledWith("floor-2", dashboard.site.id);
    act(() => notify!([{ target: cards[0], isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(screen.queryByRole("img", { name: "층 0 도면 미리보기" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "층 2 도면 미리보기" })).toBeInTheDocument();
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("history preserves context while ordinary edit removes only editorPanel", () => {
    useDashboard.mockReturnValue({ data: { ...mockDashboard, floors: [{ ...mockDashboard.floors[0], mapConfigured: true }] }, isLoading: false, error: null });
    render(<MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-2&keep=value&editorPanel=other#draft"]}><FloorPlanSettingsView capabilities={{ read: true, control: true, manage: true, commission: true }} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "B2 변경 기록" })).toHaveAttribute("href", `/settings/floor-plans/${mockDashboard.floors[0].id}/edit?siteId=site-2&keep=value&editorPanel=details#draft`);
    expect(screen.getByRole("link", { name: "B2 맵 편집" })).toHaveAttribute("href", `/settings/floor-plans/${mockDashboard.floors[0].id}/edit?siteId=site-2&keep=value#draft`);
  });

  it("links an admin to the floor editor while preserving siteId", async () => {
    const dashboard = { ...mockDashboard, floors: [{ ...mockDashboard.floors[0], mapConfigured: true }] };
    useDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null });

    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-2&keep=value#draft"]}>
        <Routes>
          <Route path="/settings/floor-plans" element={<FloorPlanSettingsView siteId="site-2" capabilities={{ read: true, control: true, manage: true, commission: true }} />} />
          <Route path="/settings/floor-plans/:floorId/edit" element={<h2>B2 맵 편집</h2>} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("B2")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "맵 관리" })).not.toBeInTheDocument();
    expect(screen.getByText("맵 설정됨")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "B2 맵 편집" })).toHaveAttribute(
      "href",
      `/settings/floor-plans/${dashboard.floors[0].id}/edit?siteId=site-2&keep=value#draft`
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
