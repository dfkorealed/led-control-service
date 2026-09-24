import type { FloorMapSnapshot } from "@led-control/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import type { AuthUser } from "../../../api/auth";
import { authMeQueryKey } from "../../../api/principal-cache";
import { vehicleEventRuleQueryKey, type VehicleEventRuleResponse } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { SessionStatusCenter, SessionStatusProvider, ToastRegion } from "../../../components/ui";
import { VehicleEventControlPanel } from "./VehicleEventControlPanel";

const floorMapQuery = vi.hoisted(() => vi.fn());

vi.mock("../../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/queries")>()),
  useFloorMapSnapshot: floorMapQuery
}));

const mocks = vi.hoisted(() => ({
  createVehicleEventRule: vi.fn(),
  deleteVehicleEventRule: vi.fn(),
  listVehicleEventRules: vi.fn(),
  updateVehicleEventRule: vi.fn()
}));

vi.mock("../../../api/automation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/automation")>()),
  ...mocks
}));

const siteId = "00000000-0000-4000-8000-000000000001";
const sensorFixtureId = "00000000-0000-4000-8000-000000000003";
const targetFixtureId = "00000000-0000-4000-8000-000000000004";
const floorMapSnapshot: FloorMapSnapshot = { floorId: "00000000-0000-4000-8000-000000000005", revision: 1, width: 600, height: 400, floorPlan: null, objects: [] };
const dashboard: Dashboard = {
  generatedAt: "2026-09-12T00:00:00.000Z",
  monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
  site: { id: siteId, name: "테스트 현장", customerName: "테스트 고객", installationStatus: "installed", address: null, tariffKwhRate: 160, timeZone: "Asia/Seoul" },
  summary: { totalFixtures: 3, onlineFixtures: 3, faultFixtures: 0, averageBrightness: 60 },
  floors: [{
    id: "00000000-0000-4000-8000-000000000005",
    name: "B1",
    level: -1,
    floorPlan: null,
    meshControlGroups: [],
    fixtures: [
      fixture(sensorFixtureId, "B1-SENSOR-001", "supported", "2026-08-31T00:00:00.000Z"),
      fixture(targetFixtureId, "B1-L001", "unsupported", null),
      fixture("00000000-0000-4000-8000-000000000006", "B1-L002", "unknown", null)
    ]
  }],
  groups: [],
  gateways: []
};

describe("VehicleEventControlPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    floorMapQuery.mockReturnValue({ data: floorMapSnapshot, error: null, isLoading: false, isFetching: false });
    mocks.listVehicleEventRules.mockResolvedValue({ items: [rule()], total: 1, nextCursor: null });
    mocks.createVehicleEventRule.mockResolvedValue(rule());
    mocks.updateVehicleEventRule.mockResolvedValue(rule());
    mocks.deleteVehicleEventRule.mockResolvedValue({ id: rule().id, deleted: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("shows every event operation field and working management actions in the compact card", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    mocks.listVehicleEventRules.mockResolvedValue({
      items: [rule({ lastDetection: {
        id: "detection-1",
        eventId: "event-1",
        sequence: "1",
        revision: 2,
        occurrenceKey: null,
        kind: "vehicle_detected",
        occurredAt: "2026-09-01T10:00:00.000Z",
        payload: {}
      } })],
      total: 1,
      nextCursor: null
    });
    renderPanel("admin");

    const list = await screen.findByRole("list", { name: "차량 이벤트 카드 목록" });
    const card = within(list).getByRole("listitem");
    expect(screen.queryByRole("table", { name: "차량 이벤트 목록" })).not.toBeInTheDocument();
    for (const label of ["입구 차량 감지", "활성", "감지 센서", "제어 조명", "밝기", "유지", "Gateway 동기화", "최근 감지"]) {
      expect(card).toHaveTextContent(label);
    }
    expect(card).toHaveTextContent("80%");
    expect(card).toHaveTextContent("60초");
    expect(card).toHaveTextContent("적용 대기");
    expect(card).toHaveTextContent("26. 9. 1.");
    fireEvent.click(within(card).getByRole("button", { name: "입구 차량 감지 비활성화" }));
    await waitFor(() => expect(mocks.updateVehicleEventRule).toHaveBeenCalledWith(siteId, rule().id, { status: "disabled" }));
    fireEvent.click(within(card).getByRole("button", { name: "입구 차량 감지 삭제" }));
    expect(screen.getByRole("dialog", { name: "이벤트 규칙 삭제" })).toBeInTheDocument();
  });

  it("keeps compact event cards read-only for viewers", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    renderPanel("viewer");
    const card = within(await screen.findByRole("list", { name: "차량 이벤트 카드 목록" })).getByRole("listitem");
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
  });

  it("shows event state and keeps mutation commands read-only for viewers", async () => {
    renderPanel("viewer");

    expect(await screen.findByText("입구 차량 감지")).toBeInTheDocument();
    expect(screen.getAllByText("활성")).toHaveLength(2);
    expect(screen.getAllByText("1개")).toHaveLength(2);
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("60초")).toBeInTheDocument();
    expect(screen.getByText("적용 대기")).toBeInTheDocument();
    expect(screen.getByText("최근 감지 없음")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이벤트 추가" })).not.toBeInTheDocument();
  });

  it("opens vehicle event creation from the level-three panel heading", async () => {
    renderPanel("admin");

    expect(await screen.findByRole("heading", { name: "이벤트 제어", level: 3 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    expect(screen.getByRole("dialog", { name: "이벤트 추가" })).toBeInTheDocument();
  });

  it("closes vehicle event creation with its cancel action", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 추가" });

    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog", { name: "이벤트 추가" })).not.toBeInTheDocument();
  });

  it("uses compact source and target cards and keeps capability filtering inside picker views", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 추가" });

    expect(within(dialog).getByRole("group", { name: "감지 센서" })).toHaveTextContent("감지 센서를 선택해 주세요.");
    expect(within(dialog).getByRole("group", { name: "실행할 조명" })).toHaveTextContent("실행할 조명을 선택해 주세요.");
    expect(within(dialog).queryByRole("group", { name: "조명 목록" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "감지 센서 선택" }));
    expect(within(dialog).getByRole("button", { name: /B1-SENSOR-001/ })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: /B1-L001.*선택 불가/ })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: /B1-SENSOR-001/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "1개 조명 선택 완료" }));

    expect(within(dialog).getByRole("group", { name: "감지 센서" })).toHaveTextContent("B1-SENSOR-001");
    expect(within(dialog).getByRole("status")).toHaveTextContent("B1-SENSOR-001 감지");
  });

  it("keeps one reachable add action for an empty vehicle event list", async () => {
    mocks.listVehicleEventRules.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    renderPanel("admin");

    await screen.findByText("등록된 이벤트 규칙이 없습니다.");
    expect(screen.getAllByRole("button", { name: "이벤트 추가" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    expect(screen.getByRole("dialog", { name: "이벤트 추가" })).toBeInTheDocument();
  });

  it("shows icon and text badges for every Gateway sync state", async () => {
    mocks.listVehicleEventRules.mockResolvedValue({
      items: [
        rule({ name: "적용 대기 규칙", syncStatus: "PENDING" }),
        rule({ id: "00000000-0000-4000-8000-000000000012", name: "적용 완료 규칙", syncStatus: "APPLIED" }),
        rule({ id: "00000000-0000-4000-8000-000000000013", name: "적용 실패 규칙", syncStatus: "REJECTED" })
      ],
      total: 3,
      nextCursor: null
    });

    renderPanel("viewer");

    expect((await screen.findByText("적용 대기")).closest("[data-tone]")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("적용됨").closest("[data-tone]")).toHaveAttribute("data-tone", "success");
    expect(screen.getByText("적용 실패").closest("[data-tone]")).toHaveAttribute("data-tone", "danger");
  });

  it("차량 이벤트 목록은 polling 실패에도 기존 행과 retry를 유지한다", async () => {
    const { queryClient } = renderPanel("admin");
    const table = await screen.findByRole("table", { name: "차량 이벤트 목록" });
    expect(table.closest("[data-automation-table-wrap]")).not.toBeNull();

    mocks.listVehicleEventRules.mockRejectedValueOnce(new Error("poll failed"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) });
    });

    expect(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    expect(screen.getByText("입구 차량 감지")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 1건" }));
    expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).toHaveTextContent("Gateway 적용 상태를 새로고침하지 못했습니다.");
    expect(screen.getByRole("button", { name: "상태 다시 조회" })).toBeInTheDocument();
  });

  it("shows last successful refresh in the selected site's time zone", async () => {
    vi.stubEnv("TZ", "UTC");
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-23T23:00:00Z"));
    const { queryClient } = renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    mocks.listVehicleEventRules.mockRejectedValueOnce(new Error("poll failed"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); });
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" }));
    expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).toHaveTextContent("마지막 성공: 26. 9. 24. 오전 8:00");
  });

  it("keeps the last whole-list success time until a real refresh succeeds", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-23T23:00:00Z"));
    mocks.listVehicleEventRules.mockResolvedValueOnce({ items: [rule()], total: 2, nextCursor: "next-page" });
    const { queryClient } = renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    const loadMore = screen.getByRole("button", { name: "더 보기" });
    mocks.listVehicleEventRules.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); });
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" }));
    const center = screen.getByRole("dialog", { name: "현재 세션 상태" });
    expect(center).toHaveTextContent("마지막 성공: 26. 9. 24. 오전 8:00");

    clock.mockReturnValue(Date.parse("2026-09-24T01:00:00Z"));
    mocks.listVehicleEventRules.mockResolvedValueOnce({ items: [rule({ id: "next-1", name: "두 번째 이벤트" })], total: 2, nextCursor: null });
    fireEvent.click(loadMore);
    await screen.findByText("두 번째 이벤트");
    expect(center).toHaveTextContent("마지막 성공: 26. 9. 24. 오전 8:00");
    await act(async () => {
      queryClient.setQueryData(vehicleEventRuleQueryKey(siteId), queryClient.getQueryData(vehicleEventRuleQueryKey(siteId)), { updatedAt: Date.parse("2026-09-24T02:00:00Z") });
    });
    expect(center).toHaveTextContent("마지막 성공: 26. 9. 24. 오전 8:00");

    clock.mockReturnValue(Date.parse("2026-09-24T03:00:00Z"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); });
    await waitFor(() => expect(center).toHaveTextContent("현재 확인할 상태가 없습니다."));
    mocks.listVehicleEventRules.mockRejectedValueOnce(new Error("refresh failed again"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); });
    await waitFor(() => expect(center).toHaveTextContent("마지막 성공: 26. 9. 24. 오후 12:00"));
  });

  it.each(["user scope", "401"])("forgets the last whole-list success time after %s ends its scope", async (boundary) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-23T23:00:00Z"));
    const rendered = renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    if (boundary === "user scope") {
      rendered.rerender(panelElement("admin", rendered.queryClient, siteId, "another-user"));
    } else {
      mocks.listVehicleEventRules.mockRejectedValueOnce(new ApiError("expired", 401, null));
      await act(async () => { await rendered.queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); });
      await screen.findByText("로그인 세션이 만료되었습니다.");
    }
    mocks.listVehicleEventRules.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => { await rendered.queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); });
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" }));
    expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).not.toHaveTextContent("마지막 성공:");
  });

  it("keeps a failed next page recoverable from the status center", async () => {
    mocks.listVehicleEventRules.mockResolvedValueOnce({ items: [rule()], total: 2, nextCursor: "next-page" }).mockRejectedValueOnce(new Error("next page failed")).mockResolvedValueOnce({ items: [rule({ id: "rule-2", name: "후속 이벤트" })], total: 2, nextCursor: null });
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    expect(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    expect(screen.getByText("입구 차량 감지")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 1건" }));
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지 다시 시도" }));
    expect(await screen.findByText("후속 이벤트")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).toHaveTextContent("현재 확인할 상태가 없습니다."));
  });

  it("keeps a missing next page after a successful poll of loaded rows", async () => {
    mocks.listVehicleEventRules.mockResolvedValueOnce({ items: [rule()], total: 2, nextCursor: "next-page" }).mockRejectedValueOnce(new Error("next page failed"));
    const { queryClient } = renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    mocks.listVehicleEventRules.mockResolvedValueOnce({ items: [rule()], total: 2, nextCursor: "next-page" });
    await act(async () => { await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 1건" }));
    mocks.listVehicleEventRules.mockResolvedValueOnce({ items: [rule({ id: "next-1", name: "누락된 이벤트" })], total: 2, nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지 다시 시도" }));
    expect(await screen.findByText("누락된 이벤트")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).toHaveTextContent("현재 확인할 상태가 없습니다."));
  });

  it("resolves a failed next-page action when refresh removes its cursor", async () => {
    mocks.listVehicleEventRules.mockResolvedValueOnce({ items: [rule()], total: 2, nextCursor: "next-page" }).mockRejectedValueOnce(new Error("next page failed"));
    const { queryClient } = renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    mocks.listVehicleEventRules.mockResolvedValueOnce({ items: [rule()], total: 1, nextCursor: null });
    await act(async () => { await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
  });

  it("keeps next-page and refresh failures as separate recoverable statuses", async () => {
    mocks.listVehicleEventRules.mockResolvedValueOnce({ items: [rule()], total: 2, nextCursor: "next-page" }).mockRejectedValueOnce(new Error("next page failed"));
    const { queryClient } = renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(within(screen.getByRole("region", { name: "알림" })).getByRole("button", { name: "알림 닫기" }));
    mocks.listVehicleEventRules.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 2건" })).toBeInTheDocument();
    const alerts = within(screen.getByRole("region", { name: "알림" })).getAllByRole("status");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Gateway 적용 상태를 새로고침하지 못했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 2건" }));
    const center = screen.getByRole("dialog", { name: "현재 세션 상태" });
    expect(within(center).getByRole("button", { name: "다음 페이지 다시 시도" })).toBeInTheDocument();
    expect(within(center).getByRole("button", { name: "상태 다시 조회" })).toBeInTheDocument();
    mocks.listVehicleEventRules.mockResolvedValueOnce({ items: [rule({ id: "next-1", name: "두 번째 이벤트" })], total: 2, nextCursor: null });
    fireEvent.click(within(center).getByRole("button", { name: "다음 페이지 다시 시도" }));
    expect(await screen.findByText("두 번째 이벤트")).toBeInTheDocument();
    await waitFor(() => expect(within(center).queryByRole("button", { name: "다음 페이지 다시 시도" })).not.toBeInTheDocument());
    expect(within(center).getByRole("button", { name: "상태 다시 조회" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "알림", hidden: true })).getAllByRole("status", { hidden: true })).toHaveLength(1);
    mocks.listVehicleEventRules.mockResolvedValueOnce({ items: [rule()], total: 2, nextCursor: "next-page" }).mockResolvedValueOnce({ items: [rule({ id: "next-1", name: "두 번째 이벤트" })], total: 2, nextCursor: null });
    fireEvent.click(within(center).getByRole("button", { name: "상태 다시 조회" }));
    await waitFor(() => expect(center).toHaveTextContent("현재 확인할 상태가 없습니다."));
  });

  it("shows a neutral viewer badge without a full-width readonly notice", async () => {
    renderPanel("viewer");
    await screen.findByText("입구 차량 감지");
    expect(screen.getByText("조회 전용").closest("[data-tone]")).toHaveAttribute("data-tone", "neutral");
    expect(screen.queryByText(/조회 전용 계정입니다/)).not.toBeInTheDocument();
  });

  it("keeps a toggle failure discoverable outside dialogs and confirms a later success by toast", async () => {
    mocks.updateVehicleEventRule.mockRejectedValueOnce(new Error("toggle failed"));
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    expect(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    expect(within(screen.getByRole("tabpanel")).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "알림" })).getByText("이벤트 규칙을 비활성화했습니다.")).toBeInTheDocument();
  });

  it("retains a toggle failure during retry and does not reannounce the same failure", async () => {
    const retry = deferredPromise<ReturnType<typeof rule>>();
    mocks.updateVehicleEventRule.mockRejectedValueOnce(new Error("toggle failed")).mockReturnValueOnce(retry.promise);
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(within(screen.getByRole("region", { name: "알림" })).getByRole("button", { name: "알림 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    await act(async () => { retry.reject(new Error("toggle failed")); await retry.promise.catch(() => undefined); });
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "알림" })).queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["add", "edit"])("retains a rule's toggle failure while an unrelated %s dialog opens", async (operation) => {
    mocks.listVehicleEventRules.mockResolvedValue({ items: [rule(), rule({ id: "rule-b", name: "출구 차량 감지" })], total: 2, nextCursor: null });
    mocks.updateVehicleEventRule.mockRejectedValueOnce(new Error("toggle failed"));
    renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "입구 차량 감지 비활성화" }));
    const statusButton = await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(screen.getByRole("button", { name: operation === "add" ? "이벤트 추가" : "출구 차량 감지 수정" }));
    const dialog = screen.getByRole("dialog", { name: operation === "add" ? "이벤트 추가" : "이벤트 수정" });
    expect(statusButton).toHaveAttribute("aria-label", "상태 센터, 미해결 1건");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    fireEvent.click(screen.getByRole("button", { name: "상태 센터, 미해결 1건" }));
    expect(screen.getByRole("dialog", { name: "현재 세션 상태" })).toHaveTextContent("입구 차량 감지");
  });

  it("retains rule A's toggle failure after rule B succeeds", async () => {
    mocks.listVehicleEventRules.mockResolvedValue({ items: [rule(), rule({ id: "rule-b", name: "출구 차량 감지" })], total: 2, nextCursor: null });
    mocks.updateVehicleEventRule.mockRejectedValueOnce(new Error("toggle failed"));
    renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "입구 차량 감지 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(screen.getByRole("button", { name: "출구 차량 감지 비활성화" }));
    await within(screen.getByRole("region", { name: "알림" })).findByText("이벤트 규칙을 비활성화했습니다.");
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 0건" });
  });

  it("keeps identical toggle failures independently identifiable by rule", async () => {
    mocks.listVehicleEventRules.mockResolvedValue({ items: [rule(), rule({ id: "rule-b", name: "출구 차량 감지" })], total: 2, nextCursor: null });
    mocks.updateVehicleEventRule.mockRejectedValueOnce(new Error("toggle failed")).mockRejectedValueOnce(new Error("toggle failed"));
    renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "입구 차량 감지 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(screen.getByRole("button", { name: "출구 차량 감지 비활성화" }));
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 2건" }));
    const center = screen.getByRole("dialog", { name: "현재 세션 상태" });
    const statuses = within(center).getAllByRole("listitem");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toHaveTextContent("입구 차량 감지");
    expect(statuses[1]).toHaveTextContent("출구 차량 감지");
    for (const status of statuses) expect(status).toHaveTextContent("이벤트 규칙 변경을 완료하지 못했습니다.");
    fireEvent.keyDown(center, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "출구 차량 감지 비활성화" }));
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" }));
    const remaining = within(screen.getByRole("dialog", { name: "현재 세션 상태" })).getByRole("listitem");
    expect(remaining).toHaveTextContent("입구 차량 감지");
    expect(remaining).not.toHaveTextContent("출구 차량 감지");
  });

  it("clears only the deleted event rule's toggle failure after deletion succeeds", async () => {
    mocks.listVehicleEventRules.mockResolvedValue({ items: [rule(), rule({ id: "rule-b", name: "출구 차량 감지" })], total: 2, nextCursor: null });
    mocks.updateVehicleEventRule.mockRejectedValueOnce(new Error("toggle failed")).mockRejectedValueOnce(new Error("toggle failed"));
    renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "입구 차량 감지 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    fireEvent.click(screen.getByRole("button", { name: "출구 차량 감지 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 2건" });

    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 삭제" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "이벤트 규칙 삭제" })).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(mocks.deleteVehicleEventRule).toHaveBeenCalledWith(siteId, rule().id));
    fireEvent.click(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" }));
    const remaining = within(screen.getByRole("dialog", { name: "현재 세션 상태" })).getByRole("listitem");
    expect(remaining).toHaveTextContent("출구 차량 감지");
    expect(remaining).not.toHaveTextContent("입구 차량 감지");
  });

  it("keeps event rule A's toggle failure through another deletion and its own failed deletion", async () => {
    mocks.listVehicleEventRules.mockResolvedValue({ items: [rule(), rule({ id: "rule-b", name: "출구 차량 감지" })], total: 2, nextCursor: null });
    mocks.updateVehicleEventRule.mockRejectedValueOnce(new Error("toggle failed"));
    mocks.deleteVehicleEventRule.mockResolvedValueOnce({ id: "rule-b", deleted: true })
      .mockRejectedValueOnce(new Error("delete failed"))
      .mockResolvedValueOnce({ id: rule().id, deleted: true });
    renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "입구 차량 감지 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });

    fireEvent.click(screen.getByRole("button", { name: "출구 차량 감지 수정" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "이벤트 수정" })).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(mocks.updateVehicleEventRule).toHaveBeenCalledWith(siteId, "rule-b", expect.objectContaining({ name: "출구 차량 감지" })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "이벤트 수정" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "출구 차량 감지 삭제" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "이벤트 규칙 삭제" })).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(mocks.deleteVehicleEventRule).toHaveBeenCalledWith(siteId, "rule-b"));
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 규칙 삭제" });
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건", hidden: true })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 0건" });
  });

  it.each(["user scope", "401"])("clears rule toggle failures when %s ends their scope", async (boundary) => {
    mocks.updateVehicleEventRule.mockRejectedValueOnce(new Error("toggle failed"));
    const rendered = renderPanel("admin");
    fireEvent.click(await screen.findByRole("button", { name: "입구 차량 감지 비활성화" }));
    await screen.findByRole("button", { name: "상태 센터, 미해결 1건" });
    if (boundary === "user scope") {
      rendered.rerender(panelElement("admin", rendered.queryClient, siteId, "another-user"));
    } else {
      mocks.listVehicleEventRules.mockRejectedValueOnce(new ApiError("expired", 401, null));
      await act(async () => { await rendered.queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); });
      await screen.findByText("로그인 세션이 만료되었습니다.");
    }
    await screen.findByRole("button", { name: "상태 센터, 미해결 0건" });
  });

  it("does not publish a stale toggle result after a site switch", async () => {
    const pending = deferredPromise<ReturnType<typeof rule>>();
    mocks.updateVehicleEventRule.mockReturnValueOnce(pending.promise);
    const queryClient = testQueryClient();
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    rendered.rerender(panelElement("admin", queryClient, nextSiteId, `user-2:${nextSiteId}`));
    await act(async () => { pending.resolve(rule()); await pending.promise; });
    expect(within(screen.getByRole("region", { name: "알림" })).queryByText("이벤트 규칙을 비활성화했습니다.")).not.toBeInTheDocument();
  });

  it("does not publish a stale toggle when site changes under one user scope", async () => {
    const pending = deferredPromise<ReturnType<typeof rule>>();
    mocks.updateVehicleEventRule.mockReturnValueOnce(pending.promise);
    const queryClient = testQueryClient();
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    rendered.rerender(panelElement("admin", queryClient, nextSiteId, siteId));
    await act(async () => { pending.resolve(rule()); await pending.promise; });
    expect(within(screen.getByRole("region", { name: "알림" })).queryByText("이벤트 규칙을 비활성화했습니다.")).not.toBeInTheDocument();
  });

  it("dismisses a published success toast when site scope changes", async () => {
    const queryClient = testQueryClient();
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    expect(await within(screen.getByRole("region", { name: "알림" })).findByText("이벤트 규칙을 비활성화했습니다.")).toBeInTheDocument();
    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    rendered.rerender(panelElement("admin", queryClient, nextSiteId, `user-1:${nextSiteId}`));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "알림" })).queryByText("이벤트 규칙을 비활성화했습니다.")).not.toBeInTheDocument());
  });

  it("dismisses a published success toast when the panel unmounts", async () => {
    const queryClient = testQueryClient();
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    expect(await within(screen.getByRole("region", { name: "알림" })).findByText("이벤트 규칙을 비활성화했습니다.")).toBeInTheDocument();
    rendered.rerender(<QueryClientProvider client={queryClient}><SessionStatusProvider><SessionStatusCenter /><ToastRegion /></SessionStatusProvider></QueryClientProvider>);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "알림" })).queryByText("이벤트 규칙을 비활성화했습니다.")).not.toBeInTheDocument());
  });

  it("ignores a stale 401 toggle after a site and user scope round trip", async () => {
    const pending = deferredPromise<ReturnType<typeof rule>>();
    mocks.updateVehicleEventRule.mockReturnValueOnce(pending.promise);
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    const nextSiteId = "00000000-0000-4000-8000-000000000099";
    rendered.rerender(panelElement("admin", queryClient, nextSiteId, `user-2:${nextSiteId}`));
    rendered.rerender(panelElement("admin", queryClient, siteId, siteId));
    await act(async () => { pending.reject(new ApiError("unauthorized", 401, null)); await pending.promise.catch(() => undefined); });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: authMeQueryKey });
    expect(within(screen.getByRole("region", { name: "알림" })).queryByText("로그인 세션이 만료되었습니다.")).not.toBeInTheDocument();
  });

  it("does not expire a new principal for an old keyed panel's 401", async () => {
    const pending = deferredPromise<ReturnType<typeof rule>>();
    mocks.updateVehicleEventRule.mockReturnValueOnce(pending.promise);
    const queryClient = testQueryClient();
    queryClient.setQueryData(authMeQueryKey, { user: authUser("user-1") });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    queryClient.setQueryData(authMeQueryKey, { user: authUser("user-2") });
    rendered.rerender(panelElement("admin", queryClient, siteId, "user-2", dashboard, "new-principal"));
    await act(async () => { pending.reject(new ApiError("unauthorized", 401, null)); await pending.promise.catch(() => undefined); });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: authMeQueryKey });
  });

  it("does not expire a logged-out session for an old keyed panel's 401", async () => {
    const pending = deferredPromise<ReturnType<typeof rule>>();
    mocks.updateVehicleEventRule.mockReturnValueOnce(pending.promise);
    const queryClient = testQueryClient();
    queryClient.setQueryData(authMeQueryKey, { user: authUser("user-1") });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderPanel("admin", { queryClient });
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 비활성화" }));
    queryClient.setQueryData(authMeQueryKey, null);
    rendered.rerender(panelElement("admin", queryClient, siteId, "logged-out", dashboard, "logged-out"));
    await act(async () => { pending.reject(new ApiError("unauthorized", 401, null)); await pending.promise.catch(() => undefined); });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: authMeQueryKey });
  });

  it("validates empty source and target selections before a create request", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");

    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 추가" });
    expect(within(dialog).getByRole("group", { name: "감지 센서" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "실행할 조명" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "밝기" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));

    expect(screen.getByText("감지 센서를 한 개 이상 선택하세요.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /B1-SENSOR-001/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "1개 조명 선택 완료" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(screen.getByText("제어 조명을 한 개 이상 선택하세요.")).toBeInTheDocument();
    expect(mocks.createVehicleEventRule).not.toHaveBeenCalled();
  });

  it("offers only Gateway-registered, capability-confirmed fixtures as sources", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));

    fireEvent.click(screen.getByRole("button", { name: "감지 센서 선택" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 추가" });
    expect(within(dialog).getByRole("button", { name: /B1-SENSOR-001/ })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: /B1-L001.*선택 불가/ })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /B1-L002.*선택 불가/ })).toBeDisabled();
  });

  it("fails closed for missing and invalid capability verification timestamps", async () => {
    const unverifiedDashboard: Dashboard = {
      ...dashboard,
      floors: [{
        ...dashboard.floors[0],
        fixtures: [
          { ...dashboard.floors[0].fixtures[0], vehicleSensorCapabilityVerifiedAt: undefined },
          { ...dashboard.floors[0].fixtures[0], id: "00000000-0000-4000-8000-000000000007", name: "B1-SENSOR-INVALID", vehicleSensorCapabilityVerifiedAt: "2026-02-30T00:00:00.000Z" }
        ]
      }]
    };
    renderPanel("admin", { dashboard: unverifiedDashboard });
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));

    fireEvent.click(screen.getByRole("button", { name: "감지 센서 선택" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 추가" });
    expect(within(dialog).getByRole("button", { name: /B1-SENSOR-001.*선택 불가/ })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /B1-SENSOR-INVALID.*선택 불가/ })).toBeDisabled();
  });

  it("shows unresolved ids and rejects an event edit with a removed target fixture", async () => {
    const removedFixtureId = "00000000-0000-4000-8000-000000000099";
    mocks.listVehicleEventRules.mockResolvedValue({
      items: [rule({ targetFixtureIds: [targetFixtureId, removedFixtureId], targetCount: 2 })],
      total: 1,
      nextCursor: null
    });
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");

    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 수정" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 수정" });
    expect(within(dialog).getByRole("group", { name: "실행할 조명" })).toHaveTextContent("1개 확인 필요");
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));

    expect(within(dialog).getByText("현재 현장에서 확인되지 않는 제어 조명이 포함되어 있습니다. 다시 선택해 주세요.")).toBeVisible();
    expect(within(dialog).getByRole("group", { name: "실행할 조명 선택" })).toHaveFocus();
    expect(mocks.updateVehicleEventRule).not.toHaveBeenCalled();
  });

  it("rejects an event edit when the selected source capability was revoked", async () => {
    const revokedDashboard: Dashboard = {
      ...dashboard,
      floors: [{
        ...dashboard.floors[0],
        fixtures: dashboard.floors[0].fixtures.map((candidate) => candidate.id === sensorFixtureId
          ? { ...candidate, vehicleSensorCapabilityStatus: "unsupported", vehicleSensorCapabilityVerifiedAt: null }
          : candidate)
      }]
    };
    renderPanel("admin", { dashboard: revokedDashboard });
    await screen.findByText("입구 차량 감지");

    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 수정" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 수정" });
    expect(within(dialog).getByRole("group", { name: "감지 센서" })).toHaveTextContent("확인 필요");
    expect(within(dialog).getByRole("status")).toHaveTextContent("확인 필요 감지");
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));

    expect(within(dialog).getByText("현재 현장에서 확인되지 않거나 차량 감지 기능이 해제된 센서가 포함되어 있습니다. 다시 선택해 주세요.")).toBeVisible();
    expect(within(dialog).getByRole("group", { name: "감지 센서 선택" })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: /B1-SENSOR-001.*선택됨/ })).toHaveAttribute("aria-pressed", "true");
    expect(mocks.updateVehicleEventRule).not.toHaveBeenCalled();
  });

  it("submits the exact quick-create payload for selected presets", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 추가" });

    fireEvent.click(within(dialog).getByRole("button", { name: "감지 센서 선택" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /B1-SENSOR-001/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "1개 조명 선택 완료" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "실행할 조명 선택" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /B1-L001/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "1개 조명 선택 완료" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "80%" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "5분" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => expect(mocks.createVehicleEventRule).toHaveBeenCalledWith(siteId, {
      name: "차량 감지 제어",
      status: "enabled",
      sourceFixtureIds: [sensorFixtureId],
      targetFixtureIds: [targetFixtureId],
      action: { dimmingEnabled: true, brightnessPercent: 80 },
      holdSeconds: 300
    }));
  });

  it("keeps event numeric validation inputs as shared string fields", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 추가" });

    expect(within(dialog).getByRole("textbox", { name: "밝기" })).toHaveAttribute("inputmode", "numeric");
    fireEvent.click(within(dialog).getByRole("button", { name: "직접 입력" }));
    expect(within(dialog).getByRole("textbox", { name: "유지 시간" })).toHaveAttribute("inputmode", "numeric");
  });

  it("submits the exact edit payload for custom hold and dimming-off normalization", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 수정" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 수정" });

    fireEvent.click(within(dialog).getByRole("button", { name: "직접 입력" }));
    fireEvent.change(within(dialog).getByLabelText("유지 시간"), { target: { value: "75" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "고급 설정" }));
    fireEvent.click(within(dialog).getByLabelText("디밍 사용"));
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => expect(mocks.updateVehicleEventRule).toHaveBeenCalledWith(siteId, rule().id, {
      name: "입구 차량 감지",
      status: "enabled",
      sourceFixtureIds: [sensorFixtureId],
      targetFixtureIds: [targetFixtureId],
      action: { dimmingEnabled: false, brightnessPercent: 100 },
      holdSeconds: 75
    }));
  });

  it("submits exact custom brightness and hold values while dimming stays enabled", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 수정" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 수정" });

    fireEvent.change(within(dialog).getByLabelText("밝기"), { target: { value: "63" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "직접 입력" }));
    fireEvent.change(within(dialog).getByLabelText("유지 시간"), { target: { value: "75" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => expect(mocks.updateVehicleEventRule).toHaveBeenCalledWith(siteId, rule().id, {
      name: "입구 차량 감지",
      status: "enabled",
      sourceFixtureIds: [sensorFixtureId],
      targetFixtureIds: [targetFixtureId],
      action: { dimmingEnabled: true, brightnessPercent: 63 },
      holdSeconds: 75
    }));
  });

  it("connects submit errors to the first invalid control group and focuses it", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "이벤트 추가" })).getByRole("button", { name: "저장" }));

    const sourceSection = screen.getByRole("group", { name: "감지 센서 선택" });
    const sourceError = screen.getByText("감지 센서를 한 개 이상 선택하세요.");
    expect(sourceSection).toHaveAttribute("aria-invalid", "true");
    expect(sourceSection).toHaveAttribute("aria-describedby", "vehicle-event-source-error");
    expect(sourceSection).toHaveAttribute("aria-errormessage", "vehicle-event-source-error");
    expect(sourceError).toHaveAttribute("id", "vehicle-event-source-error");
    expect(sourceSection).toHaveFocus();
  });

  it("expires the principal after an unauthorized mutation finishes following unmount", async () => {
    const deferred = deferredPromise<ReturnType<typeof rule>>();
    mocks.createVehicleEventRule.mockReturnValueOnce(deferred.promise);
    const queryClient = testQueryClient();
    queryClient.setQueryData(authMeQueryKey, { user: authUser("user-1") });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { unmount } = renderPanel("admin", { queryClient });
    await submitValidCreate();
    unmount();
    deferred.reject(new ApiError("unauthorized", 401, null));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: authMeQueryKey }));
  });

  it("invalidates event and dashboard caches after a successful mutation finishes following unmount", async () => {
    const deferred = deferredPromise<ReturnType<typeof rule>>();
    mocks.createVehicleEventRule.mockReturnValueOnce(deferred.promise);
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { unmount } = renderPanel("admin", { queryClient });
    await submitValidCreate();
    unmount();
    deferred.resolve(rule());

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: vehicleEventRuleQueryKey(siteId) }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
  });

  it("treats an initial list 401 as principal expiry", async () => {
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mocks.listVehicleEventRules.mockRejectedValueOnce(new ApiError("unauthorized", 401, null));
    renderPanel("admin", { queryClient });

    expect(await screen.findByRole("alert")).toHaveTextContent("로그인 세션이 만료되었습니다.");
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: authMeQueryKey }));
  });

  it("treats a next-page 401 as principal expiry", async () => {
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mocks.listVehicleEventRules
      .mockResolvedValueOnce({ items: [rule()], total: 2, nextCursor: "next-page" })
      .mockRejectedValueOnce(new ApiError("unauthorized", 401, null));
    renderPanel("admin", { queryClient });
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("로그인 세션이 만료되었습니다.");
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: authMeQueryKey }));
  });

  it("treats a background refresh 401 as principal expiry", async () => {
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderPanel("admin", { queryClient });
    await screen.findByText("입구 차량 감지");
    mocks.listVehicleEventRules.mockRejectedValueOnce(new ApiError("unauthorized", 401, null));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("로그인 세션이 만료되었습니다.");
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: authMeQueryKey }));
    expect(screen.queryByText("입구 차량 감지")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "입구 차량 감지 비활성화" })).not.toBeInTheDocument();
  });

  it("closes an open event editor on cached-list 401 and focuses recovery", async () => {
    const { queryClient } = renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 수정" }));
    expect(screen.getByRole("dialog", { name: "이벤트 수정" })).toBeInTheDocument();
    mocks.listVehicleEventRules.mockRejectedValueOnce(new ApiError("unauthorized", 401, null));
    await act(async () => { await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); });
    await waitFor(() => expect(queryClient.getQueryState(vehicleEventRuleQueryKey(siteId))?.error).toBeInstanceOf(ApiError));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "이벤트 수정" })).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("로그인 세션이 만료되었습니다.");
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 다시 조회" })).toHaveFocus());
    expect(mocks.updateVehicleEventRule).not.toHaveBeenCalled();
  });

  it("closes an open event deletion on cached-list 401 without deleting", async () => {
    const { queryClient } = renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "입구 차량 감지 삭제" }));
    const confirm = within(screen.getByRole("dialog", { name: "이벤트 규칙 삭제" })).getByRole("button", { name: "삭제" });
    mocks.listVehicleEventRules.mockRejectedValueOnce(new ApiError("unauthorized", 401, null));
    await act(async () => { await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) }); });
    await waitFor(() => expect(queryClient.getQueryState(vehicleEventRuleQueryKey(siteId))?.error).toBeInstanceOf(ApiError));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "이벤트 규칙 삭제" })).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("로그인 세션이 만료되었습니다.");
    fireEvent.click(confirm);
    expect(mocks.deleteVehicleEventRule).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 다시 조회" })).toHaveFocus());
  });
});

function panelElement(role: "admin" | "viewer", queryClient: QueryClient, panelSiteId = siteId, scopeKey = panelSiteId, panelDashboard = dashboard, panelKey?: string) {
  return <QueryClientProvider client={queryClient}>
    <SessionStatusProvider><SessionStatusCenter /><ToastRegion /><VehicleEventControlPanel key={panelKey} siteId={panelSiteId} role={role} dashboard={panelDashboard} scopeKey={scopeKey} /></SessionStatusProvider>
  </QueryClientProvider>;
}

function authUser(id: string): AuthUser {
  return { id, organizationId: "org-1", organizationType: "customer", loginId: id, name: id, role: "admin", status: "active", mustChangePassword: false };
}

function renderPanel(
  role: "admin" | "viewer",
  { queryClient = testQueryClient(), dashboard: panelDashboard = dashboard }: { queryClient?: QueryClient; dashboard?: Dashboard } = {}
) {
  return {
    ...render(panelElement(role, queryClient, siteId, siteId, panelDashboard)),
    queryClient
  };
}

function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

async function submitValidCreate() {
  await screen.findByText("입구 차량 감지");
  fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
  const dialog = screen.getByRole("dialog", { name: "이벤트 추가" });
  fireEvent.click(within(dialog).getByRole("button", { name: "감지 센서 선택" }));
  fireEvent.click(within(dialog).getByRole("button", { name: /B1-SENSOR-001/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "1개 조명 선택 완료" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "실행할 조명 선택" }));
  fireEvent.click(within(dialog).getByRole("button", { name: /B1-L001/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "1개 조명 선택 완료" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(mocks.createVehicleEventRule).toHaveBeenCalledTimes(1));
}

function deferredPromise<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function fixture(
  id: string,
  name: string,
  vehicleSensorCapabilityStatus: "supported" | "unsupported" | "unknown",
  vehicleSensorCapabilityVerifiedAt: string | null
): Dashboard["floors"][number]["fixtures"][number] {
  return {
    id, name, x: 0, y: 0, ratedWatt: 40, brightness: 70, status: "online", health: null,
    rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: null,
    gateway: { id: "gateway-1", name: "GW-B1", connectionStatus: "online" },
    controllable: true, controlBlockReason: null,
    vehicleSensorCapabilityStatus, vehicleSensorCapabilityVerifiedAt
  };
}

function rule(overrides: Partial<VehicleEventRuleResponse> = {}): VehicleEventRuleResponse {
  return {
    id: "00000000-0000-4000-8000-000000000011",
    name: "입구 차량 감지",
    status: "enabled" as const,
    sourceFixtureIds: [sensorFixtureId],
    targetFixtureIds: [targetFixtureId],
    action: { dimmingEnabled: true, brightnessPercent: 80 },
    holdSeconds: 60,
    gatewayId: "gateway-1",
    sources: [{ fixtureId: sensorFixtureId }],
    targets: [{ fixtureId: targetFixtureId }],
    sourceCount: 1,
    targetCount: 1,
    desiredRevision: 3,
    appliedRevision: 2,
    syncStatus: "PENDING" as const,
    lastDetection: null,
    lastExecution: null,
    createdById: "user-1",
    updatedById: "user-1",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides
  };
}
