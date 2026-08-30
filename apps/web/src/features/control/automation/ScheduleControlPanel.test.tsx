import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import type { ScheduleListResponse, ScheduleResponse } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { ScheduleControlPanel } from "./ScheduleControlPanel";

const mocks = vi.hoisted(() => ({
  createSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  listSchedules: vi.fn(),
  updateSchedule: vi.fn()
}));

vi.mock("../../../api/automation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/automation")>()),
  ...mocks
}));

const siteId = "00000000-0000-4000-8000-000000000001";
const fixtureId = "00000000-0000-4000-8000-000000000003";
const dashboard: Dashboard = {
  site: {
    id: siteId,
    name: "테스트 현장",
    customerName: "테스트 고객",
    installationStatus: "installed",
    address: null,
    tariffKwhRate: 160,
    timeZone: "Asia/Seoul"
  },
  summary: { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, averageBrightness: 70 },
  floors: [{
    id: "00000000-0000-4000-8000-000000000004",
    name: "B1",
    level: -1,
    floorPlan: null,
    meshControlGroups: [{ gatewayId: "gateway-1", status: "ready", version: 1, error: null }],
    fixtures: [{
      id: fixtureId,
      name: "B1-L001",
      x: 0,
      y: 0,
      ratedWatt: 40,
      brightness: 70,
      status: "online",
      statusReason: "reported",
      health: { faultCodes: [], observedAt: "2026-08-31T00:00:00.000Z" },
      rssi: -55,
      hopCount: 1,
      commandSuccessRate: 1,
      lastSeenAt: "2026-08-31T00:00:00.000Z",
      gateway: { id: "gateway-1", name: "GW-B1", connectionStatus: "online" },
      controllable: true,
      controlBlockReason: null
    }]
  }],
  groups: [],
  gateways: [{
    id: "gateway-1",
    name: "GW-B1",
    serialNumber: "GW-001",
    firmwareVersion: "1.0.0",
    lastHeartbeatAt: "2026-08-31T00:00:00.000Z",
    connectionStatus: "online"
  }]
};

describe("ScheduleControlPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSchedules.mockResolvedValue(page([schedule()]));
    mocks.createSchedule.mockResolvedValue(schedule({ name: "새 스케줄" }));
    mocks.updateSchedule.mockImplementation(async (_siteId, _scheduleId, input) => ({
      ...schedule(),
      ...input
    }));
    mocks.deleteSchedule.mockResolvedValue({ id: schedule().id, deleted: true });
  });

  afterEach(cleanup);

  it("shows loading, error with retry, and empty list states", async () => {
    mocks.listSchedules.mockImplementationOnce(() => new Promise(() => undefined));
    const first = renderPanel("admin");
    expect(screen.getByRole("status")).toHaveTextContent("스케줄을 불러오는 중입니다.");
    first.unmount();

    mocks.listSchedules.mockRejectedValueOnce(new Error("network"));
    const second = renderPanel("admin");
    expect(await screen.findByRole("alert")).toHaveTextContent("스케줄 목록을 불러오지 못했습니다.");
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
    second.unmount();

    mocks.listSchedules.mockResolvedValueOnce(page([]));
    renderPanel("admin");
    expect(await screen.findByText("등록된 스케줄이 없습니다.")).toBeInTheDocument();
  });

  it("renders sync and recent execution states but no mutation commands for a viewer", async () => {
    mocks.listSchedules.mockResolvedValue(page([
      schedule({ name: "동기화 대기", syncStatus: "PENDING" }),
      schedule({ id: "00000000-0000-4000-8000-000000000012", name: "적용 완료", syncStatus: "APPLIED" }),
      schedule({
        id: "00000000-0000-4000-8000-000000000013",
        name: "적용 실패",
        syncStatus: "REJECTED",
        lastExecution: {
          id: "execution-1",
          eventId: "event-1",
          sequence: "1",
          revision: 3,
          occurrenceKey: "2026-09-01",
          kind: "action_result",
          occurredAt: "2026-08-31T10:00:00.000Z",
          payload: {}
        }
      })
    ]));

    renderPanel("viewer");

    expect(await screen.findByText("Gateway 동기화 중")).toBeInTheDocument();
    expect(screen.getByText("Gateway 적용됨")).toBeInTheDocument();
    expect(screen.getByText("Gateway 적용 실패")).toBeInTheDocument();
    expect(screen.getByText(/조명 적용 결과/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "스케줄 추가" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /수정/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /삭제/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /비활성화/ })).not.toBeInTheDocument();
  });

  it("creates and edits a complete schedule through the dialog", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");

    const addButton = screen.getByRole("button", { name: "스케줄 추가" });
    fireEvent.click(addButton);
    expect(screen.getByRole("dialog", { name: "스케줄 추가" })).toBeInTheDocument();
    expect(screen.getByLabelText("스케줄 이름")).toHaveFocus();

    fireEvent.change(screen.getByLabelText("스케줄 이름"), { target: { value: "새 스케줄" } });
    fireEvent.click(screen.getByLabelText("B1-L001 선택"));
    fireEvent.click(screen.getByRole("button", { name: "스케줄 만들기" }));

    await waitFor(() => expect(mocks.createSchedule).toHaveBeenCalledWith(siteId, expect.objectContaining({
      name: "새 스케줄",
      status: "enabled",
      localStartTime: "18:00",
      localEndTime: "23:00",
      recurrence: expect.objectContaining({ kind: "daily" }),
      action: { dimmingEnabled: true, brightnessPercent: 70 },
      target: { type: "fixture", fixtureId }
    })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스케줄 추가" })).not.toBeInTheDocument());
    expect(addButton).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "야간 운영 수정" }));
    fireEvent.change(screen.getByLabelText("스케줄 이름"), { target: { value: "야간 운영 수정" } });
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));

    await waitFor(() => expect(mocks.updateSchedule).toHaveBeenCalledWith(
      siteId,
      schedule().id,
      expect.objectContaining({ name: "야간 운영 수정", status: "enabled" })
    ));
  });

  it("toggles and deletes a schedule with confirmation", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");

    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    await waitFor(() => expect(mocks.updateSchedule).toHaveBeenCalledWith(siteId, schedule().id, {
      status: "disabled"
    }));

    const deleteButton = screen.getByRole("button", { name: "야간 운영 삭제" });
    fireEvent.click(deleteButton);
    expect(screen.getByRole("dialog", { name: "스케줄 삭제" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));

    await waitFor(() => expect(mocks.deleteSchedule).toHaveBeenCalledWith(siteId, schedule().id));
  });

  it("keeps a delete failure visible inside the confirmation dialog", async () => {
    mocks.deleteSchedule.mockRejectedValueOnce(new ApiError("network", 500, null));
    renderPanel("admin");
    await screen.findByText("야간 운영");

    fireEvent.click(screen.getByRole("button", { name: "야간 운영 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "스케줄 삭제" });
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "스케줄 변경을 완료하지 못했습니다. 연결 상태를 확인해 주세요."
    );
  });

  it.each([
    [{ code: "schedule_overlap" }, "같은 대상과 시간대에 겹치는 활성 스케줄이 있습니다."],
    [{ code: "single_gateway_required" }, "같은 Gateway에 연결된 조명만 선택해 주세요."]
  ])("shows a safe server conflict message", async (body, expected) => {
    mocks.updateSchedule.mockRejectedValueOnce(new ApiError("conflict", 409, body));
    renderPanel("admin");
    await screen.findByText("야간 운영");

    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
  });

  it("explains skipped monthly and leap-day occurrences in the form", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 추가" }));

    fireEvent.change(screen.getByLabelText("반복"), { target: { value: "monthly" } });
    expect(screen.getByText("29~31일이 없는 달에는 해당 실행을 건너뜁니다.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("반복"), { target: { value: "yearly" } });
    expect(screen.getByText("2월 29일은 윤년에만 실행하며, 날짜가 없는 해에는 건너뜁니다.")).toBeInTheDocument();
  });
});

function renderPanel(role: "admin" | "viewer") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ScheduleControlPanel
        siteId={siteId}
        role={role}
        dashboard={dashboard}
      />
    </QueryClientProvider>
  );
}

function page(items: ScheduleResponse[]): ScheduleListResponse {
  return { items, total: items.length, nextCursor: null };
}

function schedule(overrides: Partial<ScheduleResponse> = {}): ScheduleResponse {
  return {
    id: "00000000-0000-4000-8000-000000000011",
    name: "야간 운영",
    status: "enabled",
    activeFrom: "2026-09-01T03:00:00.000Z",
    activeUntil: "2026-09-30T03:00:00.000Z",
    localStartTime: "18:00",
    localEndTime: "23:00",
    recurrence: {
      kind: "daily",
      weeklyDays: [],
      monthlyDay: null,
      yearlyMonth: null,
      yearlyDay: null
    },
    action: { dimmingEnabled: true, brightnessPercent: 70 },
    fixtureIds: [fixtureId],
    gatewayId: "gateway-1",
    targets: [{ fixtureId }],
    targetCount: 1,
    desiredRevision: 3,
    appliedRevision: 2,
    syncStatus: "PENDING",
    nextOccurrence: {
      key: "2026-09-01",
      localDate: "2026-09-01",
      startsAt: "2026-09-01T09:00:00.000Z",
      endsAt: "2026-09-01T14:00:00.000Z"
    },
    lastExecution: null,
    createdById: "user-1",
    updatedById: "user-1",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides
  };
}
