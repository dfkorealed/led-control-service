import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import type { AuthUser } from "../../../api/auth";
import { scheduleQueryKey, type ScheduleListResponse, type ScheduleResponse } from "../../../api/automation";
import { authMeQueryKey } from "../../../api/principal-cache";
import type { Dashboard } from "../../../api/queries";
import { SessionStatusCenter, SessionStatusProvider, ToastRegion } from "../../../components/ui";
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
  generatedAt: "2026-09-12T00:00:00.000Z",
  monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
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

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("atlas schedule surface shows the existing server total but labels gateway counts as loaded rows only", async () => {
    mocks.listSchedules.mockResolvedValue({ items: [schedule()], total: 27, nextCursor: "next-page" });
    renderPanel("admin");
    const overview = await screen.findByRole("group", { name: "스케줄 요약" });
    expect(overview).toHaveTextContent("Asia/Seoul");
    expect(overview).toHaveTextContent("현장 전체 규칙 27건");
    expect(overview).toHaveTextContent("불러온 1건 기준");
    expect(overview).toHaveTextContent("확인 필요 1건");
    const list = screen.getByRole("region", { name: "자동화 목록" });
    expect(list).toContainElement(screen.getByRole("table", { name: "스케줄 목록" }));
    expect(list.querySelector("[data-automation-list-scroll]")).toBeInTheDocument();
  });

  it("uses global schedule totals and navigates opaque cursor pages without appending rows", async () => {
    const first = schedule({ name: "첫 스케줄" });
    const second = schedule({ id: "00000000-0000-4000-8000-000000000012", name: "다음 스케줄" });
    const summary = { ruleCount: 120, syncRuleCounts: { APPLIED: 20, PENDING: 90, REJECTED: 10 } };
    mocks.listSchedules.mockImplementation(async (_siteId, query) => query.cursor
      ? { items: [second], total: 120, filteredTotal: 35, siteSummary: summary, nextCursor: null }
      : { items: [first], total: 120, filteredTotal: 35, siteSummary: summary, nextCursor: "opaque-v2" });
    renderPanel("admin");

    const overview = await screen.findByRole("group", { name: "스케줄 요약" });
    expect(overview).toHaveTextContent("현장 전체 규칙 120건");
    expect(overview).toHaveTextContent("적용 완료 20건 · 적용 대기 90건 · 적용 실패 10건");
    expect(screen.getByRole("status")).toHaveTextContent("조건에 맞는 규칙 35건");
    expect(screen.getByText("첫 스케줄")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    expect(await screen.findByText("다음 스케줄")).toBeInTheDocument();
    expect(screen.queryByText("첫 스케줄")).not.toBeInTheDocument();
    expect(mocks.listSchedules).toHaveBeenLastCalledWith(siteId, { limit: 10, cursor: "opaque-v2" });
    fireEvent.click(screen.getByRole("button", { name: "이전" }));
    expect(screen.getByText("첫 스케줄")).toBeInTheDocument();
    expect(screen.queryByText("다음 스케줄")).not.toBeInTheDocument();
  });

  it("resets schedule cursor when a literal server search changes", async () => {
    const summary = { ruleCount: 120, syncRuleCounts: { APPLIED: 20, PENDING: 90, REJECTED: 10 } };
    mocks.listSchedules.mockImplementation(async (_siteId, query) => query.query
      ? { items: [], total: 120, filteredTotal: 0, siteSummary: summary, nextCursor: null }
      : { items: [schedule()], total: 120, filteredTotal: 120, siteSummary: summary, nextCursor: "opaque-v1" });
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.change(screen.getByRole("searchbox", { name: "스케줄 검색" }), { target: { value: "입구_%" } });

    await waitFor(() => expect(mocks.listSchedules).toHaveBeenLastCalledWith(siteId, { limit: 10, query: "입구_%" }));
    expect(within(screen.getByRole("region", { name: "스케줄 목록 조건" })).getByRole("status")).toHaveTextContent("조건에 맞는 규칙 0건");
    expect(screen.getByText("조건에 맞는 스케줄이 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();
  });

  it("recovers an invalid schedule cursor by reloading the first page", async () => {
    const summary = { ruleCount: 2, syncRuleCounts: { APPLIED: 0, PENDING: 2, REJECTED: 0 } };
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 2, filteredTotal: 2, siteSummary: summary, nextCursor: "stale-cursor" })
      .mockRejectedValueOnce(new ApiError("invalid cursor", 400, null))
      .mockResolvedValueOnce({ items: [schedule()], total: 2, filteredTotal: 2, siteSummary: summary, nextCursor: null });
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(mocks.listSchedules).toHaveBeenCalledTimes(3));
    expect(mocks.listSchedules).toHaveBeenNthCalledWith(3, siteId, { limit: 10 });
    expect(screen.getByText("야간 운영")).toBeInTheDocument();
  });

  it("polls only the visible schedule page after visiting multiple cursor pages", async () => {
    const summary = { ruleCount: 30, syncRuleCounts: { APPLIED: 0, PENDING: 30, REJECTED: 0 } };
    const cursors = ["", "page-2", "page-3"];
    let thirdPageCalls = 0;
    mocks.listSchedules.mockImplementation(async (_siteId, query) => {
      const index = cursors.indexOf(query.cursor ?? "");
      if (index === 2) thirdPageCalls += 1;
      const updated = index === 2 && thirdPageCalls > 1;
      return {
        items: [schedule({ id: `00000000-0000-4000-8000-0000000000${11 + index}`, name: `스케줄 ${index + 1}` })],
        total: updated ? 31 : 30, filteredTotal: updated ? 31 : 30,
        siteSummary: updated ? { ruleCount: 31, syncRuleCounts: { APPLIED: 1, PENDING: 30, REJECTED: 0 } } : summary,
        nextCursor: cursors[index + 1] ?? null
      };
    });
    renderPanel("admin");
    await screen.findByText("스케줄 1");
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByText("스케줄 2");
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByText("스케줄 3");
    expect(mocks.listSchedules).toHaveBeenCalledTimes(3);

    await new Promise((resolve) => setTimeout(resolve, 3250));
    expect(mocks.listSchedules).toHaveBeenCalledTimes(4);
    expect(mocks.listSchedules).toHaveBeenLastCalledWith(siteId, { limit: 10, cursor: "page-3" });
    expect(screen.getByRole("group", { name: "스케줄 요약" })).toHaveTextContent("현장 전체 규칙 31건");
    expect(within(screen.getByRole("region", { name: "스케줄 목록 조건" })).getByRole("status")).toHaveTextContent("조건에 맞는 규칙 31건");
  });

  it("bounds polling for a legacy list response after multiple pages", async () => {
    const cursors = ["", "page-2", "page-3"];
    mocks.listSchedules.mockImplementation(async (_siteId, query) => {
      const index = cursors.indexOf(query.cursor ?? "");
      return { items: [schedule({ id: `00000000-0000-4000-8000-0000000000${11 + index}`, name: `구형 스케줄 ${index + 1}` })],
        total: 30, nextCursor: cursors[index + 1] ?? null };
    });
    renderPanel("admin");
    await screen.findByText("구형 스케줄 1");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 더 보기" }));
    await screen.findByText("구형 스케줄 2");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 더 보기" }));
    await screen.findByText("구형 스케줄 3");
    expect(mocks.listSchedules).toHaveBeenCalledTimes(3);

    await new Promise((resolve) => setTimeout(resolve, 3250));
    expect(mocks.listSchedules).toHaveBeenCalledTimes(4);
    expect(mocks.listSchedules).toHaveBeenLastCalledWith(siteId, { limit: 10, cursor: "page-3" });
  });

  it("blocks schedule actions when visible-page polling returns 401 after a next-page failure", async () => {
    const summary = { ruleCount: 3, syncRuleCounts: { APPLIED: 0, PENDING: 3, REJECTED: 0 } };
    const pageResult = (name: string, nextCursor: string | null) => ({ items: [schedule({ name })], total: 3, filteredTotal: 3, siteSummary: summary, nextCursor });
    mocks.listSchedules.mockResolvedValueOnce(pageResult("첫 스케줄", "page-2"))
      .mockResolvedValueOnce(pageResult("둘째 스케줄", "page-3"))
      .mockRejectedValueOnce(new Error("page-3 failed"))
      .mockRejectedValueOnce(new ApiError("expired", 401, null));
    renderPanel("admin");
    await screen.findByText("첫 스케줄");
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByText("둘째 스케줄");
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    await waitFor(() => expect(mocks.listSchedules).toHaveBeenCalledTimes(4), { timeout: 4500 });
    expect(await screen.findByText("로그인 세션이 만료되었습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "둘째 스케줄 수정" })).not.toBeInTheDocument();
  });

  it("keeps schedule filters editable when a filtered request fails", async () => {
    const summary = { ruleCount: 1, syncRuleCounts: { APPLIED: 0, PENDING: 1, REJECTED: 0 } };
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 1, filteredTotal: 1, siteSummary: summary, nextCursor: null })
      .mockRejectedValueOnce(new Error("network failed"));
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.change(screen.getByRole("searchbox", { name: "스케줄 검색" }), { target: { value: "없는 규칙" } });
    await waitFor(() => expect(mocks.listSchedules).toHaveBeenCalledWith(siteId, { limit: 10, query: "없는 규칙" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("searchbox", { name: "스케줄 검색" })).toHaveValue("없는 규칙");
  });

  it("shows every schedule operation field and working management actions in the compact card", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    mocks.listSchedules.mockResolvedValue(page([schedule({
      lastExecution: actionResultExecution(schedule().id, ["succeeded"])
    })]));
    renderPanel("admin");

    const list = await screen.findByRole("list", { name: "스케줄 카드 목록" });
    const card = within(list).getByRole("listitem");
    expect(screen.queryByRole("table", { name: "스케줄 목록" })).not.toBeInTheDocument();
    for (const label of ["야간 운영", "활성", "적용 기간", "다음 실행", "반복 · 시간", "밝기", "대상", "Gateway 동기화", "최근 결과"]) {
      expect(card).toHaveTextContent(label);
    }
    expect(card).toHaveTextContent("매일 · 18:00~23:00");
    expect(card).toHaveTextContent("70%");
    expect(card).toHaveTextContent("1개");
    expect(card).toHaveTextContent("적용 대기");
    expect(card).toHaveTextContent("모두 성공 · 성공 1개");
    expect(within(card).getByText(/2026.*09.*01/)).toBeInTheDocument();
    expect(within(card).getByText(/2026.*09.*30/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "야간 운영 비활성화" }));
    await waitFor(() => expect(mocks.updateSchedule).toHaveBeenCalledWith(siteId, schedule().id, { status: "disabled" }));
    fireEvent.click(within(card).getByRole("button", { name: "야간 운영 수정" }));
    expect(screen.getByRole("dialog", { name: "스케줄 수정" })).toBeInTheDocument();
  });

  it("keeps compact schedule cards read-only for viewers", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    renderPanel("viewer");
    const card = within(await screen.findByRole("list", { name: "스케줄 카드 목록" })).getByRole("listitem");
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
  });

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

  it("keeps one reachable add action for an empty schedule list", async () => {
    mocks.listSchedules.mockResolvedValue(page([]));
    renderPanel("admin");

    await screen.findByText("등록된 스케줄이 없습니다.");
    expect(screen.getAllByRole("button", { name: "스케줄 추가" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "스케줄 추가" }));
    expect(screen.getByRole("dialog", { name: "스케줄 추가" })).toBeInTheDocument();
  });

  it("opens schedule creation from the level-three panel heading", async () => {
    renderPanel("admin");

    expect(await screen.findByRole("heading", { name: "스케줄 제어", level: 3 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "스케줄 추가" }));
    expect(screen.getByRole("dialog", { name: "스케줄 추가" })).toBeInTheDocument();
  });

  it("closes schedule creation with its cancel action", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 추가" }));
    const dialog = screen.getByRole("dialog", { name: "스케줄 추가" });

    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog", { name: "스케줄 추가" })).not.toBeInTheDocument();
  });

  it("uses segmented date/time fields while keeping validation numbers as strings", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 추가" }));
    const dialog = screen.getByRole("dialog", { name: "스케줄 추가" });

    expect(within(dialog).getByRole("group", { name: "시작 시각" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "세부 일정 설정" }));
    expect(within(dialog).getByRole("group", { name: "적용 시작일" })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "밝기" })).toHaveAttribute("inputmode", "numeric");
  });

  it("offers a compact quick flow and renders the spatial selector only in its target view", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 추가" }));
    const dialog = screen.getByRole("dialog", { name: "스케줄 추가" });

    expect(within(dialog).getByRole("group", { name: "언제 켤까요?" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "매일" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).queryByLabelText("스케줄 이름")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: "공간 대상 선택" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "평일" }));
    expect(within(dialog).getByRole("status")).toHaveTextContent("평일 18:00–23:00");

    fireEvent.click(within(dialog).getByRole("button", { name: "제어 대상 선택" }));
    expect(within(dialog).getByRole("region", { name: "공간 대상 선택" })).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "조명 목록 열기" }));
    fireEvent.click(screen.getByLabelText("B1-L001 선택"));
    fireEvent.click(screen.getByRole("button", { name: "선택 완료" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "1개 조명 선택 완료" }));

    expect(within(dialog).getByRole("group", { name: "제어 대상" })).toHaveTextContent("B1-L001");
    expect(within(dialog).getByRole("status")).toHaveTextContent("B1-L001");
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

    expect((await screen.findAllByText("적용 대기"))[0].closest("[data-tone]")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("적용됨").closest("[data-tone]")).toHaveAttribute("data-tone", "success");
    expect(screen.getAllByText("적용 실패").find((element) => element.closest("[data-tone]"))?.closest("[data-tone]"))
      .toHaveAttribute("data-tone", "danger");
    expect(screen.getByText(/모두 성공 · 성공 2개/)).toBeInTheDocument();
    expect(screen.getByText(/일부 실패 · 성공 1개 · 실패 1개 · 시간 초과 1개/)).toBeInTheDocument();
    expect(screen.getByText(/실패 · 실패 1개 · 시간 초과 1개/)).toBeInTheDocument();
    expect(screen.getByText(/결과 상세를 확인할 수 없음/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "스케줄 추가" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /수정/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /삭제/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /비활성화/ })).not.toBeInTheDocument();
  });

  it("스케줄 목록은 적용 상태를 공통 badge로 구분한다", async () => {
    mocks.listSchedules.mockResolvedValue(page([
      schedule({ name: "대기 스케줄", syncStatus: "PENDING" }),
      schedule({ id: "00000000-0000-4000-8000-000000000012", name: "적용 스케줄", syncStatus: "APPLIED" }),
      schedule({ id: "00000000-0000-4000-8000-000000000013", name: "실패 스케줄", syncStatus: "REJECTED" })
    ]));
    renderPanel("viewer");

    const table = await screen.findByRole("table", { name: "스케줄 목록" });
    expect(table.closest("[data-automation-table-wrap]")).not.toBeNull();
    expect(screen.getByText("적용됨").closest("[data-tone]")).toHaveAttribute("data-tone", "success");
    expect(screen.getByText("적용 대기").closest("[data-tone]")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("적용 실패").closest("[data-tone]")).toHaveAttribute("data-tone", "danger");
  });

  it("스케줄 dialog는 빠른 설정을 먼저 보여주고 세부 입력은 요청할 때 펼친다", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 추가" }));
    const dialog = screen.getByRole("dialog", { name: "스케줄 추가" });

    expect(within(dialog).getByRole("group", { name: "언제 켤까요?" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "밝기" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "제어 대상" })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("스케줄 이름")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "세부 일정 설정" }));
    expect(within(dialog).getByRole("region", { name: "세부 일정 설정" })).toBeVisible();
    expect(within(dialog).getByLabelText("스케줄 이름")).toHaveValue("조명 스케줄");
  });

  it.each([
    {
      description: "매주 요일",
      configure: (dialog: HTMLElement) => selectOption(dialog, "반복", "매주"),
      controlLabel: "월",
      segmented: false
    },
    {
      description: "매월 날짜",
      configure: (dialog: HTMLElement) => {
        selectOption(dialog, "반복", "매월");
        fireEvent.change(within(dialog).getByLabelText("매월 날짜"), { target: { value: "" } });
      },
      controlLabel: "매월 날짜",
      segmented: false
    },
    {
      description: "매년 월",
      configure: (dialog: HTMLElement) => {
        selectOption(dialog, "반복", "매년");
        fireEvent.change(within(dialog).getByLabelText("매년 월"), { target: { value: "" } });
      },
      controlLabel: "매년 월",
      segmented: false
    },
    {
      description: "매년 날짜",
      configure: (dialog: HTMLElement) => {
        selectOption(dialog, "반복", "매년");
        fireEvent.change(within(dialog).getByLabelText("매년 날짜"), { target: { value: "" } });
      },
      controlLabel: "매년 날짜",
      segmented: false
    },
    {
      description: "밝기",
      configure: (dialog: HTMLElement) => fireEvent.change(within(dialog).getByLabelText("밝기"), { target: { value: "101" } }),
      controlLabel: "밝기",
      segmented: false
    }
  ])("이름 뒤의 $description 검증 오류를 첫 invalid control에 연결하고 focus한다", async ({ configure, controlLabel, segmented }) => {
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 추가" }));
    const dialog = screen.getByRole("dialog", { name: "스케줄 추가" });

    openScheduleAdvanced(dialog);
    fireEvent.change(within(dialog).getByLabelText("스케줄 이름"), { target: { value: "유효한 이름" } });
    selectScheduleFixture(dialog, "B1-L001 선택");
    configure(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "스케줄 만들기" }));

    const field = segmented ? within(dialog).getByRole("group", { name: controlLabel }) : null;
    const control = segmented ? within(field!).getAllByRole("spinbutton")[0] : within(dialog).getByLabelText(controlLabel);
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(control).toHaveAccessibleDescription(expect.any(String));
  });

  it("디밍 ON 밝기 오류는 visible numeric input만 error ARIA를 갖는다", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 추가" }));
    const dialog = screen.getByRole("dialog", { name: "스케줄 추가" });

    openScheduleAdvanced(dialog);
    fireEvent.change(within(dialog).getByLabelText("스케줄 이름"), { target: { value: "유효한 이름" } });
    selectScheduleFixture(dialog, "B1-L001 선택");
    fireEvent.change(within(dialog).getByLabelText("밝기"), { target: { value: "101" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "스케줄 만들기" }));

    const brightnessInput = within(dialog).getByLabelText("밝기");
    expect(brightnessInput).toHaveFocus();
    expect(brightnessInput).toHaveAttribute("aria-invalid", "true");
    expect(brightnessInput).toHaveAccessibleDescription("밝기는 0~100 사이의 정수여야 합니다.");
    expect(within(dialog).getByLabelText("디밍 사용")).not.toHaveAttribute("aria-invalid");
    expect(within(dialog).getByLabelText("디밍 사용")).not.toHaveAttribute("aria-errormessage");
  });

  it("숨겨진 밝기 input의 오류는 디밍 toggle fallback에 연결하고 focus한다", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 추가" }));
    const dialog = screen.getByRole("dialog", { name: "스케줄 추가" });

    openScheduleAdvanced(dialog);
    fireEvent.change(within(dialog).getByLabelText("스케줄 이름"), { target: { value: "유효한 이름" } });
    selectScheduleFixture(dialog, "B1-L001 선택");
    fireEvent.change(within(dialog).getByLabelText("밝기"), { target: { value: "101" } });
    fireEvent.click(within(dialog).getByLabelText("디밍 사용"));
    expect(within(dialog).getByLabelText("밝기")).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "스케줄 만들기" }));

    const dimmingToggle = within(dialog).getByLabelText("디밍 사용");
    expect(screen.getByText("밝기는 0~100 사이의 정수여야 합니다.")).toBeVisible();
    expect(dimmingToggle).toHaveFocus();
    expect(dimmingToggle).toHaveAttribute("aria-invalid", "true");
    expect(dimmingToggle).toHaveAttribute("aria-errormessage", "schedule-brightness-error");
    expect(dimmingToggle).toHaveAttribute("aria-describedby", "schedule-brightness-error");
  });

  it("target-only 검증 오류는 제어 대상 fieldset에 연결하고 focus한다", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 추가" }));
    const dialog = screen.getByRole("dialog", { name: "스케줄 추가" });

    fireEvent.click(within(dialog).getByRole("button", { name: "스케줄 만들기" }));

    const targetSection = within(dialog).getByRole("group", { name: "제어 대상 선택" });
    expect(targetSection).toHaveFocus();
    expect(targetSection).toHaveAttribute("aria-invalid", "true");
    expect(targetSection).toHaveAttribute("aria-errormessage", "schedule-target-error");
    expect(document.getElementById("schedule-target-error")).toBeInTheDocument();
  });

  it("creates and edits a complete schedule through the dialog", async () => {
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");

    const addButton = screen.getByRole("button", { name: "스케줄 추가" });
    fireEvent.click(addButton);
    const createDialog = screen.getByRole("dialog", { name: "스케줄 추가" });
    await waitFor(() => expect(within(within(createDialog).getByRole("group", { name: "시작 시각" })).getAllByRole("spinbutton")[0]).toHaveFocus());

    openScheduleAdvanced(createDialog);
    fireEvent.change(within(createDialog).getByLabelText("스케줄 이름"), { target: { value: "새 스케줄" } });
    selectScheduleFixture(createDialog, "B1-L001 선택");
    fireEvent.click(within(createDialog).getByRole("button", { name: "스케줄 만들기" }));

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

  it("shows unresolved schedule fixture ids and rejects the stale edit payload", async () => {
    const removedFixtureId = "00000000-0000-4000-8000-000000000099";
    mocks.listSchedules.mockResolvedValue(page([schedule({
      fixtureIds: [fixtureId, removedFixtureId],
      targets: [{ fixtureId }, { fixtureId: removedFixtureId }],
      targetCount: 2
    })]));
    renderPanel("admin");
    await screen.findByText("야간 운영");

    fireEvent.click(screen.getByRole("button", { name: "야간 운영 수정" }));
    const dialog = screen.getByRole("dialog", { name: "스케줄 수정" });
    expect(within(dialog).getByRole("group", { name: "제어 대상" })).toHaveTextContent("1개 확인 필요");
    fireEvent.click(within(dialog).getByRole("button", { name: "변경 저장" }));

    expect(within(dialog).getByText("현재 현장에서 확인되지 않는 조명이 포함되어 있습니다. 대상을 다시 선택해 주세요.")).toBeVisible();
    expect(within(dialog).getByRole("group", { name: "제어 대상 선택" })).toHaveFocus();
    expect(mocks.updateSchedule).not.toHaveBeenCalled();
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

    fireEvent.click(screen.getByRole("button", { name: "세부 일정 설정" }));
    selectOption(screen.getByRole("dialog", { name: "스케줄 추가" }), "반복", "매월");
    expect(screen.getByText("29~31일이 없는 달에는 해당 실행을 건너뜁니다.")).toBeInTheDocument();

    selectOption(screen.getByRole("dialog", { name: "스케줄 추가" }), "반복", "매년");
    expect(screen.getByText("2월 29일은 윤년에만 실행하며 날짜가 없는 해에는 건너뜁니다.")).toBeInTheDocument();
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
    expect(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    expect(screen.getByText("야간 운영")).toBeInTheDocument();
    expect(within(screen.getByRole("tabpanel")).queryByText("다음 스케줄을 불러오지 못했습니다.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 1건" }));
    expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).toHaveTextContent("다음 스케줄을 불러오지 못했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지 다시 시도" }));
    expect(await screen.findByText("두 번째 페이지")).toBeInTheDocument();
    expect(screen.getAllByText("두 번째 페이지")).toHaveLength(1);
    expect(mocks.listSchedules).toHaveBeenNthCalledWith(2, siteId, { limit: 10, cursor: "cursor-2" });
    expect(mocks.listSchedules).toHaveBeenNthCalledWith(3, siteId, { limit: 10, cursor: "cursor-2" });
  });

  it("keeps a missing next page in status after the loaded page polls successfully", async () => {
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 2, nextCursor: "cursor-2" }).mockRejectedValueOnce(new Error("next page failed"));
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 더 보기" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 2, nextCursor: "cursor-2" });
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    expect(screen.getByText("야간 운영")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 1건" }));
    mocks.listSchedules.mockResolvedValueOnce(page([schedule({ id: "next-1", name: "누락된 페이지" })]));
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지 다시 시도" }));
    expect(await screen.findByText("누락된 페이지")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).toHaveTextContent("현재 확인할 상태가 없습니다."));
  });

  it("resolves a failed next-page action when refresh removes its cursor", async () => {
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 2, nextCursor: "cursor-2" }).mockRejectedValueOnce(new Error("next page failed"));
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 더 보기" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    mocks.listSchedules.mockResolvedValueOnce(page([schedule()]));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "스케줄 더 보기" })).not.toBeInTheDocument();
  });

  it("keeps next-page and refresh failures as separate recoverable statuses", async () => {
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 2, nextCursor: "cursor-2" }).mockRejectedValueOnce(new Error("next page failed"));
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "스케줄 더 보기" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(within(screen.getByRole("region", { name: "알림" })).getByRole("button", { name: "알림 닫기" }));
    mocks.listSchedules.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 2건" })).toBeInTheDocument();
    const alerts = within(screen.getByRole("region", { name: "알림" })).getAllByRole("status");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Gateway 적용 상태를 새로고침하지 못했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 2건" }));
    const center = screen.getByRole("dialog", { name: "현재 세션 상태" });
    expect(within(center).getByRole("button", { name: "다음 페이지 다시 시도" })).toBeInTheDocument();
    expect(within(center).getByRole("button", { name: "상태 다시 조회" })).toBeInTheDocument();
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule({ id: "next-1", name: "두 번째 페이지" })], total: 2, nextCursor: null });
    fireEvent.click(within(center).getByRole("button", { name: "다음 페이지 다시 시도" }));
    expect(await screen.findByText("두 번째 페이지")).toBeInTheDocument();
    await waitFor(() => expect(within(center).queryByRole("button", { name: "다음 페이지 다시 시도" })).not.toBeInTheDocument());
    expect(within(center).getByRole("button", { name: "상태 다시 조회" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "알림", hidden: true })).getAllByRole("status", { hidden: true })).toHaveLength(1);
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 2, nextCursor: "cursor-2" }).mockResolvedValueOnce({ items: [schedule({ id: "next-1", name: "두 번째 페이지" })], total: 2, nextCursor: null });
    fireEvent.click(within(center).getByRole("button", { name: "상태 다시 조회" }));
    await waitFor(() => expect(center).toHaveTextContent("현재 확인할 상태가 없습니다."));
  });

  it("keeps applied rows visible and warns when a background status refresh is stale", async () => {
    mocks.listSchedules.mockResolvedValueOnce(page([schedule({ syncStatus: "APPLIED" })]));
    const { queryClient } = renderPanel("admin");
    expect(await screen.findByText("적용됨")).toBeInTheDocument();

    mocks.listSchedules.mockRejectedValueOnce(new Error("poll failed"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) });
    });

    expect(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    expect(screen.getByText("적용됨")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 1건" }));
    expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).toHaveTextContent("Gateway 적용 상태를 새로고침하지 못했습니다.");
    mocks.listSchedules.mockResolvedValueOnce(page([schedule({ syncStatus: "PENDING" })]));
    fireEvent.click(screen.getByRole("button", { name: "상태 다시 조회" }));
    expect(await screen.findByText("적용 대기")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).toHaveTextContent("현재 확인할 상태가 없습니다."));
  });

  it("shows last successful refresh in the selected site's time zone", async () => {
    vi.stubEnv("TZ", "UTC");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-23T23:00:00Z"));
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");
    mocks.listSchedules.mockRejectedValueOnce(new Error("poll failed"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" }));
    expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).toHaveTextContent("마지막 성공: 26. 9. 24. 오전 8:00");
  });

  it("keeps the last whole-list success time until a real refresh succeeds", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-23T23:00:00Z"));
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 2, nextCursor: "cursor-2" });
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");
    const loadMore = screen.getByRole("button", { name: "스케줄 더 보기" });
    mocks.listSchedules.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" }));
    const center = screen.getByRole("dialog", { name: "현재 세션 상태" });
    expect(center).toHaveTextContent("마지막 성공: 26. 9. 24. 오전 8:00");

    clock.mockReturnValue(Date.parse("2026-09-24T01:00:00Z"));
    mocks.listSchedules.mockResolvedValueOnce(page([schedule({ id: "next-1", name: "두 번째 페이지" })]));
    fireEvent.click(loadMore);
    await screen.findByText("두 번째 페이지");
    expect(center).toHaveTextContent("마지막 성공: 26. 9. 24. 오전 8:00");
    await act(async () => {
      queryClient.setQueryData(scheduleQueryKey(siteId), queryClient.getQueryData(scheduleQueryKey(siteId)), { updatedAt: Date.parse("2026-09-24T02:00:00Z") });
    });
    expect(center).toHaveTextContent("마지막 성공: 26. 9. 24. 오전 8:00");

    clock.mockReturnValue(Date.parse("2026-09-24T03:00:00Z"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
    await waitFor(() => expect(center).toHaveTextContent("현재 확인할 상태가 없습니다."));
    mocks.listSchedules.mockRejectedValueOnce(new Error("refresh failed again"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
    await waitFor(() => expect(center).toHaveTextContent("마지막 성공: 26. 9. 24. 오후 12:00"));
  });

  it.each(["user scope", "401"])("forgets the last whole-list success time after %s ends its scope", async (boundary) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-23T23:00:00Z"));
    const rendered = renderPanel("admin");
    await screen.findByText("야간 운영");
    if (boundary === "user scope") {
      clock.mockReturnValue(Date.parse("2026-09-24T03:00:00Z"));
      rendered.rerender(panelElement("admin", rendered.queryClient, siteId, "another-user"));
      await waitFor(() => expect(mocks.listSchedules).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(rendered.queryClient.isFetching({ queryKey: scheduleQueryKey(siteId) })).toBe(0));
    } else {
      mocks.listSchedules.mockRejectedValueOnce(new ApiError("expired", 401, null));
      await act(async () => { await rendered.queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
      await screen.findByText("로그인 세션이 만료되었습니다.");
    }
    mocks.listSchedules.mockRejectedValueOnce(new Error("refresh failed"));
    const activeQueryKey = rendered.queryClient.getQueryCache().findAll({ queryKey: scheduleQueryKey(siteId) }).find((query) => query.getObserversCount() > 0)?.queryKey;
    await act(async () => { await rendered.queryClient.refetchQueries({ queryKey: activeQueryKey, exact: true }); });
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" }));
    const center = screen.getByRole("dialog", { name: "현재 세션 상태" });
    if (boundary === "user scope") {
      expect(center).toHaveTextContent("마지막 성공: 26. 9. 24. 오후 12:00");
      expect(center).not.toHaveTextContent("마지막 성공: 26. 9. 24. 오전 8:00");
    } else {
      expect(center).not.toHaveTextContent("마지막 성공:");
    }
  });

  it("keeps one status and toast for repeated stale polling, then resolves both after success", async () => {
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");
    mocks.listSchedules.mockRejectedValue(new Error("poll failed"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
    expect(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "알림" })).getAllByRole("status")).toHaveLength(1);
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
    expect(within(screen.getByRole("region", { name: "알림" })).getAllByRole("status")).toHaveLength(1);
    mocks.listSchedules.mockResolvedValue(page([schedule()]));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "알림" })).queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows a neutral viewer badge without a full-width readonly notice", async () => {
    renderPanel("viewer");
    await screen.findByText("야간 운영");
    expect(screen.getByText("조회 전용").closest("[data-tone]")).toHaveAttribute("data-tone", "neutral");
    expect(screen.queryByText(/조회 전용 계정입니다/)).not.toBeInTheDocument();
  });

  it("keeps a toggle failure discoverable outside dialogs and confirms a later success by toast", async () => {
    mocks.updateSchedule.mockRejectedValueOnce(new Error("toggle failed"));
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    expect(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    expect(within(screen.getByRole("tabpanel")).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "알림" })).getByText("스케줄을 비활성화했습니다.")).toBeInTheDocument();
  });

  it("retains a toggle failure during retry and does not reannounce the same failure", async () => {
    const retry = deferred<ScheduleResponse>();
    mocks.updateSchedule.mockRejectedValueOnce(new Error("toggle failed")).mockReturnValueOnce(retry.promise);
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(within(screen.getByRole("region", { name: "알림" })).getByRole("button", { name: "알림 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    await act(async () => { retry.reject(new Error("toggle failed")); await retry.promise.catch(() => undefined); });
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "알림" })).queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["add", "edit"])("retains a rule's toggle failure while an unrelated %s dialog opens", async (operation) => {
    mocks.listSchedules.mockResolvedValue(page([schedule(), schedule({ id: "rule-b", name: "주간 운영" })]));
    mocks.updateSchedule.mockRejectedValueOnce(new Error("toggle failed"));
    renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "야간 운영 비활성화" }));
    const statusButton = await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(screen.getByRole("button", { name: operation === "add" ? "스케줄 추가" : "주간 운영 수정" }));
    const dialog = screen.getByRole("dialog", { name: operation === "add" ? "스케줄 추가" : "스케줄 수정" });
    expect(statusButton).toHaveAttribute("aria-label", "상태 센터, 미해결 1건");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 1건" }));
    expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).toHaveTextContent("야간 운영");
  });

  it("retains rule A's toggle failure after rule B succeeds", async () => {
    mocks.listSchedules.mockResolvedValue(page([schedule(), schedule({ id: "rule-b", name: "주간 운영" })]));
    mocks.updateSchedule.mockRejectedValueOnce(new Error("toggle failed"));
    renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "야간 운영 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(screen.getByRole("button", { name: "주간 운영 비활성화" }));
    await within(screen.getByRole("region", { name: "알림" })).findByText("스케줄을 비활성화했습니다.");
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 0건" });
  });

  it("keeps identical toggle failures independently identifiable by rule", async () => {
    mocks.listSchedules.mockResolvedValue(page([schedule(), schedule({ id: "rule-b", name: "주간 운영" })]));
    mocks.updateSchedule.mockRejectedValueOnce(new Error("toggle failed")).mockRejectedValueOnce(new Error("toggle failed"));
    renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "야간 운영 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(screen.getByRole("button", { name: "주간 운영 비활성화" }));
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 2건" }));
    const center = screen.getByRole("dialog", { name: "현재 세션 상태" });
    const statuses = within(center).getAllByRole("listitem");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toHaveTextContent("야간 운영");
    expect(statuses[1]).toHaveTextContent("주간 운영");
    for (const status of statuses) expect(status).toHaveTextContent("스케줄 변경을 완료하지 못했습니다.");
    fireEvent.keyDown(center, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "주간 운영 비활성화" }));
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" }));
    const remaining = within(screen.getByRole("dialog", { name: "현재 세션 상태" })).getByRole("listitem");
    expect(remaining).toHaveTextContent("야간 운영");
    expect(remaining).not.toHaveTextContent("주간 운영");
  });

  it("clears only the deleted schedule's toggle failure after deletion succeeds", async () => {
    mocks.listSchedules.mockResolvedValue(page([schedule(), schedule({ id: "rule-b", name: "주간 운영" })]));
    mocks.updateSchedule.mockRejectedValueOnce(new Error("toggle failed")).mockRejectedValueOnce(new Error("toggle failed"));
    renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "야간 운영 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(screen.getByRole("button", { name: "주간 운영 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 2건" });

    fireEvent.click(screen.getByRole("button", { name: "야간 운영 삭제" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "스케줄 삭제" })).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(mocks.deleteSchedule).toHaveBeenCalledWith(siteId, schedule().id));
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" }));
    const remaining = within(screen.getByRole("dialog", { name: "현재 세션 상태" })).getByRole("listitem");
    expect(remaining).toHaveTextContent("주간 운영");
    expect(remaining).not.toHaveTextContent("야간 운영");
  });

  it("keeps schedule A's toggle failure through another deletion and its own failed deletion", async () => {
    mocks.listSchedules.mockResolvedValue(page([schedule(), schedule({ id: "rule-b", name: "주간 운영" })]));
    mocks.updateSchedule.mockRejectedValueOnce(new Error("toggle failed"));
    mocks.deleteSchedule.mockResolvedValueOnce({ id: "rule-b", deleted: true })
      .mockRejectedValueOnce(new Error("delete failed"))
      .mockResolvedValueOnce({ id: schedule().id, deleted: true });
    renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "야간 운영 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });

    fireEvent.click(screen.getByRole("button", { name: "주간 운영 수정" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "스케줄 수정" })).getByRole("button", { name: "변경 저장" }));
    await waitFor(() => expect(mocks.updateSchedule).toHaveBeenCalledWith(siteId, "rule-b", expect.objectContaining({ name: "주간 운영" })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스케줄 수정" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "주간 운영 삭제" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "스케줄 삭제" })).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(mocks.deleteSchedule).toHaveBeenCalledWith(siteId, "rule-b"));
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "야간 운영 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "스케줄 삭제" });
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건", hidden: true })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 0건" });
  });

  it.each(["user scope", "401"])("clears rule toggle failures when %s ends their scope", async (boundary) => {
    mocks.updateSchedule.mockRejectedValueOnce(new Error("toggle failed"));
    const rendered = renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "야간 운영 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    if (boundary === "user scope") {
      rendered.rerender(panelElement("admin", rendered.queryClient, siteId, "another-user"));
    } else {
      mocks.listSchedules.mockRejectedValueOnce(new ApiError("expired", 401, null));
      await act(async () => { await rendered.queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
      await screen.findByText("로그인 세션이 만료되었습니다.");
    }
    await screen.findByRole("button", { name: "상태 센터, 미해결 0건" });
  });

  it("does not carry an old mutation failure into another site", async () => {
    mocks.updateSchedule.mockRejectedValueOnce(new Error("toggle failed"));
    const queryClient = testQueryClient();
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    rendered.rerender(panelElement("admin", queryClient, nextSiteId, `user-2:${nextSiteId}`));
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "알림" })).queryByText(/toggle failed/)).not.toBeInTheDocument();
  });

  it("does not publish a stale toggle success when the site changes under one user scope", async () => {
    const pending = deferred<ScheduleResponse>();
    mocks.updateSchedule.mockReturnValueOnce(pending.promise);
    const queryClient = testQueryClient();
    const rendered = renderPanel("admin", { queryClient, scopeKey: "user-1" });
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    rendered.rerender(panelElement("admin", queryClient, nextSiteId, "user-1"));
    await act(async () => { pending.resolve(schedule()); await pending.promise; });
    expect(within(screen.getByRole("region", { name: "알림" })).queryByText("스케줄을 비활성화했습니다.")).not.toBeInTheDocument();
  });

  it("dismisses a published success toast when site scope changes", async () => {
    const queryClient = testQueryClient();
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    expect(await within(screen.getByRole("region", { name: "알림" })).findByText("스케줄을 비활성화했습니다.")).toBeInTheDocument();
    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    rendered.rerender(panelElement("admin", queryClient, nextSiteId, `user-1:${nextSiteId}`));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "알림" })).queryByText("스케줄을 비활성화했습니다.")).not.toBeInTheDocument());
  });

  it("dismisses a published success toast when the panel unmounts", async () => {
    const queryClient = testQueryClient();
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    expect(await within(screen.getByRole("region", { name: "알림" })).findByText("스케줄을 비활성화했습니다.")).toBeInTheDocument();
    rendered.rerender(<QueryClientProvider client={queryClient}><SessionStatusProvider><SessionStatusCenter /><ToastRegion /></SessionStatusProvider></QueryClientProvider>);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "알림" })).queryByText("스케줄을 비활성화했습니다.")).not.toBeInTheDocument());
  });

  it("invalidates the original site after a mutation succeeds across a keyed remount", async () => {
    const pending = deferred<ScheduleResponse>();
    mocks.updateSchedule.mockReturnValueOnce(pending.promise);
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    rendered.rerender(panelElement("admin", queryClient, nextSiteId, `user-1:${nextSiteId}`, "next-site"));
    await act(async () => { pending.resolve(schedule()); await pending.promise; });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: scheduleQueryKey(siteId) });
  });

  it("invalidates auth for a 401 after same-principal keyed unmount", async () => {
    const pending = deferred<ScheduleResponse>();
    mocks.updateSchedule.mockReturnValueOnce(pending.promise);
    const queryClient = testQueryClient();
    queryClient.setQueryData(authMeQueryKey, { user: authUser("user-1") });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    rendered.rerender(<QueryClientProvider client={queryClient}><SessionStatusProvider><SessionStatusCenter /><ToastRegion /></SessionStatusProvider></QueryClientProvider>);
    await act(async () => { pending.reject(new ApiError("unauthorized", 401, null)); await pending.promise.catch(() => undefined); });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: authMeQueryKey });
  });

  it("does not invalidate new principal auth for an old keyed panel's 401", async () => {
    const pending = deferred<ScheduleResponse>();
    mocks.updateSchedule.mockReturnValueOnce(pending.promise);
    const queryClient = testQueryClient();
    queryClient.setQueryData(authMeQueryKey, { user: authUser("user-1") });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 비활성화" }));
    queryClient.setQueryData(authMeQueryKey, { user: authUser("user-2") });
    rendered.rerender(panelElement("admin", queryClient, siteId, "user-2", "new-principal"));
    await act(async () => { pending.reject(new ApiError("unauthorized", 401, null)); await pending.promise.catch(() => undefined); });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: authMeQueryKey });
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
    expect(screen.queryByText("야간 운영")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "야간 운영 비활성화" })).not.toBeInTheDocument();
  });

  it("closes an open schedule editor on cached-list 401 and focuses recovery", async () => {
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 수정" }));
    expect(screen.getByRole("dialog", { name: "스케줄 수정" })).toBeInTheDocument();
    mocks.listSchedules.mockRejectedValueOnce(new ApiError("unauthorized", 401, null));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
    await waitFor(() => expect(queryClient.getQueryCache().findAll({ queryKey: scheduleQueryKey(siteId) }).some((query) => query.state.error instanceof ApiError)).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스케줄 수정" })).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("로그인 세션이 만료되었습니다.");
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 다시 조회" })).toHaveFocus());
    expect(mocks.updateSchedule).not.toHaveBeenCalled();
  });

  it("closes an open schedule deletion on cached-list 401 without deleting", async () => {
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 삭제" }));
    const confirm = within(screen.getByRole("dialog", { name: "스케줄 삭제" })).getByRole("button", { name: "삭제" });
    mocks.listSchedules.mockRejectedValueOnce(new ApiError("unauthorized", 401, null));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
    await waitFor(() => expect(queryClient.getQueryCache().findAll({ queryKey: scheduleQueryKey(siteId) }).some((query) => query.state.error instanceof ApiError)).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스케줄 삭제" })).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("로그인 세션이 만료되었습니다.");
    fireEvent.click(confirm);
    expect(mocks.deleteSchedule).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 다시 조회" })).toHaveFocus());
  });

  it.each([403, 404])("hides cached schedules and closes an open editor after list %i", async (status) => {
    const summary = { ruleCount: 2, syncRuleCounts: { APPLIED: 0, PENDING: 2, REJECTED: 0 } };
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 2, filteredTotal: 2, siteSummary: summary, nextCursor: "page-2" });
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");
    expect(screen.getByRole("region", { name: "스케줄 목록 조건" })).toHaveTextContent("조건에 맞는 규칙 2건");
    expect(screen.getByRole("button", { name: "다음" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 수정" }));
    const submit = within(screen.getByRole("dialog", { name: "스케줄 수정" })).getByRole("button", { name: "변경 저장" });
    mocks.listSchedules.mockRejectedValueOnce(new ApiError("site access lost", status, null));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스케줄 수정" })).not.toBeInTheDocument());
    expect(screen.queryByText("야간 운영")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "스케줄 목록 조건" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다음" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toHaveTextContent("로그인 세션이 만료되었습니다.");
    fireEvent.click(submit);
    expect(mocks.updateSchedule).not.toHaveBeenCalled();
  });

  it.each([403, 404])("closes cached schedule deletion without POST after list %i", async (status) => {
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "야간 운영 삭제" }));
    const confirm = within(screen.getByRole("dialog", { name: "스케줄 삭제" })).getByRole("button", { name: "삭제" });
    mocks.listSchedules.mockRejectedValueOnce(new ApiError("site access lost", status, null));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스케줄 삭제" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "야간 운영 비활성화" })).not.toBeInTheDocument();
    fireEvent.click(confirm);
    expect(mocks.deleteSchedule).not.toHaveBeenCalled();
  });

  it.each([403, 404])("closes a cached schedule editor after visible-page poll %i", async (status) => {
    const summary = { ruleCount: 2, syncRuleCounts: { APPLIED: 0, PENDING: 2, REJECTED: 0 } };
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 2, filteredTotal: 2, siteSummary: summary, nextCursor: "page-2" })
      .mockResolvedValueOnce({ items: [schedule({ id: "00000000-0000-4000-8000-000000000012", name: "두 번째 스케줄" })], total: 2, filteredTotal: 2, siteSummary: summary, nextCursor: null })
      .mockRejectedValueOnce(new ApiError("site access lost", status, null));
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByText("두 번째 스케줄");
    fireEvent.click(screen.getByRole("button", { name: "두 번째 스케줄 수정" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스케줄 수정" })).not.toBeInTheDocument(), { timeout: 4500 });
    expect(screen.queryByText("두 번째 스케줄")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "스케줄 목록 조건" })).not.toBeInTheDocument();
    expect(mocks.updateSchedule).not.toHaveBeenCalled();
  });

  it.each([403, 404])("closes a cached schedule deletion after visible-page poll %i", async (status) => {
    const summary = { ruleCount: 2, syncRuleCounts: { APPLIED: 0, PENDING: 2, REJECTED: 0 } };
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 2, filteredTotal: 2, siteSummary: summary, nextCursor: "page-2" })
      .mockResolvedValueOnce({ items: [schedule({ id: "00000000-0000-4000-8000-000000000012", name: "두 번째 스케줄" })], total: 2, filteredTotal: 2, siteSummary: summary, nextCursor: null })
      .mockRejectedValueOnce(new ApiError("site access lost", status, null));
    renderPanel("admin");
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByText("두 번째 스케줄");
    fireEvent.click(screen.getByRole("button", { name: "두 번째 스케줄 삭제" }));
    const confirm = within(screen.getByRole("dialog", { name: "스케줄 삭제" })).getByRole("button", { name: "삭제" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스케줄 삭제" })).not.toBeInTheDocument(), { timeout: 4500 });
    fireEvent.click(confirm);
    expect(screen.queryByText("두 번째 스케줄")).not.toBeInTheDocument();
    expect(mocks.deleteSchedule).not.toHaveBeenCalled();
  });

  it.each([403, 404])("recovers schedule controls only after a successful list retry from %i", async (status) => {
    const { queryClient } = renderPanel("admin");
    await screen.findByText("야간 운영");
    mocks.listSchedules.mockRejectedValueOnce(new ApiError("site access lost", status, null));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
    await waitFor(() => expect(screen.queryByText("야간 운영")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "상태 다시 조회" }));
    await screen.findByText("야간 운영");
    expect(screen.getByRole("button", { name: "야간 운영 수정" })).toBeInTheDocument();
  });

  it.each([401, 403, 404])("gives a new list %i priority over an older visible-page 503", async (status) => {
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const summary = { ruleCount: 2, syncRuleCounts: { APPLIED: 0, PENDING: 2, REJECTED: 0 } };
    mocks.listSchedules.mockResolvedValueOnce({ items: [schedule()], total: 2, filteredTotal: 2, siteSummary: summary, nextCursor: "page-2" })
      .mockResolvedValueOnce({ items: [schedule({ id: "00000000-0000-4000-8000-000000000012", name: "두 번째 스케줄" })], total: 2, filteredTotal: 2, siteSummary: summary, nextCursor: null })
      .mockRejectedValueOnce(new ApiError("poll unavailable", 503, null));
    renderPanel("admin", { queryClient });
    await screen.findByText("야간 운영");
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByText("두 번째 스케줄");
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument(), { timeout: 4500 });

    mocks.listSchedules.mockRejectedValueOnce(new ApiError("site access lost", status, null));
    await act(async () => { await queryClient.refetchQueries({ queryKey: scheduleQueryKey(siteId) }); });
    await waitFor(() => expect(screen.queryByText("두 번째 스케줄")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(status === 401 ? "로그인 세션이 만료되었습니다." : /현장/);
    if (status === 401) expect(invalidate).toHaveBeenCalledWith({ queryKey: authMeQueryKey });
    else expect(invalidate).not.toHaveBeenCalledWith({ queryKey: authMeQueryKey });
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

  it("keeps legacy schedule dialog containment, Escape and focus return behavior", async () => {
    renderPanel("admin");
    await screen.findByText("야간 운영");
    const addButton = screen.getByRole("button", { name: "스케줄 추가" });
    fireEvent.click(addButton);
    const dialog = screen.getByRole("dialog", { name: "스케줄 추가" });
    const closeButton = within(dialog).getByRole("button", { name: "스케줄 추가 닫기" });
    const submitButton = within(dialog).getByRole("button", { name: "스케줄 만들기" });

    submitButton.focus();
    // Keyboard events originate at the focused control in the browser.
    fireEvent.keyDown(submitButton, { key: "Tab" });
    // The ref-only adapter cannot install React Aria sentinels. Simulate the
    // native Tab leaving its last control; focus must return inside the dialog.
    // Exact first/last cycling returns when Task 8 migrates this page to Modal.
    addButton.focus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    addButton.focus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
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
  scopeKey = panelSiteId,
  panelKey?: string
) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionStatusProvider><SessionStatusCenter /><ToastRegion /><ScheduleControlPanel
        key={panelKey}
        siteId={panelSiteId}
        role={role}
        dashboard={dashboard}
        scopeKey={scopeKey}
      /></SessionStatusProvider>
    </QueryClientProvider>
  );
}

function authUser(id: string): AuthUser {
  return { id, organizationId: "org-1", organizationType: "customer", loginId: id, name: id, role: "admin", status: "active", mustChangePassword: false };
}

function openScheduleAdvanced(dialog: HTMLElement) {
  const toggle = within(dialog).getByRole("button", { name: "세부 일정 설정" });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
}

function selectOption(dialog: HTMLElement, label: string, option: string) {
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

function selectScheduleFixture(dialog: HTMLElement, fixtureLabel: string) {
  fireEvent.click(within(dialog).getByRole("button", { name: /제어 대상 (선택|변경)/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "조명 목록 열기" }));
  fireEvent.click(screen.getByLabelText(fixtureLabel));
  fireEvent.click(screen.getByRole("button", { name: "선택 완료" }));
  fireEvent.click(within(dialog).getByRole("button", { name: /개 조명 선택 완료/ }));
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
