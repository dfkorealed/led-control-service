import type { FloorMapSnapshot } from "@led-control/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateVehicleEventRuleInput, VehicleEventRuleResponse } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { VehicleEventDialog } from "./VehicleEventDialog";

const floorMapQuery = vi.hoisted(() => vi.fn());

vi.mock("../../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/queries")>()),
  useFloorMapSnapshot: floorMapQuery
}));

const sourceFixtureId = "00000000-0000-4000-8000-000000000003";
const targetFixtureA = "00000000-0000-4000-8000-000000000004";
const targetFixtureB = "00000000-0000-4000-8000-000000000005";
const otherGatewayFixtureId = "00000000-0000-4000-8000-000000000006";
const ineligibleSourceFixtureId = "00000000-0000-4000-8000-000000000007";
const floorId = "00000000-0000-4000-8000-000000000002";
const groupId = "00000000-0000-4000-8000-000000000008";

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
  summary: { totalFixtures: 5, onlineFixtures: 5, faultFixtures: 0, averageBrightness: 70 },
  floors: [{
    id: floorId, name: "B2", level: -2, floorPlan: null,
    meshControlGroups: [{ gatewayId: "gateway-a", status: "ready", version: 1, error: null }],
    fixtures: [
      fixture(sourceFixtureId, "Gateway A 감지 조명", 100, "gateway-a", "supported"),
      fixture(targetFixtureA, "Gateway A 입구등", 200, "gateway-a"),
      fixture(targetFixtureB, "Gateway A 통로등", 300, "gateway-a"),
      fixture(otherGatewayFixtureId, "Gateway B 감지 조명", 400, "gateway-b", "supported"),
      fixture(ineligibleSourceFixtureId, "차량 감지 모델 미설정", 500, "gateway-a", "unsupported")
    ]
  }],
  groups: [{
    id: groupId, name: "B2 입구 구역", floorId, gatewayId: "gateway-a", lifecycleStatus: "active", fixtureCount: 2,
    meshControlGroup: { status: "ready", version: 1, error: null }, fixtureIds: [targetFixtureB, targetFixtureA]
  }],
  gateways: []
};

describe("VehicleEventDialog spatial source and targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    floorMapQuery.mockReturnValue({ data: snapshot, error: null, isLoading: false, isFetching: false });
  });

  afterEach(cleanup);

  it("returns from an empty source picker to the preserved form and trigger", async () => {
    renderVehicleEventDialog();
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    openSourceView();
    expect(screen.getByRole("button", { name: "선택 완료" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "설정으로 돌아가기" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "감지 센서 선택" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "50%" })).toHaveAttribute("aria-pressed", "true");
  });

  it("recovers a deleted source after dashboard refresh without closing the editor", () => {
    const rule = existingRule();
    const onClose = vi.fn();
    const view = renderVehicleEventDialog({ rule, onClose });
    openSourceView();
    const refreshed = { ...dashboard, floors: [{ ...dashboard.floors[0], fixtures: dashboard.floors[0].fixtures.filter((item) => item.id !== sourceFixtureId) }] };
    view.rerender(<VehicleEventDialog open rule={rule} dashboard={refreshed} isPending={false} serverError="" onClose={onClose} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "1개 조명 선택 완료" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "선택 비우기" }));
    fireEvent.click(screen.getByRole("button", { name: /Gateway B 감지 조명/ }));
    fireEvent.click(screen.getByRole("button", { name: "1개 조명 선택 완료" }));
    expect(screen.getByRole("group", { name: "감지 센서" })).toHaveTextContent("Gateway B 감지 조명");
    expect(screen.getByRole("button", { name: "실행할 조명 선택" })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps event sources fixture-only and resolves a target group to fixture ids", () => {
    const onSubmit = vi.fn<(input: CreateVehicleEventRuleInput) => void>();
    renderVehicleEventDialog({ onSubmit });

    openSourceView();
    expect(screen.queryByRole("button", { name: "저장된 구역" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Gateway A 감지 조명/ }));
    fireEvent.click(screen.getByRole("button", { name: "1개 조명 선택 완료" }));

    openTargetView();
    fireEvent.click(screen.getByRole("button", { name: "저장된 구역" }));
    fireEvent.click(screen.getByRole("button", { name: "B2 입구 구역" }));
    fireEvent.click(screen.getByRole("button", { name: "2개 조명 선택 완료" }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      sourceFixtureIds: [sourceFixtureId],
      targetFixtureIds: [targetFixtureA, targetFixtureB]
    }));
  });

  it("requires an eligible source before target selection can open", () => {
    renderVehicleEventDialog();

    const targetAction = screen.getByRole("button", { name: "실행할 조명 선택" });

    expect(targetAction).toBeDisabled();
    expect(screen.getByRole("group", { name: "실행할 조명" })).toHaveTextContent(
      "감지 센서를 먼저 선택하면 같은 게이트웨이의 실행 조명을 고를 수 있습니다.",
    );

    fireEvent.click(targetAction);

    expect(screen.queryByRole("heading", { name: "실행할 조명 선택" })).not.toBeInTheDocument();
  });

  it("disables target fixtures outside the selected source gateway", () => {
    renderVehicleEventDialog({ rule: existingRule({ sourceFixtureIds: [sourceFixtureId] }) });

    openTargetView();
    expect(screen.getByRole("button", { name: /Gateway B 감지 조명.*선택 불가/ })).toBeDisabled();
  });

  it("shows an ineligible vehicle source but does not allow selection", () => {
    renderVehicleEventDialog();

    openSourceView();
    expect(screen.getByRole("button", { name: /차량 감지 모델 미설정.*선택 불가/ })).toBeDisabled();
  });

  it("clears incompatible targets when the source gateway changes", () => {
    const onSubmit = vi.fn<(input: CreateVehicleEventRuleInput) => void>();
    renderVehicleEventDialog({ rule: existingRule({ sourceFixtureIds: [sourceFixtureId], targetFixtureIds: [targetFixtureA] }), onSubmit });

    openSourceView();
    fireEvent.click(screen.getByRole("button", { name: /Gateway A 감지 조명.*선택됨/ }));
    fireEvent.click(screen.getByRole("button", { name: /Gateway B 감지 조명/ }));
    fireEvent.click(screen.getByRole("button", { name: "1개 조명 선택 완료" }));

    expect(screen.getByRole("group", { name: "실행할 조명" })).toHaveTextContent("실행할 조명을 선택해 주세요.");
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("제어 조명을 한 개 이상 선택하세요.")).toBeVisible();
  });

  it("reloads persisted source and target fixture ids as direct selections", () => {
    renderVehicleEventDialog({ rule: existingRule({ sourceFixtureIds: [sourceFixtureId], targetFixtureIds: [targetFixtureA, targetFixtureB] }) });

    openSourceView();
    expect(screen.queryByRole("button", { name: "저장된 구역" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Gateway A 감지 조명.*선택됨/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "1개 조명 선택 완료" }));

    openTargetView();
    expect(screen.getByRole("button", { name: "직접 선택" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Gateway A 입구등.*선택됨/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Gateway A 통로등.*선택됨/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a group target as a stable sorted fixture-id snapshot", () => {
    const rule = existingRule({ sourceFixtureIds: [sourceFixtureId] });
    const view = renderVehicleEventDialog({ rule });

    openTargetView();
    fireEvent.click(screen.getByRole("button", { name: "저장된 구역" }));
    fireEvent.click(screen.getByRole("button", { name: "변경" }));
    fireEvent.click(screen.getByRole("button", { name: "B2 입구 구역" }));
    fireEvent.click(screen.getByRole("button", { name: "2개 조명 선택 완료" }));
    expect(screen.getByRole("group", { name: "실행할 조명" })).toHaveTextContent("B2 입구 구역");
    expect(screen.getByRole("group", { name: "실행할 조명" })).toHaveTextContent("2개 조명 스냅샷");

    view.rerender(<VehicleEventDialog open rule={rule} dashboard={{
      ...dashboard,
      groups: [{ ...dashboard.groups[0], fixtureCount: 1, fixtureIds: [targetFixtureA] }]
    }} isPending={false} serverError="" onClose={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByRole("group", { name: "실행할 조명" })).toHaveTextContent("2개 조명 스냅샷");
  });
});

function renderVehicleEventDialog(overrides: Partial<React.ComponentProps<typeof VehicleEventDialog>> = {}) {
  return render(<VehicleEventDialog open rule={null} dashboard={dashboard} isPending={false} serverError="" onClose={vi.fn()} onSubmit={vi.fn()} {...overrides} />);
}

function openSourceView() {
  fireEvent.click(screen.getByRole("button", { name: /감지 센서 (선택|변경)/ }));
}

function openTargetView() {
  fireEvent.click(screen.getByRole("button", { name: /실행할 조명 (선택|변경)/ }));
}

function existingRule(overrides: Partial<VehicleEventRuleResponse> = {}): VehicleEventRuleResponse {
  return {
    id: "00000000-0000-4000-8000-000000000009",
    name: "입구 차량 감지",
    status: "enabled",
    sourceFixtureIds: [sourceFixtureId],
    sourceCount: 1,
    targetFixtureIds: [targetFixtureA],
    targetCount: 1,
    action: { dimmingEnabled: true, brightnessPercent: 70 },
    holdSeconds: 60,
    gatewayId: "gateway-a",
    sources: [{ fixtureId: sourceFixtureId }],
    targets: [{ fixtureId: targetFixtureA }],
    desiredRevision: 1,
    appliedRevision: 1,
    syncStatus: "APPLIED",
    lastDetection: null,
    lastExecution: null,
    createdById: "user-1",
    updatedById: "user-1",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides
  };
}

function fixture(
  id: string,
  name: string,
  x: number,
  gatewayId: string,
  vehicleSensorCapabilityStatus: "supported" | "unsupported" = "unsupported"
): Dashboard["floors"][number]["fixtures"][number] {
  return {
    id, name, x, y: 100, ratedWatt: 40, brightness: 70, status: "online", health: null,
    rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: null,
    gateway: { id: gatewayId, name: gatewayId, connectionStatus: "online" },
    controllable: true, controlBlockReason: null, placementStatus: "placed",
    vehicleSensorCapabilityStatus,
    vehicleSensorCapabilityVerifiedAt: vehicleSensorCapabilityStatus === "supported" ? "2026-09-01T00:00:00.000Z" : null
  };
}
