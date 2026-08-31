import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});

function renderPanel(role: "admin" | "viewer") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <VehicleEventControlPanel siteId={siteId} role={role} dashboard={dashboard} />
    </QueryClientProvider>
  );
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

function rule() {
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
    updatedAt: "2026-08-31T00:00:00.000Z"
  };
}
