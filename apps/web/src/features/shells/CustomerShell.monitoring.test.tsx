import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../api/auth";
import type { Dashboard, FixtureSnapshot } from "../../api/queries";
import { CustomerShell } from "./CustomerShell";

const admin: AuthUser = { id: "admin-1", name: "현재 관리자", loginId: "site-admin", status: "active", role: "admin", organizationId: "org-1", organizationType: "customer", mustChangePassword: false };
const fixture: FixtureSnapshot = { id: "fixture-1", name: "입구 조명", x: 100, y: 100, ratedWatt: 40, brightness: 70, status: "online", statusReason: "reported", health: null, rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: null, gateway: null, controllable: false, controlBlockReason: "fixture_unmapped" };
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let canManage: boolean;
let refreshed: boolean;

beforeEach(() => {
  canManage = true;
  refreshed = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  fetchMock = vi.fn(async (path: string) => {
    if (path === "/api/sites/site-1/dashboard") {
      const dashboard: Dashboard = {
        generatedAt: new Date().toISOString(), monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
        site: { id: "site-1", name: "현장", customerName: "고객", installationStatus: "installed", address: null, tariffKwhRate: null, timeZone: "Asia/Seoul" },
        capabilities: { read: true, control: canManage, manage: canManage, commission: canManage },
        summary: { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, averageBrightness: 70 },
        floors: [{ id: "floor-1", name: "B1", level: -1, floorPlan: null, meshControlGroups: [], fixtures: [] }], groups: [], gateways: []
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
    throw new Error(`Unexpected monitoring request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

function mount() {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/monitoring?siteId=site-1"]}><CustomerShell user={admin} /></MemoryRouter></QueryClientProvider>);
}

describe("customer shell monitoring details", () => {
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
    await waitFor(() => expect(screen.getByRole("group", { name: "오프라인" })).toHaveTextContent("1"));
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/sites/site-1/floors/floor-1/monitoring-refreshes")).toHaveLength(1);
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("상태 수신 지연");
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    expect(screen.queryByText(/private upstream/)).not.toBeInTheDocument();
  });

  it("lets a read-only member refresh physical status and updates the selected detail through real queries", async () => {
    canManage = false;
    mount();
    await screen.findByRole("region", { name: "선택 조명 정보" });
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByRole("group", { name: "오프라인" })).toHaveTextContent("1"));
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("상태 수신 지연");
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/sites/site-1/floors/floor-1/monitoring-refreshes")).toHaveLength(1);
  });
  it("shows fixture details without requesting or exposing incident operations", async () => {
    mount();
    expect(await screen.findByRole("region", { name: "선택 조명 정보" })).toBeVisible();
    expect(screen.queryByText(/인시던트/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "판정 기준" })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes("monitoring-incidents"))).toBe(false));
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/sites/site-1/users")).toBe(false);
  });
});
