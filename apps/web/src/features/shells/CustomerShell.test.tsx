import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../api/auth";
import { CustomerShell } from "./CustomerShell";

vi.mock("../settings/floor-plans/FloorEditorRoute", () => ({ FloorEditorRoute: () => <p>맵 편집 화면</p> }));
vi.mock("../monitoring/MonitoringView", () => ({ MonitoringView: () => <p>모니터링 화면</p> }));
vi.mock("../control/ControlView", () => ({ ControlView: () => <p>제어 화면</p> }));
vi.mock("../statistics/StatisticsView", () => ({ StatisticsView: () => <p>통계 화면</p> }));
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
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
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

describe("customer shell editor floor context", () => {
  beforeEach(() => {
    dashboardState.current = { data: dashboardFor({ read: true, control: true, manage: true, commission: true }), isLoading: false, error: null, refetch: vi.fn() };
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each(["b1", "b2", "unknown"])("uses the %s editor route, not the first dashboard floor", (floor) => {
    renderShell(`/settings/floor-plans/floor-${floor}/edit?siteId=site`);
    if (floor === "unknown") {
      expect(screen.queryByTestId("active-floor-badge")).not.toBeInTheDocument();
    } else {
      expect(screen.getByTestId("active-floor-badge")).toHaveTextContent(`${floor.toUpperCase()} 주차장`);
    }
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
    expect(screen.getByText("모니터링 화면")).toBeInTheDocument();
  });

  it("shows the control route for a control-capable general user", () => {
    dashboardState.current = { data: dashboardFor({ read: true, control: true, manage: false, commission: false }), isLoading: false, error: null, refetch: vi.fn() };

    renderShell("/control?siteId=site", { ...adminUser, id: "controller", loginId: "controller", role: "viewer" });

    expect(screen.getByRole("link", { name: "제어" })).toBeInTheDocument();
    expect(screen.getByText("제어 화면")).toBeInTheDocument();
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

    expect(screen.getByRole("heading", { name: "비밀번호 변경" })).toBeInTheDocument();

    cleanup();
    renderShell("/settings/registration?siteId=site", { ...adminUser, id: "reader", loginId: "reader", role: "viewer" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings?siteId=site"));
  });

  it("orders admin settings with user management before registration", () => {
    renderShell("/monitoring?siteId=site");

    fireEvent.focus(screen.getByRole("link", { name: "설정" }));
    const labels = screen.getAllByRole("link").map((link) => link.textContent);
    expect(labels.indexOf("유저 관리")).toBeLessThan(labels.indexOf("조명 등록"));
  });
});
