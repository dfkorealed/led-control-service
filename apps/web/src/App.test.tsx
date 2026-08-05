import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, apiPost } from "./api/client";
import type { InitialSiteSetupRequest } from "./api/setup";
import { mockDashboard, mockEnergyEstimate, mockRegistrationSession } from "./test/fixtures";
import type { RegistrationSession } from "./api/registration";
import { App } from "./App";
import { settingsSectionsFor } from "./features/settings/settings-sections";

const authState = vi.hoisted(() => ({
  user: {
    id: "user-1",
    organizationId: "organization-1",
    email: "operator@example.com",
    name: "Demo Operator",
    role: "admin",
    status: "active"
  } as null | {
    id: string;
    organizationId: string;
    email: string;
    name: string;
    role: string;
    status: string;
  }
}));
const apiState = vi.hoisted(() => ({
  dashboard: null as null | unknown,
  registrationSession: null as null | RegistrationSession,
  commandStatus: null as null | unknown
}));

vi.mock("./api/client", () => ({
  apiGet: vi.fn((path: string) => {
    if (path === "/auth/me") {
      return authState.user ? Promise.resolve({ user: authState.user }) : Promise.reject(new Error("Unauthorized"));
    }
    if (path === "/sites") {
      return Promise.resolve([
        { id: mockDashboard.site.id, name: mockDashboard.site.name },
        { id: "site-2", name: "물류센터" }
      ]);
    }
    if (path === "/sites/default/dashboard") return Promise.resolve(apiState.dashboard ?? mockDashboard);
    if (path === "/sites/default/dashboard?includeFixtures=true") return Promise.resolve(apiState.dashboard ?? mockDashboard);
    if (path === "/sites/site-2/dashboard") {
      return Promise.resolve({ ...mockDashboard, site: { id: "site-2", name: "물류센터" } });
    }
    if (path === "/sites/site-2/dashboard?includeFixtures=true") {
      return Promise.resolve({ ...mockDashboard, site: { id: "site-2", name: "물류센터" } });
    }
    const fixturePageMatch = path.match(/^\/sites\/([^/]+)\/floors\/([^/]+)\/fixtures\?/);
    if (fixturePageMatch) {
      const dashboard = (apiState.dashboard ?? mockDashboard) as typeof mockDashboard;
      const fixtures = dashboard.floors.find((floor) => floor.id === fixturePageMatch[2])?.fixtures ?? [];
      return Promise.resolve({ items: fixtures, nextCursor: null });
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
    if (path === "/energy/default/estimate") return Promise.resolve(mockEnergyEstimate);
    if (path === `/registration-sessions/${mockRegistrationSession.id}`) {
      return Promise.resolve(apiState.registrationSession ?? mockRegistrationSession);
    }
    return Promise.reject(new Error(`No mock for ${path}`));
  }),
  apiPost: vi.fn((path: string, body?: unknown) => {
    if (path === "/registration-sessions") {
      const input = body as { siteId?: string; floorId?: string } | undefined;
      const dashboard = apiState.dashboard as typeof mockDashboard | null;
      const nextSession = {
        ...mockRegistrationSession,
        siteId: input?.siteId ?? dashboard?.site.id ?? mockRegistrationSession.siteId,
        floorId: input?.floorId ?? dashboard?.floors[0]?.id ?? mockRegistrationSession.floorId,
        gatewayId: dashboard?.gateways[0]?.id ?? mockRegistrationSession.gatewayId
      };
      apiState.registrationSession = nextSession;
      return Promise.resolve(nextSession);
    }
    if (path === "/setup/initial-site") {
      const input = body as InitialSiteSetupRequest;
      const nextDashboard = {
        site: { id: "site-onboarded-1", name: input.siteName },
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
    if (path.endsWith("/identify")) {
      return Promise.resolve({ ...mockRegistrationSession.discoveredNodes[0], status: "identifying", identifyState: "blinking" });
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
      email: "operator@example.com",
      name: "Demo Operator",
      role: "admin",
      status: "active"
    };
    apiState.dashboard = null;
    apiState.registrationSession = null;
    apiState.commandStatus = null;
    window.history.replaceState({}, "", "/monitoring");
    vi.clearAllMocks();
    cleanup();
  });

  it("renders the login form when no authenticated session exists", async () => {
    authState.user = null;
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "LED Control 로그인" })).toBeInTheDocument();
    expect(screen.getByLabelText("아이디")).toBeInTheDocument();
    expect(screen.getByLabelText("비밀번호")).toBeInTheDocument();
    expect(screen.getByLabelText("자동 로그인")).toBeInTheDocument();
  });

  it("renders the four primary navigation items", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("link", { name: "모니터링" })).toHaveAttribute("href", "/monitoring");
    expect(screen.getByRole("link", { name: "제어" })).toHaveAttribute("href", "/control");
    expect(screen.getByRole("link", { name: "통계" })).toHaveAttribute("href", "/statistics");
    expect(screen.getByRole("link", { name: "설정" })).toHaveAttribute("href", "/settings");
  });

  it("renders the floor-plan settings route for an admin on refresh", async () => {
    window.history.pushState({}, "", "/settings/floor-plans");
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
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
    settingsSectionsFor("operator").filter((section) => !["/settings", "/settings/floor-plans"].includes(section.path))
  )("renders a destination for the $label settings link", async (section) => {
    window.history.pushState({}, "", `${section.path}?siteId=site-1`);
    authState.user = { ...authState.user!, role: "operator" };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: section.label })).toBeInTheDocument();
    expect(screen.getByText("이 설정 화면은 준비 중입니다.")).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { name: "운영 설정" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "현장 및 층" })).not.toBeInTheDocument();
  });

  it("renders the approved control center landmarks", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByText("B2 운영 현황")).toBeInTheDocument();
    expect(screen.getAllByText("관제 센터").length).toBeGreaterThan(0);
    expect(await screen.findByText("상세 패널")).toBeInTheDocument();
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
    expect(await screen.findByText("게이트웨이가 오프라인입니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "적용" })).toBeDisabled();
  });

  it("blocks a group when one of its fixtures is uncontrollable", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "그룹" }));
    expect(await screen.findByText("B2-L02: 조명이 오프라인입니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "적용" })).toBeDisabled();
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

    expect(await screen.findByText("설정 게이트웨이 (GW-SETTINGS-001)")).toBeInTheDocument();
    expect(screen.getByText("오프라인")).toBeInTheDocument();
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
    expect(await screen.findByText("B1 운영 현황")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B1-L01 정상 50%" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "B1-L02 정상 55%" }));
    expect(await screen.findByRole("heading", { name: "B1-L02" })).toBeInTheDocument();
    expect(screen.getByText("-56 dBm")).toBeInTheDocument();
    expect(screen.getByText("99%")).toBeInTheDocument();
  });

  it("keeps the monitoring floor map read only", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByText("B2 운영 현황")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "도면 편집" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("층 도면")).toBeInTheDocument();
  });

  it("does not expose floor editing from monitoring to viewers", async () => {
    authState.user = {
      id: "viewer-1",
      organizationId: "organization-1",
      email: "viewer@example.com",
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

    expect(await screen.findByText("B2 운영 현황")).toBeInTheDocument();
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
    expect(await screen.findByText("빠른 밝기 제어")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "통계" }));
    expect(await screen.findByText("에너지 리포트")).toBeInTheDocument();
    expect(screen.queryByText("18%")).not.toBeInTheDocument();
    expect(screen.queryByText("18:00-22:00")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "설정" }));
    expect(await screen.findByText("운영 설정")).toBeInTheDocument();
    expect(screen.queryByText("MVP 2 준비")).not.toBeInTheDocument();
    expect(screen.queryByText("통신 음영 검토")).not.toBeInTheDocument();
  });

  it("sends group dimming commands from the control screen", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "제어" }));
    fireEvent.click(await screen.findByRole("button", { name: "그룹" }));
    fireEvent.click(screen.getAllByRole("button", { name: /B2 Entrance Zone/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    fireEvent.click(screen.getByRole("button", { name: "적용" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/commands/dimming", {
        siteId: mockDashboard.site.id,
        targetType: "group",
        targetId: mockDashboard.groups[0].id,
        brightness: 30
      })
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
    const applyButton = screen.getByRole("button", { name: "적용" });
    await waitFor(() => expect(applyButton).toBeEnabled());
    fireEvent.click(applyButton);

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/commands/dimming", expect.any(Object)));
    expect(await screen.findByText("일부 조명 적용 실패", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("2 / 2 처리")).toBeInTheDocument();
    expect(screen.getByText("B2-L02: 장비 응답 오류")).toBeInTheDocument();
  });

  it("starts a lighting registration session from settings and shows discovered nodes", async () => {
    authState.user = { ...authState.user!, role: "operator" };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("link", { name: "설정" }));
    expect(await screen.findByText("조명 등록")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "조명 검색 시작" }));

    expect(await screen.findByText("LC-B2-001")).toBeInTheDocument();
    expect(screen.getByText("RSSI -54 dBm")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "점멸 확인" })[0]);
    expect(await screen.findByText("점멸 중")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "등록" })[0]);
    expect(await screen.findByText("등록 완료")).toBeInTheDocument();
  });

  it("shows lighting registration as the first action when no fixtures are registered", async () => {
    authState.user = { ...authState.user!, role: "operator" };
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

    fireEvent.click(await screen.findByRole("link", { name: "모니터링" }));
    expect(await screen.findByText("등록된 조명이 없습니다")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "조명 검색 시작" })).toBeInTheDocument();
  });

  it("hides commissioning controls from an admin for an existing site", async () => {
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

    expect(await screen.findByRole("heading", { name: "설치 담당자가 현장을 준비 중입니다" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "조명 검색 시작" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "설정" }));
    await screen.findByRole("heading", { name: "운영 설정" });
    expect(screen.queryByText("게이트웨이 등록")).not.toBeInTheDocument();
    expect(screen.queryByText("조명 등록")).not.toBeInTheDocument();
  });

  it("shows installation pending instead of SetupWizard for an admin with no accessible site", async () => {
    apiState.dashboard = {
      ...mockDashboard,
      site: { id: "", name: "" },
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

  it("moves from initial setup through gateway claim to lighting registration", async () => {
    authState.user = { ...authState.user!, role: "operator" };
    apiState.dashboard = {
      ...mockDashboard,
      site: { id: "", name: "" },
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
    fireEvent.change(await screen.findByLabelText("고객사명"), { target: { value: "고객사 A" } });
    fireEvent.change(await screen.findByLabelText("현장명"), { target: { value: "온보딩 주차장" } });
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울시 중구" } });
    fireEvent.click(screen.getByRole("button", { name: "초기 설정 완료" }));

    fireEvent.change(await screen.findByLabelText("제품 시리얼"), { target: { value: "GW-ONBOARD-001" } });
    fireEvent.change(screen.getByLabelText("일회성 등록 코드"), { target: { value: "claim-once" } });
    fireEvent.click(screen.getByRole("button", { name: "게이트웨이 등록" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "조명 검색 시작" })).toBeEnabled());
    expect(screen.getByText("B2")).toBeInTheDocument();
  });

});
