import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiGet } from "../../api/client";
import { useDashboard } from "../../api/queries";
import { mockDashboard } from "../../test/fixtures";
import { SettingsView } from "./SettingsView";

vi.mock("../../api/queries", () => ({ useDashboard: vi.fn() }));
vi.mock("./TestDataToolsPanel", () => ({ TestDataToolsPanel: () => null }));
vi.mock("../../api/client", async (original) => ({ ...await original<typeof import("../../api/client")>(), apiGet: vi.fn() }));

function withQueries(children: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

function renderSettings(gatewayCount: number, fixtureCount: number, role: "admin" | "viewer" = "admin", entry?: string) {
  const dashboard = structuredClone(mockDashboard);
  dashboard.gateways = dashboard.gateways.slice(0, gatewayCount);
  dashboard.summary.totalFixtures = fixtureCount;
  vi.mocked(useDashboard).mockReturnValue({ data: dashboard } as ReturnType<typeof useDashboard>);
  render(withQueries(<MemoryRouter initialEntries={[entry ?? `/settings?siteId=${dashboard.site.id}`]}>
    <SettingsView userRole={role} siteId={dashboard.site.id} capabilities={{ read: true, control: role === "admin", manage: role === "admin", commission: role === "admin" }} />
  </MemoryRouter>));
  return dashboard.site.id;
}

describe("SettingsView 설치 이어가기", () => {
  beforeEach(() => { vi.mocked(apiGet).mockResolvedValue({ users: [], count: 7, limit: 100 }); });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("provides one whole-card link per capability without nested actions", () => {
    const siteId = renderSettings(1, 4, "admin", `/settings?siteId=${mockDashboard.site.id}&mode=detail#card`);
    for (const [label, path] of [["현장 관리", "site"], ["유저 관리", "users"], ["조명 등록", "registration"], ["맵 관리", "floor-plans"], ["계정 보안", "security"]]) {
      const link = screen.getByRole("link", { name: label });
      expect(link).toHaveAttribute("href", `/settings/${path}?siteId=${siteId}&mode=detail#card`);
      expect(within(link).queryByRole("button")).not.toBeInTheDocument();
      expect(within(link).getByRole("heading", { name: label })).toBeInTheDocument();
    }
  });

  it("게이트웨이가 없으면 기존 등록 경로로 연결한다", () => {
    const siteId = renderSettings(0, 0);
    expect(screen.getByRole("region", { name: "설치 이어가기" })).toHaveTextContent("게이트웨이 연결");
    expect(screen.getByRole("link", { name: "게이트웨이 연결하기" })).toHaveAttribute("href", `/settings/registration?siteId=${siteId}`);
  });

  it("게이트웨이 연결 후 조명이 없으면 조명 등록으로 연결한다", () => {
    const siteId = renderSettings(1, 0);
    expect(screen.getByRole("link", { name: "조명 등록하기" })).toHaveAttribute("href", `/settings/registration?siteId=${siteId}`);
  });

  it("조명이 있으면 층별 맵 배치로 연결한다", () => {
    const siteId = renderSettings(1, 1);
    expect(screen.getByRole("link", { name: "조명 위치 배치하기" })).toHaveAttribute("href", `/settings/floor-plans?siteId=${siteId}`);
  });

  it("viewer에게 설치 변경 행동을 제공하지 않는다", () => {
    renderSettings(0, 0, "viewer");
    expect(screen.queryByRole("link", { name: "게이트웨이 연결하기" })).not.toBeInTheDocument();
  });

  it("오래된 URL의 현장 ID 대신 조회된 현장 ID로 이동한다", () => {
    const siteId = renderSettings(0, 0, "admin", "/settings?siteId=old-site");
    expect(screen.getByRole("link", { name: "게이트웨이 연결하기" })).toHaveAttribute("href", `/settings/registration?siteId=${siteId}`);
  });

  it("맵 설정 수는 floorPlan 유무가 아닌 mapConfigured 요약으로 계산한다", () => {
    const dashboard = structuredClone(mockDashboard);
    dashboard.floors = [
      { ...dashboard.floors[0], floorPlan: null, mapConfigured: true },
      { ...dashboard.floors[0], id: "floor-reset", name: "B1", floorPlan: null, mapRevision: 3, mapConfigured: false }
    ];
    vi.mocked(useDashboard).mockReturnValue({ data: dashboard } as ReturnType<typeof useDashboard>);
    render(withQueries(<MemoryRouter><SettingsView userRole="admin" siteId={dashboard.site.id} capabilities={{ read: true, control: true, manage: true, commission: true }} /></MemoryRouter>));
    expect(screen.getByRole("link", { name: "맵 관리" })).toHaveTextContent("2개 층");
    expect(screen.getByRole("link", { name: "맵 관리" })).toHaveTextContent("맵 설정 1개");
  });

  it.each([
    { manage: false, installationStatus: "installed" as const },
    { manage: false, installationStatus: "pending" as const },
    { manage: true, installationStatus: "pending" as const }
  ])("never issues users query for non-manager or pending site ($manage/$installationStatus)", async ({ manage, installationStatus }) => {
    const dashboard = { ...mockDashboard, site: { ...mockDashboard.site, installationStatus } };
    vi.mocked(useDashboard).mockReturnValue({ data: dashboard } as ReturnType<typeof useDashboard>);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><SettingsView userRole="viewer" siteId={dashboard.site.id} capabilities={{ read: true, control: false, manage, commission: false }} /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(apiGet).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "유저 관리" })).not.toBeInTheDocument();
  });

  it("reads the installed manager's actual site count and retains query/hash in all five card links", async () => {
    const siteId = renderSettings(1, 1000, "admin", `/settings?siteId=${mockDashboard.site.id}&mode=detail#card`);
    expect(await screen.findByText("사용자 7명")).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledOnce();
    expect(apiGet).toHaveBeenCalledWith(`/sites/${siteId}/users`);
    // The stable SettingsShell owns the single page heading.
    expect(screen.queryByRole("heading", { name: "설정" })).not.toBeInTheDocument();
    for (const [label, path] of [["현장 관리", "site"], ["유저 관리", "users"], ["조명 등록", "registration"], ["맵 관리", "floor-plans"], ["계정 보안", "security"]]) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", `/settings/${path}?siteId=${siteId}&mode=detail#card`);
    }
    expect(screen.queryByText(/MFA.*(?:꺼짐|OFF)/)).not.toBeInTheDocument();
  });
});
