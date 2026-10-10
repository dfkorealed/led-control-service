import { act, cleanup, fireEvent, render as testingRender, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerThemeProvider, ThemeToggle, SessionStatusCenter, SessionStatusProvider, ToastRegion } from "../../components/ui";
import * as apiClient from "../../api/client";
import { CustomerShell } from "../shells/CustomerShell";
import { MonitoringView } from "./MonitoringView";

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return testingRender(ui, {
    wrapper: ({ children }) => <QueryClientProvider client={client}><SessionStatusProvider>{children}<SessionStatusCenter /><ToastRegion /></SessionStatusProvider></QueryClientProvider>
  });
}

function openInspector() {
  fireEvent.click(screen.getByRole("button", { name: "조명 검색·상세" }));
  return screen.getByRole("dialog", { name: "조명 검색·상세" });
}

async function selectStatusFilter(name: string) {
  if (!screen.queryByRole("dialog", { name: "조명 검색·상세" })) openInspector();
  await chooseSelect("상태 필터", name === "전체 조명" ? "전체" : name);
}

function closeInspector() {
  fireEvent.click(screen.getByRole("button", { name: screen.queryByRole("dialog", { name: "조명 상세" }) ? "조명 상세 닫기" : "조명 검색·상세 닫기" }));
}

// Detail regressions explicitly choose a pin; finder-opening tests use
// openInspector directly so they can catch accidental automatic selection.
function openDetails(name?: string) {
  const marker = name ? screen.getByRole("button", { name: new RegExp(`^${name} `) })
    : document.querySelector<HTMLButtonElement>('[data-spatial-map-marker][data-selected="true"]') ?? document.querySelector<HTMLButtonElement>('[data-spatial-map-marker]')!;
  fireEvent.click(marker);
  openInspector();
  fireEvent.click(screen.getByRole("button", { name: "상세 보기" }));
  return screen.getByRole("dialog", { name: "조명 상세" });
}

function openCurrentStatus() {
  fireEvent.click(screen.getByRole("button", { name: "알람센터, 현장 미선택" }));
  return screen.getByRole("region", { name: "현재 화면 상태" });
}

function floorMetric(label: string) {
  return within(screen.getByRole("region", { name: "선택 층 조명 현황" })).getByText(label).parentElement!;
}

const queryMocks = vi.hoisted(() => ({
  useDashboard: vi.fn(),
  useSites: vi.fn(),
  useFloorFixtures: vi.fn(),
  useFloorMapSnapshot: vi.fn()
}));
const refreshApi = vi.hoisted(() => ({ waitForMonitoringRefresh: vi.fn() }));
const activityApi = vi.hoisted(() => ({ useMonitoringActivity: vi.fn() }));
const authApi = vi.hoisted(() => ({ useCurrentUser: vi.fn() }));
vi.mock("../../api/monitoring-refresh", () => refreshApi);
vi.mock("./useMonitoringActivity", () => ({
  ...activityApi,
  monitoringActivityScopeKey: (principal: string, siteId: string, floorId: string) => ["monitoring-activity", principal, siteId, floorId]
}));
vi.mock("../../api/auth", async original => ({ ...await original<typeof import("../../api/auth")>(), ...authApi }));

vi.mock("../../api/queries", () => queryMocks);
vi.mock("../registration/RegistrationPanel", () => ({
  RegistrationPanel: () => <section aria-label="조명 등록 패널">조명 등록 패널</section>
}));

const dashboard = {
  site: { id: "site-1", name: "테스트 현장", timeZone: "Asia/Seoul" },
  summary: { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, offlineFixtures: 0, averageBrightness: 70 },
  floors: [{ id: "floor-1", name: "B1", level: -1, floorPlan: null, summary: { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, offlineFixtures: 0 }, fixtures: [] }],
  groups: [],
  gateways: [{ id: "gateway-1", name: "GW-1", connectionStatus: "online" }]
};

const fixture = {
  id: "fixture-1",
  name: "B1-L001",
  x: 100,
  y: 100,
  ratedWatt: 40,
  brightness: 70,
  status: "online" as const,
  statusReason: "reported" as const,
  rssi: null,
  hopCount: null,
  commandSuccessRate: null,
  lastSeenAt: "2026-08-19T01:00:00.000Z",
  health: { faultCodes: [4], observedAt: "2026-08-19T01:00:01.000Z" },
  gateway: { id: "gateway-1", name: "GW-1", connectionStatus: "online" as const },
  controllable: true,
  controlBlockReason: null
};

describe("MonitoringView refresh", () => {
  const refetchDashboard = vi.fn();
  const refetchFixtures = vi.fn();
  const refetchMap = vi.fn();

  it("shares search and list entry state while returning focus to the actual opener", async () => {
    render(<MemoryRouter><MonitoringView siteId="site-1" /></MemoryRouter>);
    const searchTrigger = screen.getByRole("button", { name: "조명 검색·상세" });
    searchTrigger.focus();
    const inspector = openInspector();
    fireEvent.change(within(inspector).getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }), { target: { value: "L001" } });
    closeInspector();
    await waitFor(() => expect(searchTrigger).toHaveFocus());
    const listTrigger = screen.getByRole("button", { name: "조명 목록" });
    listTrigger.focus();
    fireEvent.click(listTrigger);
    const listDialog = screen.getByRole("dialog", { name: "조명 검색·상세" });
    expect(within(listDialog).getByRole("searchbox", { name: "조명 이름 또는 번호 검색" })).toHaveValue("L001");
    expect(within(listDialog).getByRole("list", { name: "조명 목록" })).toHaveTextContent("B1-L001");
    closeInspector();
    await waitFor(() => expect(listTrigger).toHaveFocus());
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the real shell's single monitoring h1 in the page header (%s)", async compact => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(width < 760px)" ? compact : query === "(min-width: 1024px)" && !compact, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: { ...dashboard,
      site: { ...dashboard.site, installationStatus: "installed" }, capabilities: { read: true, control: true, manage: true, commission: true } } });
    const read = vi.spyOn(apiClient, "apiGet").mockResolvedValue({ incidents: [], unreadCount: 0, activeCount: 0, nextCursor: null });
    try {
      render(<MemoryRouter initialEntries={["/monitoring?siteId=site-1"]}><CustomerShell user={{ id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "admin", name: "관리자", role: "admin", status: "active", mustChangePassword: false }} /></MemoryRouter>);
      await screen.findByRole("region", { name: "선택 층 조명 현황" });
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.getByTestId("shell-current-menu")).toHaveTextContent("모니터링");
      expect(screen.getByRole("heading", { level: 1, name: "모니터링" }).closest("header")).toContainElement(screen.getByRole("button", { name: "새로고침" }));
    } finally { read.mockRestore(); }
  });

  it("keeps one screen safe-space owner after moving refresh above the map", () => {
    render(<MonitoringView siteId="site-1" />);
    const refresh = screen.getByRole("button", { name: "새로고침" });
    expect(document.querySelector("[data-monitoring-screen]")).toHaveClass("max-compact:pb-shell-navigation-safe");
    expect(refresh.parentElement).not.toHaveClass("max-compact:pb-shell-navigation-safe");
    expect(document.querySelector("[data-monitoring-map-panel]")).not.toHaveClass("max-compact:pb-shell-navigation-safe");
  });

  it("keeps the compact map and ticker in natural flow after the refresh header", () => {
    render(<MonitoringView siteId="site-1" />);
    expect(document.querySelector("[data-monitoring-layout]")).toHaveClass("max-compact:min-h-min", "max-compact:flex-none");
    expect(screen.getByRole("button", { name: "새로고침" }).compareDocumentPosition(document.querySelector("[data-monitoring-layout]")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it.each(["light", "dark"])("uses server floor counts rather than loaded pins in both themes (%s)", theme => {
    localStorage.setItem("led-control.customer-theme.v1", theme);
    queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: { ...dashboard,
      floors: [{ ...dashboard.floors[0], summary: { totalFixtures: 24, onlineFixtures: 20, faultFixtures: 0, offlineFixtures: 4 } }] } });
    queryMocks.useFloorFixtures.mockReturnValue({ ...queryMocks.useFloorFixtures(), data: { pages: [{ items: [fixture, { ...fixture, id: "fixture-2" }], nextCursor: "more", generatedAt: new Date().toISOString() }] }, hasNextPage: true });
    render(<CustomerThemeProvider><MonitoringView siteId="site-1" /></CustomerThemeProvider>);
    const summary = screen.getByRole("region", { name: "선택 층 조명 현황" });
    expect(within(summary).getByText("전체 조명").parentElement).toHaveTextContent("24");
    expect(within(summary).getByText("점검 필요").parentElement).toHaveTextContent("0");
    expect(summary.closest("[data-operation-map-chrome]")).not.toBeNull();
    expect(document.documentElement).toHaveAttribute("data-customer-theme", theme);
    localStorage.clear();
  });

  it("does not advance server update time after failed refresh", async () => {
    const timestamp = "2026-10-03T15:59:00.000Z";
    queryMocks.useFloorFixtures.mockReturnValue({ ...queryMocks.useFloorFixtures(), data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: timestamp }] } });
    refetchFixtures.mockRejectedValueOnce(new Error("offline"));
    render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled());
    expect(screen.getByText(/마지막 갱신:/).querySelector("time")).toHaveAttribute("datetime", timestamp);
    expect(screen.getByText(/마지막 갱신:/)).toHaveTextContent("2026-10-04 00:59:00");
  });

  it("keeps selected pin during theme change", () => {
    localStorage.clear();
    render(<CustomerThemeProvider><ThemeToggle /><MonitoringView siteId="site-1" /></CustomerThemeProvider>);
    const pin = screen.getByRole("button", { name: /B1-L001/ });
    fireEvent.click(pin);
    fireEvent.click(screen.getByRole("button", { name: "다크 모드로 변경" }));
    expect(screen.getByRole("button", { name: /B1-L001/ })).toBe(pin);
    expect(pin).toHaveAttribute("data-selected", "true");
    expect(document.documentElement).toHaveAttribute("data-customer-theme", "dark");
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
    localStorage.clear();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authApi.useCurrentUser.mockReturnValue({ data: { user: { id: "user-1", organizationId: "org-1" } } });
    queryMocks.useSites.mockReturnValue({ data: [{ id: "site-1", name: "테스트 현장", customerName: "고객사" }], isLoading: false, error: null, refetch: vi.fn() });
    activityApi.useMonitoringActivity.mockReturnValue({ data: { generatedAt: new Date().toISOString(), retainedFrom: "2026-06-25T00:00:00.000Z", items: [], nextCursor: null }, error: null, isPending: false, isRefetchError: false, refetch: vi.fn() });
    refreshApi.waitForMonitoringRefresh.mockReset().mockResolvedValue({ status: "completed" });
    const currentGeneratedAt = new Date().toISOString();
    refetchDashboard.mockResolvedValue({ data: dashboard });
    refetchFixtures.mockResolvedValue({ data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: currentGeneratedAt }] } });
    refetchMap.mockResolvedValue({ data: mapSnapshot });
    queryMocks.useDashboard.mockReturnValue({
      data: dashboard,
      isLoading: false,
      error: null,
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      refetch: refetchDashboard
    });
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: currentGeneratedAt }] },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      error: null,
      isPending: false,
      isLoading: false,
      isFetching: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });
    queryMocks.useFloorMapSnapshot.mockReturnValue({
      data: mapSnapshot,
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      error: null,
      isPending: false,
      isLoading: false,
      isFetching: false,
      refetch: refetchMap
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("combines status and search in one anchored popover without opening an unselected detail", () => {
    render(<MonitoringView siteId="site-1" />);
    expect(screen.queryByRole("button", { name: /맵 조명 상태 필터 상세 필터/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/표시 상태:/)).not.toBeInTheDocument();
    const finder = openInspector();
    expect(finder.closest("[data-placement]")).not.toBeNull();
    expect(within(finder).getByRole("button", { name: "상태 필터" })).toBeVisible();
    expect(within(finder).getByRole("searchbox", { name: "조명 이름 또는 번호 검색" })).toBeVisible();
    expect(within(finder).queryByRole("button", { name: "상세 보기" })).not.toBeInTheDocument();
  });

  async function openDesktopCondition(condition: "fault" | "search" | "placement" | "deletion", focusOpener = true) {
    vi.stubGlobal("matchMedia", vi.fn((media: string) => ({ matches: media === "(min-width: 1024px)", media, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    queryMocks.useFloorFixtures().data.pages[0].items = [{ ...fixture, status: "fault", placementStatus: condition === "placement" ? "unplaced" : "placed" }];
    const view = render(<MonitoringView siteId="site-1" userRole="viewer" />);
    const finder = openInspector();
    if (condition === "search") fireEvent.change(within(finder).getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }), { target: { value: fixture.name } });
    else if (condition !== "deletion") {
      fireEvent.click(within(finder).getByRole("button", { name: "조명 목록 보기" }));
      await chooseSelect("상태 필터", condition === "fault" ? "점검 필요" : "미배치");
    }
    fireEvent.click(within(finder).getByRole("button", { name: "상세 조명 선택" }));
    fireEvent.click(await screen.findByRole("option", { name: /B1-L001/ }));
    const opener = within(finder).getByRole("button", { name: "상세 보기" });
    if (focusOpener) opener.focus();
    fireEvent.click(opener);
    const detail = screen.getByRole("complementary", { name: "조명 상세" });
    // Let the old finder portal's return lifecycle finish before focusing the
    // desktop detail; its late return is not automatic-removal evidence.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
    const close = within(detail).getByRole("button", { name: "조명 상세 닫기" });
    close.focus();
    expect(close).toHaveFocus();
    expect(opener.isConnected).toBe(false);
    return { view, detail };
  }

  function exitDesktopCondition(condition: "fault" | "search" | "placement" | "deletion") {
    queryMocks.useFloorFixtures().data.pages[0].items = condition === "deletion" ? [] : [{ ...fixture, health: null, status: "online", name: condition === "search" ? "다른 이름" : fixture.name, placementStatus: "placed" }];
  }

  it.each(["fault", "search", "placement", "deletion"] as const)("N1 restores monitoring fallback when focused desktop detail is automatically removed by %s", async condition => {
    const { view } = await openDesktopCondition(condition);
    exitDesktopCondition(condition);
    view.rerender(<MonitoringView siteId="site-1" userRole="viewer" />);
    expect(screen.queryByRole("complementary", { name: "조명 상세" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "조명 검색·상세" })).toHaveFocus();
    expect(document.querySelector('[data-spatial-map-marker][data-selected="true"]')).not.toBeInTheDocument();
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
  });

  it("N1 preserves intentional outside focus during automatic desktop removal", async () => {
    const { view } = await openDesktopCondition("fault");
    const outside = screen.getByRole("button", { name: "새로고침" });
    outside.focus();
    exitDesktopCondition("fault");
    view.rerender(<MonitoringView siteId="site-1" userRole="viewer" />);
    expect(screen.queryByRole("complementary", { name: "조명 상세" })).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
    await act(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    expect(outside).toHaveFocus();
  });

  it("N1 rejects a connected noninteractive original focus target", async () => {
    const { view } = await openDesktopCondition("fault", false);
    exitDesktopCondition("fault");
    view.rerender(<MonitoringView siteId="site-1" userRole="viewer" />);
    expect(screen.getByRole("button", { name: "조명 검색·상세" })).toHaveFocus();
  });

  it.each(["principal", "site", "floor", "unmount"] as const)("N1 never schedules stale focus after %s scope exit", async scope => {
    if (scope === "floor") queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: { ...dashboard, floors: [...dashboard.floors, { ...dashboard.floors[0], id: "floor-2", name: "B2" }] } });
    const { view } = await openDesktopCondition("fault");
    const outside = document.createElement("button");
    outside.textContent = "다른 화면의 작업";
    document.body.append(outside);
    try {
      if (scope === "principal") {
        authApi.useCurrentUser.mockReturnValue({ data: { user: { id: "user-2", organizationId: "org-1" } } });
        exitDesktopCondition("fault");
        view.rerender(<MonitoringView siteId="site-1" userRole="viewer" />);
        expect(screen.getByRole("button", { name: "조명 검색·상세" })).not.toHaveFocus();
      } else if (scope === "site") view.rerender(<MonitoringView siteId="site-2" userRole="viewer" />);
      else if (scope === "floor") {
        outside.focus();
        await chooseSelect("맵 선택", "B2");
      } else view.unmount();
      outside.focus();
      await act(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      expect(outside).toHaveFocus();
      expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
    } finally { outside.remove(); }
  });

  it("keeps initial selection empty on runtime arrival and finder opening", () => {
    render(<MonitoringView siteId="site-1" />);
    expect(document.querySelector('[data-spatial-map-marker]')).toHaveAttribute("data-selected", "false");
    const finder = openInspector();
    expect(within(finder).queryByRole("complementary", { name: "선택 조명 상세" })).not.toBeInTheDocument();
    expect(within(finder).getByRole("button", { name: "상세 조명 선택" })).not.toHaveTextContent("B1-L001");
  });

  it("clears explicit selection on a status filter instead of selecting the first result", async () => {
    render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: /B1-L001/ }));
    await screen.findByRole("dialog", { name: "B1-L001 조명 정보" });
    await selectStatusFilter("정상");
    expect(document.querySelector('[data-spatial-map-marker]')).toHaveAttribute("data-selected", "false");
    expect(screen.queryByRole("complementary", { name: "선택 조명 상세" })).not.toBeInTheDocument();
  });

  it("retains an explicitly clicked pin while clearing its previous status filter atomically", async () => {
    render(<MonitoringView siteId="site-1" />);
    await selectStatusFilter("오프라인");
    closeInspector();
    fireEvent.click(screen.getByRole("button", { name: /B1-L001/ }));
    expect(document.querySelector('[data-spatial-map-marker]')).toHaveAttribute("data-selected", "true");
    const finder = openInspector();
    expect(within(finder).getByRole("button", { name: "상태 필터" })).toHaveTextContent("전체");
    expect(within(finder).getByRole("button", { name: "상세 조명 선택" })).toHaveTextContent("B1-L001");
  });

  it("map status reset preserves a nonempty finder search across close and reopen", async () => {
    render(<MonitoringView siteId="site-1" />);
    await selectStatusFilter("정상");
    const finder = screen.getByRole("dialog", { name: "조명 검색·상세" });
    fireEvent.change(within(finder).getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }), { target: { value: "B1-L001" } });
    closeInspector();
    const reopened = openInspector();
    fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(within(reopened).getByRole("searchbox", { name: "조명 이름 또는 번호 검색" })).toHaveValue("B1-L001");
    expect(within(reopened).queryByRole("complementary", { name: "선택 조명 상세" })).not.toBeInTheDocument();
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
    expect(within(reopened).getByRole("button", { name: "상태 필터" })).toHaveTextContent("전체");
    closeInspector();
    expect(document.querySelector('[data-spatial-map-marker]')).toHaveAttribute("data-selected", "false");
  });

  it("clears a deleted selection without substituting the remaining runtime row", () => {
    const second = { ...fixture, id: "fixture-2", name: "B1-L002" };
    const view = render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: /B1-L001/ }));
    queryMocks.useFloorFixtures().data.pages[0].items = [second];
    view.rerender(<MonitoringView siteId="site-1" />);
    expect(screen.getByRole("button", { name: /B1-L002/ })).toHaveAttribute("data-selected", "false");
    expect(screen.queryByRole("complementary", { name: "선택 조명 상세" })).not.toBeInTheDocument();
  });

  it("keeps the explicit saved pin while runtime is pending and never borrows another row", async () => {
    const snapshot = { ...mapSnapshot, fixtures: [{ id: "saved-only", name: "저장된 조명", x: 100, y: 100, size: 20 }] };
    queryMocks.useFloorMapSnapshot().data = snapshot;
    queryMocks.useFloorFixtures.mockReturnValue({ ...queryMocks.useFloorFixtures(), data: undefined, isPending: true, isFetching: true });
    const view = render(<MonitoringView siteId="site-1" />);
    const marker = screen.getByRole("button", { name: "저장된 조명 조명 정보 확인 전" });
    fireEvent.click(marker);
    const pin = await screen.findByRole("dialog", { name: "저장된 조명 조명 정보" });
    fireEvent.click(within(pin).getByRole("button", { name: "상세 보기" }));
    expect(screen.getByRole("dialog", { name: "조명 상세" })).toHaveTextContent("조명 정보 확인 전 · 상태를 불러오는 중");
    queryMocks.useFloorFixtures.mockReturnValue({ ...queryMocks.useFloorFixtures(), data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: new Date().toISOString() }] }, isPending: false, isFetching: false });
    view.rerender(<MonitoringView siteId="site-1" />);
    expect(screen.getByRole("dialog", { name: "조명 상세" })).not.toHaveTextContent("B1-L001");
    expect(marker).toHaveAttribute("data-selected", "true");
  });

  it.each(["fault", "search", "placement"] as const)("clears confirmed runtime selection that exits the current %s condition", async (condition) => {
    queryMocks.useFloorFixtures().data.pages[0].items = [{ ...fixture, status: "fault", placementStatus: condition === "placement" ? "unplaced" : "placed" }];
    const view = render(<MonitoringView siteId="site-1" userRole="viewer" />);
    const finder = openInspector();
    if (condition === "search") fireEvent.change(within(finder).getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }), { target: { value: "B1-L001" } });
    else {
      fireEvent.click(within(finder).getByRole("button", { name: "조명 목록 보기" }));
      fireEvent.click(within(finder).getByRole("button", { name: "상태 필터" }));
      fireEvent.click(await screen.findByRole("option", { name: condition === "fault" ? /^점검 필요$/ : /^미배치$/ }));
    }
    fireEvent.click(within(finder).getByRole("button", { name: "상세 조명 선택" }));
    fireEvent.click(await screen.findByRole("option", { name: /B1-L001/ }));
    fireEvent.click(within(finder).getByRole("button", { name: "상세 보기" }));
    expect(screen.getByRole("dialog", { name: "조명 상세" })).toBeVisible();
    const updated = { ...fixture, status: "online", health: null, name: condition === "search" ? "다른 이름" : fixture.name, placementStatus: "placed" };
    queryMocks.useFloorFixtures().data.pages[0].items = [updated];
    view.rerender(<MonitoringView siteId="site-1" userRole="viewer" />);
    expect(screen.queryByRole("dialog", { name: "조명 상세" })).not.toBeInTheDocument();
    expect(document.querySelector('[data-spatial-map-marker][data-selected="true"]')).not.toBeInTheDocument();
    expect(document.querySelector("[data-monitoring-pin-popover]")).not.toBeInTheDocument();
    const reopened = openInspector();
    expect(within(reopened).queryByRole("button", { name: "상세 보기" })).not.toBeInTheDocument();
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
  });

  it.each(["partial", "error"] as const)("keeps an explicitly selected saved pin with missing runtime during %s retrieval", async (state) => {
    const snapshot = { ...mapSnapshot, fixtures: [{ id: "saved-only", name: "저장된 조명", x: 100, y: 100, size: 20 }] };
    queryMocks.useFloorMapSnapshot().data = snapshot;
    queryMocks.useFloorFixtures.mockReturnValue({ ...queryMocks.useFloorFixtures(), hasNextPage: state === "partial", error: state === "error" ? new Error("runtime unavailable") : null });
    render(<MonitoringView siteId="site-1" />);
    const marker = screen.getByRole("button", { name: "저장된 조명 조명 정보 확인 전" });
    fireEvent.click(marker);
    const pin = await screen.findByRole("dialog", { name: "저장된 조명 조명 정보" });
    fireEvent.click(within(pin).getByRole("button", { name: "상세 보기" }));
    expect(screen.getByRole("dialog", { name: "조명 상세" })).toHaveTextContent("저장된 조명");
    expect(screen.getByRole("dialog", { name: "조명 상세" })).toHaveTextContent("정보 확인 전 · 상태를 불러오는 중");
    expect(marker).toHaveAttribute("data-selected", "true");
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
  });

  it("clears explicit selection on principal switch", () => {
    const view = render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: /B1-L001/ }));
    authApi.useCurrentUser.mockReturnValue({ data: { user: { id: "user-2", organizationId: "org-1" } } });
    view.rerender(<MonitoringView siteId="site-1" />);
    expect(screen.getByRole("button", { name: /B1-L001/ })).toHaveAttribute("data-selected", "false");
  });

  it("keeps site and floor registered counts independent of a partial fixture page and map pins", () => {
    queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: {
      ...dashboard,
      summary: { ...dashboard.summary, totalFixtures: 248, onlineFixtures: 237, faultFixtures: 7, offlineFixtures: 4 },
      floors: [{ ...dashboard.floors[0], summary: { totalFixtures: 62, onlineFixtures: 57, faultFixtures: 3, offlineFixtures: 2 } }]
    } });
    queryMocks.useFloorFixtures.mockReturnValue({
      ...queryMocks.useFloorFixtures(),
      data: { pages: [{ items: [fixture], nextCursor: "more", generatedAt: new Date().toISOString() }] },
      hasNextPage: true
    });
    queryMocks.useFloorMapSnapshot.mockReturnValue({ ...queryMocks.useFloorMapSnapshot(), data: {
      ...mapSnapshot,
      fixtures: [{ id: fixture.id, name: fixture.name, x: 100, y: 100, size: 20 }]
    } });
    render(<MonitoringView siteId="site-1" />);

    expect(screen.queryByRole("region", { name: "현장 전체 조명 현황" })).not.toBeInTheDocument();
    expect(screen.getByText("B1 · 조명 현황")).toBeVisible();
    expect(floorMetric("전체 조명")).toHaveTextContent("62");
    expect(screen.getByRole("button", { name: /B1-L001/ })).toBeInTheDocument();
  });

  it("opens actual activity with zero registered fixtures without a device command", async () => {
    queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: {
      ...dashboard,
      summary: { ...dashboard.summary, totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, offlineFixtures: 0 },
      floors: [{ ...dashboard.floors[0], summary: { totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, offlineFixtures: 0 } }]
    } });
    queryMocks.useFloorFixtures.mockReturnValue({ ...queryMocks.useFloorFixtures(), data: { pages: [{ items: [], nextCursor: null, generatedAt: new Date().toISOString() }] } });
    activityApi.useMonitoringActivity.mockReturnValue({ data: {
      generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z",
      items: [{ id: "00000000-0000-4000-8000-000000000010", kind: "monitoring_refresh_result", recordedAt: "2026-09-25T00:00:00.000Z", refreshStatus: "completed" }],
      nextCursor: null
    }, error: null, isPending: false, isRefetchError: false, refetch: vi.fn() });
    render(<MemoryRouter><MonitoringView siteId="site-1" userRole="admin" /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "등록된 조명이 없습니다" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
    expect(await screen.findByRole("dialog", { name: "전체 로그" })).toHaveTextContent("장치 상태 확인 · 완료");
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
  });

  it("최초 현황 조회 실패는 본문 오류에서 다시 시도할 수 있다", () => {
    queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: undefined, error: new Error("dashboard unavailable") });
    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByRole("alert")).toHaveTextContent("현황 데이터를 불러오지 못했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(refetchDashboard).toHaveBeenCalledTimes(1);
  });

  it("refreshes dashboard, current-floor fixtures, and the saved map together", async () => {
    render(<MonitoringView siteId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));

    await waitFor(() => {
      expect(refetchDashboard).toHaveBeenCalledTimes(1);
      expect(refetchFixtures).toHaveBeenCalledTimes(1);
      expect(refetchMap).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/마지막 갱신:/)).toBeInTheDocument();
  });

  it("keeps one hardware request active and refreshes marker/detail without deriving counts from fixture pages", async () => {
    const hardware = deferred<{ status: string }>();
    refreshApi.waitForMonitoringRefresh.mockReturnValueOnce(hardware.promise);
    const online = { ...fixture, health: null };
    const second = { ...online, id: "fixture-2", name: "B1-L002" };
    const query = queryMocks.useFloorFixtures();
    query.data.pages[0].items = [online, second];
    refetchFixtures.mockImplementationOnce(async () => { query.data.pages[0].items = [online, { ...second, status: "offline", statusReason: "fixture_stale" }]; });
    render(<MonitoringView siteId="site-1" userRole="viewer" />);
    fireEvent.click(screen.getByRole("button", { name: "B1-L002 정상 70%" }));
    expect(floorMetric("정상")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    const loading = screen.getByRole("button", { name: "장치 상태 확인 중" });
    expect(loading).toBeDisabled();
    fireEvent.click(loading);
    expect(refreshApi.waitForMonitoringRefresh).toHaveBeenCalledTimes(1);
    expect(refreshApi.waitForMonitoringRefresh).toHaveBeenCalledWith(expect.objectContaining({ siteId: "site-1", floorId: "floor-1", clientRequestId: expect.any(String), signal: expect.any(AbortSignal) }));
    expect(refetchFixtures).not.toHaveBeenCalled();
    await act(async () => hardware.resolve({ status: "completed" }));
    expect(floorMetric("전체 조명")).toHaveTextContent("1");
    expect(floorMetric("정상")).toHaveTextContent("1");
    expect(floorMetric("오프라인")).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: "B1-L002 상태 수신 지연 70%" })).toBeVisible();
    openDetails();
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("B1-L002");
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("상태 수신 지연");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("skips the hardware job for an empty floor and still refetches every source", async () => {
    queryMocks.useFloorFixtures().data.pages[0].items = [];
    render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(refetchMap).toHaveBeenCalledTimes(1));
    expect(refetchDashboard).toHaveBeenCalledTimes(1);
    expect(refetchFixtures).toHaveBeenCalledTimes(1);
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
  });

  it.each(["loading", "error"])("continues the same refresh into one hardware job after an unknown fixture source recovers from %s", async (initialState) => {
    const query = queryMocks.useFloorFixtures();
    query.data = undefined;
    query.error = initialState === "error" ? new Error("fixture unavailable") : null;
    const fixtureRequest = deferred<{ data: unknown }>();
    refetchFixtures.mockReturnValueOnce(fixtureRequest.promise);
    render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(screen.getByRole("button", { name: "장치 상태 확인 중" })).toBeDisabled();
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
    await act(async () => {
      query.data = { pages: [{ items: [fixture], nextCursor: null, generatedAt: new Date().toISOString() }] };
      query.error = null;
      fixtureRequest.resolve({ data: query.data });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled());
    expect(refreshApi.waitForMonitoringRefresh).toHaveBeenCalledTimes(1);
    expect(refreshApi.waitForMonitoringRefresh).toHaveBeenCalledWith(expect.objectContaining({ floorId: "floor-1" }));
    expect(refetchFixtures).toHaveBeenCalledTimes(2);
    expect(refetchDashboard).toHaveBeenCalledTimes(1);
    expect(refetchMap).toHaveBeenCalledTimes(1);
  });

  it("keeps unknown fixture errors as source errors without claiming the floor is empty", async () => {
    const query = queryMocks.useFloorFixtures();
    query.data = undefined;
    query.error = new Error("private fixture request failed");
    refetchFixtures.mockRejectedValueOnce(query.error);
    render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled());
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
    expect(refetchFixtures).toHaveBeenCalledTimes(1);
    expect(screen.getByText("일부 현황 데이터를 새로고침하지 못했습니다.")).toBeVisible();
    expect(screen.queryByText("장치 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.")).not.toBeInTheDocument();
    expect(screen.queryByText(/private fixture/)).not.toBeInTheDocument();
    expect(refetchDashboard).toHaveBeenCalledTimes(1);
    expect(refetchMap).toHaveBeenCalledTimes(1);
  });

  it("skips hardware only after the initially unknown fixture source confirms an empty floor", async () => {
    const query = queryMocks.useFloorFixtures();
    query.data = undefined;
    refetchFixtures.mockResolvedValueOnce({ data: { pages: [{ items: [], nextCursor: null, generatedAt: new Date().toISOString() }] } });
    render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled());
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
    expect(refetchFixtures).toHaveBeenCalledTimes(1);
    expect(refetchDashboard).toHaveBeenCalledTimes(1);
    expect(refetchMap).toHaveBeenCalledTimes(1);
  });

  it.each(["floor", "site", "unmount"])("does not start hardware from a late initial fixture response after %s changes", async (change) => {
    queryMocks.useFloorFixtures().data = undefined;
    const fixtureRequest = deferred<{ data: unknown }>();
    refetchFixtures.mockReturnValueOnce(fixtureRequest.promise);
    queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: { ...dashboard, floors: [...dashboard.floors, { ...dashboard.floors[0], id: "floor-2", name: "B2" }] } });
    const view = render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    if (change === "floor") await chooseSelect("맵 선택", "B2");
    if (change === "site") view.rerender(<MonitoringView siteId="site-2" />);
    if (change === "unmount") view.unmount();
    await act(async () => fixtureRequest.resolve({ data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: new Date().toISOString() }] } }));
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
    expect(refetchDashboard).not.toHaveBeenCalled();
    expect(refetchMap).not.toHaveBeenCalled();
    if (change !== "unmount") expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
  });

  it.each([
    ["partial", "일부 조명의 상태를 확인하지 못했습니다."],
    ["failed", "장치 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요."],
    ["expired", "장치 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요."]
  ])("shows sanitized %s feedback while retaining source errors", async (status, copy) => {
    refreshApi.waitForMonitoringRefresh.mockResolvedValueOnce({ status, error: "secret transport failure" });
    refetchMap.mockRejectedValueOnce(new Error("secret map failure"));
    render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled());
    expect(await screen.findByText(copy)).toBeVisible();
    const current = openCurrentStatus();
    expect(current).toHaveTextContent(copy);
    expect(current).toHaveTextContent("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.");
    expect(within(current).getByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).toBeVisible();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
    expect(refetchDashboard).toHaveBeenCalledTimes(1);
    expect(refetchFixtures).toHaveBeenCalledTimes(1);
  });

  it("sanitizes POST errors and still refreshes cached data", async () => {
    refreshApi.waitForMonitoringRefresh.mockRejectedValueOnce(new Error("private URL transport trace"));
    render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled());
    expect(screen.getByText("장치 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.")).toBeVisible();
    expect(screen.queryByText(/private URL/)).not.toBeInTheDocument();
    expect(refetchMap).toHaveBeenCalledTimes(1);
  });

  it.each(["floor", "site", "unmount"])("aborts on %s change and ignores a late hardware result", async (change) => {
    const oldRequest = deferred<{ status: string }>();
    refreshApi.waitForMonitoringRefresh.mockReturnValueOnce(oldRequest.promise);
    queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: { ...dashboard, floors: [...dashboard.floors, { ...dashboard.floors[0], id: "floor-2", name: "B2" }] } });
    const view = render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    const oldSignal = refreshApi.waitForMonitoringRefresh.mock.calls[0][0].signal as AbortSignal;
    if (change === "floor") await chooseSelect("맵 선택", "B2");
    if (change === "site") view.rerender(<MonitoringView siteId="site-2" />);
    if (change === "unmount") view.unmount();
    expect(oldSignal.aborted).toBe(true);
    if (change !== "unmount") {
      refreshApi.waitForMonitoringRefresh.mockReturnValueOnce(new Promise(() => {}));
      fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    }
    await act(async () => oldRequest.resolve({ status: "failed" }));
    expect(refetchDashboard).not.toHaveBeenCalled();
    expect(screen.queryByText("장치 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.")).not.toBeInTheDocument();
    if (change !== "unmount") expect(screen.getByRole("button", { name: "장치 상태 확인 중" })).toBeDisabled();
  });

  it("ignores an old refetch failure after moving to another floor", async () => {
    const oldMap = deferred<unknown>();
    refetchMap.mockReturnValueOnce(oldMap.promise);
    queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: { ...dashboard, floors: [...dashboard.floors, { ...dashboard.floors[0], id: "floor-2", name: "B2" }] } });
    render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(refetchMap).toHaveBeenCalledTimes(1));
    await chooseSelect("맵 선택", "B2");
    await act(async () => oldMap.reject(new Error("old map failed")));
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    expect(screen.queryByText("일부 현황 데이터를 새로고침하지 못했습니다.")).not.toBeInTheDocument();
  });

  it("uses labelled design-system selectors and non-color status text", () => {
    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByRole("button", { name: "맵 선택" })).toBeVisible();
    expect(screen.getByText("점검 필요")).toBeVisible();
    expect(floorMetric("오프라인")).toBeVisible();
  });

  it.each([0, 2])("uses %i saved map placements for the empty-placement banner when runtime placement is stale", (placementCount) => {
    const fixtures = [fixture, { ...fixture, id: "fixture-2", name: "B1-L002" }];
    queryMocks.useFloorFixtures.mockReturnValue({
      ...queryMocks.useFloorFixtures(),
      data: { pages: [{
        items: fixtures.map((item) => ({ ...item, placementStatus: "unplaced" })),
        nextCursor: null,
        generatedAt: new Date().toISOString()
      }] }
    });
    queryMocks.useFloorMapSnapshot.mockReturnValue({
      ...queryMocks.useFloorMapSnapshot(),
      data: { ...mapSnapshot, fixtures: fixtures.slice(0, placementCount).map((item, index) => ({
        id: item.id, name: item.name, x: 200 + index * 100, y: 200, size: 20
      })) }
    });

    render(<MemoryRouter><MonitoringView siteId="site-1" /></MemoryRouter>);

    const map = screen.getByRole("region", { name: "층 도면" });
    expect(within(map).queryAllByRole("button", { name: /B1-L00[12]/ })).toHaveLength(placementCount);
    if (placementCount > 0) {
      expect(screen.queryByText("배치된 조명이 없습니다")).not.toBeInTheDocument();
    } else {
      expect(screen.getByText("배치된 조명이 없습니다")).toBeVisible();
      expect(screen.getByRole("link", { name: "설정에서 조명 배치" })).toBeVisible();
    }
  });

  it("does not show another fixture's detail when a saved pin has no loaded runtime row", () => {
    queryMocks.useFloorMapSnapshot.mockReturnValue({
      ...queryMocks.useFloorMapSnapshot(),
      data: { ...mapSnapshot, fixtures: [{ id: "fixture-snapshot-only", name: "B1-L099", x: 1100, y: 700, size: 20 }] }
    });
    render(<MonitoringView siteId="site-1" />);

    const savedPin = screen.getByRole("button", { name: "B1-L099 조명 정보 확인 전" });
    fireEvent.click(savedPin);
    expect(screen.getByRole("button", { name: "B1-L099 조명 정보 확인 전" })).toHaveAttribute("aria-current", "true");
    const inspector = openDetails("B1-L099");
    expect(within(inspector).getByRole("heading", { name: "B1-L099" })).toBeVisible();
    expect(inspector).toHaveTextContent("조명 정보 확인 전 · 상태를 불러오는 중");
    expect(within(inspector).getByRole("complementary", { name: "선택 조명 상세" })).not.toHaveTextContent("B1-L001");
    expect(within(inspector).queryByText("GW-1 (정상)")).not.toBeInTheDocument();
  });

  it("검색 결과 0개에서도 이전 조명 상세와 선택기를 숨긴다", () => {
    render(<MonitoringView siteId="site-1" />);
    const inspector = openInspector();
    fireEvent.change(within(inspector).getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }), { target: { value: "없는 조명" } });
    expect(within(inspector).getByText("검색 결과가 없습니다.")).toBeVisible();
    expect(within(inspector).queryByRole("button", { name: "상세 조명 선택" })).not.toBeInTheDocument();
    expect(within(inspector).queryByRole("complementary", { name: "선택 조명 상세" })).not.toBeInTheDocument();
  });

  it("shows only fixture details without exposing incident operations", () => {
    render(<MonitoringView siteId="site-1" userRole="admin" />);
    openDetails();

    const detailPanel = screen.getByRole("complementary", { name: "선택 조명 상세" });
    expect(within(detailPanel).getByRole("region", { name: "선택 조명 정보" })).toBeVisible();
    expect(within(detailPanel).queryByRole("tablist", { name: "모니터링 상세" })).not.toBeInTheDocument();
    expect(within(detailPanel).queryByText(/인시던트/)).not.toBeInTheDocument();
    expect(within(detailPanel).queryByRole("button", { name: "판정 기준" })).not.toBeInTheDocument();
  });

  it("preserves selection and map during dashboard background failure", async () => {
    queryMocks.useFloorFixtures.mockReturnValue({ ...queryMocks.useFloorFixtures(), data: { pages: [{ items: [fixture, { ...fixture, id: "fixture-2", name: "B1-L002" }], nextCursor: null, generatedAt: new Date().toISOString() }] } });
    const view = render(<MonitoringView siteId="site-1" userRole="admin" />);
    openInspector();
    await chooseSelect("상세 조명 선택", "B1-L002 · 장애");
    closeInspector();
    fireEvent.click(screen.getByRole("button", { name: "지도 확대" }));
    queryMocks.useDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: new Error("offline"), refetch: refetchDashboard });
    view.rerender(<MonitoringView siteId="site-1" userRole="admin" />);
    openInspector();
    expect(screen.getByRole("button", { name: "상세 조명 선택" })).toHaveTextContent("B1-L002 · 장애");
    fireEvent.click(screen.getByRole("button", { name: "상세 보기" }));
    expect(screen.getByRole("region", { name: "선택 조명 정보" })).toBeVisible();
    closeInspector();
    expect(screen.getByRole("button", { name: "맵 선택" })).toHaveTextContent("B1");
    expect(screen.getByRole("region", { name: "층 도면" })).toHaveAttribute("data-zoom", "1.1");
  });

  it("presents offline fixtures immediately after the inspection metric", () => {
    queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: {
      ...dashboard,
      summary: { ...dashboard.summary, totalFixtures: 3, faultFixtures: 1, offlineFixtures: 1 },
      floors: [{ ...dashboard.floors[0], summary: { totalFixtures: 3, onlineFixtures: 1, faultFixtures: 1, offlineFixtures: 1 } }]
    } });
    const faultFixture = {
      ...fixture,
      id: "fixture-2",
      name: "B1-L002",
      brightness: 72,
      status: "fault" as const
    };
    const awaitingFixture = {
      ...fixture,
      id: "fixture-3",
      name: "B1-L003",
      status: "offline" as const,
      statusReason: "provisioning_waiting_state" as const
    };
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture, faultFixture, awaitingFixture], nextCursor: null }] },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      error: null,
      isPending: false,
      isLoading: false,
      isFetching: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });

    render(<MonitoringView siteId="site-1" />);

    expect(screen.queryByRole("heading", { name: "운영 현황" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "맵 선택" })).toHaveTextContent("B1");
    expect(floorMetric("전체 조명")).toHaveTextContent("3");
    expect(floorMetric("정상")).toHaveTextContent("1");
    expect(floorMetric("점검 필요")).toHaveTextContent("1");
    const offlineMetric = floorMetric("오프라인");
    expect(offlineMetric).toHaveTextContent("1");
    expect(offlineMetric).not.toHaveTextContent("상태 확인 대기 포함");
    expect(Array.from(offlineMetric.parentElement!.children).map(metric => metric.querySelector("span:not([aria-hidden])")?.textContent)).toEqual([
      "전체 조명",
      "정상",
      "점검 필요",
      "오프라인"
    ]);
    expect(screen.queryByRole("group", { name: "평균 밝기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "빠른 상태" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "층 도면" })).toBeInTheDocument();
    openDetails("B1-L002");
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("72%");
    const selectedFixtureDetail = screen.getByRole("region", { name: "선택 조명 정보" });
    expect(within(selectedFixtureDetail).queryByRole("heading", { name: "점검 큐" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "선택 조명 상세" })).getByText(
      /정상|장애|오프라인|상태 확인 대기/,
      { selector: "[data-tone] > span" }
    )).toBeVisible();
  });

  it("모니터링은 핵심 KPI 다음에 전폭 지도와 접근 가능한 상세 드로어를 배치한다", () => {
    const faultFixture = {
      ...fixture,
      id: "fixture-2",
      name: "B1-L002",
      status: "fault" as const
    };
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture, faultFixture], nextCursor: null }] },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });

    render(<MonitoringView siteId="site-1" />);

    const summary = screen.getByRole("region", { name: "선택 층 조명 현황" });
    const map = screen.getByRole("region", { name: "층 도면" });
    expect(summary.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const drawer = openDetails("B1-L002");
    expect(within(drawer).getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("현재 밝기");
  });

  it("keeps the mobile fixture selector and map marker selection in sync", async () => {
    const faultFixture = {
      ...fixture,
      id: "fixture-2",
      name: "B1-L002",
      brightness: 42,
      status: "fault" as const
    };
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture, faultFixture], nextCursor: null }] },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      error: null,
      isPending: false,
      isLoading: false,
      isFetching: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });

    render(<MonitoringView siteId="site-1" />);

    openInspector();

    const selector = await screen.findByRole("button", { name: "상세 조명 선택" });
    expect(selector).not.toHaveTextContent("B1-L002 · 장애");
    await chooseSelect("상세 조명 선택", "B1-L002 · 장애");
    fireEvent.click(screen.getByRole("button", { name: "상세 보기" }));
    expect(within(screen.getByRole("complementary", { name: "선택 조명 상세" })).getByRole("heading", { name: "B1-L002" })).toBeVisible();
    closeInspector();
    await waitFor(() => expect(screen.getByRole("button", { name: "조명 검색·상세" })).toHaveFocus());
    openInspector();
    await chooseSelect("상세 조명 선택", "B1-L001 · 장애");
    fireEvent.click(screen.getByRole("button", { name: "상세 보기" }));
    expect(within(screen.getByRole("complementary", { name: "선택 조명 상세" })).getByRole("heading", { name: "B1-L001" })).toBeVisible();

    closeInspector();
    fireEvent.click(screen.getByRole("button", { name: "B1-L002 장애 42%" }));
    openInspector();
    expect(screen.getByRole("button", { name: "상세 조명 선택" })).toHaveTextContent("B1-L002 · 장애");
  });

  it("opens an unplaced fixture from search without creating a map marker", () => {
    const unplaced = { ...fixture, id: "fixture-2", name: "B1-L002", placementStatus: "unplaced" as const, health: null };
    queryMocks.useFloorFixtures().data.pages[0].items = [{ ...fixture, health: null }, unplaced];
    queryMocks.useFloorMapSnapshot().data = { ...mapSnapshot, fixtures: [] };
    render(<MemoryRouter><MonitoringView siteId="site-1" userRole="viewer" /></MemoryRouter>);

    openInspector();

    fireEvent.change(screen.getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }), { target: { value: "002" } });
    fireEvent.click(within(screen.getByRole("list", { name: "조명 목록" })).getByRole("button", { name: /B1-L002/ }));

    expect(within(screen.getByRole("complementary", { name: "선택 조명 상세" })).getByRole("heading", { name: "B1-L002" })).toBeVisible();
    closeInspector();
    expect(within(screen.getByRole("region", { name: "층 도면" })).queryByRole("button", { name: /B1-L002/ })).not.toBeInTheDocument();
  });

  it("clears a prior floor search when the selected map changes", async () => {
    queryMocks.useDashboard.mockReturnValue({
      ...queryMocks.useDashboard(),
      data: { ...dashboard, floors: [...dashboard.floors, { ...dashboard.floors[0], id: "floor-2", name: "B2" }] }
    });
    render(<MemoryRouter><MonitoringView siteId="site-1" /></MemoryRouter>);
    openInspector();
    const search = screen.getByRole("searchbox", { name: "조명 이름 또는 번호 검색" });
    fireEvent.change(search, { target: { value: "001" } });
    expect(search).toHaveValue("001");

    closeInspector();
    await chooseSelect("맵 선택", "B2");
    openInspector();
    expect(screen.getByRole("searchbox", { name: "조명 이름 또는 번호 검색" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "조명 목록 보기" })).toHaveAttribute("aria-expanded", "false");
  });

  it("locks the refresh action until both requests settle", async () => {
    const dashboardRequest = deferred<unknown>();
    const fixtureRequest = deferred<unknown>();
    const mapRequest = deferred<unknown>();
    refetchDashboard.mockReturnValueOnce(dashboardRequest.promise);
    refetchFixtures.mockReturnValueOnce(fixtureRequest.promise);
    refetchMap.mockReturnValueOnce(mapRequest.promise);
    render(<MonitoringView siteId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));

    expect(screen.getByRole("button", { name: "장치 상태 확인 중" })).toBeDisabled();
    dashboardRequest.resolve({ data: dashboard });
    fixtureRequest.resolve({ data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: new Date().toISOString() }] } });
    mapRequest.resolve({ data: mapSnapshot });
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled());
  });

  it("keeps successful data and reports a partial refresh failure", async () => {
    refetchDashboard.mockRejectedValueOnce(new Error("dashboard unavailable"));
    render(<MonitoringView siteId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));

    expect(await screen.findByRole("status")).toHaveTextContent("일부 현황 데이터를 새로고침하지 못했습니다.");
    expect(screen.getByRole("button", { name: /B1-L001/ })).toBeInTheDocument();
  });

  it("keeps cached dashboard, map, and selected fixture visible when a dashboard refetch fails", () => {
    queryMocks.useDashboard.mockReturnValue({
      data: dashboard,
      isLoading: false,
      error: new Error("dashboard unavailable"),
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      refetch: refetchDashboard
    });

    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByRole("region", { name: "층 도면" })).toBeInTheDocument();
    openDetails();
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("B1-L001");
    // Cached dashboard query failures are owned by CustomerShell's status source.
    expect(within(document.querySelector("[data-monitoring-screen]") as HTMLElement).queryByText(/저장된 현황을 유지하고 있습니다/)).not.toBeInTheDocument();
  });

  it.each([
    ["Asia/Seoul", "2026-10-03T15:59:00.000Z", "2026-10-04 00:59:00"],
    ["America/Los_Angeles", "2026-10-03T00:30:00.000Z", "2026-10-02 17:30:00"]
  ])("shows the snapshot in site time across the UTC date boundary: %s", (timeZone, snapshotAt, localTime) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(new Date(snapshotAt).getTime() + 30_000));
    queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: { ...dashboard, site: { ...dashboard.site, timeZone } } });
    queryMocks.useFloorFixtures.mockReturnValue({ ...queryMocks.useFloorFixtures(), data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: snapshotAt }] } });

    render(<MonitoringView siteId="site-1" />);

    const updated = screen.getByText(/마지막 갱신:/);
    expect(updated).toHaveTextContent(localTime);
    expect(updated).toHaveTextContent("현장 시간");
    expect(updated).not.toHaveTextContent(snapshotAt);
    expect(updated.querySelector("time")).toHaveAttribute("datetime", snapshotAt);
    expect(screen.queryByText("현황 갱신이 지연되고 있습니다.")).not.toBeInTheDocument();
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
  });

  it("keeps pending snapshot metadata explicit without an invented time", () => {
    queryMocks.useFloorFixtures.mockReturnValue({ ...queryMocks.useFloorFixtures(), data: undefined, isPending: true });
    render(<MonitoringView siteId="site-1" />);
    const updated = screen.getByText(/마지막 갱신:/);
    expect(updated).toHaveTextContent("서버 snapshot 시각 확인 중");
    expect(updated.querySelector("time")).toBeNull();
  });

  it("shows a persistent stale warning after the oldest fixture page snapshot exceeds 60 seconds", () => {
    const snapshotAt = new Date(Date.now() - 60_001).toISOString();
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: snapshotAt }] },
      dataUpdatedAt: Date.now(),
      error: null,
      isPending: false,
      isLoading: false,
      isFetching: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });

    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByRole("status")).toHaveTextContent("현황 갱신이 지연되고 있습니다.");
    expect(openCurrentStatus()).toHaveTextContent("현황 갱신이 지연되고 있습니다.");
    expect(screen.getByText(/마지막 갱신:/)).not.toHaveTextContent(snapshotAt);
    expect(screen.getByText(/마지막 갱신:/).querySelector("time")).toHaveAttribute("datetime", snapshotAt);
  });

  it("keeps a future server snapshot explicit instead of presenting it as a normal relative update", () => {
    const snapshotAt = "2099-01-01T00:00:00.000Z";
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: snapshotAt }] },
      dataUpdatedAt: Date.now(),
      error: null,
      isPending: false,
      isLoading: false,
      isFetching: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });

    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByText(/마지막 갱신:/)).toHaveTextContent("시간 차이 확인 (2099-01-01 09:00:00)");
    expect(screen.getByRole("status")).toHaveTextContent("시간 차이 확인: 2099-01-01 09:00:00");
  });

  it("evaluates a newly arrived current snapshot against Date.now instead of the prior timer tick", () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-12T00:00:00.000Z");
    vi.setSystemTime(now);
    const { rerender } = render(<MonitoringView siteId="site-1" />);
    vi.setSystemTime(new Date("2026-09-12T00:00:01.000Z"));
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: "2026-09-12T00:00:01.000Z" }] },
      dataUpdatedAt: Date.now(), error: null, isPending: false, isLoading: false, isFetching: false,
      hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(), refetch: refetchFixtures
    });

    rerender(<MonitoringView siteId="site-1" />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps 60,000ms fresh and shows stale at 60,001ms without waiting for an interval tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: "2026-09-12T00:00:00.000Z" }] },
      dataUpdatedAt: Date.now(), error: null, isPending: false, isLoading: false, isFetching: false,
      hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(), refetch: refetchFixtures
    });

    render(<MonitoringView siteId="site-1" />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status")).toHaveTextContent("현황 갱신이 지연되고 있습니다.");
  });

  it.each([
    ["2099-01-01T00:00:00.000Z", "시간 차이 확인"],
    ["2026-02-30T00:00:00.000Z", "서버 snapshot 시각을 확인할 수 없습니다."],
    [undefined, "서버 snapshot 시각을 확인할 수 없습니다."]
  ])("does not let a fresh page hide invalid metadata from another page: %s", (anomalousGeneratedAt, warning) => {
    queryMocks.useFloorFixtures.mockReturnValue({
      data: {
        pages: [
          { items: [fixture], nextCursor: "page-2", generatedAt: new Date().toISOString() },
          { items: [], nextCursor: null, generatedAt: anomalousGeneratedAt }
        ]
      },
      dataUpdatedAt: Date.now(), error: null, isPending: false, isLoading: false, isFetching: false,
      hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(), refetch: refetchFixtures
    });

    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByRole("status")).toHaveTextContent(warning);
  });

  it("explains a fault without exposing technical telemetry", () => {
    render(<MonitoringView siteId="site-1" />);
    openDetails();

    expect(screen.queryByText("장비 Health")).not.toBeInTheDocument();
    expect(screen.queryByText("RSSI")).not.toBeInTheDocument();
    expect(screen.queryByText("Health 수신")).not.toBeInTheDocument();
    expect(screen.getByText("조명에서 점검이 필요한 상태를 보고했습니다.")).toBeInTheDocument();
  });

  it("shows an offline brightness as the last confirmed reading with its timestamp", () => {
    queryMocks.useFloorFixtures().data.pages[0].items = [{ ...fixture, status: "offline", statusReason: "gateway_offline", health: null, brightness: 42 }];
    render(<MonitoringView siteId="site-1" />);
    openDetails();

    const detail = screen.getByRole("complementary", { name: "선택 조명 상세" });
    expect(within(detail).getByText("최근 확인 밝기")).toBeVisible();
    expect(within(detail).getByText("42%")).toBeVisible();
    expect(within(detail).getByText(/마지막 확인:/)).toBeVisible();
    expect(within(detail).queryByText("현재 밝기")).not.toBeInTheDocument();
  });

  it("shows no brightness value before the fixture's first confirmed report", () => {
    queryMocks.useFloorFixtures().data.pages[0].items = [{ ...fixture, status: "offline", statusReason: "provisioning_waiting_state", health: null, brightness: 0, lastSeenAt: null }];
    render(<MonitoringView siteId="site-1" />);
    openDetails();

    const detail = screen.getByRole("complementary", { name: "선택 조명 상세" });
    expect(within(detail).getByText("최근 확인 밝기")).toBeVisible();
    expect(within(detail).getByText("확인 전")).toBeVisible();
    expect(within(detail).queryByText("0%")).not.toBeInTheDocument();
  });

  it("등록된 조명이 있어도 모니터링에는 조명 등록 진입점을 표시하지 않는다", () => {
    render(<MonitoringView siteId="site-1" userRole="admin" />);

    expect(screen.queryByRole("region", { name: "조명 등록 패널" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "조명 등록" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "조명 등록" })).not.toBeInTheDocument();
  });

  it("조명이 없는 최초 화면도 등록 UI 대신 설정 페이지 경로만 안내한다", () => {
    queryMocks.useDashboard.mockReturnValue({
      data: { ...dashboard, summary: { ...dashboard.summary, totalFixtures: 0 } },
      isLoading: false,
      error: null,
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      refetch: refetchDashboard
    });

    render(
      <MemoryRouter>
        <MonitoringView siteId="site-1" userRole="admin" />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "등록된 조명이 없습니다" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "조명 등록 패널" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /조명 등록/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "설정 페이지로 이동" })).toHaveAttribute(
      "href",
      "/settings/registration?siteId=site-1"
    );
  });

  it("게이트웨이만 있는 현장의 관리자는 설정 이동 경로만 안내받는다", () => {
    queryMocks.useDashboard.mockReturnValue({
      data: {
        ...dashboard,
        summary: { ...dashboard.summary, totalFixtures: 0 },
        capabilities: { read: true, control: true, manage: true, commission: true }
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: new Date("2026-09-12T00:00:00.000Z").getTime(),
      refetch: refetchDashboard
    });
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [], nextCursor: null, generatedAt: new Date().toISOString() }] },
      dataUpdatedAt: Date.now(), error: null, isPending: false, isLoading: false, isFetching: false,
      hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(), refetch: refetchFixtures
    });
    render(<MemoryRouter><MonitoringView siteId="site-1" userRole="admin" /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "등록된 조명이 없습니다" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "설정 페이지로 이동" })).toBeInTheDocument();
    expect(screen.queryByText(/인시던트/)).not.toBeInTheDocument();
  });

  it("게이트웨이만 있는 현장의 조회 사용자는 설치 대기 안내만 본다", () => {
    queryMocks.useDashboard.mockReturnValue({
      data: {
        ...dashboard,
        summary: { ...dashboard.summary, totalFixtures: 0 },
        capabilities: { read: true, control: false, manage: false, commission: false }
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.now(),
      refetch: refetchDashboard
    });
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [], nextCursor: null, generatedAt: new Date().toISOString() }] },
      dataUpdatedAt: Date.now(), error: null, isPending: false, isLoading: false, isFetching: false,
      hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(), refetch: refetchFixtures
    });
    render(<MemoryRouter><MonitoringView siteId="site-1" userRole="viewer" /></MemoryRouter>);

    expect(screen.getByRole("region", { name: "Viewer 설치 대기" })).toBeInTheDocument();
    expect(screen.queryByText(/인시던트/)).not.toBeInTheDocument();
  });

  it("층이 없는 현장의 관리자는 floor 조회 경고 없이 empty 안내를 사용한다", async () => {
    queryMocks.useDashboard.mockReturnValue({
      data: {
        ...dashboard,
        summary: { ...dashboard.summary, totalFixtures: 0 },
        floors: [],
        capabilities: { read: true, control: true, manage: true, commission: true }
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.now(),
      refetch: refetchDashboard
    });
    queryMocks.useFloorFixtures.mockReturnValue({
      data: undefined, dataUpdatedAt: 0, error: null, isPending: true, isLoading: true, isFetching: false,
      hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(), refetch: refetchFixtures
    });
    queryMocks.useFloorMapSnapshot.mockReturnValue({
      data: undefined, dataUpdatedAt: 0, error: null, isPending: true, isLoading: true, isFetching: false, refetch: refetchMap
    });
    render(<MemoryRouter><MonitoringView siteId="site-1" userRole="admin" /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "등록된 조명이 없습니다" })).toBeInTheDocument();
    expect(screen.queryByText(/조명 상태를 불러오는 중/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(refetchDashboard).toHaveBeenCalledTimes(1));
    expect(refetchFixtures).not.toHaveBeenCalled();
    expect(refetchMap).not.toHaveBeenCalled();
    expect(screen.queryByText("일부 현황 데이터를 새로고침하지 못했습니다.")).not.toBeInTheDocument();
    expect(screen.queryByText(/인시던트/)).not.toBeInTheDocument();
  });

  it("층이 없는 현장의 조회 사용자는 floor 조회 경고 없이 empty 안내를 본다", () => {
    queryMocks.useDashboard.mockReturnValue({
      data: {
        ...dashboard,
        summary: { ...dashboard.summary, totalFixtures: 0 },
        floors: [],
        capabilities: { read: true, control: false, manage: false, commission: false }
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.now(),
      refetch: refetchDashboard
    });
    queryMocks.useFloorFixtures.mockReturnValue({
      data: undefined, dataUpdatedAt: 0, error: null, isPending: true, isLoading: true, isFetching: false,
      hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(), refetch: refetchFixtures
    });
    queryMocks.useFloorMapSnapshot.mockReturnValue({
      data: undefined, dataUpdatedAt: 0, error: null, isPending: true, isLoading: true, isFetching: false, refetch: refetchMap
    });
    render(<MemoryRouter><MonitoringView siteId="site-1" userRole="viewer" /></MemoryRouter>);

    expect(screen.getByRole("region", { name: "Viewer 설치 대기" })).toBeInTheDocument();
    expect(screen.queryByText(/조명 상태를 불러오는 중/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/인시던트/)).not.toBeInTheDocument();
  });

  it("조회 사용자는 조명 등록 진입점을 표시하지 않는다", () => {
    render(<MonitoringView siteId="site-1" userRole="viewer" />);

    expect(screen.queryByRole("button", { name: "조명 등록" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "조명 등록 패널" })).not.toBeInTheDocument();
  });

  it("fixture 최초 조회 중에는 조명 0개나 빈 층으로 오표시하지 않는다", () => {
    queryMocks.useFloorFixtures.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      error: null,
      isPending: true,
      isLoading: true,
      isFetching: true,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });

    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByRole("status")).toHaveTextContent("조명 상태를 불러오는 중");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(floorMetric("전체 조명")).toHaveTextContent("1");
    expect(screen.queryByText("등록된 층이 없습니다.")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "층 도면" })).not.toBeInTheDocument();
  });

  it("층 전환 중에는 이전 층 KPI나 빈 fixture 지도를 표시하지 않는다", async () => {
    const twoFloorDashboard = {
      ...dashboard,
      floors: [
        dashboard.floors[0],
        { ...dashboard.floors[0], id: "floor-2", name: "B2", level: -2, summary: { totalFixtures: 2, onlineFixtures: 1, faultFixtures: 0, offlineFixtures: 1 } }
      ]
    };
    queryMocks.useDashboard.mockReturnValue({
      data: twoFloorDashboard,
      isLoading: false,
      error: null,
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      refetch: refetchDashboard
    });
    queryMocks.useFloorFixtures.mockImplementation((floorId: string) => floorId === "floor-1" ? {
      data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: new Date().toISOString() }] },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      error: null,
      isPending: false,
      isLoading: false,
      isFetching: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    } : {
      data: undefined,
      dataUpdatedAt: 0,
      error: null,
      isPending: true,
      isLoading: true,
      isFetching: true,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });
    queryMocks.useFloorMapSnapshot.mockImplementation((floorId: string) => ({
      data: { ...mapSnapshot, floorId },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      error: null,
      isPending: false,
      isLoading: false,
      refetch: refetchMap
    }));
    render(<MonitoringView siteId="site-1" />);

    expect(floorMetric("전체 조명")).toHaveTextContent("1");
    await chooseSelect("맵 선택", "B2");

    expect(screen.getByRole("status")).toHaveTextContent("B2 조명 상태를 불러오는 중");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(floorMetric("전체 조명")).toHaveTextContent("2");
    expect(screen.queryByRole("region", { name: "층 도면" })).not.toBeInTheDocument();
  });

  it("fixture 최초 조회 실패에는 오류와 재시도를 표시한다", () => {
    queryMocks.useFloorFixtures.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      error: new Error("fixtures unavailable"),
      isPending: false,
      isLoading: false,
      isFetching: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });
    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByRole("alert")).toHaveTextContent("조명 상태를 불러오지 못했습니다.");
    expect(floorMetric("전체 조명")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "조명 상태 다시 시도" }));
    expect(refetchFixtures).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/인시던트/)).not.toBeInTheDocument();
  });

  it("fixture 갱신 실패 시 이전 성공 데이터를 유지하고 오류를 알린다", async () => {
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture], nextCursor: null, generatedAt: new Date().toISOString() }] },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      error: new Error("fixtures unavailable"),
      isPending: false,
      isLoading: false,
      isFetching: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });

    render(<MonitoringView siteId="site-1" />);

    expect(floorMetric("전체 조명")).toHaveTextContent("1");
    expect(screen.getByRole("region", { name: "층 도면" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "알림" })).getByRole("status")).toHaveTextContent("저장된 조명 상태를 유지하고 있습니다. 조명 상태 갱신에 실패했습니다.");
    expect(within(document.querySelector("[data-monitoring-screen]") as HTMLElement).queryByText("저장된 조명 상태를 유지하고 있습니다. 조명 상태 갱신에 실패했습니다.")).not.toBeInTheDocument();
    const current = openCurrentStatus();
    expect(current).toHaveTextContent("저장된 조명 상태를 유지하고 있습니다. 조명 상태 갱신에 실패했습니다.");
    fireEvent.click(within(current).getByRole("button", { name: "조명 상태 다시 시도" }));
    await waitFor(() => expect(refetchFixtures).toHaveBeenCalledTimes(1));
  });

  it("같은 cached 실패는 재렌더에서 토스트를 다시 띄우지 않고 성공 시 상태를 해제한다", () => {
    let fixtureState = {
      ...queryMocks.useFloorFixtures(),
      error: new Error("fixtures unavailable") as Error | null
    };
    queryMocks.useFloorFixtures.mockImplementation(() => fixtureState);
    const view = render(<MonitoringView siteId="site-1" />);

    const current = openCurrentStatus();
    expect(current).toHaveTextContent("조명 상태 갱신에 실패했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "알람센터 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "알림 닫기" }));
    view.rerender(<MonitoringView siteId="site-1" userRole="viewer" />);
    expect(within(screen.getByRole("region", { name: "알림" })).queryByRole("status")).not.toBeInTheDocument();
    expect(openCurrentStatus()).toHaveTextContent("조명 상태 갱신에 실패했습니다.");

    fixtureState = { ...fixtureState, error: null };
    view.rerender(<MonitoringView siteId="site-1" userRole="viewer" />);
    expect(screen.getByRole("region", { name: "현재 화면 상태" })).toHaveTextContent("현재 확인할 상태가 없습니다.");
    expect(screen.getByRole("region", { name: "현재 화면 상태" })).not.toHaveTextContent("조명 상태 갱신에 실패했습니다.");
  });

  it("지도 최초 조회 중에는 등록된 층이 없다고 표시하지 않는다", () => {
    queryMocks.useFloorMapSnapshot.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      error: null,
      isPending: true,
      isLoading: true,
      refetch: refetchMap
    });

    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByRole("status")).toHaveTextContent("저장된 지도를 불러오는 중");
    expect(screen.queryByText("등록된 층이 없습니다.")).not.toBeInTheDocument();
  });

  it("맵 선택 라벨을 연결하고 새로고침을 상단 도구의 오른쪽 끝에 둔다", () => {
    render(<MonitoringView siteId="site-1" />);

    expect(screen.queryByRole("heading", { name: "운영 현황" })).not.toBeInTheDocument();
    expect(screen.queryByText(/10분마다 자동 갱신/)).not.toBeInTheDocument();
    const mapSelector = screen.getByRole("button", { name: "맵 선택" });
    expect(mapSelector).toHaveTextContent("B1");
    const mapSelectorField = mapSelector.closest("[data-field]");
    expect(mapSelectorField).toBeInTheDocument();
    const mapSelectorLabel = within(mapSelectorField as HTMLElement).getByText("맵 선택", { selector: "label" });
    expect(mapSelector).toHaveAttribute("aria-labelledby", mapSelectorLabel.id);
    const refreshButton = screen.getByRole("button", { name: "새로고침" });
    expect(refreshButton.parentElement?.lastElementChild).toBe(refreshButton);
    expect(mapSelectorField?.parentElement).toContainElement(screen.getByRole("button", { name: "조명 검색·상세" }));
    expect(screen.getByRole("group", { name: "지도 조작" })).toContainElement(screen.getByRole("button", { name: "지도 전체 보기" }));
    expect(screen.queryByRole("button", { name: "지도 화면 맞춤" })).not.toBeInTheDocument();
  });

  it("keeps a long map name and its fixture identity through search without sending a device command", async () => {
    const longName = "B1 · 동측 지하주차장", nextFixture = { ...fixture, id: "fixture-2", name: "동측 출입구 조명" };
    const fixturesQuery = queryMocks.useFloorFixtures(), mapQuery = queryMocks.useFloorMapSnapshot();
    queryMocks.useDashboard.mockReturnValue({ ...queryMocks.useDashboard(), data: { ...dashboard, floors: [
      { ...dashboard.floors[0], name: "B2" }, { ...dashboard.floors[0], id: "floor-2", name: longName }
    ] } });
    queryMocks.useFloorFixtures.mockImplementation((floorId: string) => floorId === "floor-2"
      ? { ...fixturesQuery, data: { pages: [{ ...fixturesQuery.data.pages[0], items: [nextFixture] }] } } : fixturesQuery);
    queryMocks.useFloorMapSnapshot.mockImplementation((floorId: string) => floorId === "floor-2"
      ? { ...mapQuery, data: { ...mapSnapshot, floorId: "floor-2" } } : mapQuery);
    render(<MonitoringView siteId="site-1" />);

    await chooseSelect("맵 선택", longName);
    expect(screen.getByRole("button", { name: "맵 선택" })).toHaveTextContent(longName);
    const inspector = openInspector();
    fireEvent.change(within(inspector).getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }), { target: { value: "동측" } });
    expect(within(inspector).getByRole("button", { name: "상세 조명 선택" })).toHaveTextContent("Select an item");
    await chooseSelect("상세 조명 선택", `${nextFixture.name} · 장애`);
    expect(within(inspector).getByRole("button", { name: "상세 조명 선택" })).toHaveTextContent(nextFixture.name);
    expect(within(inspector).queryByRole("complementary", { name: "선택 조명 상세" })).not.toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole("button", { name: "상세 보기" }));
    const detail = screen.getByRole("dialog", { name: "조명 상세" });
    expect(within(detail).getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent(nextFixture.name);
    expect(within(detail).queryByText(fixture.name)).not.toBeInTheDocument();
    closeInspector();
    expect(screen.getByRole("button", { name: "맵 선택" })).toHaveTextContent(longName);
    expect(refreshApi.waitForMonitoringRefresh).not.toHaveBeenCalled();
  });

  it("0개 상태 필터에서 다른 조명의 상세를 숨기고 전체 목록으로 돌아간다", async () => {
    render(<MonitoringView siteId="site-1" />);
    await selectStatusFilter("오프라인");
    const inspector = screen.getByRole("dialog", { name: "조명 검색·상세" });
    expect(within(inspector).getByText("오프라인 조명이 없습니다.")).toBeVisible();
    expect(within(inspector).queryByRole("button", { name: "상세 조명 선택" })).not.toBeInTheDocument();
    expect(within(inspector).queryByRole("complementary", { name: "선택 조명 상세" })).not.toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole("button", { name: "전체 조명 보기" }));
    expect(within(inspector).getByRole("button", { name: "상세 조명 선택" })).not.toHaveTextContent("B1-L001");
    expect(document.querySelector('[data-spatial-map-marker]')).toHaveAttribute("data-selected", "false");
  });

  it("지도 최초 조회 실패에는 빈 캔버스 대신 오류와 재시도를 표시한다", () => {
    queryMocks.useFloorMapSnapshot.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      error: new Error("map unavailable"),
      isPending: false,
      isLoading: false,
      refetch: refetchMap
    });
    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByText("저장된 지도를 불러오지 못했습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "지도 다시 시도" }));
    expect(refetchMap).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "층 도면" })).not.toBeInTheDocument();
  });

  it("부분 지도 갱신 실패에서도 직전 유효 데이터를 유지한다", async () => {
    refetchMap.mockRejectedValueOnce(new Error("map unavailable"));
    render(<MonitoringView siteId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));

    expect(await screen.findByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "층 도면" })).toBeInTheDocument();
    openDetails();
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("현재 밝기");
    closeInspector();
    const current = openCurrentStatus();
    expect(current).toHaveTextContent("지도 갱신에 실패했습니다.");
    fireEvent.click(within(current).getByRole("button", { name: "지도 다시 시도" }));
    expect(refetchMap).toHaveBeenCalledTimes(2);
  });

  it("같은 cached 지도의 observer 변화로 실패를 지우지 않고 새 자동 성공에서만 복구한다", async () => {
    const baselineUpdatedAt = new Date("2026-09-12T00:00:00.000Z").getTime();
    let mapState = {
      data: mapSnapshot,
      dataUpdatedAt: baselineUpdatedAt,
      error: null as Error | null,
      isPending: false,
      isLoading: false,
      isFetching: false,
      refetch: refetchMap
    };
    queryMocks.useFloorMapSnapshot.mockImplementation(() => mapState);
    refetchMap.mockRejectedValueOnce(new Error("map unavailable"));
    const view = render(<MonitoringView siteId="site-1" />);
    fireEvent.click(screen.getByRole("button", { name: "지도 확대" }));

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(await screen.findByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).toBeInTheDocument();

    view.rerender(<MonitoringView siteId="site-1" />);
    expect(screen.getByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).toBeInTheDocument();

    mapState = { ...mapState, dataUpdatedAt: baselineUpdatedAt + 1, isFetching: true };
    view.rerender(<MonitoringView siteId="site-1" />);
    expect(screen.getByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).toBeInTheDocument();

    mapState = {
      ...mapState,
      data: { ...mapSnapshot, revision: mapSnapshot.revision + 1 },
      isFetching: false
    };
    view.rerender(<MonitoringView siteId="site-1" />);

    await waitFor(() => expect(screen.queryByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).not.toBeInTheDocument());
    expect(screen.queryByText("일부 현황 데이터를 새로고침하지 못했습니다.")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "층 도면" })).toHaveAttribute("data-zoom", "1.1");
    openInspector();
    expect(screen.getByRole("button", { name: "상세 조명 선택" })).not.toHaveTextContent("B1-L001 · 장애");
  });

  it("지도 자동 복구는 함께 실패한 dashboard의 toolbar 오류를 지우지 않는다", async () => {
    const baselineUpdatedAt = new Date("2026-09-12T00:00:00.000Z").getTime();
    let mapState = {
      data: mapSnapshot,
      dataUpdatedAt: baselineUpdatedAt,
      error: null as Error | null,
      isPending: false,
      isLoading: false,
      isFetching: false,
      refetch: refetchMap
    };
    queryMocks.useFloorMapSnapshot.mockImplementation(() => mapState);
    refetchDashboard.mockRejectedValueOnce(new Error("dashboard unavailable"));
    refetchMap.mockRejectedValueOnce(new Error("map unavailable"));
    const view = render(<MonitoringView siteId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(await screen.findByText("일부 현황 데이터를 새로고침하지 못했습니다.")).toBeInTheDocument();

    mapState = {
      ...mapState,
      data: { ...mapSnapshot, revision: mapSnapshot.revision + 1 },
      dataUpdatedAt: baselineUpdatedAt + 1
    };
    view.rerender(<MonitoringView siteId="site-1" />);

    await waitFor(() => expect(screen.queryByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).not.toBeInTheDocument());
    expect(screen.getByText("일부 현황 데이터를 새로고침하지 못했습니다.")).toBeInTheDocument();
  });

  it("모바일 모니터링은 320px에서 문서 overflow 없이 동작한다", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    render(<MonitoringView siteId="site-1" />);

    const summary = screen.getByRole("region", { name: "선택 층 조명 현황" });
    const map = screen.getByRole("region", { name: "층 도면" });
    expect(summary.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(openDetails()).toContainElement(screen.getByRole("complementary", { name: "선택 조명 상세" }));
  });

  it("한 층의 지도 갱신 실패를 다른 층의 성공한 지도에 표시하지 않는다", async () => {
    const twoFloorDashboard = {
      ...dashboard,
      floors: [
        dashboard.floors[0],
        { ...dashboard.floors[0], id: "floor-2", name: "B2", level: -2 }
      ]
    };
    const firstFloorRefetch = vi.fn().mockRejectedValue(new Error("floor 1 map unavailable"));
    const secondFloorRefetch = vi.fn().mockResolvedValue({ data: { ...mapSnapshot, floorId: "floor-2" } });
    queryMocks.useDashboard.mockReturnValue({
      data: twoFloorDashboard,
      isLoading: false,
      error: null,
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      refetch: refetchDashboard
    });
    queryMocks.useFloorMapSnapshot.mockImplementation((floorId: string) => ({
      data: { ...mapSnapshot, floorId },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      error: null,
      isPending: false,
      isLoading: false,
      refetch: floorId === "floor-1" ? firstFloorRefetch : secondFloorRefetch
    }));
    render(<MonitoringView siteId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(await screen.findByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).toBeInTheDocument();

    await chooseSelect("맵 선택", "B2");

    expect(await screen.findByRole("button", { name: "맵 선택" })).toHaveTextContent("B2");
    expect(screen.queryByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).not.toBeInTheDocument();
  });
});

const mapSnapshot = {
  floorId: "00000000-0000-4000-8000-000000000003",
  revision: 1,
  width: 1200,
  height: 800,
  floorPlan: null,
  objects: []
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function chooseSelect(label: string, option: string) {
  const trigger = screen.getByRole("button", { name: label });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
  return trigger;
}
