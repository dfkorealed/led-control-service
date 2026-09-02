import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, apiPost } from "./api/client";
import type { InitialSiteSetupRequest } from "./api/setup";
import { dirtyEditorSentinelKey } from "./features/floor-editor/dirty-editor-history";
import { useFloorEditorStore } from "./features/floor-editor/editor-store";
import {
  mockDashboard,
  mockEnergyDaySeries,
  mockEnergyMonthSeries,
  mockEnergySummary,
  mockRegistrationSession
} from "./test/fixtures";
import type { RegistrationSession } from "./api/registration";
import { App } from "./App";
import { settingsSectionsFor } from "./features/settings/settings-sections";
import {
  activeCommandStorageKey,
  saveActiveCommandRequest
} from "./features/control/active-command-store";

const authState = vi.hoisted(() => ({
  user: {
    id: "user-1",
    organizationId: "organization-1",
    organizationType: "customer",
    loginId: "demo_admin",
    name: "Demo Operator",
    role: "admin",
    status: "active"
  } as null | {
    id: string;
    organizationId: string;
    organizationType: "service_provider" | "customer";
    loginId: string;
    name: string;
    role: string;
    status: string;
  }
}));
const apiState = vi.hoisted(() => ({
  dashboard: null as null | unknown,
  dashboardResponses: [] as Array<() => Promise<unknown>>,
  registrationSession: null as null | RegistrationSession,
  commandStatus: null as null | unknown
}));

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
});

vi.mock("./api/client", () => ({
  apiGet: vi.fn((path: string) => {
    const dashboardResponse = (fallback: unknown) =>
      apiState.dashboardResponses.shift()?.() ?? Promise.resolve(apiState.dashboard ?? fallback);
    if (path === "/auth/me") {
      return authState.user ? Promise.resolve({ user: authState.user }) : Promise.reject(new Error("Unauthorized"));
    }
    if (path === "/sites") {
      return Promise.resolve([
        { id: mockDashboard.site.id, name: mockDashboard.site.name, customerName: "고객사 A" },
        { id: "site-2", name: "물류센터", customerName: "고객사 B" }
      ]);
    }
    if (path === "/sites/default/dashboard") return dashboardResponse(mockDashboard);
    if (path === "/sites/default/dashboard?includeFixtures=true") return dashboardResponse(mockDashboard);
    if (path === `/sites/${mockDashboard.site.id}/dashboard`) {
      return dashboardResponse(mockDashboard);
    }
    if (path === `/sites/${mockDashboard.site.id}/dashboard?includeFixtures=true`) {
      return dashboardResponse(mockDashboard);
    }
    if (path === "/sites/site-2/dashboard") {
      return dashboardResponse({ ...mockDashboard, site: { ...mockDashboard.site, id: "site-2", name: "물류센터" } });
    }
    if (path === "/sites/site-2/dashboard?includeFixtures=true") {
      return dashboardResponse({ ...mockDashboard, site: { ...mockDashboard.site, id: "site-2", name: "물류센터" } });
    }
    const dashboardMatch = path.match(/^\/sites\/([^/]+)\/dashboard(?:\?includeFixtures=true)?$/);
    if (dashboardMatch) {
      return dashboardResponse({ ...mockDashboard, site: { ...mockDashboard.site, id: dashboardMatch[1] } });
    }
    const fixturePageMatch = path.match(/^\/sites\/([^/]+)\/floors\/([^/]+)\/fixtures\?/);
    if (fixturePageMatch) {
      const dashboard = (apiState.dashboard ?? mockDashboard) as typeof mockDashboard;
      const fixtures = dashboard.floors.find((floor) => floor.id === fixturePageMatch[2])?.fixtures ?? [];
      return Promise.resolve({ items: fixtures, nextCursor: null });
    }
    const mapSnapshotMatch = path.match(/^\/sites\/([^/]+)\/floors\/([^/]+)\/map-snapshot$/);
    if (mapSnapshotMatch) {
      const dashboard = (apiState.dashboard ?? mockDashboard) as typeof mockDashboard;
      const floor = dashboard.floors.find((item) => item.id === mapSnapshotMatch[2]);
      if (!floor) return Promise.reject(new Error(`No floor for ${path}`));
      const width = floor.floorPlan?.width ?? 1200;
      const height = floor.floorPlan?.height ?? 800;
      return Promise.resolve({
        floorId: floor.id,
        revision: floor.floorPlan?.version ?? 0,
        width,
        height,
        floorPlan: floor.floorPlan
          ? {
              imageUrl: floor.floorPlan.imageUrl,
              sourceType: "image",
              originalFileUrl: floor.floorPlan.imageUrl,
              renderedImageUrl: floor.floorPlan.imageUrl,
              width,
              height
            }
          : null,
        objects: []
      });
    }
    if (path === "/commands/command-created-1" && apiState.commandStatus) return Promise.resolve(apiState.commandStatus);
    const floorEditorMatch = path.match(/^\/floors\/(.+)\/editor-state$/);
    if (floorEditorMatch) {
      const dashboard = (apiState.dashboard ?? mockDashboard) as typeof mockDashboard;
      const floor = dashboard.floors.find((item) => item.id === floorEditorMatch[1]) ?? dashboard.floors[0];
      return Promise.resolve({
        floor: {
          id: floor.id,
          name: floor.name,
          level: floor.level,
          floorPlan: floor.floorPlan
        },
        fixtures: floor.fixtures,
        objects: []
      });
    }
    const energySummaryMatch = path.match(/^\/energy\/sites\/([^/]+)\/summary$/);
    if (energySummaryMatch) {
      const selectedSiteId = decodeURIComponent(energySummaryMatch[1]);
      return Promise.resolve(selectedSiteId === "site-2"
        ? {
            ...mockEnergySummary,
            siteId: selectedSiteId,
            today: { ...mockEnergySummary.today, estimatedKwh: 7.5, estimatedCost: 1_200 }
          }
        : mockEnergySummary);
    }
    const energySeriesMatch = path.match(/^\/energy\/sites\/([^/]+)\/series\?(.*)$/);
    if (energySeriesMatch) {
      const selectedSiteId = decodeURIComponent(energySeriesMatch[1]);
      const params = new URLSearchParams(energySeriesMatch[2]);
      const fixture = params.get("granularity") === "month" ? mockEnergyMonthSeries : mockEnergyDaySeries;
      return Promise.resolve({ ...fixture, siteId: selectedSiteId });
    }
    if (path === `/registration-sessions/${mockRegistrationSession.id}`) {
      return Promise.resolve(apiState.registrationSession ?? mockRegistrationSession);
    }
    return Promise.reject(new Error(`No mock for ${path}`));
  }),
  apiPost: vi.fn((path: string, body?: unknown) => {
    if (path === "/auth/login") {
      const input = body as { loginId: string };
      authState.user = {
        id: `user-${input.loginId.trim()}`,
        organizationId: `organization-${input.loginId.trim()}`,
        organizationType: input.loginId.includes("operator") ? "service_provider" : "customer",
        loginId: input.loginId.trim().toLowerCase(),
        name: "Authenticated User",
        role: input.loginId.includes("operator") ? "operator" : "admin",
        status: "active"
      };
      return Promise.resolve({ user: authState.user });
    }
    if (path === "/auth/logout") {
      authState.user = null;
      return Promise.resolve({ ok: true });
    }
    if (path === "/registration-sessions") {
      const input = body as { siteId?: string; floorId?: string; gatewayId?: string } | undefined;
      const dashboard = apiState.dashboard as typeof mockDashboard | null;
      const nextSession = {
        ...mockRegistrationSession,
        scanStatus: "completed" as const,
        scanCompletedAt: "2026-07-01T00:00:10.000Z",
        siteId: input?.siteId ?? dashboard?.site.id ?? mockRegistrationSession.siteId,
        floorId: input?.floorId ?? dashboard?.floors[0]?.id ?? mockRegistrationSession.floorId,
        gatewayId: input?.gatewayId ?? dashboard?.gateways[0]?.id ?? mockRegistrationSession.gatewayId
      };
      apiState.registrationSession = nextSession;
      return Promise.resolve(nextSession);
    }
    if (path === "/setup/initial-site") {
      const input = body as InitialSiteSetupRequest;
      const nextDashboard = {
        site: {
          id: input.siteId,
          name: "설치 완료 현장",
          customerName: "고객사",
          installationStatus: "installed" as const,
          address: input.address,
          tariffKwhRate: input.tariffKwhRate,
          timeZone: input.timeZone ?? "Asia/Seoul"
        },
        summary: { totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, averageBrightness: 0 },
        floors: input.floors.map((floor, index) => ({
          id: `floor-onboarded-${index + 1}`,
          name: floor.name,
          level: floor.level,
          floorPlan: floor.floorPlan ? { ...floor.floorPlan, version: 1 } : null,
          fixtures: []
        })),
        groups: [],
        gateways: []
      };
      apiState.dashboard = nextDashboard;
      apiState.registrationSession = {
        ...mockRegistrationSession,
        siteId: nextDashboard.site.id,
        floorId: nextDashboard.floors[0]?.id ?? "",
        gatewayId: ""
      };
      return Promise.resolve(nextDashboard);
    }
    if (path === "/gateways/claim") {
      const input = body as { siteId: string; name: string; serialNumber: string };
      const dashboard = apiState.dashboard as typeof mockDashboard;
      apiState.dashboard = {
        ...dashboard,
        gateways: [{
          id: "gateway-onboarded-1",
          name: input.name,
          serialNumber: input.serialNumber,
          firmwareVersion: "bootstrap-pending",
          lastHeartbeatAt: null,
          connectionStatus: "offline" as const
        }]
      };
      return Promise.resolve({ status: "claimed", gatewayId: "gateway-onboarded-1", siteId: input.siteId, serialNumber: input.serialNumber });
    }
    if (path.endsWith("/nodes/register-batch")) {
      const input = body as { nodes: Array<{ nodeId: string }> };
      const requestedIds = new Set(input.nodes.map((node) => node.nodeId));
      const currentSession = apiState.registrationSession ?? mockRegistrationSession;
      apiState.registrationSession = {
        ...currentSession,
        discoveredNodes: currentSession.discoveredNodes.map((node) => requestedIds.has(node.id)
          ? { ...node, status: "provisioned" as const }
          : node)
      };
      return Promise.resolve({
        items: input.nodes.map((node, index) => ({
          nodeId: node.nodeId,
          status: "accepted",
          fixtureName: `B2-L${String(index + 1).padStart(3, "0")}`
        }))
      });
    }
    if (path.endsWith("/register")) {
      return Promise.resolve({
        fixture: { id: "fixture-new-1", name: "B2-L13" },
        discoveredNode: { ...mockRegistrationSession.discoveredNodes[0], status: "provisioned" }
      });
    }
    if (path.endsWith("/complete")) return Promise.resolve({ ...mockRegistrationSession, status: "completed" });
    if (path === "/commands/dimming") return Promise.resolve({ id: "command-created-1", dispatchCount: 1 });
    return Promise.resolve({ status: "accepted" });
  }),
  apiRequest: vi.fn(() => Promise.resolve({}))
}));

describe("App", () => {
  afterEach(() => {
    authState.user = {
      id: "user-1",
      organizationId: "organization-1",
      organizationType: "customer",
      loginId: "demo_admin",
      name: "Demo Operator",
      role: "admin",
      status: "active"
    };
    apiState.dashboard = null;
    apiState.dashboardResponses = [];
    apiState.registrationSession = null;
    apiState.commandStatus = null;
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/monitoring");
    vi.clearAllMocks();
    cleanup();
  });

  it("로그인은 운영 요약 없이 Calm Operations 브랜드와 실제 폼만 표시한다", async () => {
    authState.user = null;
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: /빛을 더 안정적으로/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LED Control 로그인" })).toBeInTheDocument();
    expect(screen.queryByText("연결 조명")).not.toBeInTheDocument();
    expect(screen.queryByText("정상 운영")).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Gateway|게이트웨이)$/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("아이디")).toBeInTheDocument();
    expect(screen.getByLabelText("비밀번호")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "자동 로그인" })).toBeChecked();
  });

  it("submits the login id and never renders public signup controls", async () => {
    authState.user = null;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(["dashboard", "old-tenant"], { siteName: "이전 고객 현장", secret: "old-tenant-data" });
    const oldMutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async (variables: { password: string }) => variables
    });
    await oldMutation.execute({ password: "old-principal-password" });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    await screen.findByRole("heading", { name: "LED Control 로그인" });
    expect(screen.getByLabelText("아이디")).toHaveValue("");
    expect(screen.getByLabelText("비밀번호")).toHaveValue("");
    expect(screen.queryByText(/회원\s*가입|초대 코드/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("아이디"), { target: { value: " ADMIN_01 " } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/auth/login", {
        loginId: " ADMIN_01 ",
        password: "correct horse battery staple",
        rememberMe: true
      });
    });
    await waitFor(() => expect(queryClient.getQueryData(["auth", "me"])).toMatchObject({
      user: { loginId: "admin_01", organizationId: "organization-ADMIN_01" }
    }));
    expect(queryClient.getQueryData(["dashboard", "old-tenant"])).toBeUndefined();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain("old-tenant-data");
    expect(JSON.stringify(queryClient.getMutationCache().getAll().map((mutation) => mutation.state))).not.toContain("password");
  });

  it("keeps failed login plaintext out of React Query caches and exposes an alert", async () => {
    authState.user = null;
    vi.mocked(apiPost).mockRejectedValueOnce(new Error("unauthorized"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    await screen.findByRole("heading", { name: "LED Control 로그인" });
    fireEvent.change(screen.getByLabelText("아이디"), { target: { value: "admin_01" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "failed-login-password" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("아이디 또는 비밀번호를 확인해 주세요.");
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain("failed-login-password");
  });

  it("clears tenant query and mutation data when auth me is revoked before showing the next login", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(["tenant", "dashboard"], { heading: "이전 고객 대시보드", tenantSecret: "tenant-a-private" });
    const tenantMutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async (variables: { tenantSecret: string }) => variables
    });
    await tenantMutation.execute({ tenantSecret: "tenant-a-private" });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
    await screen.findByRole("link", { name: "모니터링" });

    authState.user = null;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    });

    expect(await screen.findByRole("heading", { name: "LED Control 로그인" })).toBeInTheDocument();
    expect(screen.queryByText("이전 고객 대시보드")).not.toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryData(["tenant", "dashboard"])).toBeUndefined());
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain("tenant-a-private");
  });

  it("clears tenant caches before rendering a different principal from auth me", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
    await screen.findByRole("link", { name: "모니터링" });

    queryClient.setQueryData(["dashboard", "default"], {
      ...mockDashboard,
      site: { ...mockDashboard.site, id: "tenant-a-private", name: "Tenant A Private" }
    });
    const tenantMutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async (variables: { tenantSecret: string }) => variables
    });
    await tenantMutation.execute({ tenantSecret: "tenant-a-private" });
    vi.mocked(apiGet).mockClear();

    authState.user = {
      id: "user-2",
      organizationId: "organization-2",
      organizationType: "customer",
      loginId: "tenant_b_admin",
      name: "Tenant B Admin",
      role: "admin",
      status: "active"
    };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    });

    await waitFor(() => expect(queryClient.getQueryData(["auth", "me"])).toMatchObject({
      user: { id: "user-2", organizationId: "organization-2" }
    }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/sites/default/dashboard"));
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain("tenant-a-private");
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it("keeps the four customer navigation links after rail markup changes", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    const links = await Promise.all([
      screen.findByRole("link", { name: "모니터링" }),
      screen.findByRole("link", { name: "제어" }),
      screen.findByRole("link", { name: "통계" }),
      screen.findByRole("link", { name: "설정" })
    ]);

    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/monitoring",
      "/control",
      "/statistics",
      "/settings"
    ]);
  });

  it("renders the floor-plan settings route for an admin on refresh", async () => {
    window.history.pushState({}, "", "/settings/floor-plans?siteId=site-2");
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
    expect(window.location.search).toBe("?siteId=site-2");
    expect(screen.getByRole("link", { name: "설정" })).toHaveAttribute("href", "/settings?siteId=site-2");
    expect(screen.queryByLabelText("설정 메뉴")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "설치 및 시운전" })).not.toBeInTheDocument();
  });

  it("loads the selected site through its site-scoped dashboard URL", async () => {
    window.history.pushState({}, "", "/monitoring?siteId=site-2");
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByText("물류센터")).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith("/sites/site-2/dashboard");
  });

  it("loads selected-site fixtures through the site-scoped URL", async () => {
    window.history.pushState({}, "", "/monitoring?siteId=site-2");
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    await screen.findByText("물류센터");

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith(
        `/sites/site-2/floors/${mockDashboard.floors[0].id}/fixtures?limit=200`
      );
    });
  });

  it.each(
    settingsSectionsFor("admin").filter((section) => !["/settings", "/settings/floor-plans"].includes(section.path))
  )("renders an admin destination for the $label settings link", async (section) => {
    window.history.pushState({}, "", `${section.path}?siteId=site-1`);
    authState.user = { ...authState.user!, role: "admin" };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: section.label })).toBeInTheDocument();
    expect(screen.getByLabelText("현재 비밀번호")).toBeInTheDocument();
  });

  it.each(["/monitoring", "/control", "/statistics", "/settings", "/unrecognized-route"])(
    "replaces operator deep links to the site admin account route without customer queries: %s",
    async (path) => {
      window.history.pushState({}, "", `${path}?siteId=site-2`);
      authState.user = {
        id: "operator-1",
        organizationId: "service-provider-1",
        organizationType: "service_provider",
        loginId: "operator_01",
        name: "Service Operator",
        role: "operator",
        status: "active"
      };
      const queryClient = new QueryClient();
      render(
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      );

      expect(await screen.findByRole("heading", { name: "현장 관리자 계정" })).toBeInTheDocument();
      await waitFor(() => expect(window.location.pathname).toBe("/operator/site-admins"));
      expect(screen.getByText("operator_01")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "모니터링" })).not.toBeInTheDocument();
      expect(vi.mocked(apiGet).mock.calls.filter(([requestPath]) => (
        requestPath === "/sites" || requestPath.includes("/dashboard")
      ))).toEqual([]);
    }
  );

  it.each(["admin", "viewer"] as const)("keeps the customer shell routes for %s", async (role) => {
    window.history.pushState({}, "", "/monitoring?siteId=site-2");
    authState.user = { ...authState.user!, role };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("link", { name: "모니터링" })).toHaveAttribute("href", "/monitoring?siteId=site-2");
    expect(screen.queryByRole("heading", { name: "현장 관리자 계정" })).not.toBeInTheDocument();
  });

  it("redirects a pending admin from monitoring to initial settings while preserving siteId", async () => {
    window.history.pushState({}, "", "/monitoring?siteId=site-2");
    apiState.dashboard = {
      ...mockDashboard,
      site: {
        ...mockDashboard.site,
        id: "site-2",
        name: "물류센터",
        customerName: "고객사 B",
        installationStatus: "pending",
        address: null,
        tariffKwhRate: null,
        timeZone: "Asia/Seoul"
      },
      floors: [],
      gateways: []
    };
    const queryClient = new QueryClient();
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    expect(await screen.findByRole("heading", { name: "초기 설치 설정" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.search).toBe("?siteId=site-2");
  });

  it("redirects a viewer's unavailable settings URL to the settings overview", async () => {
    window.history.pushState({}, "", "/settings/floors?siteId=site-2");
    authState.user = { ...authState.user!, role: "viewer" };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "현장 및 층" })).not.toBeInTheDocument();
  });

  it("replaces a viewer's password URL with settings while preserving the selected site", async () => {
    window.history.pushState({}, "", "/settings/security?siteId=site-2");
    authState.user = { ...authState.user!, role: "viewer" };
    const queryClient = new QueryClient();
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.search).toBe("?siteId=site-2");
    expect(screen.queryByLabelText("현재 비밀번호")).not.toBeInTheDocument();
    expect(vi.mocked(apiPost).mock.calls.filter(([path]) => path === "/auth/change-password")).toHaveLength(0);
  });

  it.each([
    ["/monitoring?siteId=site-2", (path: string) => /\/floors\/.*\/(fixtures|map-snapshot)/.test(path)],
    ["/control?siteId=site-2", (path: string) => path.includes("dashboard?includeFixtures=true")],
    ["/statistics?siteId=site-2", (path: string) => path.startsWith("/energy/sites/")]
  ])("does not mount a pending admin customer child route before installation status resolves: %s", async (path, isChildRequest) => {
    let resolveDashboard: ((dashboard: unknown) => void) | undefined;
    apiState.dashboardResponses = [() => new Promise((resolve) => { resolveDashboard = resolve; })];
    window.history.pushState({}, "", path);
    const queryClient = new QueryClient();
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    expect(await screen.findByText("설치 상태를 확인하는 중입니다.")).toBeInTheDocument();
    expect(vi.mocked(apiGet).mock.calls.filter(([requestPath]) => isChildRequest(requestPath))).toHaveLength(0);
    resolveDashboard?.({
      ...mockDashboard,
      site: {
        ...mockDashboard.site,
        id: "site-2",
        installationStatus: "pending",
        address: null,
        tariffKwhRate: null
      },
      floors: [],
      gateways: []
    });
  });

  it("does not request floor editor state or a lease before a pending admin dashboard decision", async () => {
    let resolveDashboard: ((dashboard: unknown) => void) | undefined;
    apiState.dashboardResponses = [() => new Promise((resolve) => { resolveDashboard = resolve; })];
    window.history.pushState({}, "", "/settings/floor-plans/floor-1/edit?siteId=site-2");
    const queryClient = new QueryClient();
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    expect(await screen.findByText("설치 상태를 확인하는 중입니다.")).toBeInTheDocument();
    expect(vi.mocked(apiGet).mock.calls.filter(([path]) => /\/floors\/.*\/editor-state$/.test(path))).toHaveLength(0);
    expect(vi.mocked(apiPost).mock.calls.filter(([path]) => /\/editor-lease$/.test(path))).toHaveLength(0);
    resolveDashboard?.({
      ...mockDashboard,
      site: {
        ...mockDashboard.site,
        id: "site-2",
        installationStatus: "pending",
        address: null,
        tariffKwhRate: null
      },
      floors: [],
      gateways: []
    });
  });

  it("shows a retryable installation-status error before mounting an admin child route", async () => {
    apiState.dashboardResponses = [
      () => Promise.reject(new Error("dashboard unavailable")),
      () => Promise.resolve({ ...mockDashboard, site: { ...mockDashboard.site, id: "site-2" } })
    ];
    window.history.pushState({}, "", "/control?siteId=site-2");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    expect(await screen.findByRole("alert")).toHaveTextContent("설치 상태를 확인하지 못했습니다.");
    expect(vi.mocked(apiGet).mock.calls.filter(([path]) => path.includes("dashboard?includeFixtures=true"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(vi.mocked(apiGet).mock.calls.filter(([path]) => path === "/sites/site-2/dashboard")).toHaveLength(2));
  });

  it("keeps an installed default dashboard after setup even when the invalidated refetch fails", async () => {
    apiState.dashboardResponses = [
      () => Promise.resolve({
        ...mockDashboard,
        site: {
          ...mockDashboard.site,
          installationStatus: "pending",
          address: null,
          tariffKwhRate: null
        },
        floors: [],
        gateways: []
      }),
      () => Promise.reject(new Error("refetch unavailable"))
    ];
    window.history.pushState({}, "", "/settings");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    expect(await screen.findByRole("heading", { name: "초기 설치 설정" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울시 강남구" } });
    fireEvent.click(screen.getByRole("button", { name: "초기 설정 완료" }));

    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    expect(queryClient.getQueryData(["dashboard", "default"])).toMatchObject({
      site: { installationStatus: "installed", address: "서울시 강남구" }
    });
  });

  it("renders the approved control center landmarks", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "운영 현황" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "전체 조명" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toBeInTheDocument();
    expect(screen.getAllByText("관제 센터").length).toBeGreaterThan(0);
  });

  it("shows the selected fixture's assigned gateway in monitoring details", async () => {
    apiState.dashboard = {
      ...mockDashboard,
      floors: mockDashboard.floors.map((floor, floorIndex) => ({
        ...floor,
        fixtures: floor.fixtures.map((fixture, fixtureIndex) =>
          floorIndex === 0 && fixtureIndex === 10
            ? { ...fixture, gateway: { id: "gateway-fixture-a", name: "조명 전용 게이트웨이 A", connectionStatus: "online" as const } }
            : fixture
        )
      }))
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByText("조명 전용 게이트웨이 A (정상)")).toBeInTheDocument();
  });

  it("disables control and explains the server-provided block reason", async () => {
    apiState.dashboard = {
      ...mockDashboard,
      floors: mockDashboard.floors.map((floor, floorIndex) => ({
        ...floor,
        fixtures: floor.fixtures.map((fixture, fixtureIndex) =>
          floorIndex === 0 && fixtureIndex === 0
            ? { ...fixture, controllable: false, controlBlockReason: "gateway_offline" as const }
            : fixture
        )
      }))
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "제어" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "B2-L01 선택" }));

    expect(await screen.findByText("B2-L01: 게이트웨이가 오프라인입니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
  });

  it("blocks a zone when one of its fixtures is uncontrollable", async () => {
    apiState.dashboard = {
      ...mockDashboard,
      floors: mockDashboard.floors.map((floor, floorIndex) => ({
        ...floor,
        fixtures: floor.fixtures.map((fixture, fixtureIndex) =>
          floorIndex === 0 && fixtureIndex === 1
            ? { ...fixture, controllable: false, controlBlockReason: "fixture_offline" as const }
            : fixture
        )
      }))
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "제어" }));
    const zoneModeButton = await screen.findByRole("button", { name: "구역" });
    fireEvent.click(zoneModeButton);
    expect(zoneModeButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "B2 Entrance Zone 선택" }));

    expect(await screen.findByText("B2-L02: 조명이 오프라인입니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
  });

  it("shows unregistered gateway status when the dashboard has no gateways", async () => {
    apiState.dashboard = {
      ...mockDashboard,
      gateways: []
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByText("게이트웨이 미등록")).toBeInTheDocument();
    expect(screen.queryByText("게이트웨이 정상")).not.toBeInTheDocument();
  });

  it("shows actual gateway values in settings", async () => {
    apiState.dashboard = {
      ...mockDashboard,
      gateways: [
        {
          id: "gateway-settings-1",
          name: "설정 게이트웨이",
          serialNumber: "GW-SETTINGS-001",
          firmwareVersion: "settings-1.0.0",
          lastHeartbeatAt: null,
          connectionStatus: "offline" as const
        }
      ]
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "설정" }));

    const gatewayStatus = await screen.findByRole("group", { name: "게이트웨이 상태" });
    expect(gatewayStatus).toHaveTextContent("설정 게이트웨이");
    expect(gatewayStatus).toHaveTextContent("GW-SETTINGS-001");
    expect(gatewayStatus).toHaveTextContent("오프라인");
  });

  it("shows unregistered gateway in settings when no gateways exist", async () => {
    apiState.dashboard = {
      ...mockDashboard,
      gateways: []
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "설정" }));

    await waitFor(() => expect(screen.getAllByText("미등록").length).toBeGreaterThan(0));
  });

  it("switches monitoring floors and updates the detail panel from map selection", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "B1" }));
    expect(await screen.findByRole("heading", { name: "운영 현황" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "B1-L01 정상 50%" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "B1-L02 정상 55%" }));
    expect(await screen.findByRole("heading", { name: "B1-L02" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("-56 dBm");
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("99%");
  });

  it("keeps the monitoring floor map read only", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "운영 현황" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "도면 편집" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "층 도면" })).toBeInTheDocument();
  });

  it("excludes fixtures waiting for initial state from the offline inspection queue", async () => {
    const sourceFixture = mockDashboard.floors[0].fixtures[0];
    const offlineFixture = mockDashboard.floors[0].fixtures[5];
    apiState.dashboard = {
      ...mockDashboard,
      summary: { ...mockDashboard.summary, totalFixtures: 2 },
      floors: [
        {
          ...mockDashboard.floors[0],
          fixtures: [
            {
              ...sourceFixture,
              id: "fixture-waiting-state",
              name: "B2-L-WAITING",
              status: "offline" as const,
              statusReason: "provisioning_waiting_state",
              lastSeenAt: null
            },
            { ...offlineFixture, id: "fixture-real-offline", name: "B2-L-OFFLINE" }
          ]
        }
      ]
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    const offlineQueue = await screen.findByRole("button", { name: "오프라인 1대" });
    fireEvent.click(offlineQueue);

    expect(await screen.findByRole("heading", { name: "B2-L-OFFLINE" })).toBeInTheDocument();
  });

  it("does not expose floor editing from monitoring to viewers", async () => {
    authState.user = {
      id: "viewer-1",
      organizationId: "organization-1",
      organizationType: "customer",
      loginId: "viewer_01",
      name: "Demo Viewer",
      role: "viewer",
      status: "active"
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "운영 현황" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "층 도면" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "도면 편집" })).not.toBeInTheDocument();
  });

  it("renders redesigned landmarks for control statistics and settings", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "제어" }));
    expect(await screen.findByRole("heading", { name: "조명 밝기 제어" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "통계" }));
    expect(await screen.findByText("에너지 리포트")).toBeInTheDocument();
    expect(screen.queryByText("18%")).not.toBeInTheDocument();
    expect(screen.queryByText("18:00-22:00")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "설정" }));
    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    expect(screen.queryByText("MVP 2 준비")).not.toBeInTheDocument();
    expect(screen.queryByText("통신 음영 검토")).not.toBeInTheDocument();
  });

  it("loads statistics summary and series from the selected site", async () => {
    window.history.pushState({}, "", "/statistics?siteId=site-2");
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("group", { name: "오늘 전력 사용량" })).toHaveTextContent("7.5 kWh");
    expect(apiGet).toHaveBeenCalledWith("/energy/sites/site-2/summary");
    expect(apiGet).toHaveBeenCalledWith(
      "/energy/sites/site-2/series?granularity=day&from=2026-08-01&to=2026-08-31"
    );
    expect(apiGet).toHaveBeenCalledWith(
      "/energy/sites/site-2/series?granularity=month&from=2026-01-01&to=2026-12-01"
    );
  });

  it("uses the dashboard site for statistics when the URL has no siteId", async () => {
    window.history.pushState({}, "", "/statistics");
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("group", { name: "오늘 전력 사용량" })).toHaveTextContent("4.25 kWh");
    expect(apiGet).toHaveBeenCalledWith(`/energy/sites/${mockDashboard.site.id}/summary`);
    expect(apiGet).not.toHaveBeenCalledWith("/energy/default/estimate");
  });

  it("switches statistics data with the selected site instead of reusing another site's cache", async () => {
    window.history.pushState({}, "", "/statistics?siteId=site-2");
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("group", { name: "오늘 전력 사용량" })).toHaveTextContent("7.5 kWh");
    window.history.pushState({}, "", `/statistics?siteId=${mockDashboard.site.id}`);
    view.unmount();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("group", { name: "오늘 전력 사용량" })).toHaveTextContent("4.25 kWh");
    expect(apiGet).toHaveBeenCalledWith("/energy/sites/site-2/summary");
    expect(apiGet).toHaveBeenCalledWith(`/energy/sites/${mockDashboard.site.id}/summary`);
  });

  it("sends group dimming commands from the control screen", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "제어" }));
    const zoneModeButton = await screen.findByRole("button", { name: "구역" });
    fireEvent.click(zoneModeButton);
    expect(zoneModeButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "B2 Entrance Zone 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/commands/dimming", expect.objectContaining({
        siteId: mockDashboard.site.id,
        target: {
          type: "group",
          groupId: mockDashboard.groups[0].id
        },
        brightness: 30,
        clientRequestId: expect.any(String)
      }), { signal: expect.any(AbortSignal) })
    );
    expect(await screen.findByText("명령을 전송했습니다. 장비 ACK를 기다리는 중입니다.")).toBeInTheDocument();
  });

  it("shows fixture-level partial failure from command status polling", async () => {
    apiState.commandStatus = {
      id: "command-created-1",
      stage: "partial_failed",
      dispatchCount: 1,
      completedFixtureCount: 2,
      totalFixtureCount: 2,
      errorMessage: "one or more gateway dispatches failed",
      dispatches: [
        {
          id: "dispatch-1",
          status: "failed",
          gateway: { id: "gateway-1", name: "Gateway B2" },
          errorMessage: null,
          results: [
            { fixtureId: "fixture-1", fixtureName: "B2-L01", status: "succeeded", errorMessage: null },
            { fixtureId: "fixture-2", fixtureName: "B2-L02", status: "failed", errorMessage: "장비 응답 오류" }
          ]
        }
      ]
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "제어" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "B2-L01 선택" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "B2-L02 선택" }));
    const applyButton = screen.getByRole("button", { name: "밝기 적용" });
    await waitFor(() => expect(applyButton).toBeEnabled());
    fireEvent.click(applyButton);

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/commands/dimming", expect.objectContaining({
      siteId: mockDashboard.site.id,
      target: {
        type: "fixtures",
        fixtureIds: [
          mockDashboard.floors[0].fixtures[0].id,
          mockDashboard.floors[0].fixtures[1].id
        ]
      },
      brightness: 70,
      clientRequestId: expect.any(String)
    }), { signal: expect.any(AbortSignal) }));
    expect(await screen.findByText("일부 조명 적용 실패", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("2 / 2 처리")).toBeInTheDocument();
    expect(screen.getByText("B2-L02: 장비 응답 오류")).toBeInTheDocument();
  });

  it("renders control as read-only for viewers and never posts a command", async () => {
    authState.user = {
      id: "viewer-1",
      organizationId: "organization-1",
      organizationType: "customer",
      loginId: "viewer_01",
      name: "Demo Viewer",
      role: "viewer",
      status: "active"
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "제어" }));
    expect(await screen.findByText("조회 전용 계정입니다. 조명 제어는 admin 계정으로만 수행할 수 있습니다."))
      .toBeInTheDocument();
    const fixtureModeButton = screen.getByRole("button", { name: "개별/다중" });
    expect(fixtureModeButton).toHaveAttribute("aria-pressed", "true");
    expect(fixtureModeButton).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "B2-L01 선택" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
    const applyButton = screen.getByRole("button", { name: "밝기 적용" });
    expect(applyButton).toBeDisabled();
    fireEvent.click(applyButton);
    expect(apiPost).not.toHaveBeenCalledWith("/commands/dimming", expect.anything());
    expect(screen.queryByText("명령 전송에 실패했습니다. 대상 상태와 게이트웨이 연결을 확인하세요.")).not.toBeInTheDocument();
  });

  it("confirms dirty editor logout before revoking the session", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    window.history.replaceState({}, "", "/settings?siteId=site-2");
    window.history.pushState({}, "", "/settings/floor-plans/floor-b2/edit?siteId=site-2");
    window.history.pushState({ [dirtyEditorSentinelKey]: "dirty-editor" }, "", window.location.href);
    useFloorEditorStore.setState({ isDirty: true });
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "로그아웃" }));

    expect(confirm).toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalledWith("/auth/logout", {});
    useFloorEditorStore.setState({ isDirty: false });
  });

  it("returns to the login view after a confirmed logout from a dirty editor", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState({}, "", "/settings?siteId=site-2");
    window.history.pushState({}, "", "/settings/floor-plans/floor-b2/edit?siteId=site-2");
    window.history.pushState({ [dirtyEditorSentinelKey]: "dirty-editor" }, "", window.location.href);
    useFloorEditorStore.setState({ isDirty: true });
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "로그아웃" }));

    expect(confirm).toHaveBeenCalled();
    expect(apiPost).toHaveBeenCalledWith("/auth/logout", {});
    expect(await screen.findByRole("heading", { name: "LED Control 로그인" })).toBeInTheDocument();
    expect(useFloorEditorStore.getState().isDirty).toBe(false);
  });

  it("removes only the authenticated user's command recovery records on logout", async () => {
    const otherUserId = "user-2";
    const request = {
      siteId: mockDashboard.site.id,
      clientRequestId: "00000000-0000-4000-8000-000000009099",
      target: { type: "fixture" as const, fixtureId: mockDashboard.floors[0].fixtures[0].id },
      brightness: 30
    };
    saveActiveCommandRequest(authState.user!.id, request.siteId, request);
    saveActiveCommandRequest(otherUserId, request.siteId, {
      ...request,
      clientRequestId: "00000000-0000-4000-8000-000000009098"
    });
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "로그아웃" }));

    await waitFor(() => expect(sessionStorage.getItem(activeCommandStorageKey("user-1", request.siteId))).toBeNull());
    expect(sessionStorage.getItem(activeCommandStorageKey(otherUserId, request.siteId))).not.toBeNull();
  });

  it.each(["success", "failure"])(
    "does not recreate command recovery after an in-flight POST resolves with %s during logout",
    async (result) => {
      let resolveCommand: (value: unknown) => void = () => undefined;
      let rejectCommand: (reason: unknown) => void = () => undefined;
      let resolveLogout: () => void = () => undefined;
      vi.mocked(apiPost)
        .mockImplementationOnce(() => new Promise((resolve, reject) => {
          resolveCommand = resolve;
          rejectCommand = reject;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveLogout = () => {
            authState.user = null;
            resolve({ ok: true });
          };
        }));
      const queryClient = new QueryClient();
      render(
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      );

      fireEvent.click(await screen.findByRole("link", { name: "제어" }));
      fireEvent.click(await screen.findByRole("checkbox", { name: "B2-L01 선택" }));
      fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));
      await waitFor(() => expect(apiPost).toHaveBeenCalledWith(
        "/commands/dimming",
        expect.anything(),
        { signal: expect.any(AbortSignal) }
      ));
      const commandSignal = vi.mocked(apiPost).mock.calls[0][2]?.signal;
      const recoveryKey = activeCommandStorageKey("user-1", mockDashboard.site.id);

      fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));

      expect(commandSignal?.aborted).toBe(true);
      expect(sessionStorage.getItem(recoveryKey)).toContain("clientRequestId");

      await act(async () => {
        if (result === "success") resolveCommand({ id: "command-created-1", dispatchCount: 1 });
        else rejectCommand(new Error("response lost"));
        await Promise.resolve();
      });
      expect(sessionStorage.getItem(recoveryKey)).not.toContain("command-created-1");

      await act(async () => {
        resolveLogout();
        await Promise.resolve();
      });
      expect(await screen.findByRole("heading", { name: "LED Control 로그인" })).toBeInTheDocument();
      expect(sessionStorage.getItem(recoveryKey)).toBeNull();
    }
  );

  it("keeps command retry disabled while the logout API is pending", async () => {
    let resolveLogout: () => void = () => undefined;
    vi.mocked(apiPost)
      .mockImplementationOnce((_path, _body, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveLogout = () => {
          authState.user = null;
          resolve({ ok: true });
        };
      }));
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "제어" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "B2-L01 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(
      "/commands/dimming",
      expect.anything(),
      { signal: expect.any(AbortSignal) }
    ));

    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));

    const retryButton = await screen.findByRole("button", { name: "동일 요청 다시 전송" });
    expect(retryButton).toBeDisabled();
    fireEvent.click(retryButton);
    expect(vi.mocked(apiPost).mock.calls.filter(([path]) => path === "/commands/dimming")).toHaveLength(1);

    await act(async () => {
      resolveLogout();
      await Promise.resolve();
    });
    expect(await screen.findByRole("heading", { name: "LED Control 로그인" })).toBeInTheDocument();
  });

  it("unblocks command retry when logout fails", async () => {
    let rejectLogout: (reason: unknown) => void = () => undefined;
    vi.mocked(apiPost)
      .mockImplementationOnce((_path, _body, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectLogout = reject;
      }));
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "제어" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "B2-L01 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(
      "/commands/dimming",
      expect.anything(),
      { signal: expect.any(AbortSignal) }
    ));

    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    expect(await screen.findByRole("button", { name: "동일 요청 다시 전송" })).toBeDisabled();

    await act(async () => {
      rejectLogout(new Error("logout unavailable"));
      await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("로그아웃에 실패했습니다");
    const retryButton = screen.getByRole("button", { name: "동일 요청 다시 전송" });
    expect(retryButton).toBeEnabled();
    fireEvent.click(retryButton);

    await waitFor(() => expect(
      vi.mocked(apiPost).mock.calls.filter(([path]) => path === "/commands/dimming")
    ).toHaveLength(2));
    expect(await screen.findByText("명령을 전송했습니다. 장비 ACK를 기다리는 중입니다.")).toBeInTheDocument();
  });

  it("shows commissioning controls to an admin for an installed site without fixtures", async () => {
    apiState.dashboard = {
      ...mockDashboard,
      summary: { ...mockDashboard.summary, totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, averageBrightness: 0 },
      floors: mockDashboard.floors.map((floor) => ({ ...floor, fixtures: [] })),
      groups: []
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "조명 등록" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "설정" }));
    await screen.findByRole("heading", { name: "설정 개요" });
    expect(screen.getByRole("heading", { name: "조명 등록" })).toBeInTheDocument();
  });

  it("never shows commissioning controls to a viewer", async () => {
    authState.user = { ...authState.user!, role: "viewer" };
    apiState.dashboard = {
      ...mockDashboard,
      summary: { ...mockDashboard.summary, totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, averageBrightness: 0 },
      floors: mockDashboard.floors.map((floor) => ({ ...floor, fixtures: [] })),
      groups: []
    };
    const queryClient = new QueryClient();
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    expect(await screen.findByRole("heading", { name: "설치 담당자가 현장을 준비 중입니다" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "게이트웨이 등록" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "조명 등록" })).not.toBeInTheDocument();
  });

  it("shows installation pending instead of SetupWizard for an admin with no accessible site", async () => {
    apiState.dashboard = {
      ...mockDashboard,
      site: { id: "", name: "", customerName: "", installationStatus: "pending", address: null, tariffKwhRate: null, timeZone: "Asia/Seoul" },
      summary: { ...mockDashboard.summary, totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, averageBrightness: 0 },
      floors: [],
      gateways: [],
      groups: []
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "모니터링" }));
    expect(await screen.findByRole("heading", { name: "설치 담당자가 현장을 준비 중입니다" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "초기 설치 설정" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "조명 검색 시작" })).not.toBeInTheDocument();
  });

});
