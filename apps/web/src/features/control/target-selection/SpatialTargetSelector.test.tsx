import type { FloorMapSnapshot } from "@led-control/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dashboard } from "../../../api/queries";
import { SpatialTargetSelector } from "./SpatialTargetSelector";

const floorMapQuery = vi.hoisted(() => vi.fn());

vi.mock("../../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/queries")>()),
  useFloorMapSnapshot: floorMapQuery
}));

const fixtureA = "fixture-a";
const fixtureB = "fixture-b";
const fixtureOtherGateway = "fixture-other-gateway";
const groupId = "group-a";
const onChange = vi.fn();

const snapshot: FloorMapSnapshot = {
  floorId: "floor-b2",
  revision: 1,
  width: 600,
  height: 400,
  floorPlan: null,
  objects: []
};

const dashboard: Dashboard = {
  generatedAt: "2026-09-16T00:00:00.000Z",
  monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
  site: { id: "site-a", name: "테스트 현장", customerName: "고객사", installationStatus: "installed", address: null, tariffKwhRate: null, timeZone: "Asia/Seoul" },
  summary: { totalFixtures: 3, onlineFixtures: 3, faultFixtures: 0, averageBrightness: 70 },
  floors: [{
    id: "floor-b2", name: "B2", level: -2, floorPlan: null,
    meshControlGroups: [{ gatewayId: "gateway-a", status: "ready", version: 1, error: null }],
    fixtures: [
      fixture(fixtureA, "B2-L001", 100, 100),
      fixture(fixtureB, "B2-L002", 200, 100),
      fixture(fixtureOtherGateway, "B2-L003", 300, 100, "gateway-b")
    ]
  }],
  groups: [{
    id: groupId, name: "B2 입구 구역", floorId: "floor-b2", gatewayId: "gateway-a", lifecycleStatus: "active", fixtureCount: 2,
    meshControlGroup: { status: "ready", version: 1, error: null }, fixtureIds: [fixtureA, fixtureB]
  }],
  gateways: []
};

describe("SpatialTargetSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    floorMapQuery.mockReturnValue({ data: snapshot, error: null, isLoading: false, isFetching: false });
  });

  afterEach(cleanup);

  it("keeps map, list, and summary on one selection state", () => {
    renderSelector({ selection: { mode: "fixtures", fixtureIds: [] } });
    fireEvent.click(screen.getByRole("button", { name: /B2-L001/ }));

    expect(onChange).toHaveBeenLastCalledWith({ mode: "fixtures", fixtureIds: [fixtureA] });
    expect(screen.getByText("1개 선택")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
    expect(screen.getByRole("checkbox", { name: "B2-L001 선택" })).toBeChecked();
  });

  it("keeps unplaced fixtures in the list when no marker exists", () => {
    renderSelector({ dashboard: dashboardWithUnplacedFixture });
    fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
    expect(screen.getByText("미배치")).toBeInTheDocument();
  });

  it("opens the list fallback when the floor has no map snapshot", () => {
    floorMapQuery.mockReturnValue({ data: undefined, error: { status: 404 }, isLoading: false, isFetching: false });
    renderSelector();
    expect(screen.getByText("등록된 도면이 없어 목록으로 선택합니다.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "조명 목록" })).toBeInTheDocument();
  });

  it("highlights group members without rendering a persisted boundary", () => {
    renderSelector({ selection: { mode: "group", groupId } });
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(2);
    expect(screen.queryByTestId("saved-group-polygon")).not.toBeInTheDocument();
  });

  it("requires confirmation before discarding a non-empty selection mode", () => {
    renderSelector({ selection: { mode: "fixtures", fixtureIds: [fixtureA] } });
    fireEvent.click(screen.getByRole("button", { name: "저장된 구역" }));
    expect(screen.getByRole("alertdialog", { name: "선택 방식 변경" })).toBeInTheDocument();
  });

  it("keeps cached map data visible beside a refresh warning", () => {
    floorMapQuery.mockReturnValue({ data: snapshot, error: new Error("refresh failed"), isLoading: false, isFetching: false });
    renderSelector();
    expect(screen.getByRole("region", { name: "B2 도면" })).toBeInTheDocument();
    expect(screen.getByText("도면을 최신 상태로 갱신하지 못했습니다.")).toBeInTheDocument();
  });

  it("resolves every current floor member for a floor selection", () => {
    renderSelector({ selection: { mode: "floor", floorId: "floor-b2" } });
    expect(screen.getByText("3개 선택")).toBeInTheDocument();
  });

  it("does not oscillate when a selected floor disappears from the dashboard", () => {
    const selectedMissingFloor = { mode: "floor" as const, floorId: "removed-floor" };
    render(<SpatialTargetSelector siteId="site-a" dashboard={dashboard} selection={selectedMissingFloor} disabled={false} onChange={onChange} />);
    expect(screen.getByRole("region", { name: "B2 도면" })).toBeInTheDocument();
    expect(floorMapQuery).toHaveBeenLastCalledWith("floor-b2", "site-a");
  });

  it("disables aggregate choices that violate gateway or fixture constraints", () => {
    const constrained = dashboardWithSecondFloor;
    const fixtureFilter = (item: Dashboard["floors"][number]["fixtures"][number]) => item.id !== fixtureB;
    const groupView = renderSelector({ dashboard: constrained, selection: { mode: "group", groupId: "" }, requiredGatewayId: "gateway-a", fixtureFilter });
    expect(screen.getByRole("button", { name: "B2 입구 구역" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "B1 구역" })).toBeDisabled();
    groupView.unmount();

    renderSelector({ dashboard: constrained, selection: { mode: "floor", floorId: "" }, requiredGatewayId: "gateway-a", fixtureFilter });
    expect(screen.getByRole("button", { name: "B2" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "B1" })).toBeDisabled();
  });

  it("locks direct selection to the first selected fixture gateway", () => {
    renderSelector({ selection: { mode: "fixtures", fixtureIds: [fixtureA] } });
    fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
    expect(screen.getByRole("checkbox", { name: "B2-L003 선택" })).toBeDisabled();
  });

  it("locks an area selection to its first eligible fixture gateway", () => {
    renderSelector({ interactionMode: "area" });
    const viewport = screen.getByRole("region", { name: "B2 도면" });
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, button: 0, clientX: 50, clientY: 50 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, clientX: 350, clientY: 150 });
    dispatchPointer(viewport, "pointerup", { pointerId: 1, clientX: 350, clientY: 150 });
    expect(onChange).toHaveBeenLastCalledWith({ mode: "fixtures", fixtureIds: [fixtureA, fixtureB] });
  });

  it("focuses the search field when the list opens", () => {
    renderSelector();
    fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
    expect(screen.getByRole("searchbox", { name: "조명 검색" })).toHaveFocus();
  });

  it("keeps drawer scrolling bounded while completion stays in the dialog footer", () => {
    renderSelector();
    fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
    const dialog = screen.getByRole("dialog", { name: "조명 목록" });
    const body = dialog.querySelector<HTMLElement>("[data-dialog-body]")!;
    const list = screen.getByRole("group", { name: "조명 목록" });
    const completion = screen.getByRole("button", { name: "선택 완료" });
    expect(dialog).toHaveClass("max-compact:h-full!", "max-compact:overflow-hidden!");
    expect(body).toHaveClass("min-h-0", "overflow-hidden");
    expect(list).toHaveAttribute("data-fixture-selection-list", "");
    expect(list).toHaveClass("min-h-0", "overflow-y-auto", "overscroll-contain");
    expect(body).not.toContainElement(completion);
    expect(completion.closest("[data-dialog-actions]")).toBeTruthy();
  });

  it("uses the approved 16px field size in the compact drawer", () => {
    renderSelector();
    fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
    expect(screen.getByRole("searchbox", { name: "조명 검색" })).toHaveClass("text-body-lg");
  });

  it("provides explicit compact summary expansion controls", () => {
    renderSelector();
    expect(screen.getByTestId("summary-normal-content")).toHaveClass("hidden", "compact:block");
    expect(screen.getByTestId("summary-compact-control")).toHaveClass("compact:hidden");
    const expand = screen.getByRole("button", { name: "선택 대상 펼치기" });
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "선택 대상 접기" })).toBeInTheDocument();
  });
});

function renderSelector(overrides: Partial<React.ComponentProps<typeof SpatialTargetSelector>> = {}) {
  onChange.mockClear();
  return render(<SelectorHarness {...overrides} />);
}

function SelectorHarness(overrides: Partial<React.ComponentProps<typeof SpatialTargetSelector>>) {
  const [selection, setSelection] = useState<React.ComponentProps<typeof SpatialTargetSelector>["selection"]>(overrides.selection ?? { mode: "fixtures", fixtureIds: [] });
  return <SpatialTargetSelector siteId="site-a" dashboard={dashboard} disabled={false} onChange={(next) => { onChange(next); setSelection(next); }} {...overrides} selection={selection} />;
}

function fixture(id: string, name: string, x: number, y: number, gatewayId = "gateway-a") {
  return {
    id, name, x, y, placementStatus: "placed" as const, positionVerifiedAt: null, ratedWatt: 20, brightness: 70,
    status: "online" as const, statusReason: null, health: null, rssi: null, hopCount: null, commandSuccessRate: null,
    lastSeenAt: null, gateway: { id: gatewayId, name: gatewayId, connectionStatus: "online" as const }, controllable: true,
    controlBlockReason: null
  };
}

const dashboardWithUnplacedFixture: Dashboard = {
  ...dashboard,
  floors: [{ ...dashboard.floors[0], fixtures: [{ ...dashboard.floors[0].fixtures[0], placementStatus: "unplaced", x: 0, y: 0 }] }]
};

const dashboardWithSecondFloor: Dashboard = {
  ...dashboard,
  floors: [...dashboard.floors, {
    id: "floor-b1", name: "B1", level: -1, floorPlan: null,
    meshControlGroups: [{ gatewayId: "gateway-b", status: "ready", version: 1, error: null }],
    fixtures: [fixture("fixture-b1", "B1-L001", 100, 100, "gateway-b")]
  }],
  groups: [...dashboard.groups, {
    id: "group-b", name: "B1 구역", floorId: "floor-b1", gatewayId: "gateway-b", lifecycleStatus: "active", fixtureCount: 1,
    meshControlGroup: { status: "ready", version: 1, error: null }, fixtureIds: ["fixture-b1"]
  }]
};

function dispatchPointer(target: HTMLElement, type: string, properties: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, properties);
  fireEvent(target, event);
}
