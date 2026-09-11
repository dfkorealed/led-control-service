import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { authMeQueryKey } from "../../../api/principal-cache";
import { vehicleEventRuleQueryKey, type VehicleEventRuleResponse } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { VehicleEventControlPanel } from "./VehicleEventControlPanel";

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
const dashboard: Dashboard = {
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
    mocks.listVehicleEventRules.mockResolvedValue({ items: [rule()], total: 1, nextCursor: null });
    mocks.createVehicleEventRule.mockResolvedValue(rule());
    mocks.updateVehicleEventRule.mockResolvedValue(rule());
    mocks.deleteVehicleEventRule.mockResolvedValue({ id: rule().id, deleted: true });
  });

  afterEach(cleanup);

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

  it("uses a level-three panel heading and shared add button", async () => {
    renderPanel("admin");

    expect(await screen.findByRole("heading", { name: "이벤트 제어", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이벤트 추가" })).toHaveClass("ui-button", "ui-button-primary");
  });

  it("uses shared dialog action buttons", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 추가" });

    expect(within(dialog).getByRole("button", { name: "취소" })).toHaveClass("ui-button", "ui-button-secondary");
    expect(within(dialog).getByRole("button", { name: "저장" })).toHaveClass("ui-button", "ui-button-primary");
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
    expect(within(dialog).getByLabelText("B1-SENSOR-001 선택")).toBeVisible();
    expect(within(dialog).queryByLabelText("B1-L001 선택")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText("B1-SENSOR-001 선택"));
    fireEvent.click(within(dialog).getByRole("button", { name: "선택 완료" }));

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

    expect((await screen.findByText("적용 대기")).closest(".ui-status-badge")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("적용됨").closest(".ui-status-badge")).toHaveAttribute("data-tone", "success");
    expect(screen.getByText("적용 실패").closest(".ui-status-badge")).toHaveAttribute("data-tone", "danger");
  });

  it("차량 이벤트 목록은 polling 실패에도 기존 행과 retry를 유지한다", async () => {
    const { queryClient } = renderPanel("admin");
    expect(await screen.findByRole("table", { name: "차량 이벤트 목록" })).toBeInTheDocument();

    mocks.listVehicleEventRules.mockRejectedValueOnce(new Error("poll failed"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: vehicleEventRuleQueryKey(siteId) });
    });

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveClass("ui-feedback-state");
    expect(warning).toHaveTextContent("Gateway 적용 상태를 새로고침하지 못했습니다. 표시된 상태가 최신이 아닐 수 있습니다.");
    expect(screen.getByText("입구 차량 감지")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "상태 다시 조회" })).toBeInTheDocument();
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
    fireEvent.click(within(dialog).getByLabelText("B1-SENSOR-001 선택"));
    fireEvent.click(within(dialog).getByRole("button", { name: "선택 완료" }));
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
    expect(within(dialog).getByLabelText("B1-SENSOR-001 선택")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("B1-L001 선택")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("B1-L002 선택")).not.toBeInTheDocument();
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
    expect(within(dialog).queryByLabelText("B1-SENSOR-001 선택")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("B1-SENSOR-INVALID 선택")).not.toBeInTheDocument();
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
    expect(within(dialog).queryByLabelText("B1-SENSOR-001 선택")).not.toBeInTheDocument();
    expect(mocks.updateVehicleEventRule).not.toHaveBeenCalled();
  });

  it("submits the exact quick-create payload for selected presets", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    const dialog = screen.getByRole("dialog", { name: "이벤트 추가" });

    fireEvent.click(within(dialog).getByRole("button", { name: "감지 센서 선택" }));
    fireEvent.click(within(dialog).getByLabelText("B1-SENSOR-001 선택"));
    fireEvent.click(within(dialog).getByRole("button", { name: "선택 완료" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "실행할 조명 선택" }));
    fireEvent.click(within(dialog).getByLabelText("B1-L001 선택"));
    fireEvent.click(within(dialog).getByRole("button", { name: "선택 완료" }));
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
  });
});

function renderPanel(
  role: "admin" | "viewer",
  { queryClient = testQueryClient(), dashboard: panelDashboard = dashboard }: { queryClient?: QueryClient; dashboard?: Dashboard } = {}
) {
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <VehicleEventControlPanel siteId={siteId} role={role} dashboard={panelDashboard} />
      </QueryClientProvider>
    ),
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
  fireEvent.click(within(dialog).getByLabelText("B1-SENSOR-001 선택"));
  fireEvent.click(within(dialog).getByRole("button", { name: "선택 완료" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "실행할 조명 선택" }));
  fireEvent.click(within(dialog).getByLabelText("B1-L001 선택"));
  fireEvent.click(within(dialog).getByRole("button", { name: "선택 완료" }));
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
