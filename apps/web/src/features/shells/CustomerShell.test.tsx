import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../api/auth";
import { apiGet } from "../../api/client";
import { CustomerShell } from "./CustomerShell";

vi.mock("../settings/floor-plans/FloorEditorRoute", () => ({ FloorEditorRoute: () => <p>맵 편집 화면</p> }));
vi.mock("../monitoring/MonitoringView", () => ({ MonitoringView: () => <p>모니터링 화면</p> }));
vi.mock("../control/ControlView", () => ({ ControlView: () => <p>제어 화면</p> }));
vi.mock("../statistics/StatisticsOverviewPage", () => ({ StatisticsOverviewPage: () => <p>통계 화면</p> }));
vi.mock("../statistics/reports/StatisticsReportsPage", () => ({ StatisticsReportsPage: () => <p>보고서 화면</p> }));
vi.mock("../../api/client", async (original) => ({
  ...await original<typeof import("../../api/client")>(),
  apiGet: vi.fn()
}));
const dashboardState = vi.hoisted(() => ({
  current: {
    data: undefined as ReturnType<typeof dashboardFor> | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn()
  }
}));
vi.mock("../../api/queries", async (original) => ({
  ...await original<typeof import("../../api/queries")>(),
  useDashboard: () => dashboardState.current,
  useSites: () => ({ data: [] })
}));

const adminUser = {
  id: "admin",
  organizationId: "org",
  organizationType: "customer" as const,
  loginId: "admin",
  name: "관리자",
  role: "admin" as const,
  status: "active" as const,
  mustChangePassword: false
};

function dashboardFor(capabilities: { read: boolean; control: boolean; manage: boolean; commission: boolean }) {
  return {
    site: { id: "site", name: "현장", customerName: "고객사", installationStatus: "installed" as const, address: null, tariffKwhRate: 160, timeZone: "Asia/Seoul" },
    summary: { totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, averageBrightness: 0 },
    gateways: [],
    groups: [],
    floors: [{ id: "floor-b2", name: "B2", level: -2, floorPlan: null, meshControlGroups: [], fixtures: [] }, { id: "floor-b1", name: "B1", level: -1, floorPlan: null, meshControlGroups: [], fixtures: [] }],
    capabilities
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function renderShell(path: string, user: AuthUser = adminUser) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <CustomerShell user={user} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("customer shell site context", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset().mockResolvedValue({ users: [], count: 0, limit: 100 });
    dashboardState.current = { data: dashboardFor({ read: true, control: true, manage: true, commission: true }), isLoading: false, error: null, refetch: vi.fn() };
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("keeps navigation and logout available while password settings loads, then preserves its URL", async () => {
    renderShell("/settings/security?siteId=site&source=account#password");

    expect(within(screen.getByRole("main")).getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("navigation", { name: "주 메뉴" })).toBeVisible();
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeEnabled();
    expect(await screen.findByRole("heading", { name: "계정 보안" })).toBeVisible();
    expect(within(screen.getByRole("main")).queryByText("화면을 불러오는 중입니다.")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/security?siteId=site&source=account#password");
  });

  it("redirects a direct users URL without requesting protected user data when manage is denied", async () => {
    dashboardState.current.data = dashboardFor({ read: true, control: false, manage: false, commission: false });
    renderShell("/settings/users?siteId=site&source=direct", { ...adminUser, role: "viewer" });

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings?siteId=site&source=direct"));
    await screen.findByRole("navigation", { name: "설정 메뉴" });
    expect(screen.queryByRole("button", { name: "사용자 추가" })).not.toBeInTheDocument();
    expect(apiGet).not.toHaveBeenCalledWith("/sites/site/users");
  });

  it.each(["b1", "b2", "unknown"])("keeps the site badge independent of the %s editor route", (floor) => {
    renderShell(`/settings/floor-plans/floor-${floor}/edit?siteId=site`);
    expect(screen.getByTestId("active-site-badge")).toHaveTextContent("현장");
    expect(screen.queryByTestId("active-floor-badge")).not.toBeInTheDocument();
  });

  it("links the primary statistics item to overview and keeps it active on statistics child routes", async () => {
    renderShell("/statistics/overview?siteId=site");

    const statisticsLink = await screen.findByRole("link", { name: "통계" });
    expect(statisticsLink).toHaveAttribute("href", "/statistics/overview?siteId=site");
    expect(statisticsLink).toHaveClass("active");
  });

  it("preserves the selected site and hash in the legacy statistics redirect", async () => {
    renderShell("/statistics?siteId=site#summary");

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(
      "/statistics/overview?siteId=site#summary"
    ));
  });

  it("opens the released customer report route with the selected site", async () => {
    renderShell("/statistics/reports?siteId=site");

    expect(await screen.findByText("보고서 화면")).toBeInTheDocument();
  });

  it("does not render a viewer control route before dashboard capabilities are known", () => {
    dashboardState.current = { data: undefined, isLoading: true, error: null, refetch: vi.fn() };

    renderShell("/control?siteId=site", { ...adminUser, id: "viewer", loginId: "viewer", role: "viewer" });

    expect(screen.getByText("현장 권한을 확인하는 중입니다.")).toBeInTheDocument();
    expect(screen.queryByText("제어 화면")).not.toBeInTheDocument();
  });

  it("hides control and replaces a direct control route for read users", async () => {
    dashboardState.current = { data: dashboardFor({ read: true, control: false, manage: false, commission: false }), isLoading: false, error: null, refetch: vi.fn() };

    renderShell("/control?siteId=site", { ...adminUser, id: "reader", loginId: "reader", role: "viewer" });

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/monitoring?siteId=site"));
    expect(screen.queryByRole("link", { name: "제어" })).not.toBeInTheDocument();
    expect(await screen.findByText("모니터링 화면")).toBeInTheDocument();
  });

  it("shows the control route for a control-capable general user", async () => {
    dashboardState.current = { data: dashboardFor({ read: true, control: true, manage: false, commission: false }), isLoading: false, error: null, refetch: vi.fn() };

    renderShell("/control?siteId=site", { ...adminUser, id: "controller", loginId: "controller", role: "viewer" });

    expect(screen.getByRole("link", { name: "제어" })).toBeInTheDocument();
    expect(await screen.findByText("제어 화면")).toBeInTheDocument();
  });

  it("uses manage capability instead of admin role for the map edit route", async () => {
    dashboardState.current = { data: dashboardFor({ read: true, control: true, manage: false, commission: false }), isLoading: false, error: null, refetch: vi.fn() };

    renderShell("/settings/floor-plans/floor-b2/edit?siteId=site", adminUser);

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans?siteId=site"));
    expect(screen.queryByText("맵 편집 화면")).not.toBeInTheDocument();
  });

  it("allows every customer user to open password settings but keeps registration admin-only", async () => {
    dashboardState.current = { data: dashboardFor({ read: true, control: false, manage: false, commission: false }), isLoading: false, error: null, refetch: vi.fn() };
    renderShell("/settings/security?siteId=site", { ...adminUser, id: "reader", loginId: "reader", role: "viewer" });

    expect(await screen.findByRole("heading", { name: "계정 보안" })).toBeInTheDocument();

    cleanup();
    renderShell("/settings/registration?siteId=site", { ...adminUser, id: "reader", loginId: "reader", role: "viewer" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings?siteId=site"));
  });

  it("orders admin settings tabs with user management before registration", async () => {
    renderShell("/settings?siteId=site");

    const settingsTabs = await screen.findByRole("navigation", { name: "설정 메뉴" });
    const labels = within(settingsTabs).getAllByRole("link").map((link) => link.textContent);
    expect(labels.indexOf("유저 관리")).toBeLessThan(labels.indexOf("조명 등록"));
  });

  it("requests and renders site users for the selected site", async () => {
    renderShell("/settings/users?siteId=site");

    expect(await screen.findByText("등록된 사용자가 없습니다.")).toBeVisible();
    expect(apiGet).toHaveBeenCalledWith("/sites/site/users");
  });
});
