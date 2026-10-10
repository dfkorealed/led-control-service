import type { FloorMapSnapshot } from "@led-control/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureGroupMetadata } from "@led-control/shared";

import type { Dashboard } from "../../../api/queries";
import { FixtureGroupsPanel } from "./FixtureGroupsPanel";

const mocks = vi.hoisted(() => ({
  listFixtureGroups: vi.fn(),
  createFixtureGroup: vi.fn(),
  updateFixtureGroup: vi.fn(),
  deleteFixtureGroup: vi.fn(),
  resyncFixtureGroup: vi.fn()
}));
const floorMapQuery = vi.hoisted(() => vi.fn());

vi.mock("../../../api/fixture-groups", () => ({
  fixtureGroupQueryKey: (siteId: string) => ["fixture-groups", siteId],
  ...mocks
}));
vi.mock("../../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/queries")>()),
  useFloorMapSnapshot: floorMapQuery
}));

const ids = {
  site: "00000000-0000-4000-8000-000000000101",
  floor: "00000000-0000-4000-8000-000000000102",
  gateway: "00000000-0000-4000-8000-000000000103",
  firstFixture: "00000000-0000-4000-8000-000000000104",
  secondFixture: "00000000-0000-4000-8000-000000000105",
  group: "00000000-0000-4000-8000-000000000106"
};

const failedGroup: FixtureGroupMetadata = {
  id: ids.group,
  name: "B2 입구",
  floorId: ids.floor,
  gatewayId: ids.gateway,
  lifecycleStatus: "active",
  fixtureCount: 1,
  meshControlGroup: { status: "failed", version: 2, error: "구독 설정 응답 시간 초과" }
};

const dashboard = createDashboard();
const snapshot: FloorMapSnapshot = { floorId: ids.floor, revision: 1, width: 600, height: 400, floorPlan: null, objects: [] };

describe("FixtureGroupsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    floorMapQuery.mockReturnValue({ data: snapshot, error: null, isLoading: false, isFetching: false });
    mocks.listFixtureGroups.mockResolvedValue([failedGroup]);
    mocks.updateFixtureGroup.mockResolvedValue({ ...failedGroup, name: "수정 이름", meshControlGroup: { status: "configuring", version: 3, error: null } });
    mocks.deleteFixtureGroup.mockResolvedValue({ id: ids.group, lifecycleStatus: "retiring" });
    mocks.resyncFixtureGroup.mockResolvedValue({ ...failedGroup, meshControlGroup: { status: "configuring", version: 3, error: null } });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  function mount(canManage = true, isActive = true, mutationsBlocked = false) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const props = { siteId: ids.site, dashboard, canManage, isActive, mutationsBlocked };
    const view = render(<QueryClientProvider client={client}><FixtureGroupsPanel {...props} /></QueryClientProvider>);
    return { ...view, client, props };
  }
  it("fidelity exposes the actual group fields through the shared grid and keeps row mutations locked", async () => {
    mount(true, true, true);
    const list = await screen.findByRole("list", { name: "저장 구역 목록" });
    const row = within(list).getByRole("listitem");
    expect(row).toHaveTextContent("B2 입구");
    expect(row).toHaveTextContent("B2");
    expect(row).toHaveTextContent("Gateway B2");
    expect(row).toHaveTextContent("1개");
    expect(row).toHaveTextContent("Mesh 설정 실패");
    expect(row).toHaveTextContent("Mesh 구성 v2");
    for (const action of ["수정", "재동기화", "삭제"]) {
      const button = within(row).getByRole("button", { name: `B2 입구 ${action}` });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(mocks.updateFixtureGroup).not.toHaveBeenCalled();
    expect(mocks.resyncFixtureGroup).not.toHaveBeenCalled();
    expect(mocks.deleteFixtureGroup).not.toHaveBeenCalled();
  });
  it("keeps the approved common surface inset around list and the same active editor", async () => {
    mount();
    await screen.findByText("B2 입구");
    const surface = screen.getByRole("heading", { name: "현재 저장 구역" }).closest("section[data-variant]");
    // This asserts the approved spacing declaration, not JSDOM pixel geometry.
    expect(surface).toHaveClass("p-4");
    fireEvent.click(screen.getByRole("button", { name: "B2 입구 수정" }));
    expect(screen.getByLabelText("구역 이름").closest("section[data-variant]")).toBe(surface);
    expect(surface).toHaveClass("p-4");
  });
  it("reads the actual failed Mesh state without exposing mutations for a control-only user", async () => {
    mount(false);
    await screen.findByText("B2 입구");
    expect(screen.getByText("Mesh 설정 실패")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /새 구역|수정|삭제|재동기화/ })).not.toBeInTheDocument();
    expect(mocks.createFixtureGroup).not.toHaveBeenCalled();
    expect(mocks.updateFixtureGroup).not.toHaveBeenCalled();
  });
  it("uses one original membership editor and saves the full replacement snapshot", async () => {
    mount();
    await screen.findByText("B2 입구");
    fireEvent.click(screen.getByRole("button", { name: "B2 입구 수정" }));
    fireEvent.change(screen.getByLabelText("구역 이름"), { target: { value: "수정 이름" } });
    fireEvent.click(await screen.findByRole("button", { name: /B2-L002/ }));
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    await waitFor(() => expect(mocks.updateFixtureGroup).toHaveBeenCalledWith(ids.site, ids.group, {
      name: "수정 이름", floorId: ids.floor, gatewayId: ids.gateway, fixtureIds: [ids.firstFixture, ids.secondFixture]
    }));
    expect(await screen.findByText("수정 이름")).toBeInTheDocument();
    expect(screen.getByText("Mesh 설정 중")).toBeInTheDocument();
    expect(mocks.createFixtureGroup).not.toHaveBeenCalled();
  });
  it("disables both the open deletion confirmation and latest mutation handler when locks change", async () => {
    const { rerender, client, props } = mount();
    await screen.findByText("B2 입구");
    fireEvent.click(screen.getByRole("button", { name: "B2 입구 삭제" }));
    rerender(<QueryClientProvider client={client}><FixtureGroupsPanel {...props} mutationsBlocked /></QueryClientProvider>);
    expect(screen.getByRole("button", { name: "삭제 확인" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "삭제 확인" }));
    expect(mocks.deleteFixtureGroup).not.toHaveBeenCalled();
  });
  it("stops an inactive panel query and resets its draft on reactivation", async () => {
    const { rerender, client, props } = mount(true, false);
    expect(mocks.listFixtureGroups).not.toHaveBeenCalled();
    rerender(<QueryClientProvider client={client}><FixtureGroupsPanel {...props} isActive /></QueryClientProvider>);
    await screen.findByText("B2 입구");
    fireEvent.click(screen.getByRole("button", { name: "새 구역" }));
    fireEvent.change(screen.getByLabelText("구역 이름"), { target: { value: "비활성 초안" } });
    rerender(<QueryClientProvider client={client}><FixtureGroupsPanel {...props} isActive={false} /></QueryClientProvider>);
    await client.invalidateQueries({ queryKey: ["fixture-groups", ids.site] });
    expect(mocks.listFixtureGroups).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("구역 이름")).not.toBeInTheDocument();
  });
  it("cleans the single polling observer and stops API reads after unmount", async () => {
    vi.useFakeTimers();
    const { unmount, client } = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.listFixtureGroups).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocks.listFixtureGroups).toHaveBeenCalledTimes(2);
    unmount();
    expect(client.getQueryCache().find({ queryKey: ["fixture-groups", ids.site] })?.getObserversCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(mocks.listFixtureGroups).toHaveBeenCalledTimes(2);
    client.clear();
  });
});
function createDashboard(): Dashboard {
  const fixture = (id: string, name: string): Dashboard["floors"][number]["fixtures"][number] => ({
    id,
    name,
    x: 0,
    y: 0,
    ratedWatt: 40,
    brightness: 70,
    status: "online",
    health: { faultCodes: [], observedAt: "2026-08-26T00:00:00.000Z" },
    rssi: -55,
    hopCount: 1,
    commandSuccessRate: 1,
    lastSeenAt: "2026-08-26T00:00:00.000Z",
    gateway: { id: ids.gateway, name: "Gateway B2", connectionStatus: "online" },
    controllable: true,
    controlBlockReason: null
  });
  return {
    generatedAt: "2026-09-12T00:00:00.000Z",
    monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
    site: {
      id: ids.site,
      name: "테스트 현장",
      customerName: "테스트 고객사",
      installationStatus: "installed",
      address: "서울시 강남구",
      tariffKwhRate: 160,
      timeZone: "Asia/Seoul"
    },
    summary: { totalFixtures: 2, onlineFixtures: 2, faultFixtures: 0, averageBrightness: 70 },
    floors: [{
      id: ids.floor,
      name: "B2",
      level: -2,
      floorPlan: null,
      meshControlGroups: [{ gatewayId: ids.gateway, status: "ready", version: 1, error: null }],
      fixtures: [fixture(ids.firstFixture, "B2-L001"), fixture(ids.secondFixture, "B2-L002")]
    }],
    groups: [{ ...failedGroup, fixtureIds: [ids.firstFixture] }],
    gateways: [{
      id: ids.gateway,
      name: "Gateway B2",
      serialNumber: "GW-001",
      firmwareVersion: "1.0.0",
      lastHeartbeatAt: "2026-08-26T00:00:00.000Z",
      connectionStatus: "online"
    }]
  };
}
