import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dashboard } from "../../api/queries";
import { ControlView } from "./ControlView";

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
    mocks.apiPost.mockResolvedValue({
      id: "command-1",
      dispatchCount: 1,
      selectedTargetCount: 2,
      transmissionCount: 2,
      deliveryMode: "parallel_unicast"
    });
    mocks.useCommandStatus.mockReturnValue({ data: undefined, error: null });
    mocks.useControlDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null });
  });

  afterEach(() => cleanup());

  it("sends one selected light as a fixture target", async () => {
    renderControl();

    fireEvent.click(screen.getByLabelText("B2-L001 선택"));
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith("/commands/dimming", {
      siteId: dashboard.site.id,
      target: { type: "fixture", fixtureId: fixtureIds.b2First },
      brightness: 70
    }));
  });

  it("sends arbitrary multiple lights as a fixtures target", async () => {
    renderControl();

    fireEvent.click(screen.getByLabelText("B2-L001 선택"));
    fireEvent.click(screen.getByLabelText("B2-L002 선택"));
    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith("/commands/dimming", {
      siteId: dashboard.site.id,
      target: { type: "fixtures", fixtureIds: [fixtureIds.b2First, fixtureIds.b2Second] },
      brightness: 30
    }));
    expect(screen.getByText("2개 선택 · 제어 불가 0개")).toBeInTheDocument();
  });

  it("sends floor and zone selections through their mesh group targets", async () => {
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: "층" }));
    fireEvent.click(screen.getByRole("button", { name: "B1" }));
    expect(screen.getByText("BLE Mesh 그룹 전송")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenLastCalledWith("/commands/dimming", {
      siteId: dashboard.site.id,
      target: { type: "floor", floorId: dashboard.floors[1].id },
      brightness: 70
    }));

    fireEvent.click(screen.getByRole("button", { name: "구역" }));
    fireEvent.click(screen.getByRole("button", { name: /B2 입구 구역/ }));
    fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenLastCalledWith("/commands/dimming", {
      siteId: dashboard.site.id,
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
    mocks.useCommandStatus.mockReturnValue({
      error: null,
      data: {
        id: "command-1",
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
