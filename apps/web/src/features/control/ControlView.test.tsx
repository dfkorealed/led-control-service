import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandStage } from "../../api/commands";
import type { Dashboard } from "../../api/queries";
import { ControlView } from "./ControlView";
import { activeCommandStorageKey } from "./active-command-store";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  useControlDashboard: vi.fn(),
  useCommandStatus: vi.fn()
}));

vi.mock("../../api/client", () => ({ apiPost: mocks.apiPost }));
vi.mock("../../api/queries", () => ({ useControlDashboard: mocks.useControlDashboard }));
vi.mock("../../api/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/commands")>()),
  useCommandStatus: mocks.useCommandStatus
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

const dashboard: Dashboard = {
  site: { id: "00000000-0000-4000-8000-000000000003", name: "테스트 현장" },
  summary: { totalFixtures: 4, onlineFixtures: 3, faultFixtures: 0, averageBrightness: 65 },
  floors: [
    {
      id: "00000000-0000-4000-8000-000000000005",
      name: "B2",
      level: -2,
      floorPlan: null,
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
      fixtures: [createFixture(fixtureIds.b1First, "B1-L001", 50)]
    }
  ],
  groups: [
    {
      id: "00000000-0000-4000-8000-000000000006",
      name: "B2 입구 구역",
      fixtureIds: [fixtureIds.b2First, fixtureIds.b2Second]
    },
    {
      id: "00000000-0000-4000-8000-000000000007",
      name: "B2 비상 구역",
      fixtureIds: [fixtureIds.b2First, fixtureIds.b2Offline]
    }
  ],
  gateways: []
};

describe("ControlView 대상 선택", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.apiPost.mockResolvedValue({
      id: commandIds.default,
      dispatchCount: 1,
      selectedTargetCount: 2,
      transmissionCount: 2,
      deliveryMode: "parallel_unicast"
    });
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: null, isFetching: false, refetch: vi.fn() });
    mocks.useControlDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null });
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it("sends one selected light as a fixture target", async () => {
    renderControl();

    fireEvent.click(screen.getByLabelText("B2-L001 선택"));
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith("/commands/dimming", {
      siteId: dashboard.site.id,
      clientRequestId: expect.any(String),
      target: { type: "fixture", fixtureId: fixtureIds.b2First },
      brightness: 70
    }));
  });

  it("syncs brightness from the fixture when exactly one light is selected", () => {
    renderControl();

    fireEvent.click(screen.getByLabelText("B2-L002 선택"));

    expect(screen.getByRole("slider", { name: "밝기" })).toHaveValue("60");
  });

  it("keeps the chosen brightness for empty and multiple light selections", () => {
    renderControl();
    const brightnessSlider = screen.getByRole("slider", { name: "밝기" });

    fireEvent.click(screen.getByLabelText("B2-L001 선택"));
    expect(brightnessSlider).toHaveValue("70");

    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    fireEvent.click(screen.getByLabelText("B2-L002 선택"));
    expect(brightnessSlider).toHaveValue("30");

    fireEvent.click(screen.getByRole("button", { name: "선택 해제" }));
    expect(brightnessSlider).toHaveValue("30");
  });

  it("keeps the chosen brightness when switching to floor and zone targets", () => {
    renderControl();
    const brightnessSlider = screen.getByRole("slider", { name: "밝기" });

    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    fireEvent.click(screen.getByRole("button", { name: "층" }));
    fireEvent.click(screen.getByRole("button", { name: "B1" }));
    expect(brightnessSlider).toHaveValue("30");

    fireEvent.click(screen.getByRole("button", { name: "구역" }));
    fireEvent.click(screen.getByRole("button", { name: /B2 입구 구역/ }));
    expect(brightnessSlider).toHaveValue("30");
  });

  it("sends arbitrary multiple lights as a fixtures target", async () => {
    renderControl();

    fireEvent.click(screen.getByLabelText("B2-L001 선택"));
    fireEvent.click(screen.getByLabelText("B2-L002 선택"));
    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith("/commands/dimming", {
      siteId: dashboard.site.id,
      clientRequestId: expect.any(String),
      target: { type: "fixtures", fixtureIds: [fixtureIds.b2First, fixtureIds.b2Second] },
      brightness: 30
    }));
    expect(screen.getByText("2개 선택 · 제어 불가 0개")).toBeInTheDocument();
  });

  it("sends floor and zone selections through their mesh group targets", async () => {
    const { rerender } = renderControl();

    fireEvent.click(screen.getByRole("button", { name: "층" }));
    fireEvent.click(screen.getByRole("button", { name: "B1" }));
    expect(screen.getByText("BLE Mesh 그룹 전송")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenLastCalledWith("/commands/dimming", {
      siteId: dashboard.site.id,
      clientRequestId: expect.any(String),
      target: { type: "floor", floorId: dashboard.floors[1].id },
      brightness: 70
    }));

    mocks.useCommandStatus.mockReturnValue({
      data: createCommandStatus(commandIds.default, "completed"),
      error: null,
      isFetching: false,
      refetch: vi.fn()
    });
    rerender(controlElement(dashboard.site.id));
    await waitFor(() => expect(screen.getByRole("button", { name: "밝기 적용" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "구역" }));
    fireEvent.click(screen.getByRole("button", { name: /B2 입구 구역/ }));
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenLastCalledWith("/commands/dimming", {
      siteId: dashboard.site.id,
      clientRequestId: expect.any(String),
      target: { type: "group", groupId: dashboard.groups[0].id },
      brightness: 70
    }));
  });

  it("filters the fixture checklist by search, state, and floor", () => {
    renderControl();

    fireEvent.change(screen.getByRole("searchbox", { name: "조명 검색" }), { target: { value: "L001" } });
    fireEvent.change(screen.getByLabelText("상태 필터"), { target: { value: "online" } });
    fireEvent.change(screen.getByLabelText("층 필터"), { target: { value: dashboard.floors[1].id } });

    const list = screen.getByRole("group", { name: "조명 목록" });
    expect(within(list).getByText("B1-L001")).toBeInTheDocument();
    expect(within(list).queryByText("B2-L001")).not.toBeInTheDocument();
    expect(within(list).queryByText("B2-L003")).not.toBeInTheDocument();
  });

  it("blocks a selection containing an uncontrollable light and explains the reason", () => {
    renderControl();

    fireEvent.click(screen.getByLabelText("B2-L001 선택"));
    fireEvent.click(screen.getByLabelText("B2-L003 선택"));

    expect(screen.getByText("2개 선택 · 제어 불가 1개")).toBeInTheDocument();
    expect(screen.getByText(/B2-L003: 게이트웨이가 오프라인/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
  });

  it("keeps every control disabled for viewer accounts", () => {
    renderControl("viewer");

    expect(screen.getByText(/조회 전용 계정/)).toBeInTheDocument();
    expect(screen.getByLabelText("B2-L001 선택")).toBeDisabled();
    expect(screen.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
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

    expect(screen.getByText(/B2 · 장애 · Health 장애/)).toBeInTheDocument();
  });

  it("keeps fixture-level command failures visible while polling status", () => {
    sessionStorage.setItem(activeCommandStorageKey(dashboard.site.id), JSON.stringify({ commandId: commandIds.default }));
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

    expect(screen.getByText("일부 조명 적용 실패")).toBeInTheDocument();
    expect(screen.getByText("2 / 2 처리")).toBeInTheDocument();
    expect(screen.getByText("B2-L002: 장비 응답 오류")).toBeInTheDocument();
  });

  it("keeps cached controls visible when a background refresh fails", () => {
    mocks.useControlDashboard.mockReturnValue({
      data: dashboard,
      isLoading: false,
      error: new Error("temporary refresh failure")
    });

    renderControl();

    expect(screen.getByRole("heading", { name: "조명 밝기 제어" })).toBeInTheDocument();
    expect(screen.getByLabelText("B2-L001 선택")).toBeInTheDocument();
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

  it("renders large fixture lists in fixed batches while selecting the full filtered result", () => {
    const largeDashboard = createLargeDashboard(1000);
    mocks.useControlDashboard.mockReturnValue({ data: largeDashboard, isLoading: false, error: null });

    renderControl("admin", largeDashboard.site.id);

    expect(screen.getAllByRole("checkbox")).toHaveLength(100);
    expect(screen.getByText("100 / 1000개 표시")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "검색 결과 전체 선택" }));
    expect(screen.getByText("1000개 선택 · 제어 불가 0개")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(200);
    expect(screen.getByText("200 / 1000개 표시")).toBeInTheDocument();
  });

  it("caps bulk and individual fixture selection at 1000 items", () => {
    const largeDashboard = createLargeDashboard(1001);
    mocks.useControlDashboard.mockReturnValue({ data: largeDashboard, isLoading: false, error: null });

    renderControl("admin", largeDashboard.site.id);

    fireEvent.click(screen.getByRole("button", { name: "검색 결과 전체 선택" }));
    expect(screen.getByText("1000개 선택 · 제어 불가 0개")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("최대 1,000개");

    fireEvent.change(screen.getByRole("searchbox", { name: "조명 검색" }), {
      target: { value: "대규모 조명 1001" }
    });
    fireEvent.click(screen.getByLabelText("대규모 조명 1001 선택"));

    expect(screen.getByText("1000개 선택 · 제어 불가 0개")).toBeInTheDocument();
    expect(screen.getByLabelText("대규모 조명 1001 선택")).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("최대 1,000개");
  });

  it("resets picker filters when the active site changes", () => {
    const { rerender } = renderControl();
    fireEvent.change(screen.getByRole("searchbox", { name: "조명 검색" }), { target: { value: "L001" } });
    fireEvent.change(screen.getByLabelText("상태 필터"), { target: { value: "offline" } });
    fireEvent.change(screen.getByLabelText("층 필터"), { target: { value: dashboard.floors[0].id } });

    const nextDashboard: Dashboard = {
      ...dashboard,
      site: { id: "00000000-0000-4000-8000-000000000099", name: "다음 현장" }
    };
    mocks.useControlDashboard.mockReturnValue({ data: nextDashboard, isLoading: false, error: null });
    rerender(controlElement(nextDashboard.site.id));

    expect(screen.getByRole("searchbox", { name: "조명 검색" })).toHaveValue("");
    expect(screen.getByLabelText("상태 필터")).toHaveValue("all");
    expect(screen.getByLabelText("층 필터")).toHaveValue("all");
  });

  it("exposes target modes as pressed buttons instead of incomplete radio semantics", () => {
    renderControl();

    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "개별/다중" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "층" })).toHaveAttribute("aria-pressed", "false");
  });

  it("locks every editable control until the device result is terminal", async () => {
    let resolveCommand: (value: { id: string }) => void = () => undefined;
    mocks.apiPost.mockImplementationOnce(() => new Promise((resolve) => { resolveCommand = resolve; }));
    renderControl();

    fireEvent.click(screen.getByLabelText("B2-L001 선택"));
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));

    expect(screen.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "70%" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "층" })).toBeDisabled();
    expect(screen.getByRole("searchbox", { name: "조명 검색" })).toBeDisabled();
    expect(screen.getByLabelText("상태 필터")).toBeDisabled();
    expect(screen.getByLabelText("층 필터")).toBeDisabled();
    expect(screen.getByRole("button", { name: "검색 결과 전체 선택" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "선택 해제" })).toBeDisabled();
    expect(screen.getByLabelText("B2-L001 선택")).toBeDisabled();

    resolveCommand({ id: commandIds.locked });
    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.locked));
    expect(screen.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();
  });

  it("keeps controls locked when a terminal status belongs to a different command", async () => {
    const refetch = vi.fn();
    sessionStorage.setItem(activeCommandStorageKey(dashboard.site.id), JSON.stringify({ commandId: commandIds.expected }));
    mocks.useCommandStatus.mockReturnValue({
      data: createCommandStatus(commandIds.different, "completed"),
      error: null,
      isFetching: false,
      refetch
    });

    renderControl();

    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.expected));
    expect(screen.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
    expect(screen.queryByText("조명 적용 완료")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("명령 상태 응답의 식별자가 일치하지 않습니다");
    fireEvent.click(screen.getByRole("button", { name: "명령 상태 다시 조회" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(activeCommandStorageKey(dashboard.site.id))).toContain(commandIds.expected);
  });

  it("releases only a missing active command when status lookup returns 404", async () => {
    sessionStorage.setItem(activeCommandStorageKey(dashboard.site.id), JSON.stringify({ commandId: commandIds.missing }));
    mocks.useCommandStatus.mockReturnValue({
      data: undefined,
      error: Object.assign(new Error("not found"), { status: 404 }),
      isFetching: false,
      refetch: vi.fn()
    });

    renderControl();

    expect(await screen.findByText("진행 중 명령을 찾을 수 없어 제어 잠금을 해제했습니다")).toBeInTheDocument();
    expect(screen.getByLabelText("B2-L001 선택")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "명령 상태 다시 조회" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(activeCommandStorageKey(dashboard.site.id))).toBeNull();
  });

  it("releases a missing active command when a matching nonterminal status is cached", async () => {
    sessionStorage.setItem(activeCommandStorageKey(dashboard.site.id), JSON.stringify({ commandId: commandIds.cached404 }));
    mocks.useCommandStatus.mockReturnValue({
      data: createCommandStatus(commandIds.cached404, "accepted"),
      error: Object.assign(new Error("not found"), { status: 404 }),
      isFetching: false,
      refetch: vi.fn()
    });

    renderControl();

    expect(await screen.findByText("진행 중 명령을 찾을 수 없어 제어 잠금을 해제했습니다")).toBeInTheDocument();
    expect(screen.getByLabelText("B2-L001 선택")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "명령 상태 다시 조회" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(activeCommandStorageKey(dashboard.site.id))).toBeNull();
  });

  it("hides a stale status error when matching terminal results arrive", async () => {
    sessionStorage.setItem(activeCommandStorageKey(dashboard.site.id), JSON.stringify({ commandId: commandIds.terminal }));
    mocks.useCommandStatus.mockReturnValue({
      data: createCommandStatus(commandIds.terminal, "completed"),
      error: Object.assign(new Error("not found"), { status: 404 }),
      isFetching: false,
      refetch: vi.fn()
    });

    renderControl();

    expect(await screen.findByText("조명 적용 완료")).toBeInTheDocument();
    expect(screen.queryByText("진행 중 명령을 찾을 수 없어 제어 잠금을 해제했습니다")).not.toBeInTheDocument();
    expect(screen.queryByText("명령 상태를 불러오지 못했습니다. 연결을 확인한 뒤 다시 조회하세요.")).not.toBeInTheDocument();
  });

  it("locks the load-more action while restoring a command for a large site", async () => {
    const largeDashboard = createLargeDashboard(101);
    sessionStorage.setItem(activeCommandStorageKey(largeDashboard.site.id), JSON.stringify({ commandId: commandIds.large }));
    mocks.useControlDashboard.mockReturnValue({ data: largeDashboard, isLoading: false, error: null });

    renderControl("admin", largeDashboard.site.id);

    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.large));
    expect(screen.getByRole("button", { name: "더 보기" })).toBeDisabled();
  });

  it("unlocks controls and keeps terminal device results visible", async () => {
    const terminalStatus = createCommandStatus(commandIds.default, "partial_failed");
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: null, isFetching: false, refetch: vi.fn() });
    const { rerender } = renderControl();

    fireEvent.click(screen.getByLabelText("B2-L001 선택"));
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));
    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.default));

    mocks.useCommandStatus.mockReturnValue({ data: terminalStatus, error: null, isFetching: false, refetch: vi.fn() });
    rerender(controlElement(dashboard.site.id));

    expect(await screen.findByText("일부 조명 적용 실패")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "밝기 적용" })).toBeEnabled();
    await waitFor(() => expect(sessionStorage.getItem(activeCommandStorageKey(dashboard.site.id))).toBeNull());
  });

  it("restores the active command for the loaded site after a refresh", async () => {
    sessionStorage.setItem(activeCommandStorageKey(dashboard.site.id), JSON.stringify({ commandId: commandIds.restored }));
    renderControl();

    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.restored));
    expect(screen.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();
  });

  it.each([
    ["network", new Error("network")],
    ["5xx", Object.assign(new Error("server error"), { status: 500 })]
  ])("keeps the active command when a %s status lookup fails and retries on request", async (_label, queryError) => {
    const refetch = vi.fn();
    sessionStorage.setItem(activeCommandStorageKey(dashboard.site.id), JSON.stringify({ commandId: commandIds.retry }));
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: queryError, isFetching: false, refetch });
    renderControl();

    expect(await screen.findByText("명령 상태를 불러오지 못했습니다. 연결을 확인한 뒤 다시 조회하세요.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();
    expect(sessionStorage.getItem(activeCommandStorageKey(dashboard.site.id))).toContain(commandIds.retry);

    fireEvent.click(screen.getByRole("button", { name: "명령 상태 다시 조회" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("isolates restored command state and results when the loaded site changes", async () => {
    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    sessionStorage.setItem(activeCommandStorageKey(dashboard.site.id), JSON.stringify({ commandId: commandIds.siteA }));
    sessionStorage.setItem(activeCommandStorageKey(nextSiteId), JSON.stringify({ commandId: commandIds.siteB }));
    const { rerender } = renderControl();

    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.siteA));
    const nextDashboard: Dashboard = { ...dashboard, site: { id: nextSiteId, name: "다음 현장" } };
    mocks.useControlDashboard.mockReturnValue({ data: nextDashboard, isLoading: false, error: null });
    rerender(controlElement(nextSiteId));

    await waitFor(() => expect(mocks.useCommandStatus).toHaveBeenLastCalledWith(commandIds.siteB));
    expect(screen.queryByText("명령 접수 완료")).not.toBeInTheDocument();
  });
});

function renderControl(
  role: "operator" | "admin" | "viewer" = "admin",
  siteId = dashboard.site.id
) {
  return render(controlElement(siteId, role));
}

function controlElement(siteId: string, role: "operator" | "admin" | "viewer" = "admin") {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ControlView siteId={siteId} userRole={role} />
    </QueryClientProvider>
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
    site: { id: "00000000-0000-4000-8000-000000000088", name: "대규모 현장" },
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
