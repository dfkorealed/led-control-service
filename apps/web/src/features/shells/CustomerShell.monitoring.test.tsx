import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../api/auth";
import type { Dashboard, FixtureSnapshot } from "../../api/queries";
import { incidentFixture } from "../monitoring/monitoring-test-fixtures";
import { CustomerShell } from "./CustomerShell";

const admin: AuthUser = { id: "admin-1", name: "현재 관리자", loginId: "site-admin", status: "active", role: "admin", organizationId: "org-1", organizationType: "customer", mustChangePassword: false };
const fixture: FixtureSnapshot = { id: "fixture-1", name: "입구 조명", x: 100, y: 100, ratedWatt: 40, brightness: 70, status: "online", statusReason: "reported", health: null, rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: null, gateway: null, controllable: false, controlBlockReason: "fixture_unmapped" };
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let canManage: boolean;

beforeEach(() => {
  canManage = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
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
    if (path === "/api/sites/site-1/users") return Response.json({ users: [], count: 0, limit: 100 });
    if (path === "/api/sites/site-1/floors/floor-1/fixtures?limit=200") return Response.json({ items: [fixture], generatedAt: new Date().toISOString(), nextCursor: null });
    if (path === "/api/sites/site-1/floors/floor-1/map-snapshot") return Response.json({ floorId: "floor-1", revision: 1, width: 1200, height: 800, floorPlan: null, objects: [] });
    if (path === "/api/sites/site-1/monitoring-incidents?status=all&limit=20") return Response.json({ incidents: [incidentFixture()], activeCount: 1, nextCursor: null });
    if (path === "/api/sites/site-1/monitoring-incidents/incident-1" && init?.method === "PATCH") return Response.json(incidentFixture());
    throw new Error(`Unexpected monitoring request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

function mount() {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/monitoring?siteId=site-1"]}><CustomerShell user={admin} /></MemoryRouter></QueryClientProvider>);
}

describe("customer shell monitoring identity", () => {
  it("carries authenticated admin identity through the real view to self-assignment", async () => {
    mount();
    fireEvent.click(await screen.findByRole("tab", { name: "인시던트 1" }));
    const assignee = await screen.findByRole("combobox", { name: "담당자" });
    await waitFor(() => expect(assignee).toBeEnabled());
    expect(within(assignee).getByRole("option", { name: "현재 관리자 (site-admin)" })).toHaveValue("admin-1");
    fireEvent.change(assignee, { target: { value: "admin-1" } });
    fireEvent.click(screen.getByRole("button", { name: "담당 저장" }));
    await waitFor(() => expect(JSON.parse(fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1].body ?? "null")).toEqual({ action: "assign", userId: "admin-1", expectedUpdatedAt: "2026-09-12T01:00:00.000Z" }));
  });

  it("does not turn active admin identity into write capability or request site users for a read-only site", async () => {
    canManage = false;
    mount();
    fireEvent.click(await screen.findByRole("tab", { name: "인시던트 1" }));
    expect(screen.getByRole("list", { name: "인시던트 이력" })).toHaveTextContent("입구 조명");
    expect(screen.queryByRole("combobox", { name: "담당자" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "판정 기준" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/sites/site-1/users")).toBe(false);
  });
});
