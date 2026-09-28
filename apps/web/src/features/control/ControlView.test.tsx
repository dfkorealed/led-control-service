import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FloorMapSnapshot } from "@led-control/shared";
import type { CommandStage } from "../../api/commands";
import type { Dashboard } from "../../api/queries";
import { SessionStatusCenter, SessionStatusProvider, ToastRegion } from "../../components/ui";
import { detailRetainedFrom } from "../../api/detail-retention";
import { ControlView } from "./ControlView";
import { activeCommandStorageKey, loadObservedVerificationCase, saveObservedVerificationCase,
  saveActiveCommandRequest, markActiveCommandReplayRejected, markActiveCommandCaseReconciled } from "./active-command-store";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(),
  useControlDashboard: vi.fn(),
  useFloorMapSnapshot: vi.fn(),
  useCommandStatus: vi.fn()
}));

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  apiPost: mocks.apiPost,
  apiGet: async (...args: unknown[]) => ({ generatedAt: "2026-09-25T00:00:00.000Z", retainedFrom: "2026-06-25T00:00:00.000Z", retentionEnabled: false, ...await mocks.apiGet(...args) }),
  apiRequest: vi.fn()
}));
vi.mock("../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/queries")>()),
  useControlDashboard: mocks.useControlDashboard,
  useFloorMapSnapshot: mocks.useFloorMapSnapshot
}));
vi.mock("../../api/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/commands")>()),
  useCommandStatus: (...args: Parameters<typeof import("../../api/commands").useCommandStatus>) => ({
    isDetailCurrent: () => true,
    ...mocks.useCommandStatus(...args)
  })
}));
vi.mock("./automation/ScheduleControlPanel", () => ({
  ScheduleControlPanel: ({ siteId }: { siteId: string }) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    return (
      <div>
        <p>스케줄 패널 {siteId}</p>
        <button type="button" onClick={() => setDialogOpen(true)}>테스트 스케줄 dialog 열기</button>
        {dialogOpen ? <p>테스트 스케줄 dialog 열림</p> : null}
      </div>
    );
  }
}));
vi.mock("./automation/VehicleEventControlPanel", () => ({
  VehicleEventControlPanel: ({ siteId }: { siteId: string }) => <p>이벤트 패널 {siteId}</p>
}));

const fixtureIds = {
  b2First: "00000000-0000-4000-8000-000000002001",
  b2Second: "00000000-0000-4000-8000-000000002002",
  b2Offline: "00000000-0000-4000-8000-000000002003",
  b1First: "00000000-0000-4000-8000-000000003001"
};

const commandIds = {
  default: "00000000-0000-4000-8000-000000009001",
  locked: "00000000-0000-4000-8000-000000009002",
  expected: "00000000-0000-4000-8000-000000009003",
  different: "00000000-0000-4000-8000-000000009004",
  missing: "00000000-0000-4000-8000-000000009005",
  terminal: "00000000-0000-4000-8000-000000009006",
  large: "00000000-0000-4000-8000-000000009007",
  restored: "00000000-0000-4000-8000-000000009008",
  retry: "00000000-0000-4000-8000-000000009009",
  siteA: "00000000-0000-4000-8000-000000009010",
  siteB: "00000000-0000-4000-8000-000000009011",
  cached404: "00000000-0000-4000-8000-000000009012"
};
const USER_A = "user-a";
const USER_B = "user-b";

const mapSnapshot: FloorMapSnapshot = {
  floorId: "00000000-0000-4000-8000-000000000005",
  revision: 1,
  width: 600,
  height: 400,
  floorPlan: null,
  objects: []
};

const dashboard: Dashboard = {
  generatedAt: "2026-09-12T00:00:00.000Z",
  monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
  capabilities: { read: true, control: true, manage: true, commission: true },
  site: {
    id: "00000000-0000-4000-8000-000000000003",
    name: "테스트 현장",
    customerName: "테스트 고객사",
    installationStatus: "installed",
    address: "서울시 강남구",
    tariffKwhRate: 160,
    timeZone: "Asia/Seoul"
  },
  summary: { totalFixtures: 4, onlineFixtures: 3, faultFixtures: 0, averageBrightness: 65 },
  floors: [
    {
      id: "00000000-0000-4000-8000-000000000005",
      name: "B2",
      level: -2,
      floorPlan: null,
      meshControlGroups: [{ gatewayId: "gateway-1", status: "ready", version: 1, error: null }],
      fixtures: [
        createFixture(fixtureIds.b2First, "B2-L001", 70),
        createFixture(fixtureIds.b2Second, "B2-L002", 60),
        createFixture(fixtureIds.b2Offline, "B2-L003", 0, {
          status: "offline",
          gateway: { id: "gateway-1", name: "GW-B2", connectionStatus: "offline" },
          controllable: false,
          controlBlockReason: "gateway_offline"
        })
      ]
    },
    {
      id: "00000000-0000-4000-8000-000000000015",
      name: "B1",
      level: -1,
      floorPlan: null,
      meshControlGroups: [{ gatewayId: "gateway-1", status: "ready", version: 1, error: null }],
      fixtures: [createFixture(fixtureIds.b1First, "B1-L001", 50)]
    }
  ],
  groups: [
    {
      id: "00000000-0000-4000-8000-000000000006",
      name: "B2 입구 구역",
      floorId: "00000000-0000-4000-8000-000000000005",
      gatewayId: "gateway-1",
      lifecycleStatus: "active",
      fixtureCount: 2,
      meshControlGroup: { status: "ready", version: 1, error: null },
      fixtureIds: [fixtureIds.b2First, fixtureIds.b2Second]
    },
    {
      id: "00000000-0000-4000-8000-000000000007",
      name: "B2 비상 구역",
      floorId: "00000000-0000-4000-8000-000000000005",
      gatewayId: "gateway-1",
      lifecycleStatus: "active",
      fixtureCount: 2,
      meshControlGroup: { status: "ready", version: 1, error: null },
      fixtureIds: [fixtureIds.b2First, fixtureIds.b2Offline]
    }
  ],
  gateways: []
};

describe("ControlView 대상 선택", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.apiGet.mockResolvedValue({ items: [], nextCursor: null });
    mocks.apiPost.mockResolvedValue({
      id: commandIds.default,
      dispatchCount: 1,
      selectedTargetCount: 2,
      transmissionCount: 2,
      deliveryMode: "parallel_unicast"
    });
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: null, isFetching: false, refetch: vi.fn() });
    mocks.useControlDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null });
    mocks.useFloorMapSnapshot.mockImplementation((floorId: string) => ({
      data: floorId ? { ...mapSnapshot, floorId } : undefined,
      error: null,
      isLoading: false,
      isFetching: false
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    sessionStorage.clear();
  });

  it.each([401, 403, 404, 410, 500])("discards an open terminal result after refetch %s without replay", async (status) => {
    const actual = await vi.importActual<typeof import("../../api/commands")>("../../api/commands");
    mocks.useCommandStatus.mockImplementation(actual.useCommandStatus);
    const record = { ...createCommandStatus(commandIds.terminal, "verified_not_applied"), retentionEnabled: true, get generatedAt() { return new Date().toISOString(); }, get retainedFrom() { return new Date(detailRetainedFrom(Date.now())).toISOString(); }, createdAt: new Date().toISOString(), siteId: dashboard.site.id, targetFixtureIds: [fixtureIds.b2First], brightness: 37 };
    let unavailable = false;
    mocks.apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/commands?")) return { retentionEnabled: true, generatedAt: record.generatedAt, retainedFrom: record.retainedFrom, items: [record], nextCursor: null };
      if (unavailable) throw { status, body: { code: status === 410 ? "command_expired" : "unavailable" } };
      return record;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SessionStatusProvider><MemoryRouter><ControlView siteId={dashboard.site.id} userId={USER_A} userRole="admin" /></MemoryRouter></SessionStatusProvider></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(commandIds.terminal) }));
    expect(await screen.findByRole("button", { name: "안전하게 다시 적용" })).toBeEnabled();
    unavailable = true;
    await act(async () => { await client.invalidateQueries({ queryKey: ["command-status", record.id] }); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "안전하게 다시 적용" })).not.toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "명령 결과 후속 조치" })).not.toBeInTheDocument();
    expect(Boolean(screen.queryByText(/상세 보관 종료/))).toBe(status === 410);
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-05-31T12:00:00Z", "2026-08-31T12:00:00Z"],
    ["2026-02-28T23:00:00Z", "2026-05-28T23:00:00Z"],
    ["2024-02-29T23:30:00Z", "2024-05-29T23:30:00Z"],
    ["2026-02-28T23:00:00Z", "2026-05-29T23:00:00Z"]
  ])("expires the open terminal result and history drawer for %s at %s", async (createdAt, boundary) => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); vi.setSystemTime(new Date(Date.parse(boundary) - 1_000));
    const actual = await vi.importActual<typeof import("../../api/commands")>("../../api/commands");
    mocks.useCommandStatus.mockImplementation(actual.useCommandStatus);
    const record = { ...createCommandStatus(commandIds.terminal, "verified_not_applied"), retentionEnabled: true, get generatedAt() { return new Date().toISOString(); }, get retainedFrom() { return new Date(detailRetainedFrom(Date.now())).toISOString(); }, createdAt, siteId: dashboard.site.id, targetFixtureIds: [fixtureIds.b2First], brightness: 37 };
    mocks.apiGet.mockImplementation(async (path: string) => path.startsWith("/commands?") ? { retentionEnabled: true, generatedAt: record.generatedAt, retainedFrom: record.retainedFrom, items: [record], nextCursor: null } : record);
    renderControl();
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(commandIds.terminal) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByRole("button", { name: "안전하게 다시 적용" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "명령 이력 열기" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    expect(within(drawer).getByRole("button", { name: new RegExp(commandIds.terminal) })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(942); });
    expect(within(drawer).queryByRole("button", { name: new RegExp(commandIds.terminal) })).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "명령 이력 닫기" }));
    expect(screen.queryByRole("button", { name: "안전하게 다시 적용" })).not.toBeInTheDocument();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("atlas execution keeps one natural-flow map and execution surface with no numbered duplicate headings", () => {
    renderControl();
    const toolbar = document.querySelector<HTMLElement>("[data-target-selection-toolbar]");
    const execution = screen.getByRole("complementary", { name: "밝기 실행" });
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "구역 관리" }));
    expect(screen.queryByRole("heading", { name: "조명 밝기 제어" })).not.toBeInTheDocument();
    expect(screen.queryByText("01 / 제어 대상")).not.toBeInTheDocument();
    expect(screen.queryByText("02 / 밝기 실행")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "선택 대상 요약" })).not.toBeInTheDocument();
    expect(execution).not.toHaveClass("hidden");
    expect(screen.getByRole("region", { name: "제어 대상 지도" })).toHaveClass("max-compact:overflow-visible");
    expect(screen.getByRole("region", { name: "공간 대상 선택" })).toHaveClass("max-compact:overflow-visible");
    expect(within(execution).getByText("0개 선택")).toBeInTheDocument();
    expect(within(execution).getByRole("button", { name: "밝기 적용" })).toBeDisabled();
  });

  it("atlas execution keeps a refreshed blocked selection intact but sends no partial command", () => {
    const { rerender } = renderControl();
    selectFixture("B2-L001");
    const blockedDashboard: Dashboard = {
      ...dashboard,
      floors: dashboard.floors.map((floor) => ({
        ...floor,
        fixtures: floor.fixtures.map((fixture) => fixture.id === fixtureIds.b2First
          ? { ...fixture, controllable: false, status: "offline", controlBlockReason: "gateway_offline" }
          : fixture)
      }))
    };
    mocks.useControlDashboard.mockReturnValue({ data: blockedDashboard, isLoading: false, error: null });
    rerender(controlElement(dashboard.site.id));
    const execution = screen.getByRole("complementary", { name: "밝기 실행" });
    const count = within(execution).getByText("1개 선택");
    const warning = within(execution).getByRole("alert");
    expect(count.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(warning).toHaveTextContent(/제어할 수 없|오프라인/);
    const apply = within(execution).getByRole("button", { name: "1개 조명에 밝기 적용" });
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("exposes the calm operations hierarchy for manual control", () => {
    renderControl();

    expect(screen.queryByRole("heading", { name: "조명 제어", level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "조명 밝기 제어", level: 3 })).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "제어 방식" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "수동 제어" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "수동 제어" })).toHaveAttribute("data-control-manual-panel");
    expect(screen.getByRole("region", { name: "제어 대상 지도" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "조명 목록 열기" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "최근 명령 이력" })).toHaveAttribute("data-command-history-panel");
    expect(screen.getByRole("complementary", { name: "밝기 실행" })).toHaveAttribute("data-control-panel");
    expect(screen.getByRole("status", { name: "명령 진행 상태" })).toHaveAttribute("data-command-status-region");
  });

  it("uses the map as the primary manual target picker", () => {
    renderControl();

    expect(screen.getByRole("region", { name: "제어 대상 지도" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "조명 목록 열기" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "밝기 실행" })).toBeInTheDocument();
  });

  it("presents target, brightness, and recent result in decision order with one desktop apply action", () => {
    renderControl();

    const target = screen.getByRole("region", { name: "제어 대상 지도" });
    const brightness = screen.getByRole("heading", { name: "밝기" });
    const result = screen.getByRole("heading", { name: "최근 결과" });
    const execution = screen.getByRole("complementary", { name: "밝기 실행" });
    const apply = within(execution).getByRole("button", { name: "밝기 적용" });

    expect(target.compareDocumentPosition(brightness) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(brightness.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(execution).getAllByRole("button", { name: "밝기 적용" })).toHaveLength(1);
    expect(within(execution).queryByText(/전송 방식|BLE Mesh/)).not.toBeInTheDocument();
  });

  it("announces the selection count once across the map and execution panel", () => {
    renderControl();
    selectFixture("B2-L001");
    const countAnnouncements = [...document.querySelectorAll('[aria-live="polite"]')].filter((element) => element.textContent?.includes("1개 선택"));
    expect(countAnnouncements).toHaveLength(1);
  });

  it("keeps brightness, apply, and recent result in natural mobile reading order", () => {
    renderControl();
    const execution = screen.getByRole("complementary", { name: "밝기 실행" });
    const historyDisclosure = screen.getByRole("button", { name: "명령 이력 열기" });
    expect(execution).toContainElement(within(execution).getByRole("slider", { name: "밝기" }));
    expect(execution).toContainElement(within(execution).getByRole("textbox", { name: "밝기 수치" }));
    expect(execution).toContainElement(within(execution).getByRole("button", { name: "밝기 적용" }));
    expect(within(execution).getByRole("heading", { name: "최근 결과" })).toBeInTheDocument();
    expect(execution.compareDocumentPosition(historyDisclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "선택 대상 펼치기" })).not.toBeInTheDocument();
  });

  it("keeps submitted command progress and outcome actions inside the expanded compact summary", async () => {
    const verificationRequired = createCommandStatus(commandIds.default, "verification_required");
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: null, isFetching: false, refetch: vi.fn() });
    const { rerender } = renderControl();
    selectFixture("B2-L001");
    const execution = screen.getByRole("complementary", { name: "밝기 실행" });
    fireEvent.click(within(execution).getByRole("button", { name: "1개 조명에 밝기 적용" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith("/commands/dimming", expect.anything(), expect.anything()));
    mocks.useCommandStatus.mockReturnValue({ data: verificationRequired, error: null, isFetching: false, refetch: vi.fn() });
    rerender(controlElement(dashboard.site.id));

    const outcomeSurface = screen.getByRole("complementary", { name: "밝기 실행" });
    expect(within(outcomeSurface).getByRole("status", { name: "명령 진행 상태" })).toBeInTheDocument();
    expect(within(outcomeSurface).getAllByText("실제 상태 확인 필요").length).toBeGreaterThan(0);
    expect(within(outcomeSurface).getByRole("button", { name: "실제 상태 확인" })).toBeEnabled();
  });

  it("keeps lost-command retry inside the expanded compact summary", async () => {
    mocks.apiPost.mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({ id: commandIds.retry, dispatchCount: 1 });
    renderControl();
    selectFixture("B2-L001");
    const execution = screen.getByRole("complementary", { name: "밝기 실행" });
    fireEvent.click(within(execution).getByRole("button", { name: "1개 조명에 밝기 적용" }));

    const retry = await within(execution).findByRole("button", { name: "동일 요청 확인(새 제어 아님)" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(2));
  });

  it("keeps command status refresh inside the expanded compact summary", () => {
    const refetch = vi.fn();
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.expected }));
    mocks.useCommandStatus.mockReturnValue({
      data: createCommandStatus(commandIds.different, "completed"),
      error: null,
      isFetching: false,
      refetch
    });
    renderControl();

    const execution = screen.getByRole("complementary", { name: "밝기 실행" });
    const refresh = within(execution).getByRole("button", { name: "명령 상태 다시 조회" });
    fireEvent.click(refresh);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("places the compact apply sheet before the history drawer opener", () => {
    renderControl();

    const applySheet = screen.getByRole("complementary", { name: "밝기 실행" });
    const historyOpener = screen.getByRole("button", { name: "명령 이력 열기" });

    expect(applySheet.compareDocumentPosition(historyOpener) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(historyOpener).toHaveAttribute("aria-haspopup", "dialog");
    expect(within(applySheet).getByRole("button", { name: "밝기 적용" })).toBeInTheDocument();
  });

  it("submits the same stable fixture target selected from the map", async () => {
    renderControl();

    fireEvent.click(await screen.findByRole("button", { name: /B2-L001/ }));
    fireEvent.click(screen.getByRole("button", { name: "70%" }));
    fireEvent.click(within(screen.getByRole("complementary", { name: "밝기 실행" })).getByRole("button", { name: "1개 조명에 밝기 적용" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      "/commands/dimming",
      expect.objectContaining({ target: { type: "fixture", fixtureId: fixtureIds.b2First }, brightness: 70 }),
      expect.anything()
    ));
  });

  it("locks direct manual selection to the first fixture gateway", async () => {
    const multiGatewayDashboard = twoGatewayFloorDashboard("ready");
    mocks.useControlDashboard.mockReturnValue({ data: multiGatewayDashboard, isLoading: false, error: null });
    renderControl("admin", multiGatewayDashboard.site.id);

    fireEvent.click(await screen.findByRole("button", { name: /B2-L001/ }));
    fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
    expect(screen.getByRole("checkbox", { name: /B2-L002.*선택/ })).toBeDisabled();
  });

  it("keeps every map and brightness action disabled for a viewer", () => {
    mocks.useControlDashboard.mockReturnValue({
      data: { ...dashboard, capabilities: { read: true, control: false, manage: false, commission: false } },
      isLoading: false,
      error: null
    });
    renderControl("viewer");

    expect(screen.getAllByRole("button", { name: /L00/ }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
  });

  it("selects the visible map marker with an accessible fixture name", () => {
    renderControl();

    const marker = fixtureMarker("B2-L001");
    selectFixture("B2-L001");

    expect(marker).toHaveAttribute("aria-pressed", "true");
  });

  it("checks unknown without creating Set and locks controls until the verification finishes", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
    const unknown = { ...createCommandStatus(commandIds.default, "verification_required"), outcome: "unknown", verificationAttemptCount: 0 };
    mocks.useCommandStatus.mockReturnValue({ data: unknown, error: null, isFetching: false, refetch: vi.fn() });
    mocks.apiPost.mockResolvedValue({ dispatchId: "status-check", dispatchIds: ["status-check"], verificationAttempt: 1, terminalStatusUrl: `/commands/${commandIds.default}` });
    const { rerender } = renderControl();
    expect(screen.queryByRole("button", { name: "안전하게 다시 적용" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "실제 상태 확인" }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(`/commands/${commandIds.default}/status-checks`, { clientRequestId: expect.any(String) }, { signal: expect.any(AbortSignal) }));
    expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
    mocks.useCommandStatus.mockReturnValue({ data: { ...unknown, verificationAttemptCount: 1, dispatches: [{ ...unknown.dispatches[0], id: "status-check", kind: "status_check", verificationAttempt: 1, status: "accepted" }] }, error: null, isFetching: false, refetch: vi.fn() });
    rerender(controlElement(dashboard.site.id));
    expect(screen.getByRole("button", { name: "실제 상태 확인 중" })).toBeDisabled();
    expect(mocks.apiPost.mock.calls.every(([url]) => url.endsWith("/status-checks"))).toBe(true);
  });

  it("replays a lost status-check response with the same Get request ID", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
    mocks.useCommandStatus.mockReturnValue({ data: { ...createCommandStatus(commandIds.default, "verification_required"), verificationAttemptCount: 2 }, error: null, isFetching: false, refetch: vi.fn() });
    mocks.apiPost.mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce({ dispatchId: "check", dispatchIds: ["check"], verificationAttempt: 3 });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: "실제 상태 확인" }));
    fireEvent.click(await screen.findByRole("button", { name: "동일 상태 확인 요청 조회" }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(2));
    expect(mocks.apiPost.mock.calls[1][1]).toEqual(mocks.apiPost.mock.calls[0][1]);
  });

  it("keeps a rejected status-check explanation visible after releasing its local lock", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
    mocks.useCommandStatus.mockReturnValue({ data: createCommandStatus(commandIds.default, "verification_required"), error: null, isFetching: false, refetch: vi.fn() });
    mocks.apiPost.mockRejectedValueOnce({ status: 403 });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: "실제 상태 확인" }));
    await waitFor(() => expect(screen.getByRole("slider", { name: "밝기" })).toBeEnabled());
    expect(screen.getByText("상태 확인 권한이 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "동일 상태 확인 요청 조회" })).not.toBeInTheDocument();
  });

  it("unlocks after a lost status-check response when detail independently confirms application", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
    const original = createCommandStatus(commandIds.default, "verification_required");
    mocks.useCommandStatus.mockReturnValue({ data: original, error: null, isFetching: false, refetch: vi.fn() });
    mocks.apiPost.mockRejectedValueOnce(new Error("lost"));
    const { rerender } = renderControl();
    fireEvent.click(screen.getByRole("button", { name: "실제 상태 확인" }));
    await screen.findByRole("button", { name: "동일 상태 확인 요청 조회" });
    mocks.useCommandStatus.mockReturnValue({ data: { ...original, stage: "verified_applied", verificationAttemptCount: 1,
      dispatches: [...original.dispatches, { ...original.dispatches[0], id: "check", kind: "status_check", verificationAttempt: 1, status: "completed", results: [] }]
    }, error: null, isFetching: false, refetch: vi.fn() });
    rerender(controlElement(dashboard.site.id));
    await waitFor(() => expect(screen.getByRole("slider", { name: "밝기" })).toBeEnabled());
    expect(screen.getByText("요청한 밝기가 이미 적용되어 있습니다.")).toBeInTheDocument();
    expect(screen.queryByText("B2-L001: 장비 응답 오류")).not.toBeInTheDocument();
  });

  it("safely reapplies the original fixture snapshot and brightness with a fresh request ID", async () => {
    const oldRequest = { siteId: dashboard.site.id, clientRequestId: "00000000-0000-4000-8000-000000009999", target: { type: "fixture", fixtureId: fixtureIds.b2First }, brightness: 30 };
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default, request: oldRequest }));
    mocks.useCommandStatus.mockReturnValue({ data: { ...createCommandStatus(commandIds.default, "verified_not_applied"), siteId: dashboard.site.id, targetType: "floor", targetId: dashboard.floors[0].id, targetFixtureIds: [fixtureIds.b2First], brightness: 30, outcome: "not_applied", verificationAttemptCount: 1 }, error: null, isFetching: false, refetch: vi.fn() });
    renderControl();
    selectFixture("B2-L001");
    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    fireEvent.click(screen.getByRole("button", { name: "안전하게 다시 적용" }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    expect(mocks.apiPost.mock.calls[0][0]).toBe("/commands/dimming");
    expect(mocks.apiPost.mock.calls[0][1]).toMatchObject({ siteId: dashboard.site.id, target: { type: "fixtures", fixtureIds: [fixtureIds.b2First] }, brightness: 30 });
    expect(mocks.apiPost.mock.calls[0][1].clientRequestId).not.toBe(oldRequest.clientRequestId);
  });

  it("reopens historical detail after closing without issuing physical control", async () => {
    const status = { ...createCommandStatus(commandIds.terminal, "verified_applied"), siteId: dashboard.site.id, outcome: "applied" };
    mocks.apiGet.mockResolvedValue({ items: [status], nextCursor: null });
    mocks.useCommandStatus.mockImplementation((id) => ({ data: id === status.id ? status : undefined, error: null, isFetching: false, refetch: vi.fn() }));
    renderControl();
    const row = await screen.findByRole("button", { name: new RegExp(commandIds.terminal) });
    fireEvent.click(row);
    expect(await screen.findByText("요청한 밝기가 이미 적용되어 있습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "명령 상세 닫기" }));
    expect(screen.queryByText("요청한 밝기가 이미 적용되어 있습니다.")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(commandIds.terminal) }));
    expect(await screen.findByText("요청한 밝기가 이미 적용되어 있습니다.")).toBeInTheDocument();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("waits for fresh historical detail before exposing a cached safe retry", async () => {
    const actual = await vi.importActual<typeof import("../../api/commands")>("../../api/commands");
    mocks.useCommandStatus.mockImplementation(actual.useCommandStatus);
    const cached = { ...createCommandStatus(commandIds.terminal, "verified_not_applied"), siteId: dashboard.site.id, targetFixtureIds: [fixtureIds.b2First], brightness: 30 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["command-status", commandIds.terminal], cached);
    let resolveDetail: (value: unknown) => void = () => undefined;
    mocks.apiGet.mockImplementation((path: string) => path.startsWith("/commands?")
      ? Promise.resolve({ items: [cached], nextCursor: null })
      : new Promise((resolve) => { resolveDetail = resolve; }));
    render(<QueryClientProvider client={client}><SessionStatusProvider><MemoryRouter><ControlView siteId={dashboard.site.id} userId={USER_A} userRole="admin" /></MemoryRouter></SessionStatusProvider></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(commandIds.terminal) }));
    expect(screen.queryByRole("button", { name: "안전하게 다시 적용" })).not.toBeInTheDocument();
    resolveDetail({ ...cached, stage: "verified_applied" });
    expect(await screen.findByText("요청한 밝기가 이미 적용되어 있습니다.")).toBeInTheDocument();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("keeps a restored command locked until fresh detail replaces a cached unknown result", async () => {
    const actual = await vi.importActual<typeof import("../../api/commands")>("../../api/commands");
    mocks.useCommandStatus.mockImplementation(actual.useCommandStatus);
    const unknown = createCommandStatus(commandIds.default, "verification_required");
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: unknown.id }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["command-status", unknown.id], unknown);
    let resolveDetail: (value: unknown) => void = () => undefined;
    mocks.apiGet.mockImplementation((path: string) => path.startsWith("/commands?")
      ? Promise.resolve({ items: [], nextCursor: null })
      : new Promise((resolve) => { resolveDetail = resolve; }));
    render(<QueryClientProvider client={client}><SessionStatusProvider><MemoryRouter><ControlView siteId={dashboard.site.id} userId={USER_A} userRole="admin" /></MemoryRouter></SessionStatusProvider></QueryClientProvider>);
    expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toContain(unknown.id);
    await act(async () => resolveDetail({ ...unknown, dispatches: [{ ...unknown.dispatches[0], kind: "status_check", verificationAttempt: 1, status: "accepted" }] }));
    expect(await screen.findByRole("button", { name: "실제 상태 확인 중" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
  });

  it("continues real status polling when GET races before a lost status-check POST commits", async () => {
    const actual = await vi.importActual<typeof import("../../api/commands")>("../../api/commands");
    mocks.useCommandStatus.mockImplementation(actual.useCommandStatus);
    const unknown = createCommandStatus(commandIds.default, "verification_required");
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: unknown.id }));
    let serverCommitted = false;
    let rejectPost: (reason: unknown) => void = () => undefined;
    mocks.apiGet.mockImplementation((path: string) => Promise.resolve(path.startsWith("/commands?")
      ? { items: [], nextCursor: null }
      : serverCommitted ? { ...unknown, verificationAttemptCount: 1, dispatches: [{ ...unknown.dispatches[0], kind: "status_check", verificationAttempt: 1, status: "accepted" }] } : unknown));
    mocks.apiPost.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPost = reject; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SessionStatusProvider><MemoryRouter><ControlView siteId={dashboard.site.id} userId={USER_A} userRole="admin" /></MemoryRouter></SessionStatusProvider></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "실제 상태 확인" }));
    await waitFor(() => expect(mocks.apiGet.mock.calls.filter(([path]) => path === `/commands/${unknown.id}`).length).toBeGreaterThanOrEqual(2));
    await act(async () => rejectPost(new Error("lost response")));
    expect(await screen.findByRole("button", { name: "동일 상태 확인 요청 조회" })).toBeEnabled();
    serverCommitted = true;
    expect(await screen.findByRole("button", { name: "실제 상태 확인 중" }, { timeout: 2500 })).toBeDisabled();
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
  });

  it.each(["site", "user"])("discards delayed status-check responses when the %s scope changes", async (scope) => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
    mocks.useCommandStatus.mockReturnValue({ data: createCommandStatus(commandIds.default, "verification_required"), error: null, isFetching: false, refetch: vi.fn() });
    let resolveCheck: (value: unknown) => void = () => undefined;
    mocks.apiPost.mockImplementationOnce(() => new Promise((resolve) => { resolveCheck = resolve; }));
    const { rerender } = renderControl();
    fireEvent.click(screen.getByRole("button", { name: "실제 상태 확인" }));
    const signal = mocks.apiPost.mock.calls[0][2].signal as AbortSignal;
    const nextSite = scope === "site" ? "00000000-0000-4000-8000-000000000099" : dashboard.site.id;
    const nextUser = scope === "user" ? USER_B : USER_A;
    mocks.useControlDashboard.mockReturnValue({ data: { ...dashboard, site: { ...dashboard.site, id: nextSite } }, isLoading: false, error: null });
    rerender(controlElement(nextSite, "admin", nextUser));
    expect(signal.aborted).toBe(true);
    resolveCheck({ dispatchId: "check", dispatchIds: ["check"], verificationAttempt: 1 });
    await waitFor(() => expect(screen.getByRole("slider", { name: "밝기" })).toBeEnabled());
    expect(sessionStorage.getItem(activeCommandStorageKey(nextUser, nextSite))).toBeNull();
    expect(screen.queryByText("실제 밝기를 확인하고 있습니다.")).not.toBeInTheDocument();
  });

  it("수동 제어는 실제 command stage를 명령 진행 단계로 표시한다", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
    const commandStatus = createCommandStatus(commandIds.default, "partial_failed");
    mocks.useCommandStatus.mockReturnValue({
      data: commandStatus,
      error: null,
      isFetching: false,
      refetch: vi.fn()
    });

    renderControl();

    expect(screen.getByRole("tabpanel", { name: "수동 제어" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "제어 대상 지도" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "밝기 실행" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "명령 진행" })).toHaveTextContent("장비 응답");
  });

  it("history detail marks device response not reached for an exact pre-RF clock refusal only", async () => {
    const refused = { ...createCommandStatus(commandIds.default, "failed"), outcome: "not_applied" as const, errorCode: "GATEWAY_CLOCK_UNTRUSTED" as const };
    const generic = { ...createCommandStatus(commandIds.different, "failed"), outcome: "not_applied" as const };
    const expired = { ...createCommandStatus(commandIds.terminal, "failed"), outcome: "not_applied" as const, errorCode: "COMMAND_EXPIRED" };
    const records = [refused, generic, expired];
    mocks.apiGet.mockImplementation(async (url: string) => ({
      items: url.includes("/commands?") ? url.includes("limit=1") ? [refused] : records : [],
      nextCursor: null,
      retainedFrom: "2026-06-25T00:00:00.000Z"
    }));
    mocks.useCommandStatus.mockImplementation((id: string | null) => ({
      data: records.find((record) => record.id === id), error: null, isFetching: false, refetch: vi.fn()
    }));
    renderControl();

    const history = await screen.findByRole("region", { name: "최근 명령 이력" });
    fireEvent.click(await within(history).findByRole("button", { name: new RegExp(`최근 명령 상세: ${commandIds.default}`) }));
    const progress = screen.getByRole("list", { name: "명령 진행" });
    expect(within(progress).getByText("명령 접수").closest("li")).toHaveAttribute("data-state", "complete");
    expect(within(progress).getByText("Gateway 전송").closest("li")).toHaveAttribute("data-state", "complete");
    expect(within(progress).getByText("장비 응답").closest("li")).toHaveAttribute("data-state", "pending");
    expect(within(progress).getByText("조명 적용").closest("li")).toHaveAttribute("data-state", "error");

    fireEvent.click(within(history).getByRole("button", { name: "명령 이력 열기" }));
    const drawer = screen.getByRole("dialog", { name: "명령 이력" });
    for (const command of [generic, expired]) {
      fireEvent.click((await within(drawer).findByText(command.id)).closest("button")!);
      expect(within(screen.getByRole("list", { name: "명령 진행" })).getByText("장비 응답").closest("li")).toHaveAttribute("data-state", "complete");
      expect(within(screen.getByRole("list", { name: "명령 진행" })).getByText("조명 적용").closest("li")).toHaveAttribute("data-state", "error");
    }
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("서버의 ACK 문구는 사용자 화면에서 장비 응답으로 표시한다", () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
    const commandStatus = createCommandStatus(commandIds.default, "partial_failed");
    commandStatus.dispatches[0].results[0].errorMessage = "게이트웨이 ACK를 확인하지 못했습니다.";
    mocks.useCommandStatus.mockReturnValue({
      data: commandStatus,
      error: null,
      isFetching: false,
      refetch: vi.fn()
    });

    renderControl();

    expect(screen.getByRole("status", { name: "명령 진행 상태" })).toHaveTextContent("B2-L001: 게이트웨이 장비 응답을 확인하지 못했습니다.");
    expect(screen.queryByText(/ACK/i)).not.toBeInTheDocument();
  });

  it("floor와 저장 구역 Mesh 오류의 ACK는 사용자 화면에서 장비 응답으로 표시한다", () => {
    const ackDashboard: Dashboard = {
      ...dashboard,
      floors: dashboard.floors.map((floor, index) => index === 0
        ? {
            ...floor,
            meshControlGroups: [{ ...floor.meshControlGroups[0], status: "failed", error: "Gateway ACK를 확인하지 못했습니다." }],
            fixtures: floor.fixtures.map((fixture) => ({ ...fixture, controllable: true, controlBlockReason: null }))
          }
        : floor),
      groups: dashboard.groups.map((group, index) => index === 0
        ? { ...group, meshControlGroup: { ...group.meshControlGroup!, status: "failed", error: "Gateway ACK를 확인하지 못했습니다." } }
        : group)
    };
    mocks.useControlDashboard.mockReturnValue({ data: ackDashboard, isLoading: false, error: null });

    renderControl();
    chooseTargetMode("층 전체");
    const floor = screen.getByRole("button", { name: "B2" });
    expect(floor).toBeDisabled();
    expect(floor).toHaveAccessibleDescription("게이트웨이 장비 응답을 확인하지 못했습니다.");

    chooseTargetMode("저장된 구역");
    const group = screen.getByRole("button", { name: /B2 입구 구역/ });
    expect(group).toBeDisabled();
    expect(group).toHaveAccessibleDescription("게이트웨이 장비 응답을 확인하지 못했습니다.");
    expect(screen.queryByText(/ACK/i)).not.toBeInTheDocument();
  });

  it("밝기 preset과 대상 유형 action을 수동 제어 상태에 반영한다", () => {
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    expect(screen.getByRole("slider", { name: "밝기" })).toHaveValue("30");

    chooseFloor("B2");
    const executionPanel = screen.getByRole("complementary", { name: "밝기 실행" });
    expect(within(executionPanel).getByText("3개 선택")).toBeInTheDocument();
    expect(within(executionPanel).getByRole("alert")).toHaveTextContent(/제어할 수 없|제어 불가|오프라인/);
  });

  it("sends one selected light as a fixture target", async () => {
    renderControl();

    selectFixture("B2-L001");
    fireEvent.click(applyButton());

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith("/commands/dimming", expect.objectContaining({
      siteId: dashboard.site.id,
      clientRequestId: expect.any(String),
      target: { type: "fixture", fixtureId: fixtureIds.b2First },
      brightness: 70
    }), { signal: expect.any(AbortSignal) }));
  });

  it("syncs brightness from the fixture when exactly one light is selected", () => {
    renderControl();

    selectFixture("B2-L002");

    expect(screen.getByRole("slider", { name: "밝기" })).toHaveValue("60");
  });

  it("keeps the shared brightness Slider and NumberField on one number state", () => {
    renderControl();
    const slider = screen.getByRole("slider", { name: "밝기" });
    const number = within(screen.getByRole("complementary", { name: "밝기 실행" })).getByRole("textbox", { name: "밝기 수치" });

    fireEvent.change(number, { target: { value: "42" } });
    fireEvent.blur(number);
    expect(slider).toHaveValue("42");
    fireEvent.change(slider, { target: { value: "35" } });
    expect(number).toHaveValue("35");
  });

  it("keeps the chosen brightness for multiple light selections", () => {
    renderControl();
    const brightnessSlider = screen.getByRole("slider", { name: "밝기" });

    selectFixture("B2-L001");
    expect(brightnessSlider).toHaveValue("70");

    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    selectFixture("B2-L002");
    expect(brightnessSlider).toHaveValue("30");

    expect(brightnessSlider).toHaveValue("30");
  });

  it("keeps the chosen brightness when switching to floor and zone targets", () => {
    renderControl();
    const brightnessSlider = screen.getByRole("slider", { name: "밝기" });

    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    chooseFloor("B1");
    expect(brightnessSlider).toHaveValue("30");

    chooseGroup(/B2 입구 구역/);
    expect(brightnessSlider).toHaveValue("30");
  });

  it("sends arbitrary multiple lights as a fixtures target", async () => {
    renderControl();

    selectFixture("B2-L001");
    selectFixture("B2-L002");
    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    fireEvent.click(applyButton());

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith("/commands/dimming", expect.objectContaining({
      siteId: dashboard.site.id,
      clientRequestId: expect.any(String),
      target: { type: "fixtures", fixtureIds: [fixtureIds.b2First, fixtureIds.b2Second] },
      brightness: 30
    }), { signal: expect.any(AbortSignal) }));
    expect(screen.getByText("2개 선택")).toBeInTheDocument();
  });

  it("sends floor and zone selections through their mesh group targets", async () => {
    const { rerender } = renderControl();

    chooseFloor("B1");
    expect(screen.queryByText(/전송 방식|BLE Mesh 그룹 전송/)).not.toBeInTheDocument();
    fireEvent.click(applyButton());
    await waitFor(() => expect(mocks.apiPost).toHaveBeenLastCalledWith("/commands/dimming", expect.objectContaining({
      siteId: dashboard.site.id,
      clientRequestId: expect.any(String),
      target: { type: "floor", floorId: dashboard.floors[1].id },
      brightness: 70
    }), { signal: expect.any(AbortSignal) }));

    mocks.useCommandStatus.mockReturnValue({
      data: createCommandStatus(commandIds.default, "completed"),
      error: null,
      isFetching: false,
      refetch: vi.fn()
    });
    rerender(controlElement(dashboard.site.id));
    await waitFor(() => expect(applyButton()).toBeEnabled());

    chooseGroup(/B2 입구 구역/);
    fireEvent.click(applyButton());
    await waitFor(() => expect(mocks.apiPost).toHaveBeenLastCalledWith("/commands/dimming", expect.objectContaining({
      siteId: dashboard.site.id,
      clientRequestId: expect.any(String),
      target: { type: "group", groupId: dashboard.groups[0].id },
      brightness: 70
    }), { signal: expect.any(AbortSignal) }));
  });

  it("does not expose configuring or failed mesh groups as selectable control targets", () => {
    const unavailableDashboard: Dashboard = {
      ...dashboard,
      floors: dashboard.floors.map((floor, index) => index === 0
        ? { ...floor, meshControlGroups: [{ gatewayId: "gateway-1", status: "configuring", version: 2, error: null }] }
        : floor),
      groups: dashboard.groups.map((group, index) => index === 0
        ? { ...group, meshControlGroup: { status: "failed", version: 2, error: "subscription rejected" } }
        : group)
    };
    mocks.useControlDashboard.mockReturnValue({ data: unavailableDashboard, isLoading: false, error: null });
    renderControl();

    chooseTargetMode("저장된 구역");
    expect(screen.getByRole("button", { name: /B2 입구 구역/ })).toBeDisabled();

    chooseTargetMode("층 전체");
    expect(screen.getByRole("button", { name: "B2" })).toBeDisabled();
  });

  it("requires every gateway mesh group on a floor to be ready", () => {
    const partiallyReadyDashboard: Dashboard = {
      ...dashboard,
      floors: dashboard.floors.map((floor, index) => index === 0 ? {
        ...floor,
        fixtures: floor.fixtures.map((fixture, fixtureIndex) => fixtureIndex === 1 ? {
          ...fixture,
          gateway: { id: "gateway-2", name: "GW-B2-2", connectionStatus: "online" }
        } : fixture),
        meshControlGroups: [
          { gatewayId: "gateway-1", status: "ready", version: 2, error: null },
          { gatewayId: "gateway-2", status: "configuring", version: 2, error: null }
        ]
      } : floor)
    };
    mocks.useControlDashboard.mockReturnValue({ data: partiallyReadyDashboard, isLoading: false, error: null });
    renderControl();

    chooseTargetMode("층 전체");
    expect(screen.getByRole("button", { name: "B2" })).toBeDisabled();
  });

  it("keeps floor control unavailable when a fixture gateway has no mesh group metadata", () => {
    const missingGatewayGroupDashboard: Dashboard = {
      ...dashboard,
      floors: dashboard.floors.map((floor, index) => index === 0 ? {
        ...floor,
        fixtures: floor.fixtures.map((fixture, fixtureIndex) => fixtureIndex === 1 ? {
          ...fixture,
          gateway: { id: "gateway-2", name: "GW-B2-2", connectionStatus: "online" }
        } : fixture),
        meshControlGroups: [{ gatewayId: "gateway-1", status: "ready", version: 2, error: null }]
      } : floor)
    };
    mocks.useControlDashboard.mockReturnValue({ data: missingGatewayGroupDashboard, isLoading: false, error: null });
    renderControl();

    chooseTargetMode("층 전체");
    expect(screen.getByRole("button", { name: "B2" })).toBeDisabled();
  });

  it("keeps a multi-gateway floor unavailable before and after dashboard refresh", () => {
    const readyDashboard = twoGatewayFloorDashboard("ready");
    mocks.useControlDashboard.mockReturnValue({ data: readyDashboard, isLoading: false, error: null });
    const { rerender } = renderControl("admin", readyDashboard.site.id);

    chooseTargetMode("층 전체");
    expect(screen.getByRole("button", { name: "B2" })).toBeDisabled();
    expect(applyButton()).toBeDisabled();

    const refreshedDashboard = twoGatewayFloorDashboard("configuring");
    mocks.useControlDashboard.mockReturnValue({ data: refreshedDashboard, isLoading: false, error: null });
    rerender(controlElement(refreshedDashboard.site.id));

    chooseTargetMode("층 전체");
    expect(screen.getByRole("button", { name: "B2" })).toBeDisabled();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(applyButton());
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("opens saved-zone management for admin and read-only status for general users", () => {
    const { rerender } = renderControl("admin");
    expect(screen.getByRole("button", { name: "구역 관리" })).toBeEnabled();

    mocks.useControlDashboard.mockReturnValue({
      data: { ...dashboard, capabilities: { read: true, control: true, manage: false, commission: false } },
      isLoading: false,
      error: null
    });
    rerender(controlElement(dashboard.site.id, "viewer"));
    expect(screen.getByRole("button", { name: "구역 현황" })).toBeEnabled();
  });

  it("filters the fixture drawer by search, state, and floor", () => {
    renderControl();

    openFixtureList();
    fireEvent.change(screen.getByRole("searchbox", { name: "조명 검색" }), { target: { value: "L001" } });
    selectOption("상태 필터", "온라인");
    selectOption("층 필터", "B1");

    const list = screen.getByRole("group", { name: "조명 목록" });
    expect(within(list).getByText("B1-L001")).toBeInTheDocument();
    expect(within(list).queryByText("B2-L001")).not.toBeInTheDocument();
    expect(within(list).queryByText("B2-L003")).not.toBeInTheDocument();
  });

  it("blocks a selection containing an uncontrollable light and explains the reason", () => {
    renderControl();

    selectFixture("B2-L001");
    expect(fixtureMarker("B2-L003")).toBeDisabled();

    expect(screen.getByText("1개 선택")).toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
  });

  it("locks direct fixture selection to the first selected gateway", () => {
    const multiGatewayDashboard = twoGatewayFloorDashboard("ready");
    mocks.useControlDashboard.mockReturnValue({ data: multiGatewayDashboard, isLoading: false, error: null });
    renderControl("admin", multiGatewayDashboard.site.id);

    selectFixture("B2-L001");

    const otherGatewayFixture = fixtureMarker("B2-L002");
    expect(otherGatewayFixture).toBeDisabled();
    expect(otherGatewayFixture).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("1개 선택")).toBeInTheDocument();
  });

  it("keeps drawer selection on the first selected gateway", () => {
    const multiGatewayDashboard = twoGatewayFloorDashboard("ready");
    mocks.useControlDashboard.mockReturnValue({ data: multiGatewayDashboard, isLoading: false, error: null });
    renderControl("admin", multiGatewayDashboard.site.id);

    selectFixture("B2-L001");
    openFixtureList();

    expect(screen.getByRole("checkbox", { name: "B2-L002 선택" })).toBeDisabled();
    expect(screen.getByText("1개 선택")).toBeInTheDocument();
  });

  it("keeps every control disabled for viewer accounts", () => {
    mocks.useControlDashboard.mockReturnValue({
      data: { ...dashboard, capabilities: { read: true, control: false, manage: false, commission: false } },
      isLoading: false,
      error: null
    });
    renderControl("viewer");

    expect(screen.getAllByText("조회 전용", { selector: "span" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/조회 전용 계정입니다/)).not.toBeInTheDocument();
    expect(fixtureMarker("B2-L001")).toBeDisabled();
    expect(applyButton()).toBeDisabled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("allows manual control but hides admin automation modes for a control-capable user", async () => {
    mocks.useControlDashboard.mockReturnValue({
      data: { ...dashboard, capabilities: { read: true, control: true, manage: false, commission: false } },
      isLoading: false,
      error: null
    });

    renderControl("viewer", dashboard.site.id, USER_A, `/control?siteId=${dashboard.site.id}&mode=schedule`);

    await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent("mode=manual"));
    expect(screen.getByRole("tab", { name: "수동 제어" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "스케줄 제어" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "이벤트 제어" })).not.toBeInTheDocument();
    expect(screen.queryByText(/조회 전용 계정/)).not.toBeInTheDocument();
    expect(fixtureMarker("B2-L001")).toBeEnabled();
  });

  it("keeps fixture Health faults visible in the target list", () => {
    const faultDashboard: Dashboard = {
      ...dashboard,
      floors: dashboard.floors.map((floor, floorIndex) => floorIndex === 0 ? {
        ...floor,
        fixtures: floor.fixtures.map((fixture, fixtureIndex) => fixtureIndex === 0 ? {
          ...fixture,
          status: "fault",
          health: { faultCodes: [4], observedAt: "2026-08-19T01:00:01.000Z" },
          controllable: false,
          controlBlockReason: "fixture_fault"
        } : fixture)
      } : floor)
    };
    mocks.useControlDashboard.mockReturnValue({ data: faultDashboard, isLoading: false, error: null });

    renderControl();

    expect(fixtureMarker("B2-L001")).toBeDisabled();
    openFixtureList();
    const fixture = screen.getByRole("checkbox", { name: "B2-L001 선택" });
    expect(fixture).toHaveAccessibleDescription("조명 장애를 먼저 점검해야 합니다. 장애 코드 4");
    expect(screen.getByText("조명 장애를 먼저 점검해야 합니다. 장애 코드 4")).toBeVisible();
  });

  it("keeps fixture-level command failures visible while polling status", () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
    mocks.useCommandStatus.mockReturnValue({
      error: null,
      data: {
        id: commandIds.default,
        stage: "partial_failed",
        dispatchCount: 1,
        completedFixtureCount: 2,
        totalFixtureCount: 2,
        errorMessage: "one or more gateway dispatches failed",
        dispatches: [{
          id: "dispatch-1",
          status: "failed",
          gateway: { id: "gateway-1", name: "GW-B2" },
          errorMessage: null,
          results: [
            { fixtureId: fixtureIds.b2First, fixtureName: "B2-L001", status: "succeeded", errorMessage: null },
            { fixtureId: fixtureIds.b2Second, fixtureName: "B2-L002", status: "failed", errorMessage: "장비 응답 오류" }
          ]
        }]
      }
    });

    renderControl();

    expect(within(screen.getByRole("status", { name: "명령 진행 상태" })).getByText("일부 조명 적용 실패")).toBeInTheDocument();
    expect(screen.getByText("2 / 2 처리")).toBeInTheDocument();
    expect(screen.getByText("B2-L002: 장비 응답 오류")).toBeInTheDocument();
  });

  it.each(["partial_failed", "failed", "timed_out", "verification_required", "verified_not_applied", "verified_partial"] as const)(
    "offers manual reentry for %s without sending a command from the status center",
    async (stage) => {
      sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
      mocks.useCommandStatus.mockReturnValue({ data: createCommandStatus(commandIds.default, stage), error: null, isFetching: false, refetch: vi.fn() });
      renderControl();

      await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument());
      expect(within(screen.getByRole("status", { name: "명령 진행 상태" })).getAllByText(stage === "verification_required" ? "실제 상태 확인 필요" : stage === "verified_not_applied" ? "미적용 확인" : stage === "verified_partial" ? "일부 적용 확인" : stage === "partial_failed" ? "일부 조명 적용 실패" : stage === "failed" ? "명령 처리 실패" : "명령 응답 시간 초과").length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole("tab", { name: "스케줄 제어" }));
      await waitFor(() => expect(screen.getByRole("tab", { name: "스케줄 제어" })).toHaveAttribute("aria-selected", "true"));
      fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 1건" }));
      const center = screen.getByRole("dialog", { name: "현재 세션 상태" });
      fireEvent.click(within(center).getByRole("button", { name: "수동 제어로 이동" }));

      await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent("mode=manual"));
      expect(mocks.apiPost).not.toHaveBeenCalled();
    }
  );

  it("shows an unresolved command in the status center and resolves it after a successful result", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
    mocks.useCommandStatus.mockReturnValue({ data: createCommandStatus(commandIds.default, "accepted"), error: null, isFetching: false, refetch: vi.fn() });
    const { rerender } = renderControl();

    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument());
    expect(within(screen.getByRole("status", { name: "명령 진행 상태" })).getByText("게이트웨이 수신 완료")).toBeInTheDocument();
    mocks.useCommandStatus.mockReturnValue({ data: createCommandStatus(commandIds.default, "completed"), error: null, isFetching: false, refetch: vi.fn() });
    rerender(controlElement(dashboard.site.id));

    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeInTheDocument());
    expect(within(screen.getByRole("status", { name: "명령 진행 상태" })).getByText("조명 적용 완료 · 기본 밝기로 저장됨")).toBeInTheDocument();
  });

  it("describes an in-flight manual command as sending rather than a lost response", async () => {
    let resolveCommand: (value: unknown) => void = () => undefined;
    mocks.apiPost.mockImplementationOnce(() => new Promise((resolve) => { resolveCommand = resolve; }));
    renderControl();
    selectFixture("B2-L001");
    fireEvent.click(applyButton());

    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 1건" }));
    const center = screen.getByRole("dialog", { name: "현재 세션 상태" });
    expect(within(center).getByText("명령 전송 중")).toBeInTheDocument();
    expect(within(center).queryByText("명령 응답을 확인하지 못했습니다")).not.toBeInTheDocument();
    await act(async () => resolveCommand({ id: commandIds.default }));
  });

  it("resolves command status after closing its detail", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
    mocks.useCommandStatus.mockReturnValue({ data: createCommandStatus(commandIds.default, "verification_required"), error: null, isFetching: false, refetch: vi.fn() });
    renderControl();

    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "명령 상세 닫기" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeInTheDocument());
  });

  it.each(["site", "user"])('resolves an open command status when the %s scope changes', async (scope) => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
    mocks.useCommandStatus.mockReturnValue({ data: createCommandStatus(commandIds.default, "verification_required"), error: null, isFetching: false, refetch: vi.fn() });
    const { rerender } = renderControl();
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument());

    if (scope === "site") {
      const nextSiteId = "00000000-0000-4000-8000-000000000099";
      rerender(controlElement(nextSiteId));
      await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeInTheDocument());
      mocks.useControlDashboard.mockReturnValue({ data: { ...dashboard, site: { ...dashboard.site, id: nextSiteId } }, isLoading: false, error: null });
      rerender(controlElement(nextSiteId));
    } else {
      rerender(controlElement(dashboard.site.id, "admin", USER_B));
    }

    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "알림" })).queryByText("실제 상태 확인 필요")).not.toBeInTheDocument();
  });

  it("keeps cached controls visible when a background refresh fails", () => {
    mocks.useControlDashboard.mockReturnValue({
      data: dashboard,
      isLoading: false,
      error: new Error("temporary refresh failure")
    });

    renderControl();

    expect(screen.getByRole("region", { name: "제어 대상 지도" })).toBeInTheDocument();
    expect(fixtureMarker("B2-L001")).toBeInTheDocument();
    expect(screen.queryByText("제어 대상을 불러오지 못했습니다.")).not.toBeInTheDocument();
  });

  it("shows the initial error only when no cached dashboard exists", () => {
    mocks.useControlDashboard.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("initial load failure")
    });

    renderControl();

    expect(screen.getByRole("alert")).toHaveTextContent("제어 대상을 불러오지 못했습니다.");
  });

  it("renders large fixture lists in fixed batches through the secondary drawer", () => {
    const largeDashboard = createLargeDashboard(1000);
    mocks.useControlDashboard.mockReturnValue({ data: largeDashboard, isLoading: false, error: null });

    renderControl("admin", largeDashboard.site.id);

    openFixtureList();
    expect(screen.getAllByRole("checkbox")).toHaveLength(100);

    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(200);
  });

  it("resets the secondary drawer filters when the active site changes", () => {
    const { rerender } = renderControl();
    openFixtureList();
    fireEvent.change(screen.getByRole("searchbox", { name: "조명 검색" }), { target: { value: "L001" } });
    selectOption("상태 필터", "오프라인");
    selectOption("층 필터", "B2");
    fireEvent.click(screen.getByRole("button", { name: "조명 목록 닫기" }));

    const nextDashboard: Dashboard = {
      ...dashboard,
      site: { ...dashboard.site, id: "00000000-0000-4000-8000-000000000099", name: "다음 현장" }
    };
    mocks.useControlDashboard.mockReturnValue({ data: nextDashboard, isLoading: false, error: null });
    rerender(controlElement(nextDashboard.site.id));
    openFixtureList();

    expect(screen.getByRole("searchbox", { name: "조명 검색" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "상태 필터" })).toHaveTextContent("모든 상태");
    expect(screen.getByRole("button", { name: "층 필터" })).toHaveTextContent("모든 층");
  });

  it("exposes target modes as pressed buttons instead of incomplete radio semantics", () => {
    renderControl();

    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "개별 조명" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "층 전체" })).not.toHaveAttribute("aria-current", "true");
  });

  it("locks every editable control until the device result is terminal", async () => {
    let resolveCommand: (value: { id: string }) => void = () => undefined;
    mocks.apiPost.mockImplementationOnce(() => new Promise((resolve) => { resolveCommand = resolve; }));
    renderControl();

    selectFixture("B2-L001");
    fireEvent.click(applyButton());

    expect(applyButton()).toBeDisabled();
    expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "70%" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "층 전체" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "조명 목록 열기" })).toBeDisabled();
    expect(fixtureMarker("B2-L001")).toBeDisabled();

    resolveCommand({ id: commandIds.locked });
    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.locked));
    expect(applyButton()).toBeDisabled();
  });

  it("retries a lost POST response with the same client request ID and canonical payload", async () => {
    mocks.apiPost
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({
        id: commandIds.retry,
        dispatchCount: 1,
        selectedTargetCount: 2,
        transmissionCount: 2,
        deliveryMode: "parallel_unicast"
      });
    renderControl();

    selectFixture("B2-L002");
    selectFixture("B2-L001");
    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    fireEvent.click(applyButton());

    expect(await screen.findByRole("button", { name: "동일 요청 확인(새 제어 아님)" })).toBeEnabled();
    const firstPayload = mocks.apiPost.mock.calls[0][1];
    expect(firstPayload.target.fixtureIds).toEqual([fixtureIds.b2First, fixtureIds.b2Second]);
    expect(mocks.apiPost.mock.calls[0][2]).toMatchObject({ signal: expect.any(AbortSignal) });

    fireEvent.click(screen.getByRole("button", { name: "동일 요청 확인(새 제어 아님)" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(2));
    expect(mocks.apiPost.mock.calls[1][1]).toEqual(firstPayload);
    expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.retry);
  });

  it.each([
    [409, { code: "client_request_id_payload_conflict" }, "동일 요청 ID가 다른 제어 내용과 충돌했습니다"],
    [403, { message: "forbidden" }, "제어 권한이 없습니다"]
  ])("clears a pending request and unlocks controls after a definitive %s rejection", async (status, body, message) => {
    mocks.apiPost.mockRejectedValueOnce(Object.assign(new Error("rejected"), { status, body }));
    renderControl();

    selectFixture("B2-L001");
    fireEvent.click(applyButton());

    expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "동일 요청 확인(새 제어 아님)" })).not.toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toBeNull();
  });

  it("does not hold or replay a new Set rejected while gateway recommission is in progress", async () => {
    mocks.apiPost.mockRejectedValueOnce(Object.assign(new Error("gateway resetting"), {
      status: 409, body: { code: "gateway_recommission_in_progress" }
    })).mockResolvedValueOnce({ id: commandIds.default, dispatchCount: 1 });
    renderControl();
    selectFixture("B2-L001");
    fireEvent.click(applyButton());

    expect(await screen.findByText(/게이트웨이 재등록이 진행 중입니다/)).toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
    expect(fixtureMarker("B2-L001")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "동일 요청 확인(새 제어 아님)" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toBeNull();
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);

    fireEvent.click(applyButton());
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(2));
    expect(mocks.apiPost.mock.calls[1][1].clientRequestId).not.toBe(mocks.apiPost.mock.calls[0][1].clientRequestId);
  });

  it.each([
    [409, { code: "command_request_expired" }],
    [409, { code: "command_requires_verification", caseId: "case-1", blockingCaseCount: 1 }],
    [410, { code: "command_expired" }],
    [409, { code: "unexpected_future_safety_code" }]
  ])("keeps the manual hold after a safety-sensitive %s response %#", async (status, body) => {
    mocks.apiPost.mockRejectedValueOnce(Object.assign(new Error("unsafe to retry"), { status, body }));
    renderControl();
    selectFixture("B2-L001");
    fireEvent.click(applyButton());

    expect(await screen.findByText(/실제 상태를 확인하기 전까지 제어 잠금을 유지합니다/)).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    expect(fixtureMarker("B2-L001")).toBeDisabled();
    expect(screen.queryByText(/새 제어 요청을 실행하세요/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toContain("request");
    expect(screen.queryByRole("button", { name: "동일 요청 확인(새 제어 아님)" })).not.toBeInTheDocument();
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
  });

  it("does not replay a safety-rejected dimming request after remount", async () => {
    mocks.apiPost.mockRejectedValueOnce(Object.assign(new Error("blocked"), {
      status: 409, body: { code: "command_requires_verification", caseId: "case-1", blockingCaseCount: 1 }
    }));
    const { unmount } = renderControl();
    selectFixture("B2-L001");
    fireEvent.click(applyButton());
    expect(await screen.findByText(/실제 상태를 확인하기 전까지 제어 잠금을 유지합니다/)).toBeInTheDocument();
    unmount();
    renderControl();
    expect(await screen.findByText(/안전을 위해 재전송할 수 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "동일 요청 확인(새 제어 아님)" })).not.toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
  });

  it("keeps a reconciled safety hold on reload until a fresh exact case read succeeds", async () => {
    const request = { siteId: dashboard.site.id, clientRequestId: "00000000-0000-4000-8000-000000009099",
      target: { type: "fixture" as const, fixtureId: fixtureIds.b2First }, brightness: 30 };
    saveActiveCommandRequest(USER_A, dashboard.site.id, request);
    markActiveCommandReplayRejected(USER_A, dashboard.site.id, request.clientRequestId, "case-1");
    markActiveCommandCaseReconciled(USER_A, dashboard.site.id, request.clientRequestId, "case-1", commandIds.missing);
    let finishExactRead: (value: unknown) => void = () => undefined;
    mocks.apiGet.mockImplementation((path: string) => path.includes(`originalCommandId=${commandIds.missing}`)
      ? new Promise((resolve) => { finishExactRead = resolve; })
      : Promise.resolve({ items: [], nextCursor: null }));
    renderControl();
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith(expect.stringContaining(`originalCommandId=${commandIds.missing}`)));
    expect(applyButton()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "동일 요청 확인(새 제어 아님)" })).not.toBeInTheDocument();
    expect(mocks.apiPost).not.toHaveBeenCalled();
    finishExactRead({ items: [], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" });
    await waitFor(() => expect(applyButton()).toBeDisabled());
    // The selected fixtures are reset on remount; storage may clear, but no Set
    // runs until the operator explicitly selects and applies a target again.
    await waitFor(() => expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toBeNull());
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it.each([401, 500])("keeps the reconciled safety hold when its fresh exact read fails with %s", async (status) => {
    const request = { siteId: dashboard.site.id, clientRequestId: "00000000-0000-4000-8000-000000009099",
      target: { type: "fixture" as const, fixtureId: fixtureIds.b2First }, brightness: 30 };
    saveActiveCommandRequest(USER_A, dashboard.site.id, request);
    markActiveCommandReplayRejected(USER_A, dashboard.site.id, request.clientRequestId, "case-1");
    markActiveCommandCaseReconciled(USER_A, dashboard.site.id, request.clientRequestId, "case-1", commandIds.missing);
    mocks.apiGet.mockImplementation(async (path: string) => {
      if (path.includes(`originalCommandId=${commandIds.missing}`)) throw Object.assign(new Error("read failed"), { status });
      return { items: [], nextCursor: null };
    });
    renderControl();
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith(expect.stringContaining(`originalCommandId=${commandIds.missing}`)));
    expect(applyButton()).toBeDisabled();
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toContain("reconciledOriginalCommandId");
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("does not restore another user's pending request for the same site", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({
      request: {
        siteId: dashboard.site.id,
        clientRequestId: "00000000-0000-4000-8000-000000009099",
        target: { type: "fixture", fixtureId: fixtureIds.b2First },
        brightness: 30
      }
    }));

    const { rerender } = renderControl("admin", dashboard.site.id, USER_A);
    expect(await screen.findByRole("button", { name: "동일 요청 확인(새 제어 아님)" })).toBeInTheDocument();

    rerender(controlElement(dashboard.site.id, "admin", USER_B));

    await waitFor(() => expect(screen.queryByRole("button", { name: "동일 요청 확인(새 제어 아님)" })).not.toBeInTheDocument());
    expect(fixtureMarker("B2-L001")).toBeEnabled();
  });

  it.each(["success", "failure"])("ignores a delayed %s result after switching users", async (result) => {
    let resolveCommand: (value: unknown) => void = () => undefined;
    let rejectCommand: (reason: unknown) => void = () => undefined;
    mocks.apiPost.mockImplementationOnce(() => new Promise((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
    }));
    const { rerender } = renderControl("admin", dashboard.site.id, USER_A);

    selectFixture("B2-L001");
    fireEvent.click(applyButton());
    const originalSignal = mocks.apiPost.mock.calls[0][2]?.signal as AbortSignal;

    rerender(controlElement(dashboard.site.id, "admin", USER_B));
    expect(originalSignal.aborted).toBe(true);

    if (result === "success") resolveCommand({ id: commandIds.siteA });
    else rejectCommand(new Error("response lost"));

    await waitFor(() => expect(fixtureMarker("B2-L001")).toBeEnabled());
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).not.toContain(commandIds.siteA);
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_B, dashboard.site.id))).toBeNull();
    expect(screen.queryByText("명령을 전송했습니다. 장비 ACK를 기다리는 중입니다.")).not.toBeInTheDocument();
    expect(screen.queryByText("명령 응답을 확인하지 못했습니다. 동일 요청 확인은 새 제어를 만들지 않습니다.")).not.toBeInTheDocument();
  });

  it.each(["success", "failure"])("ignores a delayed %s result after switching sites", async (result) => {
    let resolveCommand: (value: unknown) => void = () => undefined;
    let rejectCommand: (reason: unknown) => void = () => undefined;
    mocks.apiPost.mockImplementationOnce(() => new Promise((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
    }));
    const { rerender } = renderControl();

    selectFixture("B2-L001");
    fireEvent.click(applyButton());
    const originalSignal = mocks.apiPost.mock.calls[0][2]?.signal as AbortSignal;

    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    const nextDashboard: Dashboard = { ...dashboard, site: { ...dashboard.site, id: nextSiteId, name: "다음 현장" } };
    mocks.useControlDashboard.mockReturnValue({ data: nextDashboard, isLoading: false, error: null });
    rerender(controlElement(nextSiteId));
    expect(originalSignal.aborted).toBe(true);

    if (result === "success") {
      resolveCommand({ id: commandIds.siteA });
    } else {
      rejectCommand(new Error("response lost"));
    }

    await waitFor(() => expect(fixtureMarker("B2-L001")).toBeEnabled());
    expect(screen.queryByText("명령을 전송했습니다. 장비 ACK를 기다리는 중입니다.")).not.toBeInTheDocument();
    expect(screen.queryByText("명령 응답을 확인하지 못했습니다. 동일 요청 확인은 새 제어를 만들지 않습니다.")).not.toBeInTheDocument();
  });

  it("keeps controls locked when a terminal status belongs to a different command", async () => {
    const refetch = vi.fn();
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.expected }));
    mocks.useCommandStatus.mockReturnValue({
      data: createCommandStatus(commandIds.different, "completed"),
      error: null,
      isFetching: false,
      refetch
    });

    renderControl();

    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.expected));
    expect(applyButton()).toBeDisabled();
    expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
    expect(within(screen.getByRole("status", { name: "명령 진행 상태" })).queryByText("조명 적용 완료")).not.toBeInTheDocument();
    const commandStatus = screen.getByRole("status", { name: "명령 진행 상태" });
    const commandAlert = screen.getByText("명령 상태 응답의 식별자가 일치하지 않습니다. 안전을 위해 제어 잠금을 유지합니다.").closest<HTMLElement>("[role=alert]");
    expect(commandAlert).not.toBeNull();
    expect(commandAlert).toHaveTextContent("명령 상태 응답의 식별자가 일치하지 않습니다");
    expect(within(commandStatus).queryByRole("alert")).not.toBeInTheDocument();
    expect(commandStatus).not.toContainElement(commandAlert!);
    fireEvent.click(screen.getByRole("button", { name: "명령 상태 다시 조회" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toContain(commandIds.expected);
  });

  it.each([404, 410])("retains the command hold when an active command detail returns %s", async (status) => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.missing }));
    mocks.useCommandStatus.mockReturnValue({
      data: undefined,
      error: Object.assign(new Error("not found"), { status }),
      isFetching: false,
      refetch: vi.fn()
    });

    renderControl();

    expect(await screen.findByText("명령 원본을 찾을 수 없습니다. 실제 상태 확인 전까지 제어 잠금을 유지합니다.")).toBeInTheDocument();
    expect(fixtureMarker("B2-L001")).toBeDisabled();
    expect(applyButton()).toBeDisabled();
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toContain(commandIds.missing);
  });

  it("reads the exact original-command case after 410 and opens its separate safe surface", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.missing }));
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: { status: 410, body: { code: "command_expired" } }, isFetching: false, refetch: vi.fn() });
    mocks.apiGet.mockImplementation(async (path: string) => path.startsWith("/commands/requiring-verification?")
      ? { items: [{ caseId: "case-1", originalCommandId: commandIds.missing, siteId: dashboard.site.id, targetCount: 2, verificationAttemptCount: 1, status: "verification_required", canRequestStatusCheck: true, lastCheckedAt: null, reasonCode: "outcome_unknown" }], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" }
      : { items: [], nextCursor: null });
    renderControl();
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith(expect.stringContaining(`originalCommandId=${commandIds.missing}`)));
    fireEvent.click(screen.getByRole("button", { name: "확인 필요한 명령" }));
    expect(await screen.findByRole("dialog", { name: "확인 필요한 명령" })).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("does not release an expired command hold when an authorized exact case lookup is empty", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.missing }));
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: { status: 410, body: { code: "command_expired" } }, isFetching: false, refetch: vi.fn() });
    mocks.apiGet.mockResolvedValue({ items: [], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" });
    renderControl();
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith(expect.stringContaining(`originalCommandId=${commandIds.missing}`)));
    expect(applyButton()).toBeDisabled();
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toContain(commandIds.missing);
  });

  it("releases a known expired hold only after a fresh exact-filter empty read, with no case POST", async () => {
    const caseRecord = { caseId: "case-1", originalCommandId: commandIds.missing, siteId: dashboard.site.id, targetCount: 2,
      verificationAttemptCount: 3, status: "verification_required", canRequestStatusCheck: false, lastCheckedAt: null, reasonCode: "attempts_exhausted" };
    let caseExists = true;
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.missing }));
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: { status: 410, body: { code: "command_expired" } }, isFetching: false, refetch: vi.fn() });
    mocks.apiGet.mockImplementation(async (path: string) => path.startsWith("/commands/requiring-verification?")
      ? { items: caseExists ? [caseRecord] : [], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" } : { items: [], nextCursor: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SessionStatusProvider><MemoryRouter><ControlView siteId={dashboard.site.id} userId={USER_A} userRole="admin" /></MemoryRouter></SessionStatusProvider></QueryClientProvider>);
    await waitFor(() => expect(loadObservedVerificationCase(USER_A, dashboard.site.id, commandIds.missing)).toBe("case-1"));
    expect(applyButton()).toBeDisabled();
    caseExists = false;
    await act(async () => { await client.invalidateQueries({ queryKey: ["command-verification-cases-exact"] }); });
    await waitFor(() => expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toBeNull());
    selectFixture("B2-L001");
    expect(applyButton()).toBeEnabled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("recovers an observed case marker after remount and waits for a fresh authorized exact empty read", async () => {
    let finishExactRead: (value: unknown) => void = () => undefined;
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.missing }));
    saveObservedVerificationCase(USER_A, dashboard.site.id, commandIds.missing, "case-1");
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: { status: 410, body: { code: "command_expired" } }, isFetching: false, refetch: vi.fn() });
    mocks.apiGet.mockImplementation((path: string) => path.includes(`originalCommandId=${commandIds.missing}`)
      ? new Promise((resolve) => { finishExactRead = resolve; })
      : Promise.resolve({ items: [], nextCursor: null }));
    renderControl();
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith(expect.stringContaining(`originalCommandId=${commandIds.missing}`)));
    expect(applyButton()).toBeDisabled();
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toContain(commandIds.missing);
    finishExactRead({ items: [], nextCursor: null, generatedAt: "2026-09-25T00:00:00.000Z" });
    await waitFor(() => expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toBeNull());
    expect(loadObservedVerificationCase(USER_A, dashboard.site.id, commandIds.missing)).toBeNull();
  });

  it("retains the hold when a cached nonterminal command detail returns 404", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.cached404 }));
    mocks.useCommandStatus.mockReturnValue({
      data: createCommandStatus(commandIds.cached404, "accepted"),
      error: Object.assign(new Error("not found"), { status: 404 }),
      isFetching: false,
      refetch: vi.fn()
    });

    renderControl();

    expect(await screen.findByText("명령 원본을 찾을 수 없습니다. 실제 상태 확인 전까지 제어 잠금을 유지합니다.")).toBeInTheDocument();
    expect(fixtureMarker("B2-L001")).toBeDisabled();
    expect(applyButton()).toBeDisabled();
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toContain(commandIds.cached404);
  });

  it("hides cached terminal results and retains the lock after detail 404", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.terminal }));
    mocks.useCommandStatus.mockReturnValue({
      data: createCommandStatus(commandIds.terminal, "completed"),
      error: Object.assign(new Error("not found"), { status: 404 }),
      isFetching: false,
      refetch: vi.fn()
    });

    renderControl();

    expect(within(screen.getByRole("status", { name: "명령 진행 상태" })).queryByText("조명 적용 완료 · 기본 밝기로 저장됨")).not.toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
    expect(screen.queryByText("진행 중 명령을 찾을 수 없어 제어 잠금을 해제했습니다")).not.toBeInTheDocument();
    expect(screen.queryByText("명령 상태를 불러오지 못했습니다. 연결을 확인한 뒤 다시 조회하세요.")).not.toBeInTheDocument();
  });

  it("locks map and drawer selection while restoring a command for a large site", async () => {
    const largeDashboard = createLargeDashboard(101);
    sessionStorage.setItem(activeCommandStorageKey(USER_A, largeDashboard.site.id), JSON.stringify({ commandId: commandIds.large }));
    mocks.useControlDashboard.mockReturnValue({ data: largeDashboard, isLoading: false, error: null });

    renderControl("admin", largeDashboard.site.id);

    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.large));
    expect(screen.getByRole("button", { name: "조명 목록 열기" })).toBeDisabled();
    expect(fixtureMarker("대규모 조명 0001")).toBeDisabled();
  });

  it("unlocks controls and keeps terminal device results visible", async () => {
    const terminalStatus = createCommandStatus(commandIds.default, "partial_failed");
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: null, isFetching: false, refetch: vi.fn() });
    const { rerender } = renderControl();

    selectFixture("B2-L001");
    fireEvent.click(applyButton());
    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.default));

    mocks.useCommandStatus.mockReturnValue({ data: terminalStatus, error: null, isFetching: false, refetch: vi.fn() });
    rerender(controlElement(dashboard.site.id));

    expect(await within(screen.getByRole("status", { name: "명령 진행 상태" })).findByText("일부 조명 적용 실패")).toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
    await waitFor(() => expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toBeNull());
  });

  it("restores the active command for the loaded site after a refresh", async () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.restored }));
    renderControl();

    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.restored));
    expect(applyButton()).toBeDisabled();
  });

  it.each([
    ["network", new Error("network")],
    ["5xx", Object.assign(new Error("server error"), { status: 500 })]
  ])("keeps the active command when a %s status lookup fails and retries on request", async (_label, queryError) => {
    const refetch = vi.fn();
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.retry }));
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: queryError, isFetching: false, refetch });
    renderControl();

    expect(await screen.findByText("명령 상태를 불러오지 못했습니다. 연결을 확인한 뒤 다시 조회하세요.")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, dashboard.site.id))).toContain(commandIds.retry);

    fireEvent.click(screen.getByRole("button", { name: "명령 상태 다시 조회" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "without cached data", data: undefined, error: new Error("network"), title: "명령 상태 조회 실패" },
    { label: "with a cached nonterminal status", data: createCommandStatus(commandIds.retry, "accepted"), error: new Error("network"), title: "명령 상태 조회 실패" },
    { label: "with a mismatched response", data: createCommandStatus(commandIds.different, "completed"), error: null, title: "명령 상태 응답 확인 필요" }
  ])("keeps a $label command status failure discoverable from automation without sending a command", async ({ data: commandData, error: commandError, title }) => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.retry }));
    mocks.useCommandStatus.mockReturnValue({ data: commandData, error: commandError, isFetching: false, refetch: vi.fn() });
    renderControl();

    expect(screen.getByRole("button", { name: "명령 상태 다시 조회" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "스케줄 제어" }));
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 1건" }));
    const center = screen.getByRole("dialog", { name: "현재 세션 상태" });
    expect(within(center).getByText(title)).toBeInTheDocument();
    expect(within(center).getByText("확인 필요")).toBeInTheDocument();
    fireEvent.click(within(center).getByRole("button", { name: "수동 제어로 이동" }));

    await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent("mode=manual"));
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("deduplicates repeated command lookup failures and clears their toast when polling recovers", async () => {
    const accepted = createCommandStatus(commandIds.retry, "accepted");
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.retry }));
    mocks.useCommandStatus.mockReturnValue({ data: accepted, error: new Error("network"), isFetching: false, refetch: vi.fn() });
    const { rerender } = renderControl();
    const region = screen.getByRole("region", { name: "알림" });
    await waitFor(() => expect(within(region).getByRole("status")).toHaveTextContent("명령 상태 조회 실패"));

    mocks.useCommandStatus.mockReturnValue({ data: accepted, error: new Error("network"), isFetching: false, refetch: vi.fn() });
    rerender(controlElement(dashboard.site.id));
    expect(within(region).getAllByRole("status")).toHaveLength(1);

    mocks.useCommandStatus.mockReturnValue({ data: accepted, error: null, isFetching: false, refetch: vi.fn() });
    rerender(controlElement(dashboard.site.id));
    await waitFor(() => expect(within(region).queryByRole("status")).not.toBeInTheDocument());

    mocks.useCommandStatus.mockReturnValue({ data: accepted, error: new Error("network"), isFetching: false, refetch: vi.fn() });
    rerender(controlElement(dashboard.site.id));
    await waitFor(() => expect(within(region).getByRole("status")).toHaveTextContent("명령 상태 조회 실패"));
  });

  it("isolates restored command state and results when the loaded site changes", async () => {
    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    sessionStorage.setItem(activeCommandStorageKey(USER_A, dashboard.site.id), JSON.stringify({ commandId: commandIds.siteA }));
    sessionStorage.setItem(activeCommandStorageKey(USER_A, nextSiteId), JSON.stringify({ commandId: commandIds.siteB }));
    const { rerender } = renderControl();

    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.siteA));
    const nextDashboard: Dashboard = { ...dashboard, site: { ...dashboard.site, id: nextSiteId, name: "다음 현장" } };
    mocks.useControlDashboard.mockReturnValue({ data: nextDashboard, isLoading: false, error: null });
    rerender(controlElement(nextSiteId));

    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.siteB));
    expect(within(screen.getByRole("status", { name: "명령 진행 상태" })).queryByText("명령 접수 완료")).not.toBeInTheDocument();
  });

  it("persists control mode in the URL and restores the selected tab", async () => {
    renderControl("admin", dashboard.site.id, USER_A, `/control?siteId=${dashboard.site.id}&mode=schedule`);

    expect(screen.getByRole("tab", { name: "스케줄 제어" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(`스케줄 패널 ${dashboard.site.id}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "수동 제어" }));
    await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent("mode=manual"));
    expect(screen.getByRole("region", { name: "제어 대상 지도" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "이벤트 제어" }));
    await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent("mode=event"));
    expect(await screen.findByText(`이벤트 패널 ${dashboard.site.id}`)).toBeInTheDocument();
  });

  it("submits the selected target and brightness without expiry UI or fields", async () => {
    renderControl();

    expect(screen.queryByLabelText("수동 override 종료 시각")).not.toBeInTheDocument();
    selectFixture("B2-L001");
    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    fireEvent.click(applyButton());

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    expect(mocks.apiPost).toHaveBeenCalledWith("/commands/dimming", expect.objectContaining({
      siteId: dashboard.site.id,
      clientRequestId: expect.any(String),
      target: { type: "fixture", fixtureId: fixtureIds.b2First },
      brightness: 30
    }), { signal: expect.any(AbortSignal) });
    expect(mocks.apiPost.mock.calls[0][1]).not.toHaveProperty("overrideUntil");
    expect(mocks.apiPost.mock.calls[0][1]).not.toHaveProperty("overrideRemainingMs");
  });

  it("uses roving tab focus and selects modes with circular arrow, Home, and End keys", async () => {
    renderControl("admin", dashboard.site.id, USER_A, `/control?siteId=${dashboard.site.id}&mode=manual`);
    const manualTab = screen.getByRole("tab", { name: "수동 제어" });
    const scheduleTab = screen.getByRole("tab", { name: "스케줄 제어" });
    const eventTab = screen.getByRole("tab", { name: "이벤트 제어" });

    expect(manualTab).toHaveAttribute("tabindex", "0");
    expect(scheduleTab).toHaveAttribute("tabindex", "-1");
    expect(eventTab).toHaveAttribute("tabindex", "-1");

    manualTab.focus();
    fireEvent.keyDown(manualTab, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent("mode=event"));
    expect(eventTab).toHaveFocus();
    expect(eventTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(eventTab, { key: "Home" });
    await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent("mode=manual"));
    expect(manualTab).toHaveFocus();

    fireEvent.keyDown(manualTab, { key: "End" });
    await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent("mode=event"));
    expect(eventTab).toHaveFocus();

    fireEvent.keyDown(eventTab, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent("mode=manual"));
    expect(manualTab).toHaveFocus();
  });

  it("restores the selected roving tab after browser back and forward navigation", async () => {
    renderControl("admin", dashboard.site.id, USER_A, `/control?siteId=${dashboard.site.id}&mode=manual`);

    fireEvent.click(screen.getByRole("tab", { name: "스케줄 제어" }));
    await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent("mode=schedule"));
    fireEvent.click(screen.getByRole("tab", { name: "이벤트 제어" }));
    await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent("mode=event"));

    fireEvent.click(screen.getByRole("button", { name: "브라우저 뒤로" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "스케줄 제어" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("tab", { name: "스케줄 제어" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "이벤트 제어" })).toHaveAttribute("tabindex", "-1");

    fireEvent.click(screen.getByRole("button", { name: "브라우저 앞으로" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "이벤트 제어" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("tab", { name: "이벤트 제어" })).toHaveAttribute("tabindex", "0");
  });

  it("normalizes an invalid mode to manual while preserving the selected site", async () => {
    renderControl("admin", dashboard.site.id, USER_A, `/control?siteId=${dashboard.site.id}&mode=unknown`);

    expect(screen.getByRole("region", { name: "제어 대상 지도" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("control-location")).toHaveTextContent(
      `?siteId=${dashboard.site.id}&mode=manual`
    ));
  });

  it("drops schedule dialog state when the site or user scope changes", async () => {
    const { rerender } = renderControl(
      "admin",
      dashboard.site.id,
      USER_A,
      `/control?siteId=${dashboard.site.id}&mode=schedule`
    );
    fireEvent.click(screen.getByRole("button", { name: "테스트 스케줄 dialog 열기" }));
    expect(screen.getByText("테스트 스케줄 dialog 열림")).toBeInTheDocument();

    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    const nextDashboard: Dashboard = { ...dashboard, site: { ...dashboard.site, id: nextSiteId, name: "다음 현장" } };
    mocks.useControlDashboard.mockReturnValue({ data: nextDashboard, isLoading: false, error: null });
    rerender(controlElement(nextSiteId, "admin", USER_A, `/control?siteId=${dashboard.site.id}&mode=schedule`));
    expect(screen.queryByText("테스트 스케줄 dialog 열림")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "테스트 스케줄 dialog 열기" }));
    rerender(controlElement(nextSiteId, "admin", USER_B, `/control?siteId=${dashboard.site.id}&mode=schedule`));
    expect(screen.queryByText("테스트 스케줄 dialog 열림")).not.toBeInTheDocument();
  });
});

function renderControl(
  role: "operator" | "admin" | "viewer" = "admin",
  siteId = dashboard.site.id,
  userId = USER_A,
  initialEntry = `/control?siteId=${siteId}`
) {
  return render(controlElement(siteId, role, userId, initialEntry));
}

function selectOption(label: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

function fixtureMarker(name: string) {
  return screen.getByRole("button", { name: new RegExp(`^${name} `) });
}

function selectFixture(name: string) {
  fireEvent.click(fixtureMarker(name));
}

function openFixtureList() {
  fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
  return screen.getByRole("dialog", { name: "조명 목록" });
}

function chooseTargetMode(name: "층 전체" | "저장된 구역") {
  fireEvent.click(screen.getByRole("button", { name }));
  const confirm = screen.queryByRole("button", { name: "변경" });
  if (confirm) fireEvent.click(confirm);
}

function chooseFloor(name: string) {
  chooseTargetMode("층 전체");
  fireEvent.click(screen.getByRole("button", { name }));
}

function chooseGroup(name: RegExp) {
  chooseTargetMode("저장된 구역");
  fireEvent.click(screen.getByRole("button", { name }));
}

function applyButton() {
  const button = document.querySelector<HTMLButtonElement>("[data-control-submit]");
  if (!button) throw new Error("manual apply action is missing");
  return button;
}

function controlElement(
  siteId: string,
  role: "operator" | "admin" | "viewer" = "admin",
  userId = USER_A,
  initialEntry = `/control?siteId=${siteId}`
) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <SessionStatusProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <SessionStatusCenter />
          <ToastRegion />
          <ControlView siteId={siteId} userId={userId} userRole={role} />
          <ControlLocation />
        </MemoryRouter>
      </SessionStatusProvider>
    </QueryClientProvider>
  );
}

function ControlLocation() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="control-location">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => void navigate(-1)}>브라우저 뒤로</button>
      <button type="button" onClick={() => void navigate(1)}>브라우저 앞으로</button>
    </>
  );
}

function createFixture(
  id: string,
  name: string,
  brightness: number,
  overrides: Partial<Dashboard["floors"][number]["fixtures"][number]> = {}
): Dashboard["floors"][number]["fixtures"][number] {
  return {
    id,
    name,
    x: 0,
    y: 0,
    ratedWatt: 40,
    brightness,
    status: "online",
    statusReason: "reported",
    health: { faultCodes: [], observedAt: "2026-08-19T01:00:00.000Z" },
    rssi: -55,
    hopCount: 1,
    commandSuccessRate: 1,
    lastSeenAt: "2026-08-19T01:00:00.000Z",
    gateway: { id: "gateway-1", name: "GW-B2", connectionStatus: "online" },
    controllable: true,
    controlBlockReason: null,
    ...overrides
  };
}

function createLargeDashboard(fixtureCount: number): Dashboard {
  return {
    ...dashboard,
    site: { ...dashboard.site, id: "00000000-0000-4000-8000-000000000088", name: "대규모 현장" },
    summary: {
      totalFixtures: fixtureCount,
      onlineFixtures: fixtureCount,
      faultFixtures: 0,
      averageBrightness: 70
    },
    floors: [{
      id: "00000000-0000-4000-8000-000000000089",
      name: "B1",
      level: -1,
      floorPlan: null,
      meshControlGroups: [{ gatewayId: "gateway-1", status: "ready", version: 1, error: null }],
      fixtures: Array.from({ length: fixtureCount }, (_, index) => createFixture(
        `00000000-0000-4000-8${String(index).padStart(3, "0")}-${String(index + 1).padStart(12, "0")}`,
        `대규모 조명 ${String(index + 1).padStart(4, "0")}`,
        70
      ))
    }],
    groups: [],
    gateways: []
  };
}

function twoGatewayFloorDashboard(secondGatewayStatus: "ready" | "configuring"): Dashboard {
  const floor = dashboard.floors[0];
  return {
    ...dashboard,
    floors: [{
      ...floor,
      fixtures: [
        { ...floor.fixtures[0], gateway: { id: "gateway-1", name: "GW-B2-1", connectionStatus: "online" } },
        { ...floor.fixtures[1], gateway: { id: "gateway-2", name: "GW-B2-2", connectionStatus: "online" } }
      ],
      meshControlGroups: [
        { gatewayId: "gateway-1", status: "ready", version: 2, error: null },
        { gatewayId: "gateway-2", status: secondGatewayStatus, version: 2, error: null }
      ]
    }],
    groups: []
  };
}

function createCommandStatus(
  id: string,
  stage: CommandStage
) {
  return {
    id,
    stage,
    dispatchCount: 1,
    completedFixtureCount: 1,
    totalFixtureCount: 1,
    errorMessage: null,
    dispatches: [{
      id: "dispatch-1",
      status: stage,
      gateway: { id: "gateway-1", name: "GW-B2" },
      errorMessage: null,
      results: [{ fixtureId: fixtureIds.b2First, fixtureName: "B2-L001", status: "failed" as const, errorMessage: "장비 응답 오류" }]
    }]
  };
}
