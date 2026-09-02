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

  it("validates empty source and target selections before a create request", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");

    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "이벤트 추가" })).getByRole("button", { name: "저장" }));

    expect(screen.getByText("감지 센서를 한 개 이상 선택하세요.")).toBeInTheDocument();
    expect(screen.getByText("제어 조명을 한 개 이상 선택하세요.")).toBeInTheDocument();
    expect(mocks.createVehicleEventRule).not.toHaveBeenCalled();
  });

  it("offers only Gateway-registered, capability-confirmed fixtures as sources", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));

    const sourceSection = screen.getByRole("group", { name: "감지 센서" });
    expect(within(sourceSection).getByLabelText("B1-SENSOR-001 선택")).toBeInTheDocument();
    expect(within(sourceSection).queryByLabelText("B1-L001 선택")).not.toBeInTheDocument();
    expect(within(sourceSection).queryByLabelText("B1-L002 선택")).not.toBeInTheDocument();
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

    const sourceSection = screen.getByRole("group", { name: "감지 센서" });
    expect(within(sourceSection).queryByLabelText("B1-SENSOR-001 선택")).not.toBeInTheDocument();
    expect(within(sourceSection).queryByLabelText("B1-SENSOR-INVALID 선택")).not.toBeInTheDocument();
  });

  it("connects submit errors to the first invalid control group and focuses it", async () => {
    renderPanel("admin");
    await screen.findByText("입구 차량 감지");
    fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "이벤트 추가" })).getByRole("button", { name: "저장" }));

    const sourceSection = screen.getByRole("group", { name: "감지 센서" });
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
  return render(
    <QueryClientProvider client={queryClient}>
      <VehicleEventControlPanel siteId={siteId} role={role} dashboard={panelDashboard} />
    </QueryClientProvider>
  );
}

function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

async function submitValidCreate() {
  await screen.findByText("입구 차량 감지");
  fireEvent.click(screen.getByRole("button", { name: "이벤트 추가" }));
  const sourceSection = screen.getByRole("group", { name: "감지 센서" });
  const targetSection = screen.getByRole("group", { name: "제어 조명" });
  fireEvent.click(within(sourceSection).getByLabelText("B1-SENSOR-001 선택"));
  fireEvent.click(within(targetSection).getByLabelText("B1-L001 선택"));
  fireEvent.click(within(screen.getByRole("dialog", { name: "이벤트 추가" })).getByRole("button", { name: "저장" }));
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
