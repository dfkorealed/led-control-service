import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../api/auth";
import type { Dashboard, FixtureSnapshot } from "../../api/queries";
import { CustomerShell } from "./CustomerShell";

const admin: AuthUser = { id: "admin-1", name: "현재 관리자", loginId: "site-admin", status: "active", role: "admin", organizationId: "org-1", organizationType: "customer", mustChangePassword: false };
const fixture: FixtureSnapshot = { id: "fixture-1", name: "입구 조명", x: 100, y: 100, ratedWatt: 40, brightness: 70, status: "online", statusReason: "reported", health: null, rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: null, gateway: null, controllable: false, controlBlockReason: "fixture_unmapped" };
let client: QueryClient;
// Keep this fixture callable when Vitest's generic mock type includes constructors.
let fetchMock: ReturnType<typeof vi.fn<(path: string) => Promise<Response>>>;
let canManage: boolean;
let refreshed: boolean;

beforeEach(() => {
  canManage = true;
  refreshed = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(min-width: 1024px)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  fetchMock = vi.fn(async (path: string) => {
    if (path === "/api/sites") return Response.json([{ id: "site-1", name: "현장", customerName: "고객" }]);
    if (path === "/api/sites/site-1/monitoring-incidents?limit=1&view=personal") return Response.json({ incidents: [], unreadCount: 0, activeCount: 0, nextCursor: null });
    if (path === "/api/sites/site-1/dashboard") {
      const fixtureCounts = refreshed
        ? { totalFixtures: 1, onlineFixtures: 0, faultFixtures: 0, offlineFixtures: 1 }
        : { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, offlineFixtures: 0 };
      const dashboard: Dashboard = {
        generatedAt: new Date().toISOString(), monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
        site: { id: "site-1", name: "현장", customerName: "고객", installationStatus: "installed", address: null, tariffKwhRate: null, timeZone: "Asia/Seoul" },
        capabilities: { read: true, control: canManage, manage: canManage, commission: canManage },
        summary: { ...fixtureCounts, averageBrightness: 70 },
        floors: [{ id: "floor-1", name: "B1", level: -1, summary: fixtureCounts, floorPlan: null, meshControlGroups: [], fixtures: [] }], groups: [], gateways: []
      };
      return Response.json(dashboard);
    }
    if (path === "/api/sites/site-1/floors/floor-1/monitoring-refreshes") return Response.json({ id: "refresh-1", status: "completed", totalFixtures: 1 });
    if (path === "/api/sites/site-1/monitoring-refreshes/refresh-1") {
      refreshed = true;
      return Response.json({ id: "refresh-1", status: "completed", totalFixtures: 1, onlineFixtures: 0, offlineFixtures: 1, unverifiedFixtures: 0, completedAt: new Date().toISOString() });
    }
    if (path === "/api/sites/site-1/floors/floor-1/fixtures?limit=200") return Response.json({ items: [{ ...fixture, ...(refreshed ? { status: "offline", statusReason: "fixture_stale" } : {}) }], generatedAt: new Date().toISOString(), nextCursor: null });
    if (path === "/api/sites/site-1/floors/floor-1/map-snapshot") return Response.json({ floorId: "floor-1", revision: 1, width: 1200, height: 800, floorPlan: null, objects: [] });
    if (path === "/api/sites/site-1/floors/floor-1/monitoring-activity?limit=5") return Response.json({ generatedAt: new Date().toISOString(), retainedFrom: "2026-06-25T00:00:00.000Z", items: [], nextCursor: null });
    throw new Error(`Unexpected monitoring request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

function mount() {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/monitoring?siteId=site-1"]}><CustomerShell user={admin} /></MemoryRouter></QueryClientProvider>);
}

async function openFixtureInspector() {
  fireEvent.click(await screen.findByRole("button", { name: "조명 검색/목록" }));
  const finder = await screen.findByRole("dialog", { name: "조명 검색/목록" });
  expect(within(finder).queryByRole("complementary", { name: "선택 조명 상세" })).not.toBeInTheDocument();
  fireEvent.click(within(finder).getByRole("button", { name: /입구 조명/ }));
  const pin = await screen.findByRole("dialog", { name: "입구 조명 조명 정보" });
  fireEvent.click(within(pin).getByRole("button", { name: "상세 보기" }));
  return screen.findByRole("complementary", { name: "조명 상세" });
}

describe("customer shell monitoring details", () => {
  it("reserves a single flow notice band outside the sticky header and keeps monitoring fullview naturally scrollable", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (path: string) => {
      const response = await normalFetch(path);
      if (!String(path).includes('/fixtures?')) return response;
      return Response.json({ ...await response.json(), generatedAt: new Date(Date.now() - 120_000).toISOString() });
    });
    mount();
    const notice = await screen.findByRole("region", { name: "알림" });
    expect(await within(notice).findByRole("status")).toHaveTextContent("현황 갱신이 지연");
    const main = screen.getByRole("main"), header = main.querySelector('[data-shell-topbar]')!, content = main.querySelector('[data-shell-content]')!;
    expect(main).toContainElement(notice); expect(header).not.toContainElement(notice);
    expect(header.nextElementSibling).toBe(notice); expect(notice.nextElementSibling).toBe(content);
    expect(notice).not.toHaveClass("fixed");
    fireEvent.click(screen.getByRole("button", { name: "지도 전체 보기" }));
    expect(main.parentElement).toHaveAttribute("data-workspace-full-view", "true");
    expect(main.parentElement).not.toHaveClass("overflow-hidden"); expect(main).not.toHaveClass("overflow-hidden"); expect(content).not.toHaveClass("overflow-hidden");
    expect(screen.getAllByRole("region", { name: "알림" })).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([path]) => String(path).includes('monitoring-refreshes'))).toHaveLength(0);
  });

  it.each([false, true])("gives monitoring a definite flex height without clipping short-height page overflow (compact %s)", async (compact) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: compact, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    mount();
    await screen.findByRole("button", { name: "새로고침" });
    const main = screen.getByRole("main");
    expect(main.parentElement).toHaveClass("flex", "h-dvh", "min-h-0");
    expect(main.parentElement).not.toHaveClass("pb-shell-navigation-safe");
    expect(main.parentElement).not.toHaveClass("overflow-hidden");
    expect(main).toHaveClass("min-h-0");
    expect(main).not.toHaveClass("overflow-hidden");
    const content = main.querySelector("[data-shell-content]");
    expect(content).toHaveClass("flex", "flex-col", "min-h-0");
    expect(content).not.toHaveClass("overflow-hidden");
  });

  it.each(["loading", "error"])("sends exactly one hardware POST after the initial fixture GET recovers from %s", async (initialState) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let blocked = true;
    let release!: () => void;
    const initialResponse = new Promise<void>((resolve) => { release = resolve; });
    fetchMock.mockImplementation(async (path: string) => {
      if (blocked && path === "/api/sites/site-1/floors/floor-1/fixtures?limit=200") {
        if (initialState === "error") return Response.json({ message: "private upstream error" }, { status: 503 });
        await initialResponse;
      }
      return normalFetch(path);
    });
    mount();
    const refresh = await screen.findByRole("button", { name: "새로고침" });
    if (initialState === "error") {
      await waitFor(() => expect(client.getQueryState(["floor-fixtures", "site-1", "floor-1"])?.status).toBe("error"));
      blocked = false;
    }
    fireEvent.click(refresh);
    expect(screen.getByRole("button", { name: "장치 상태 확인 중" })).toBeDisabled();
    blocked = false;
    release();
    await waitFor(() => expect(within(screen.getByRole("region", { name: "선택 층 조명 현황" })).getByText("오프라인").parentElement).toHaveTextContent("1"));
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/sites/site-1/floors/floor-1/monitoring-refreshes")).toHaveLength(1);
    const inspector = await openFixtureInspector();
    expect(within(inspector).getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("상태 수신 지연");
    expect(refresh).toBeEnabled();
    expect(screen.queryByText(/private upstream/)).not.toBeInTheDocument();
  });

  it("lets a read-only member refresh physical status and updates the selected detail through real queries", async () => {
    canManage = false;
    mount();
    const refresh = await screen.findByRole("button", { name: "새로고침" });
    fireEvent.click(refresh);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "선택 층 조명 현황" })).getByText("오프라인").parentElement).toHaveTextContent("1"));
    const inspector = await openFixtureInspector();
    expect(within(inspector).getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("상태 수신 지연");
    expect(refresh).toBeEnabled();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/sites/site-1/floors/floor-1/monitoring-refreshes")).toHaveLength(1);
  });
  it("shows fixture details with a read-only closed alarm badge and no incident operations", async () => {
    mount();
    const inspector = await openFixtureInspector();
    expect(await within(inspector).findByRole("region", { name: "선택 조명 정보" })).toBeVisible();
    expect(screen.queryByText(/인시던트/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "판정 기준" })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => String(path).includes("monitoring-incidents"))).toEqual([
      ["/api/sites/site-1/monitoring-incidents?limit=1&view=personal", expect.objectContaining({ credentials: "include" })]
    ]));
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/sites/site-1/users")).toBe(false);
  });
});
