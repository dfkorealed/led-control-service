import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { scheduleQueryKey, type ScheduleListResponse, type ScheduleResponse } from "../../../api/automation";
import { authMeQueryKey } from "../../../api/principal-cache";
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
const secondFixtureId = "00000000-0000-4000-8000-000000000005";
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
  summary: { totalFixtures: 2, onlineFixtures: 2, faultFixtures: 0, averageBrightness: 60 },
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
    }, {
      id: secondFixtureId,
      name: "B1-L002",
      x: 0,
      y: 0,
      ratedWatt: 40,
      brightness: 50,
      status: "online",
      statusReason: "reported",
      health: { faultCodes: [], observedAt: "2026-08-31T00:00:00.000Z" },
      rssi: -56,
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
    mocks.createSchedule.mockReset();
    mocks.deleteSchedule.mockReset();
    mocks.listSchedules.mockReset();
    mocks.updateSchedule.mockReset();
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

  it("renders sync and production action-result summaries but no mutation commands for a viewer", async () => {
    mocks.listSchedules.mockResolvedValue(page([
      schedule({
        name: "동기화 대기",
        syncStatus: "PENDING",
        lastExecution: actionResultExecution(schedule().id, ["succeeded", "succeeded"])
      }),
      schedule({
        id: "00000000-0000-4000-8000-000000000012",
        name: "적용 완료",
        syncStatus: "APPLIED",
        lastExecution: actionResultExecution("00000000-0000-4000-8000-000000000012", [
          "succeeded",
          "failed",
          "timed_out"
        ])
      }),
      schedule({
        id: "00000000-0000-4000-8000-000000000013",
        name: "적용 실패",
        syncStatus: "REJECTED",
        lastExecution: actionResultExecution("00000000-0000-4000-8000-000000000013", ["failed", "timed_out"])
      }),
      schedule({
        id: "00000000-0000-4000-8000-000000000014",
        name: "과거 payload",
        lastExecution: {
          ...actionResultExecution("00000000-0000-4000-8000-000000000014", ["succeeded"]),
          payload: { legacyResult: "ok" }
        }
      })
    ]));

    renderPanel("viewer");

    expect(await screen.findAllByText("Gateway 동기화 중")).not.toHaveLength(0);
    expect(screen.getByText("Gateway 적용됨")).toBeInTheDocument();
    expect(screen.getByText("Gateway 적용 실패")).toBeInTheDocument();
    expect(screen.getByText(/모두 성공 · 성공 2개/)).toBeInTheDocument();
    expect(screen.getByText(/일부 실패 · 성공 1개 · 실패 1개 · 시간 초과 1개/)).toBeInTheDocument();
    expect(screen.getByText(/실패 · 실패 1개 · 시간 초과 1개/)).toBeInTheDocument();
    expect(screen.getByText(/결과 상세를 확인할 수 없음/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "스케줄 추가" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /수정/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /삭제/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /비활성화/ })).not.toBeInTheDocument();
  });

  it("creates and edits a complete schedule through the dialog", async () => {
    const { queryClient } = renderPanel("admin");
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

    mocks.listSchedules.mockResolvedValue(page([schedule({
      name: "연간 야간 운영",
      status: "disabled",
      activeFrom: "2026-02-01T03:00:00.000Z",
      activeUntil: "2028-03-31T03:00:00.000Z",
      localStartTime: "23:30",
      localEndTime: "05:15",
      recurrence: {
        kind: "yearly",
        weeklyDays: [],
        monthlyDay: null,
        yearlyMonth: 2,
        yearlyDay: 29
      },
      action: { dimmingEnabled: true, brightnessPercent: 35 },
      fixtureIds: [fixtureId, secondFixtureId],
      targets: [{ fixtureId }, { fixtureId: secondFixtureId }],
      targetCount: 2
    })]));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: scheduleQueryKey(siteId) });
    });

    fireEvent.click(await screen.findByRole("button", { name: "연간 야간 운영 수정" }));
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));

    await waitFor(() => expect(mocks.updateSchedule).toHaveBeenCalledWith(
      siteId,
      schedule().id,
      {
        name: "연간 야간 운영",
        status: "disabled",
        activeFrom: "2026-02-01T03:00:00.000Z",
        activeUntil: "2028-03-31T03:00:00.000Z",
        localStartTime: "23:30",
        localEndTime: "05:15",
        recurrence: {
          kind: "yearly",
          weeklyDays: [],
          monthlyDay: null,
          yearlyMonth: 2,
          yearlyDay: 29
        },
        action: { dimmingEnabled: true, brightnessPercent: 35 },
        target: { type: "fixtures", fixtureIds: [fixtureId, secondFixtureId] }
      }
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

  it("retries a failed next page with the same cursor and appends it once", async () => {
    const nextSchedule = schedule({
      id: "00000000-0000-4000-8000-000000000012",
      name: "두 번째 페이지"
    });
    mocks.listSchedules
      .mockResolvedValueOnce({ items: [schedule()], total: 2, nextCursor: "cursor-2" })
      .mockRejectedValueOnce(new Error("next page failed"))
      .mockResolvedValueOnce({ items: [nextSchedule], total: 2, nextCursor: null });
    renderPanel("admin");
    await screen.findByText("야간 운영");

    fireEvent.click(screen.getByRole("button", { name: "스케줄 더 보기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("다음 스케줄을 불러오지 못했습니다.");
    expect(screen.getByText("야간 운영")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지 다시 시도" }));
    expect(await screen.findByText("두 번째 페이지")).toBeInTheDocument();
    expect(screen.getAllByText("두 번째 페이지")).toHaveLength(1);
    expect(mocks.listSchedules).toHaveBeenNthCalledWith(2, siteId, { limit: 100, cursor: "cursor-2" });
    expect(mocks.listSchedules).toHaveBeenNthCalledWith(3, siteId, { limit: 100, cursor: "cursor-2" });
  });

  it("keeps applied rows visible and warns when a background status refresh is stale", async () => {
    mocks.listSchedules.mockResolvedValueOnce(page([schedule({ syncStatus: "APPLIED" })]));
    const { queryClient } = renderPanel("admin");
    expect(await screen.findByText("Gateway 적용됨")).toBeInTheDocument();

    mocks.listSchedules.mockRejectedValueOnce(new Error("poll failed"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gateway 적용 상태를 새로고침하지 못했습니다. 표시된 상태가 최신이 아닐 수 있습니다."
    );
    expect(screen.getByText("Gateway 적용됨")).toBeInTheDocument();

    mocks.listSchedules.mockResolvedValueOnce(page([schedule({ syncStatus: "PENDING" })]));
    fireEvent.click(screen.getByRole("button", { name: "상태 다시 조회" }));
    expect(await screen.findByText("Gateway 동기화 중")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("expires the principal once when initial and repeated polling requests return 401", async () => {
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mocks.listSchedules.mockRejectedValueOnce(new ApiError("unauthorized", 401, null));
    renderPanel("admin", { queryClient });

    expect(await screen.findByRole("alert")).toHaveTextContent("로그인 세션이 만료되었습니다.");
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: authMeQueryKey }));
    expect(invalidate).toHaveBeenCalledTimes(1);

    mocks.listSchedules.mockResolvedValueOnce(page([schedule()]));
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await screen.findByText("야간 운영");
    mocks.listSchedules.mockRejectedValueOnce(new ApiError("unauthorized", 401, null));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("로그인 세션이 만료되었습니다.");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("expires the current principal for a 401 mutation", async () => {
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mocks.updateSchedule.mockRejectedValueOnce(new ApiError("unauthorized", 401, null));
    renderPanel("admin", { queryClient });
    await screen.findByText("야간 운영");

    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("로그인 세션이 만료되었습니다.");
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: authMeQueryKey }));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale 401 mutation after a site and user scope generation round trip", async () => {
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const pending = deferred<ScheduleResponse>();
    mocks.updateSchedule.mockReturnValueOnce(pending.promise);
    const rendered = renderPanel("admin", { queryClient, scopeKey: `user-1:${siteId}` });
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));

    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    rendered.rerender(panelElement("admin", queryClient, nextSiteId, `user-2:${nextSiteId}`));
    rendered.rerender(panelElement("admin", queryClient, siteId, `user-1:${siteId}`));
    await act(async () => {
      pending.reject(new ApiError("unauthorized", 401, null));
      await pending.promise.catch(() => undefined);
    });

    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.queryByText("로그인 세션이 만료되었습니다.")).not.toBeInTheDocument();
  });

  it("keeps schedule dialog Escape, focus wrap, and focus return behavior", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");
    const addButton = screen.getByRole("button", { name: "스케줄 추가" });
    fireEvent.click(addButton);
    const dialog = screen.getByRole("dialog", { name: "스케줄 추가" });
    const closeButton = within(dialog).getByRole("button", { name: "스케줄 추가 닫기" });
    const submitButton = within(dialog).getByRole("button", { name: "스케줄 만들기" });

    submitButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();
    closeButton.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(submitButton).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스케줄 추가" })).not.toBeInTheDocument());
    expect(addButton).toHaveFocus();
  });
});

function testQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
}

function renderPanel(role: "admin" | "viewer", options: {
  queryClient?: QueryClient;
  siteId?: string;
  scopeKey?: string;
} = {}) {
  const queryClient = options.queryClient ?? testQueryClient();
  return {
    ...render(panelElement(role, queryClient, options.siteId ?? siteId, options.scopeKey)),
    queryClient
  };
}

function panelElement(
  role: "admin" | "viewer",
  queryClient: QueryClient,
  panelSiteId = siteId,
  scopeKey = panelSiteId
) {
  return (
    <QueryClientProvider client={queryClient}>
      <ScheduleControlPanel
        siteId={panelSiteId}
        role={role}
        dashboard={dashboard}
        scopeKey={scopeKey}
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

function actionResultExecution(
  sourceId: string,
  statuses: Array<"succeeded" | "failed" | "timed_out">
): NonNullable<ScheduleResponse["lastExecution"]> {
  const resultFixtureIds = [
    fixtureId,
    secondFixtureId,
    "00000000-0000-4000-8000-000000000006"
  ];
  return {
    id: "00000000-0000-4000-8000-000000000021",
    eventId: "00000000-0000-4000-8000-000000000022",
    sequence: "1",
    revision: 3,
    occurrenceKey: "2026-09-01",
    kind: "action_result",
    occurredAt: "2026-08-31T10:00:00.000Z",
    payload: {
      sourceType: "schedule",
      sourceId,
      results: statuses.map((status, index) => ({
        fixtureId: resultFixtureIds[index],
        status,
        brightnessPercent: status === "succeeded" ? 70 : null,
        faultCode: null,
        errorCode: status === "failed" ? "mesh_rejected" : status === "timed_out" ? "timeout" : null,
        occurredAt: "2026-08-31T10:00:00.000Z"
      }))
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
