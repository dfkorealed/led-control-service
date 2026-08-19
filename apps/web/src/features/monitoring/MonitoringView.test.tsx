import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitoringView } from "./MonitoringView";

const queryMocks = vi.hoisted(() => ({
  useDashboard: vi.fn(),
  useFloorFixtures: vi.fn(),
  useFloorMapSnapshot: vi.fn()
}));

vi.mock("../../api/queries", () => queryMocks);

const dashboard = {
  site: { id: "site-1", name: "테스트 현장" },
  summary: { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, averageBrightness: 70 },
  floors: [{ id: "floor-1", name: "B1", level: -1, floorPlan: null, fixtures: [] }],
  groups: [],
  gateways: []
};

const fixture = {
  id: "fixture-1",
  name: "B1-L001",
  x: 100,
  y: 100,
  ratedWatt: 40,
  brightness: 70,
  status: "online" as const,
  statusReason: "reported" as const,
  rssi: null,
  hopCount: null,
  commandSuccessRate: null,
  lastSeenAt: "2026-08-19T01:00:00.000Z",
  health: { faultCodes: [4], observedAt: "2026-08-19T01:00:01.000Z" },
  gateway: { id: "gateway-1", name: "GW-1", connectionStatus: "online" as const },
  controllable: true,
  controlBlockReason: null
};

describe("MonitoringView refresh", () => {
  const refetchDashboard = vi.fn();
  const refetchFixtures = vi.fn();
  const refetchMap = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    refetchDashboard.mockResolvedValue({ data: dashboard });
    refetchFixtures.mockResolvedValue({ data: { pages: [{ items: [fixture], nextCursor: null }] } });
    refetchMap.mockResolvedValue({ data: mapSnapshot });
    queryMocks.useDashboard.mockReturnValue({
      data: dashboard,
      isLoading: false,
      error: null,
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      refetch: refetchDashboard
    });
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture], nextCursor: null }] },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });
    queryMocks.useFloorMapSnapshot.mockReturnValue({
      data: mapSnapshot,
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      error: null,
      refetch: refetchMap
    });
  });

  afterEach(() => cleanup());

  it("refreshes dashboard, current-floor fixtures, and the saved map together", async () => {
    render(<MonitoringView siteId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));

    await waitFor(() => {
      expect(refetchDashboard).toHaveBeenCalledTimes(1);
      expect(refetchFixtures).toHaveBeenCalledTimes(1);
      expect(refetchMap).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/마지막 갱신:/)).toBeInTheDocument();
  });

  it("locks the refresh action until both requests settle", async () => {
    const dashboardRequest = deferred<unknown>();
    const fixtureRequest = deferred<unknown>();
    const mapRequest = deferred<unknown>();
    refetchDashboard.mockReturnValueOnce(dashboardRequest.promise);
    refetchFixtures.mockReturnValueOnce(fixtureRequest.promise);
    refetchMap.mockReturnValueOnce(mapRequest.promise);
    render(<MonitoringView siteId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));

    expect(screen.getByRole("button", { name: "새로고침 중" })).toBeDisabled();
    dashboardRequest.resolve({ data: dashboard });
    fixtureRequest.resolve({ data: { pages: [{ items: [fixture], nextCursor: null }] } });
    mapRequest.resolve({ data: mapSnapshot });
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled());
  });

  it("keeps successful data and reports a partial refresh failure", async () => {
    refetchDashboard.mockRejectedValueOnce(new Error("dashboard unavailable"));
    render(<MonitoringView siteId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));

    expect(await screen.findByRole("status")).toHaveTextContent("일부 현황 데이터를 새로고침하지 못했습니다.");
    expect(screen.getAllByText("B1-L001")).not.toHaveLength(0);
  });

  it("shows the latest Health Current fault snapshot", () => {
    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByText("장비 Health")).toBeInTheDocument();
    expect(screen.getByText("장애 (0x04)")).toBeInTheDocument();
    expect(screen.getByText("Health 수신")).toBeInTheDocument();
  });
});

const mapSnapshot = {
  floorId: "00000000-0000-4000-8000-000000000003",
  revision: 1,
  width: 1200,
  height: 800,
  floorPlan: null,
  objects: []
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
