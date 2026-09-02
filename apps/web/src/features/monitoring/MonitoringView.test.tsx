import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitoringView } from "./MonitoringView";

const queryMocks = vi.hoisted(() => ({
  useDashboard: vi.fn(),
  useFloorFixtures: vi.fn(),
  useFloorMapSnapshot: vi.fn()
}));

vi.mock("../../api/queries", () => queryMocks);
vi.mock("../registration/RegistrationPanel", () => ({
  RegistrationPanel: () => <section aria-label="조명 등록 패널">조명 등록 패널</section>
}));

const dashboard = {
  site: { id: "site-1", name: "테스트 현장" },
  summary: { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, averageBrightness: 70 },
  floors: [{ id: "floor-1", name: "B1", level: -1, floorPlan: null, fixtures: [] }],
  groups: [],
  gateways: [{ id: "gateway-1", name: "GW-1", connectionStatus: "online" }]
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

  it("presents the populated floor with semantic metrics and selected fixture detail", () => {
    const faultFixture = {
      ...fixture,
      id: "fixture-2",
      name: "B1-L002",
      brightness: 72,
      status: "fault" as const
    };
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture, faultFixture], nextCursor: null }] },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });

    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByRole("heading", { name: "운영 현황" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "전체 조명" })).toHaveTextContent("2");
    expect(screen.getByRole("group", { name: "정상" })).toHaveTextContent("1");
    expect(screen.getByRole("group", { name: "점검 필요" })).toHaveTextContent("1");
    expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("72%");
    const selectedFixtureDetail = screen.getByRole("region", { name: "선택 조명 정보" });
    expect(within(selectedFixtureDetail).getByRole("heading", { name: "점검 큐" })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "선택 조명 상세" })).getByText(
      /정상|장애|오프라인|상태 확인 대기/,
      { selector: ".ui-status-badge > span" }
    )).toBeVisible();
  });

  it("keeps the mobile fixture selector and map marker selection in sync", async () => {
    const faultFixture = {
      ...fixture,
      id: "fixture-2",
      name: "B1-L002",
      brightness: 42,
      status: "fault" as const
    };
    queryMocks.useFloorFixtures.mockReturnValue({
      data: { pages: [{ items: [fixture, faultFixture], nextCursor: null }] },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchFixtures
    });

    render(<MonitoringView siteId="site-1" />);

    const selector = await screen.findByRole("combobox", { name: "상세 조명 선택" });
    expect(selector).toHaveValue("fixture-2");
    expect(within(screen.getByRole("complementary", { name: "선택 조명 상세" })).getByRole("heading", { name: "B1-L002" })).toBeVisible();

    fireEvent.change(selector, { target: { value: "fixture-1" } });
    expect(within(screen.getByRole("complementary", { name: "선택 조명 상세" })).getByRole("heading", { name: "B1-L001" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "B1-L002 장애 42%" }));
    expect(selector).toHaveValue("fixture-2");
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

  it("이미 등록된 조명이 있어도 관리자는 진행 중 등록 세션에 접근할 수 있다", () => {
    render(<MonitoringView siteId="site-1" userRole="admin" />);

    expect(screen.getByRole("region", { name: "조명 등록 패널" })).toBeInTheDocument();
  });

  it("지도 최초 조회 실패에는 빈 캔버스 대신 오류와 재시도를 표시한다", () => {
    queryMocks.useFloorMapSnapshot.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      error: new Error("map unavailable"),
      refetch: refetchMap
    });
    render(<MonitoringView siteId="site-1" />);

    expect(screen.getByText("저장된 지도를 불러오지 못했습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "지도 다시 시도" }));
    expect(refetchMap).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "층 도면" })).not.toBeInTheDocument();
  });

  it("이전 지도 snapshot이 있을 때 갱신 실패를 알리고 지도를 유지한다", async () => {
    refetchMap.mockRejectedValueOnce(new Error("map unavailable"));
    render(<MonitoringView siteId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));

    expect(await screen.findByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "층 도면" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "지도 다시 시도" }));
    expect(refetchMap).toHaveBeenCalledTimes(2);
  });

  it("한 층의 지도 갱신 실패를 다른 층의 성공한 지도에 표시하지 않는다", async () => {
    const twoFloorDashboard = {
      ...dashboard,
      floors: [
        dashboard.floors[0],
        { ...dashboard.floors[0], id: "floor-2", name: "B2", level: -2 }
      ]
    };
    const firstFloorRefetch = vi.fn().mockRejectedValue(new Error("floor 1 map unavailable"));
    const secondFloorRefetch = vi.fn().mockResolvedValue({ data: { ...mapSnapshot, floorId: "floor-2" } });
    queryMocks.useDashboard.mockReturnValue({
      data: twoFloorDashboard,
      isLoading: false,
      error: null,
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      refetch: refetchDashboard
    });
    queryMocks.useFloorMapSnapshot.mockImplementation((floorId: string) => ({
      data: { ...mapSnapshot, floorId },
      dataUpdatedAt: new Date("2026-08-19T01:00:00.000Z").getTime(),
      error: null,
      refetch: floorId === "floor-1" ? firstFloorRefetch : secondFloorRefetch
    }));
    render(<MonitoringView siteId="site-1" />);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(await screen.findByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "B2" }));

    expect(await screen.findByRole("heading", { name: "운영 현황" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B2" })).toHaveClass("active");
    expect(screen.queryByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).not.toBeInTheDocument();
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
