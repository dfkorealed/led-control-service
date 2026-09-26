import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloorMap } from "./FloorMap";

const mapSnapshot = {
  floorId: "00000000-0000-4000-8000-000000000003",
  revision: 2,
  width: 1200,
  height: 800,
  floorPlan: {
    imageUrl: "/demo.svg",
    sourceType: "image" as const,
    originalFileUrl: "/demo.svg",
    renderedImageUrl: "/demo.svg",
    width: 1200,
    height: 800,
    gridSize: 10
  },
  objects: [{
    id: "rectangle-1",
    type: "rectangle" as const,
    x: 40,
    y: 60,
    width: 200,
    height: 100,
    rotation: 0,
    points: null,
    text: null,
    strokeColor: "#0b63e5",
    fillColor: "#dbeafe",
    strokeWidth: 2,
    fontSize: null,
    zIndex: 1,
    locked: false,
    visible: true
  }]
};

const navigationFloor = {
  id: "floor-1",
  name: "B1",
  level: -1,
  floorPlan: null,
  meshControlGroups: [],
  fixtures: [{
    id: "fixture-1",
    name: "B1-L001",
    x: 120,
    y: 80,
    size: 20,
    ratedWatt: 40,
    brightness: 70,
    status: "online" as const,
    statusReason: "reported" as const,
    placementStatus: "placed" as const,
    health: null,
    rssi: -60,
    hopCount: 2,
    commandSuccessRate: 0.99,
    lastSeenAt: "2026-09-10T01:00:00.000Z",
    gateway: null,
    controllable: true,
    controlBlockReason: null
  }]
};

describe("FloorMap", () => {
  afterEach(() => cleanup());

  it("counts saved map placements without mixing loaded, hidden or missing data", () => {
    const { rerender } = render(<FloorMap floor={{ ...navigationFloor, fixtures: [
      { ...navigationFloor.fixtures[0]!, placementStatus: "unplaced" },
      { ...navigationFloor.fixtures[0]!, id: "runtime-unplaced", name: "미배치 목록 조명", placementStatus: "unplaced" }
    ] }} snapshot={{ ...mapSnapshot, objects: [{ ...mapSnapshot.objects[0]!, visible: false }], fixtures: [
      { id: "saved-only", name: "지도에 저장된 조명", x: 200, y: 300, size: 20 }
    ] }} selectedFixtureId={null} onSelectFixture={vi.fn()} />);
    expect(screen.getByText("지도 표시 1대")).toBeVisible();
    rerender(<FloorMap floor={navigationFloor} snapshot={{ ...mapSnapshot, fixtures: [
      { id: "saved-only", name: "지도에 저장된 조명", x: 200, y: 300, size: 20 }
    ] }} selectedFixtureId={null} onSelectFixture={vi.fn()} />);
    expect(screen.getByText("지도 배치 정보 확인 불가")).toBeVisible();
    rerender(<FloorMap floor={{ ...navigationFloor, fixtures: [] }} snapshot={{ ...mapSnapshot, fixtures: [] }} selectedFixtureId={null} onSelectFixture={vi.fn()} />);
    expect(screen.getByText("지도 표시 0대")).toBeVisible();
    rerender(<FloorMap floor={navigationFloor} snapshot={mapSnapshot} selectedFixtureId={null} onSelectFixture={vi.fn()} />);
    expect(screen.getByText("지도 배치 정보 확인 불가")).toBeVisible();
  });

  it("opens a read-only popover with saved coordinates and real brightness, then restores marker focus", async () => {
    const onSelectFixture = vi.fn();
    render(<FloorMap floor={navigationFloor} snapshot={{ ...mapSnapshot, fixtures: [{
      id: "fixture-1", name: "B1-L001", x: 120, y: 80, size: 20
    }] }} selectedFixtureId={null} onSelectFixture={onSelectFixture} timeZone="Asia/Seoul" />);

    const marker = screen.getByRole("button", { name: "B1-L001 정상 70%" });
    fireEvent.click(marker);
    const info = await screen.findByRole("dialog", { name: "B1-L001 조명 정보" });
    expect(info).toHaveTextContent("현재 밝기");
    expect(info).toHaveTextContent("70%");
    expect(info).toHaveTextContent("지도 좌표");
    expect(info).toHaveTextContent("120, 80");
    expect(info).not.toHaveTextContent("주차면 앞");
    expect(info.querySelector("button")).toBeNull();
    expect(onSelectFixture).toHaveBeenCalledWith("fixture-1");

    fireEvent.keyDown(info, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "B1-L001 조명 정보" })).not.toBeInTheDocument());
    expect(marker).toHaveFocus();
  });

  it("moves only the focused map viewport with arrow keys", () => {
    render(<FloorMap floor={navigationFloor} snapshot={mapSnapshot} selectedFixtureId={null} onSelectFixture={vi.fn()} />);
    const viewport = screen.getByTestId("monitoring-map-viewport");
    const scrollBy = vi.fn();
    viewport.scrollBy = scrollBy;
    viewport.focus();

    const right = fireEvent.keyDown(viewport, { key: "ArrowRight", cancelable: true });
    expect(right).toBe(false);
    expect(scrollBy).toHaveBeenCalledWith({ left: 80, top: 0, behavior: "smooth" });
    const documentEvent = fireEvent.keyDown(document.body, { key: "ArrowDown", cancelable: true });
    expect(documentEvent).toBe(true);
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it("does not present an unobserved offline brightness as current output", async () => {
    render(<FloorMap floor={{ ...navigationFloor, fixtures: [{
      ...navigationFloor.fixtures[0]!, status: "offline", statusReason: "fixture_stale", lastSeenAt: null
    }] }} snapshot={mapSnapshot} selectedFixtureId={null} onSelectFixture={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "B1-L001 상태 수신 지연 70%" }));
    const info = await screen.findByRole("dialog", { name: "B1-L001 조명 정보" });
    expect(info).toHaveTextContent("최근 확인 밝기");
    expect(info).toHaveTextContent("확인 전");
    expect(info).not.toHaveTextContent("70%");
  });

  it("shows saved-only coordinates without inventing live brightness and runtime-only pins without invented coordinates", async () => {
    const { rerender } = render(<FloorMap floor={{ ...navigationFloor, fixtures: [] }} snapshot={{
      ...mapSnapshot, fixtures: [{ id: "saved-only", name: "저장된 조명", x: 1120, y: 740, size: 20 }]
    }} selectedFixtureId={null} onSelectFixture={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /저장된 조명/ }));
    const saved = await screen.findByRole("dialog", { name: "저장된 조명 조명 정보" });
    expect(saved).toHaveTextContent("상태 확인 전");
    expect(saved).not.toHaveTextContent("0%");
    expect(saved).toHaveTextContent("1120, 740");

    rerender(<FloorMap floor={navigationFloor} snapshot={{ ...mapSnapshot, fixtures: [] }} selectedFixtureId={null} onSelectFixture={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "B1-L001 정상 70%" }));
    const runtime = await screen.findByRole("dialog", { name: "B1-L001 조명 정보" });
    expect(runtime).toHaveTextContent("저장된 위치 정보 없음");
    expect(runtime).toHaveTextContent("70%");
  });

  it("closes a pin popover when the saved map revision changes", async () => {
    const props = { floor: navigationFloor, selectedFixtureId: null, onSelectFixture: vi.fn() };
    const { rerender } = render(<FloorMap {...props} snapshot={mapSnapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "B1-L001 정상 70%" }));
    expect(await screen.findByRole("dialog", { name: "B1-L001 조명 정보" })).toBeInTheDocument();
    rerender(<FloorMap {...props} snapshot={{ ...mapSnapshot, revision: 3 }} />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "B1-L001 조명 정보" })).not.toBeInTheDocument());
  });

  it("keeps marker copy accessible without rendering visible brightness labels", () => {
    const onSelectFixture = vi.fn();
    render(
      <FloorMap
        snapshot={mapSnapshot}
        selectedFixtureId="fixture-1"
        onSelectFixture={onSelectFixture}
        floor={{
          id: "floor-1",
          name: "B2",
          level: -2,
          floorPlan: { imageUrl: "/demo.svg", width: 1200, height: 800, version: 1 },
          meshControlGroups: [],
          fixtures: [
            {
              id: "fixture-1",
              name: "B2-L01",
              x: 100,
              y: 120,
              ratedWatt: 40,
              brightness: 70,
              status: "online",
              health: { faultCodes: [], observedAt: "2026-07-01T00:00:00.000Z" },
              rssi: -58,
              hopCount: 1,
              commandSuccessRate: 0.98,
              lastSeenAt: "2026-07-01T00:00:00.000Z",
              gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
              controllable: true,
              controlBlockReason: null
            }
          ]
        }}
      />
    );

    expect(screen.queryByText("B2-L01")).not.toBeInTheDocument();
    expect(screen.queryByText("70%")).not.toBeInTheDocument();
    const fixtureButton = screen.getByRole("button", { name: "B2-L01 정상 70%" });
    expect(fixtureButton).toBeInTheDocument();
    expect(fixtureButton).toHaveAttribute("aria-current", "true");
    expect(fixtureButton).not.toHaveAttribute("aria-pressed");
    expect(fixtureButton).toHaveTextContent("");
    expect(fixtureButton.querySelector("span[aria-hidden='true']")).toHaveClass("bg-fixture-connected");
    expect(fixtureButton.closest("[data-floor-scene]")).toHaveAttribute("data-map-objects-interactive", "false");
    expect(fixtureButton.closest("[data-floor-scene]")).not.toHaveAttribute("data-interactive");
    expect(fixtureButton).toHaveStyle({
      "--fixture-left": "8.333333333333332%",
      "--fixture-top": "15%"
    });
    expect(fixtureButton).toHaveAttribute("data-brightness-level", "8");
    expect(fixtureButton.querySelector("[data-spatial-map-marker-dot]")).toHaveClass("bg-fixture-brightness-8");
    expect(screen.getByAltText("B2 도면")).toHaveAttribute("src", "/demo.svg");
    expect(screen.getByAltText("B2 도면")).toHaveAttribute("draggable", "false");
    expect(screen.getByTestId("map-object-rectangle-1")).toBeInTheDocument();

    fireEvent.click(fixtureButton);
    expect(onSelectFixture).toHaveBeenCalledWith("fixture-1");
  });

  it("labels a provisioned fixture as waiting for its first real state", () => {
    render(
      <FloorMap
        snapshot={{ ...mapSnapshot, floorPlan: null, objects: [] }}
        selectedFixtureId={null}
        onSelectFixture={vi.fn()}
        floor={{
          id: "floor-1",
          name: "B2",
          level: -2,
          floorPlan: null,
          meshControlGroups: [],
          fixtures: [{
            id: "fixture-2",
            name: "B2-L02",
            x: 200,
            y: 240,
            ratedWatt: 40,
            brightness: 0,
            status: "offline",
            statusReason: "provisioning_waiting_state",
            health: null,
            rssi: null,
            hopCount: null,
            commandSuccessRate: null,
            lastSeenAt: null,
            gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
            controllable: false,
            controlBlockReason: "fixture_offline"
          }]
        }}
      />
    );

    expect(screen.getByRole("button", { name: "B2-L02 상태 확인 대기 0%" })).toBeInTheDocument();
  });

  it("uses the shared gateway-offline presentation for the marker accessibility name", () => {
    render(
      <FloorMap
        snapshot={{ ...mapSnapshot, floorPlan: null, objects: [] }}
        selectedFixtureId={null}
        onSelectFixture={vi.fn()}
        floor={{
          id: "floor-1",
          name: "B2",
          level: -2,
          floorPlan: null,
          meshControlGroups: [],
          fixtures: [{
            id: "fixture-gateway-offline",
            name: "B2-L03",
            x: 200,
            y: 240,
            ratedWatt: 40,
            brightness: 0,
            status: "offline",
            statusReason: "gateway_offline",
            health: null,
            rssi: null,
            hopCount: null,
            commandSuccessRate: null,
            lastSeenAt: null,
            gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "offline" },
            controllable: false,
            controlBlockReason: "gateway_offline"
          }]
        }}
      />
    );

    expect(screen.getByRole("button", { name: "B2-L03 게이트웨이 오프라인 0%" })).toBeInTheDocument();
  });

  it("shows an icon and text legend with semantic marker variants", () => {
    const sharedFixture = {
      x: 200,
      y: 240,
      ratedWatt: 40,
      brightness: 0,
      health: null,
      rssi: null,
      hopCount: null,
      commandSuccessRate: null,
      lastSeenAt: null,
      gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" as const },
      controllable: false,
      controlBlockReason: "fixture_offline" as const
    };
    render(
      <FloorMap
        snapshot={{ ...mapSnapshot, floorPlan: null, objects: [] }}
        selectedFixtureId={null}
        onSelectFixture={vi.fn()}
        floor={{
          id: "floor-1",
          name: "B2",
          level: -2,
          floorPlan: null,
          meshControlGroups: [],
          fixtures: [
            { ...sharedFixture, id: "fixture-fault", name: "B2-Fault", status: "fault" as const },
            { ...sharedFixture, id: "fixture-offline", name: "B2-Offline", status: "offline" as const },
            {
              ...sharedFixture,
              id: "fixture-awaiting",
              name: "B2-Awaiting",
              status: "offline" as const,
              statusReason: "provisioning_waiting_state"
            }
          ]
        }}
      />
    );

    const legend = screen.getByRole("list", { name: "조명 상태 범례" });
    const map = screen.getByRole("region", { name: "층 도면" });
    const panHint = screen.getByText("드래그 또는 스크롤로 이동");
    expect(map.querySelector(".floor-map-label")).not.toBeInTheDocument();
    expect(legend.parentElement).toBe(map);
    expect(panHint.parentElement).toBe(map);
    expect(legend.compareDocumentPosition(panHint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const legendItems = within(legend).getAllByRole("listitem");
    expect(legendItems).toHaveLength(4);
    for (const label of ["정상", "장애", "오프라인", "상태 확인 대기"]) {
      const item = within(legend).getByText(label).closest("li");
      expect(item).not.toBeNull();
      expect(item?.querySelector("svg")).not.toBeNull();
    }

    const faultMarker = screen.getByRole("button", { name: "B2-Fault 장애 0%" });
    expect(faultMarker.querySelector("span[aria-hidden='true']")).toHaveClass("bg-fixture-fault");
    const offlineMarker = screen.getByRole("button", { name: "B2-Offline 오프라인 0%" });
    expect(offlineMarker.querySelector("[data-spatial-map-marker-dot]")).toHaveClass("bg-fixture-offline-background", "border-fixture-offline-border!");
    expect(offlineMarker.querySelector("span[aria-hidden='true']")).toHaveClass("bg-fixture-offline");
    const awaitingMarker = screen.getByRole("button", { name: "B2-Awaiting 상태 확인 대기 0%" });
    expect(awaitingMarker.querySelector("[data-spatial-map-marker-dot]")).toHaveClass("bg-fixture-inspection-background", "border-fixture-inspection-border!");
    expect(awaitingMarker.querySelector("span[aria-hidden='true']")).toHaveClass("bg-fixture-inspection");
  });

  it("changes the fitted map zoom with controls and resets it to 100%", () => {
    render(<FloorMap floor={navigationFloor} snapshot={mapSnapshot} selectedFixtureId={null} onSelectFixture={vi.fn()} />);

    const map = screen.getByRole("region", { name: "층 도면" });
    expect(map).toHaveAttribute("data-zoom", "1");

    fireEvent.click(screen.getByRole("button", { name: "지도 확대" }));
    expect(map).toHaveAttribute("data-zoom", "1.1");
    expect(screen.getByRole("button", { name: "지도 배율 110%" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "지도 화면 맞춤" }));
    expect(map).toHaveAttribute("data-zoom", "1");
  });

  it("fits a newly selected floor instead of carrying over the previous floor zoom", () => {
    const { rerender } = render(
      <FloorMap floor={navigationFloor} snapshot={mapSnapshot} selectedFixtureId={null} onSelectFixture={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "지도 확대" }));
    expect(screen.getByRole("region", { name: "층 도면" })).toHaveAttribute("data-zoom", "1.1");

    rerender(
      <FloorMap
        floor={{ ...navigationFloor, id: "floor-2", name: "B2" }}
        snapshot={{ ...mapSnapshot, floorId: "floor-2", width: 600, height: 1200 }}
        selectedFixtureId={null}
        onSelectFixture={vi.fn()}
      />
    );

    expect(screen.getByRole("region", { name: "층 도면" })).toHaveAttribute("data-zoom", "1");
  });

  it("zooms with a modified wheel and pans by dragging the viewport", async () => {
    render(<FloorMap floor={navigationFloor} snapshot={mapSnapshot} selectedFixtureId={null} onSelectFixture={vi.fn()} />);

    const map = screen.getByRole("region", { name: "층 도면" });
    const viewport = screen.getByTestId("monitoring-map-viewport");
    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
      clientX: 100,
      clientY: 80
    });
    expect(fireEvent(viewport, wheelEvent)).toBe(false);
    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(viewport).toHaveAttribute("data-zoom", "1.1");
    await waitFor(() => expect(map).toHaveAttribute("data-zoom", "1.1"));

    viewport.scrollLeft = 40;
    viewport.scrollTop = 30;
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, button: 0, clientX: 70, clientY: 75 });
    dispatchPointer(viewport, "pointerup", { pointerId: 1, button: 0, clientX: 70, clientY: 75 });

    expect(viewport.scrollLeft).toBe(70);
    expect(viewport.scrollTop).toBe(55);
  });

  it("keeps monitoring markers selectable while allowing a two-touch pinch", () => {
    const onSelectFixture = vi.fn();
    render(<FloorMap floor={navigationFloor} snapshot={mapSnapshot} selectedFixtureId={null} onSelectFixture={onSelectFixture} />);

    const viewport = screen.getByTestId("monitoring-map-viewport");
    expect(viewport).toHaveClass("touch-none");
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointerdown", { pointerId: 2, button: 0, clientX: 200, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 2, button: 0, clientX: 300, clientY: 100 });
    dispatchPointer(viewport, "pointerup", { pointerId: 2, button: 0, clientX: 300, clientY: 100 });

    expect(screen.getByRole("region", { name: "층 도면" })).toHaveAttribute("data-zoom", "2");
    fireEvent.click(screen.getByRole("button", { name: "B1-L001 정상 70%" }));
    expect(onSelectFixture).not.toHaveBeenCalled();
  });
});

function dispatchPointer(target: HTMLElement, type: string, init: Record<string, number>) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, Object.fromEntries(
    Object.entries(init).map(([key, value]) => [key, { configurable: true, value }])
  ));
  fireEvent(target, event);
}
