import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logout, type AuthUser } from "../../api/auth";
import { apiGet, apiPost } from "../../api/client";
import { detailRetainedFrom } from "../../api/detail-retention";
import type { Dashboard } from "../../api/queries";
import { CustomerShell } from "./CustomerShell";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { isActiveCommandSessionBlocked } from "../control/active-command-session";

vi.mock("../settings/floor-plans/FloorEditorRoute", () => ({ FloorEditorRoute: () => <p>맵 편집 화면</p> }));
vi.mock("../monitoring/MonitoringView", () => ({ MonitoringView: () => <p>모니터링 화면</p> }));
const controlConsumer = vi.hoisted(() => ({ actual: false }));
vi.mock("../control/ControlView", async original => {
  const actual = await original<typeof import("../control/ControlView")>();
  return { ControlView: (props: Parameters<typeof actual.ControlView>[0]) => controlConsumer.actual ? <actual.ControlView {...props} /> : <p>제어 화면</p> };
});
vi.mock("../statistics/StatisticsOverviewPage", () => ({ StatisticsOverviewPage: () => <p>통계 화면</p> }));
vi.mock("../statistics/reports/StatisticsReportsPage", () => ({ StatisticsReportsPage: () => <p>보고서 화면</p> }));
vi.mock("../../api/client", async (original) => ({
  ...await original<typeof import("../../api/client")>(),
  apiGet: vi.fn(),
  apiPost: vi.fn()
}));
vi.mock("../../api/auth", async (original) => ({
  ...await original<typeof import("../../api/auth")>(),
  logout: vi.fn().mockResolvedValue({ ok: true })
}));
const dashboardState = vi.hoisted(() => ({
  current: {
    data: undefined as ReturnType<typeof dashboardFor> | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn()
  }
}));
const sitesState = vi.hoisted(() => ({
  current: {
    data: [{ id: "site", name: "현장", customerName: "고객사" }],
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn()
  }
}));
vi.mock("../../api/queries", async (original) => ({
  ...await original<typeof import("../../api/queries")>(),
  useDashboard: () => dashboardState.current,
  useControlDashboard: () => dashboardState.current,
  useFloorMapSnapshot: () => ({ data: undefined, isLoading: false, error: null, isFetching: false }),
  useSites: () => sitesState.current
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

function dashboardFor(
  capabilities: { read: boolean; control: boolean; manage: boolean; commission: boolean },
  gateways: Dashboard["gateways"] = []
): Dashboard {
  return {
    generatedAt: "2026-09-24T00:00:00.000Z",
    monitoringPolicy: { gatewayOfflineAfterSeconds: 60, fixtureStaleAfterSeconds: 120 },
    site: { id: "site", name: "현장", customerName: "고객사", installationStatus: "installed" as const, address: null, tariffKwhRate: 160, timeZone: "Asia/Seoul" },
    summary: { totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, averageBrightness: 0 },
    gateways,
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
  it.each([[759.5, true], [760, false], [760.5, false]] as const)("publishes the strict CSS media contract at controlled width %s", (_width, compact) => {
    // Chromium rounds CSS iframe viewports to integer pixels. This controlled
    // media owner covers the requested fractional API boundary separately from
    // the real 759/760/761px browser tests; it is not a real-browser claim.
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(width < 760px)" ? compact : false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    renderShell("/control?siteId=site");
    expect(screen.queryByRole("navigation", { name: "모바일 주 메뉴" }) !== null).toBe(compact);
    expect(window.matchMedia).toHaveBeenCalledWith("(width < 760px)");
  });
  it.each(["ready", "loading", "error", "empty"])("keeps mobile brand and both action owners available with %s sites", state => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(width < 760px)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    if (state === "loading") sitesState.current.isLoading = true;
    if (state === "error") sitesState.current.error = new Error("unavailable");
    if (state === "empty") sitesState.current.data = [];
    renderShell("/settings?siteId=site");
    const header = document.querySelector("[data-shell-topbar]") as HTMLElement;
    expect(within(header).getByRole("img", { name: "킨다" })).toBeVisible();
    expect(within(header).getByRole("button", { name: "다크 모드로 변경" })).toBeEnabled();
    expect(within(header).getByRole("button", { name: /^알람센터/ })).toBeEnabled();
    const siteName = state === "ready" ? /현장 선택/ : state === "loading" ? "현장 목록 확인 중" : state === "error" ? "현장 목록 확인 불가" : "접근 가능한 현장 없음";
    expect(within(header).getByRole("button", { name: siteName })).toBeVisible();
  });
  it.each(["/monitoring", "/control", "/statistics/overview", "/settings"])("keeps server aggregate always visible on %s", async path => {
    renderShell(`${path}?siteId=site`);
    expect(screen.getByRole("region", { name: "현장 전체" })).toHaveTextContent("0대");
    expect(screen.queryByRole("button", { name: /현장 전체 보기/ })).not.toBeInTheDocument();
    await screen.findByTestId("shell-current-menu");
  });
  it("collapses the wide sidebar without remounting its route", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(min-width: 1024px)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    renderShell("/control?siteId=site");
    const route = await screen.findByText("제어 화면");
    fireEvent.click(screen.getByRole("button", { name: "사이드바 접기" }));
    expect(screen.getByRole("button", { name: "사이드바 펼치기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("제어 화면")).toBe(route);
    fireEvent.click(screen.getByRole("button", { name: "사이드바 펼치기" }));
    expect(screen.getByRole("button", { name: "사이드바 접기" })).toHaveAttribute("aria-expanded", "true");
    expect(apiPost).not.toHaveBeenCalled();
  });
  it("changes customer theme without remounting the route or clearing queries or sending commands", async () => {
    const client = new QueryClient(); const sentinel = { identity: "unchanged" };
    client.setQueryData(["theme-identity"], sentinel);
    const mounted = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/control?siteId=site#draft"]}><CustomerShell user={adminUser} /><LocationProbe /></MemoryRouter></QueryClientProvider>);
    const route = await screen.findByText("제어 화면");
    const beforePosts = vi.mocked(apiPost).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "다크 모드로 변경" }));
    expect(document.documentElement).toHaveAttribute("data-customer-theme", "dark");
    expect(screen.getByText("제어 화면")).toBe(route);
    expect(screen.getByTestId("location")).toHaveTextContent("/control?siteId=site#draft");
    expect(client.getQueryData(["theme-identity"])).toBe(sentinel);
    expect(vi.mocked(apiPost).mock.calls.length).toBe(beforePosts);
    mounted.unmount();
    expect(document.documentElement).not.toHaveAttribute("data-customer-theme");
    localStorage.removeItem("led-control.customer-theme.v1");
  });
  beforeEach(() => {
    controlConsumer.actual = false;
    vi.mocked(apiPost).mockReset();
    useFloorEditorStore.getState().reset();
    vi.mocked(logout).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(apiGet).mockReset().mockImplementation(async (path) => path.includes("monitoring-incidents")
      ? { incidents: [], activeCount: 0, unreadCount: 0, nextCursor: null }
      : { users: [], count: 0, limit: 100 });
    dashboardState.current = { data: dashboardFor({ read: true, control: true, manage: true, commission: true }), isLoading: false, error: null, refetch: vi.fn() };
    sitesState.current = { data: [{ id: "site", name: "현장", customerName: "고객사" }], isLoading: false, error: null, refetch: vi.fn() };
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it("forwards the existing navigation breakpoint to the real Control close action without resetting details", async () => {
    controlConsumer.actual = true;
    let onChange: ((event: MediaQueryListEvent) => void) | undefined;
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(width < 760px)",
      addEventListener: (_type: string, listener: typeof onChange) => { if (query === "(width < 760px)") onChange = listener; }, removeEventListener: vi.fn() })));
    const generatedAt = new Date().toISOString();
    const retainedFrom = new Date(detailRetainedFrom(Date.parse(generatedAt))).toISOString();
    const status = { id: "00000000-0000-4000-8000-000000009977", siteId: "site", stage: "verified_applied", outcome: "applied", createdAt: generatedAt, generatedAt, retainedFrom,
      dispatchCount: 0, completedFixtureCount: 0, totalFixtureCount: 0, errorMessage: null, dispatches: [] };
    vi.mocked(apiGet).mockImplementation(async path => path.startsWith("/commands?") ? { items: [status], nextCursor: null, generatedAt, retainedFrom }
      : path.startsWith("/commands/requiring-verification") ? { items: [], nextCursor: null, generatedAt }
      : path.startsWith("/commands/") ? status
        : path.includes("monitoring-incidents") ? { incidents: [], activeCount: 0, unreadCount: 0, nextCursor: null } : { users: [], count: 0, limit: 100 });
    renderShell("/control?siteId=site");
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(status.id) }));
    fireEvent.click(await screen.findByRole("button", { name: "상세 보기" }));
    const detail = screen.getByRole("region", { name: "최근 결과 상세" });
    expect(detail).toContainElement(screen.getByRole("button", { name: "명령 상세 닫기" }));
    act(() => onChange?.({ matches: false } as MediaQueryListEvent));
    expect(screen.getByRole("region", { name: "최근 결과 상세" })).toBe(detail);
    expect(detail).not.toContainElement(screen.getByRole("button", { name: "명령 상세 닫기" }));
    act(() => onChange?.({ matches: true } as MediaQueryListEvent));
    expect(detail).toContainElement(screen.getByRole("button", { name: "명령 상세 닫기" }));
    expect(screen.getAllByRole("button", { name: "명령 상세 닫기" })).toHaveLength(1);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("stale summary is rejected across scope transition", async () => {
    sitesState.current.data.push({ id: "site-2", name: "새 현장", customerName: "고객사" });
    dashboardState.current.data!.summary = { totalFixtures: 17, onlineFixtures: 12, faultFixtures: 2, averageBrightness: 50 };
    renderShell("/monitoring?siteId=site");
    const band = screen.getByRole("region", { name: "현장 전체" });
    expect(band).toHaveTextContent("17");
    expect(band).toHaveTextContent("—");
    fireEvent.click(screen.getByRole("button", { name: /현장 선택/ }));
    fireEvent.click(screen.getByRole("option", { name: "고객사 · 새 현장" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("siteId=site-2"));
    expect(screen.getByRole("region", { name: "현장 전체" })).not.toHaveTextContent("17");
    expect(screen.getByRole("region", { name: "현장 전체" })).toHaveTextContent("새 현장");
  });

  it.each(["viewer", "admin", "no-site", "pending", "loading", "error"])("account escape remains available for %s", async state => {
    const user = state === "viewer" ? { ...adminUser, role: "viewer" as const } : adminUser;
    if (state === "no-site") sitesState.current.data = [];
    if (state === "pending") dashboardState.current.data!.site.installationStatus = "pending";
    if (state === "loading" || state === "error" || state === "no-site") dashboardState.current = { data: undefined, isLoading: state === "loading", error: state === "error" ? new Error("private") : null, refetch: vi.fn() };
    renderShell("/settings?siteId=site", user);
    const account = screen.getByRole("region", { name: "내 계정" });
    expect(within(account).getByRole("button", { name: "로그아웃" })).toBeEnabled();
    expect(account).toHaveTextContent(user.name);
    expect(account).toHaveTextContent(user.loginId);
  });

  it("dirty cancel preserves draft and logout failure restores initiating focus", async () => {
    useFloorEditorStore.setState({ isDirty: true });
    renderShell("/settings?siteId=site");
    const trigger = within(screen.getByRole("region", { name: "내 계정" })).getByRole("button", { name: "로그아웃" });
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "로그아웃 확인" })).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(useFloorEditorStore.getState().isDirty).toBe(true);
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent("siteId=site");
    vi.mocked(logout).mockRejectedValueOnce(new Error("private"));
    act(() => useFloorEditorStore.setState({ isDirty: false }));
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("region", { name: "내 계정" })).toHaveTextContent("로그아웃에 실패했습니다"));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(isActiveCommandSessionBlocked(adminUser.id)).toBe(false);
  });

  it("데스크톱 셸에 킨다 관제 센터 브랜드를 표시한다", () => {
    renderShell("/monitoring?siteId=site");

    expect(screen.getByRole("img", { name: "킨다 관제 센터" })).toBeVisible();
    expect(screen.queryByText(/LED\s+Control/)).not.toBeInTheDocument();
  });

  it.each(["/control", "/settings", "/statistics/overview"])("keeps the ordinary %s document-scroll layout outside monitoring", async (path) => {
    renderShell(`${path}?siteId=site`);
    const main = screen.getByRole("main");
    expect(main.parentElement).toHaveClass("min-h-screen");
    expect(main.parentElement).not.toHaveClass("h-dvh", "overflow-hidden");
    expect(main).not.toHaveClass("min-h-0", "overflow-hidden");
    const content = main.querySelector("[data-shell-content]");
    expect(content).not.toHaveClass("flex", "min-h-0", "overflow-hidden");
  });

  it("shows authorized sites globally and switches only the siteId in the current route", async () => {
    sitesState.current.data = [
      { id: "site", name: "본사", customerName: "고객사 A" },
      { id: "site-2", name: "물류센터", customerName: "고객사 B" }
    ];
    renderShell("/statistics/overview?siteId=site&source=summary#energy");

    fireEvent.click(screen.getByRole("button", { name: /현장 선택/ }));
    fireEvent.click(screen.getByRole("option", { name: "고객사 B · 물류센터" }));

    expect(screen.queryByRole("dialog", { name: "현장 변경" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/statistics/overview?siteId=site-2&source=summary#energy"));
  });

  it("does not present an out-of-contract URL site as the selected option", () => {
    sitesState.current.data = [{ id: "site", name: "본사", customerName: "고객사 A" }];
    renderShell("/monitoring?siteId=outside");

    expect(screen.getByRole("button", { name: /현장 선택/ })).toHaveTextContent("현장 선택");
    expect(screen.getByRole("button", { name: /현장 선택/ })).not.toHaveTextContent("outside");
  });

  it("exposes a site-list failure through the status center without enabling a false selector", async () => {
    sitesState.current = { data: [], isLoading: false, error: new Error("private"), refetch: vi.fn() };
    renderShell("/monitoring?siteId=site");

    expect(screen.getByRole("button", { name: "현장 목록 확인 불가" })).toBeDisabled();
    const statusTrigger = await screen.findByRole("button", { name: "알람센터, 현장 미선택" });
    fireEvent.click(statusTrigger);
    expect(await screen.findByRole("dialog", { name: "알람센터" })).toHaveTextContent("현장 목록을 확인하지 못했습니다.");
  });

  it("keeps the gateway aggregate inside the status drawer without a second topbar control", async () => {
    dashboardState.current.data = dashboardFor(
      { read: true, control: true, manage: true, commission: true },
      [
        { id: "gateway-1", name: "Gateway 1", serialNumber: "GW-1", firmwareVersion: "1.0.0", lastHeartbeatAt: null, connectionStatus: "online" },
        { id: "gateway-2", name: "Gateway 2", serialNumber: "GW-2", firmwareVersion: "1.0.0", lastHeartbeatAt: null, connectionStatus: "offline" }
      ]
    );
    renderShell("/monitoring?siteId=site");

    expect(screen.queryByRole("button", { name: /게이트웨이 .*상태 센터 열기/ })).not.toBeInTheDocument();
    const statusTrigger = await screen.findByRole("button", { name: "알람센터, 미읽음 0건" });
    fireEvent.click(statusTrigger);

    const dialog = await screen.findByRole("dialog", { name: "알람센터" });
    expect(dialog).toHaveTextContent("게이트웨이 1/2대 연결");
    expect(dialog).toHaveTextContent("확인이 필요한 게이트웨이가 있습니다.");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(statusTrigger).toHaveFocus());
  });

  it("logs out immediately when there is no dirty editor state", async () => {
    renderShell("/settings?siteId=site");
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    expect(screen.queryByRole("alertdialog", { name: "로그아웃 확인" })).not.toBeInTheDocument();
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
  });

  it.each([
    ["/monitoring?siteId=site", "모니터링"],
    ["/control?siteId=site", "제어"],
    ["/statistics/overview?siteId=site", "통계"],
    ["/settings?siteId=site", "설정"]
  ])("shows the current menu title for %s", async (path, title) => {
    renderShell(path);
    expect(await screen.findByTestId("shell-current-menu")).toHaveTextContent(title);
    expect(screen.queryByText("현장 관제")).not.toBeInTheDocument();
  });

  it("updates the current menu title after a capability redirect", async () => {
    dashboardState.current.data = dashboardFor({ read: true, control: false, manage: false, commission: false });
    renderShell("/control?siteId=site", { ...adminUser, id: "viewer", loginId: "viewer", role: "viewer" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/monitoring?siteId=site"));
    expect(screen.getByTestId("shell-current-menu")).toHaveTextContent("모니터링");
  });

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

  it("gives the editor outlet the remaining height after the settings navigation row", async () => {
    renderShell("/settings/floor-plans/floor-b2/edit?siteId=site");

    const settingsShell = (await screen.findByRole("navigation", { name: "설정 메뉴" })).closest("section");
    expect(settingsShell).not.toBeNull();
    expect(settingsShell?.parentElement).toHaveClass("[&>section:last-child]:grid-rows-[auto_minmax(min-content,1fr)]");
    expect(settingsShell?.parentElement).not.toHaveClass("[&>section]:grid-rows-[auto_auto_minmax(0,1fr)]");
  });

  it("lets only the editor intrinsic minimum extend the document on short screens", async () => {
    renderShell("/settings/floor-plans/floor-b2/edit?siteId=site");
    const settingsShell = (await screen.findByRole("navigation", { name: "설정 메뉴" })).closest("section");
    const content = settingsShell?.parentElement;
    expect(content).toHaveClass("min-h-min", "grid-rows-[auto_minmax(min-content,1fr)]");
    expect(content).not.toHaveClass("overflow-hidden");
    expect(content?.closest("main")).not.toHaveClass("overflow-hidden");
    expect(content?.closest("[data-app-shell]")).toHaveClass("min-h-dvh");
    expect(content?.closest("[data-app-shell]")).not.toHaveClass("h-dvh", "overflow-hidden");
    expect(screen.getByRole("region", { name: "내 계정" })).toBeVisible();
  });

  it("links the primary statistics item to overview and keeps it active on statistics child routes", async () => {
    renderShell("/statistics/overview?siteId=site");

    const statisticsLink = await screen.findByRole("link", { name: "통계" });
    expect(statisticsLink).toHaveAttribute("href", "/statistics/overview?siteId=site");
    expect(statisticsLink).toHaveAttribute("aria-current", "page");
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

  it("keeps manage-capable users on the operational site settings route", async () => {
    renderShell("/settings/site?siteId=site");

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/site?siteId=site");
  });

  it("hides and replaces operational site settings for viewers", async () => {
    dashboardState.current = { data: dashboardFor({ read: true, control: false, manage: false, commission: false }), isLoading: false, error: null, refetch: vi.fn() };

    renderShell("/settings/site?siteId=site", { ...adminUser, id: "viewer", loginId: "viewer", role: "viewer" });

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings?siteId=site"));
    expect(screen.queryByRole("link", { name: "현장 관리" })).not.toBeInTheDocument();
  });
});
