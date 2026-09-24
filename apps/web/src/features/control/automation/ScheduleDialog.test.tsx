import type { FloorMapSnapshot } from "@led-control/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateScheduleInput, ScheduleResponse } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { ScheduleDialog } from "./ScheduleDialog";

const floorMapQuery = vi.hoisted(() => vi.fn());

vi.mock("../../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/queries")>()),
  useFloorMapSnapshot: floorMapQuery
}));

const fixtureA = "00000000-0000-4000-8000-000000000003";
const fixtureB = "00000000-0000-4000-8000-000000000005";
const fixtureC = "00000000-0000-4000-8000-000000000009";
const fixtureOtherGateway = "00000000-0000-4000-8000-000000000007";
const floorId = "00000000-0000-4000-8000-000000000004";
const groupId = "00000000-0000-4000-8000-000000000006";
const snapshot: FloorMapSnapshot = {
  floorId,
  revision: 1,
  width: 600,
  height: 400,
  floorPlan: null,
  objects: []
};

const dashboard: Dashboard = {
  generatedAt: "2026-09-16T00:00:00.000Z",
  monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
  site: { id: "00000000-0000-4000-8000-000000000001", name: "테스트 현장", customerName: "고객사", installationStatus: "installed", address: null, tariffKwhRate: null, timeZone: "Asia/Seoul" },
  summary: { totalFixtures: 2, onlineFixtures: 2, faultFixtures: 0, averageBrightness: 70 },
  floors: [{
    id: floorId, name: "B2", level: -2, floorPlan: null,
    meshControlGroups: [{ gatewayId: "gateway-a", status: "ready", version: 1, error: null }],
    fixtures: [fixture(fixtureA, "B2-L001", 100), fixture(fixtureB, "B2-L002", 200)]
  }],
  groups: [{
    id: groupId, name: "B2 입구 구역", floorId, gatewayId: "gateway-a", lifecycleStatus: "active", fixtureCount: 2,
    meshControlGroup: { status: "ready", version: 1, error: null }, fixtureIds: [fixtureA, fixtureB]
  }],
  gateways: []
};

const multiGatewayDashboard: Dashboard = {
  ...dashboard,
  summary: { ...dashboard.summary, totalFixtures: 3, onlineFixtures: 3 },
  floors: [{
    ...dashboard.floors[0],
    fixtures: [...dashboard.floors[0].fixtures, fixture(fixtureOtherGateway, "B2-L003", 300, "gateway-b")]
  }]
};

const unreadyFloorDashboard: Dashboard = {
  ...dashboard,
  floors: [{
    ...dashboard.floors[0],
    meshControlGroups: [{ gatewayId: "gateway-a", status: "configuring", version: 2, error: null }]
  }]
};

const changedGroupDashboard: Dashboard = {
  ...dashboard,
  summary: { ...dashboard.summary, totalFixtures: 3, onlineFixtures: 3 },
  floors: [{ ...dashboard.floors[0], fixtures: [...dashboard.floors[0].fixtures, fixture(fixtureC, "B2-L003", 300)] }],
  groups: [{ ...dashboard.groups[0], fixtureCount: 2, fixtureIds: [fixtureA, fixtureC] }]
};

const persistedSchedule = schedule({ fixtureIds: [fixtureA, fixtureB], targets: [{ fixtureId: fixtureA }, { fixtureId: fixtureB }], targetCount: 2 });

describe("ScheduleDialog spatial targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    floorMapQuery.mockReturnValue({ data: snapshot, error: null, isLoading: false, isFetching: false });
  });

  afterEach(cleanup);

  it("shows the default one-day date range and its limit before advanced settings are opened", () => {
    renderScheduleDialog();
    const dialog = screen.getByRole("dialog", { name: "스케줄 추가" });

    expect(within(dialog).getByRole("group", { name: "적용 시작일" })).toBeVisible();
    expect(within(dialog).getByRole("group", { name: "적용 종료일" })).toBeVisible();
    expect(within(dialog).getByText(/오늘만 적용/)).toBeVisible();
    expect(within(dialog).getByRole("status")).toHaveTextContent("하루만 적용");
    expect(within(dialog).queryByRole("region", { name: "세부 일정 설정" })).not.toBeInTheDocument();
  });

  it("shows a saved multi-day range without calling it today-only", () => {
    renderScheduleDialog({ schedule: persistedSchedule });
    const dialog = screen.getByRole("dialog", { name: "스케줄 수정" });

    expect(within(dialog).getByRole("group", { name: "적용 시작일" })).toBeVisible();
    expect(within(dialog).getByRole("group", { name: "적용 종료일" })).toBeVisible();
    expect(within(dialog).queryByText(/오늘만 적용/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("status")).toHaveTextContent("2026-09-01–2026-09-30");
  });

  it("returns from an empty picker without discarding the form draft and restores its trigger focus", async () => {
    renderScheduleDialog();
    fireEvent.click(screen.getByRole("button", { name: "30%" }));
    openTargetView();
    expect(screen.getByRole("button", { name: "선택 완료" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "설정으로 돌아가기" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "제어 대상 선택" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "30%" })).toHaveAttribute("aria-pressed", "true");
  });

  it.each(["gateway", "uncontrollable"])("revalidates a direct snapshot at save after a %s refresh", (change) => {
    const onSubmit = vi.fn();
    const view = renderScheduleDialog({ onSubmit });
    openTargetView();
    fireEvent.click(screen.getByRole("button", { name: /B2-L001 정상/ }));
    fireEvent.click(screen.getByRole("button", { name: /B2-L002 정상/ }));
    fireEvent.click(screen.getByRole("button", { name: "2개 조명 선택 완료" }));
    const nextDashboard = structuredClone(dashboard);
    const changed = nextDashboard.floors[0].fixtures[1];
    if (change === "gateway") changed.gateway!.id = "gateway-b";
    else { changed.controllable = false; changed.controlBlockReason = "fixture_offline"; }
    view.rerender(scheduleDialogElement({ dashboard: nextDashboard, onSubmit }));
    fireEvent.click(screen.getByRole("button", { name: "스케줄 만들기" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "제어 대상 선택" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "2개 조명 선택 완료" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(change === "gateway" ? "같은 게이트웨이" : "제어할 수 없는");
  });

  it("selects a saved group on the map and explains snapshot storage", async () => {
    renderScheduleDialog();
    openTargetView();
    fireEvent.click(screen.getByRole("button", { name: "저장된 구역" }));
    fireEvent.click(screen.getByRole("button", { name: "B2 입구 구역" }));

    expect(screen.getByText("현재 2개 조명이 스케줄 대상으로 저장됩니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "2개 조명 선택 완료" }));
    expect(screen.getByRole("group", { name: "제어 대상" })).toHaveTextContent("B2 입구 구역");
    expect(screen.getByRole("group", { name: "제어 대상" })).toHaveTextContent("2개 조명 스냅샷");
  });

  it("blocks a floor target that spans gateways", () => {
    renderScheduleDialog({ dashboard: multiGatewayDashboard });
    openTargetView();
    fireEvent.click(screen.getByRole("button", { name: "층 전체" }));
    fireEvent.click(screen.getByRole("button", { name: "B2" }));
    expect(screen.getByRole("button", { name: /선택 완료/ })).toBeDisabled();
    expect(screen.getByRole("complementary", { name: "선택 대상 요약" })).toHaveTextContent("같은 게이트웨이");
  });

  it("blocks completion and submit when an authored floor loses Mesh readiness", () => {
    const onSubmit = vi.fn<(input: CreateScheduleInput) => void>();
    const view = renderScheduleDialog({ onSubmit });
    openTargetView();
    fireEvent.click(screen.getByRole("button", { name: "층 전체" }));
    fireEvent.click(screen.getByRole("button", { name: "B2" }));
    fireEvent.click(screen.getByRole("button", { name: "2개 조명 선택 완료" }));

    view.rerender(scheduleDialogElement({ dashboard: unreadyFloorDashboard, onSubmit }));
    fireEvent.click(screen.getByRole("button", { name: "스케줄 만들기" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "2개 조명 선택 완료" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Mesh 설정 중");
  });

  it("keeps group snapshot fixtures displayed and submitted after live membership changes", async () => {
    const onSubmit = vi.fn<(input: CreateScheduleInput) => void>();
    const view = renderScheduleDialog({ onSubmit });
    openTargetView();
    fireEvent.click(screen.getByRole("button", { name: "저장된 구역" }));
    fireEvent.click(screen.getByRole("button", { name: "B2 입구 구역" }));
    fireEvent.click(screen.getByRole("button", { name: "2개 조명 선택 완료" }));

    view.rerender(scheduleDialogElement({ dashboard: changedGroupDashboard, onSubmit }));
    openTargetView();
    expect(screen.getByRole("button", { name: /B2-L001 정상 70%/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /B2-L002 정상 70%/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /B2-L003 정상 70%/ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
    expect(screen.getByRole("checkbox", { name: "B2-L001 선택" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "B2-L002 선택" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "B2-L003 선택" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "선택 완료" }));
    fireEvent.click(screen.getByRole("button", { name: "2개 조명 선택 완료" }));
    fireEvent.click(screen.getByRole("button", { name: "스케줄 만들기" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      target: { type: "fixtures", fixtureIds: [fixtureA, fixtureB] }
    })));
  });

  it("loads an existing persisted fixture snapshot as direct selection", () => {
    renderScheduleDialog({ schedule: persistedSchedule });
    openTargetView();
    expect(screen.getByRole("button", { name: "직접 선택" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("현재 저장된 조명 2개")).toBeInTheDocument();
  });

  it("selects a direct fixture marker and preserves the schedule API payload", async () => {
    const onSubmit = vi.fn<(input: CreateScheduleInput) => void>();
    renderScheduleDialog({ onSubmit });
    openTargetView();
    fireEvent.click(screen.getByRole("button", { name: /B2-L001 정상 70%/ }));
    fireEvent.click(screen.getByRole("button", { name: "1개 조명 선택 완료" }));
    fireEvent.click(screen.getByRole("button", { name: "스케줄 만들기" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      target: { type: "fixture", fixtureId: fixtureA },
      recurrence: expect.objectContaining({ kind: "daily" }),
      action: { dimmingEnabled: true, brightnessPercent: 70 }
    })));
  });

  it("opens the bounded fixture list when the map endpoint returns 404", () => {
    floorMapQuery.mockReturnValue({ data: undefined, error: { status: 404 }, isLoading: false, isFetching: false });
    renderScheduleDialog();
    openTargetView();

    const list = screen.getByRole("dialog", { name: "조명 목록" });
    expect(list).toHaveClass("max-compact:h-full!", "overflow-hidden!");
    expect(screen.getByText("등록된 도면이 없어 목록으로 선택합니다.")).toBeInTheDocument();
  });

  it("moves target validation focus into the selector", () => {
    renderScheduleDialog();
    fireEvent.click(screen.getByRole("button", { name: "스케줄 만들기" }));

    const selector = screen.getByRole("group", { name: "제어 대상 선택" });
    expect(selector).toHaveFocus();
    expect(selector).toHaveAttribute("aria-errormessage", "schedule-target-error");
  });
});

function renderScheduleDialog(overrides: Partial<React.ComponentProps<typeof ScheduleDialog>> = {}) {
  return render(scheduleDialogElement(overrides));
}

function scheduleDialogElement(overrides: Partial<React.ComponentProps<typeof ScheduleDialog>> = {}) {
  return <ScheduleDialog
    open
    schedule={null}
    dashboard={dashboard}
    isPending={false}
    serverError=""
    onClose={vi.fn()}
    onSubmit={vi.fn()}
    {...overrides}
  />;
}

function openTargetView() {
  fireEvent.click(screen.getByRole("button", { name: /제어 대상 (선택|변경)/ }));
}

function fixture(id: string, name: string, x: number, gatewayId = "gateway-a") {
  return {
    id, name, x, y: 100, placementStatus: "placed" as const, positionVerifiedAt: null, ratedWatt: 40, brightness: 70,
    status: "online" as const, statusReason: "reported" as const, health: null, rssi: -55, hopCount: 1,
    commandSuccessRate: 1, lastSeenAt: "2026-08-31T00:00:00.000Z",
    gateway: { id: gatewayId, name: gatewayId, connectionStatus: "online" as const }, controllable: true, controlBlockReason: null
  };
}

function schedule(overrides: Partial<ScheduleResponse> = {}): ScheduleResponse {
  return {
    id: "00000000-0000-4000-8000-000000000011", name: "야간 운영", status: "enabled",
    activeFrom: "2026-09-01T03:00:00.000Z", activeUntil: "2026-09-30T03:00:00.000Z", localStartTime: "18:00", localEndTime: "23:00",
    recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
    action: { dimmingEnabled: true, brightnessPercent: 70 }, fixtureIds: [fixtureA], gatewayId: "gateway-a", targets: [{ fixtureId: fixtureA }], targetCount: 1,
    desiredRevision: 1, appliedRevision: 1, syncStatus: "APPLIED", nextOccurrence: null, lastExecution: null,
    createdById: "user-a", updatedById: "user-a", createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z", ...overrides
  };
}
