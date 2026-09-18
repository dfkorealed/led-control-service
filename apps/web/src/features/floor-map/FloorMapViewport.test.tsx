import type { FloorMapSnapshot } from "@led-control/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloorMapViewport } from "./FloorMapViewport";
import type { MapInteractionMode, MapSelectionRect } from "./map-gestures";

const snapshot: FloorMapSnapshot = {
  floorId: "floor-1",
  revision: 1,
  width: 600,
  height: 400,
  floorPlan: null,
  objects: []
};

describe("FloorMapViewport", () => {
  afterEach(() => cleanup());

  it("gives two-pointer pinch precedence over area selection and prevents a jump", () => {
    render(<ViewportHarness mode="area" />);
    const viewport = screen.getByRole("region", { name: "테스트 지도" });

    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointerdown", { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });

    expect(viewport).toHaveAttribute("data-zoom", "2");
    expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();

    const scrollAfterPinch = viewport.scrollLeft;
    dispatchPointer(viewport, "pointerup", { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "touch", clientX: 110, clientY: 100 });
    expect(viewport.scrollLeft).toBe(scrollAfterPinch);
  });

  it.each(["pan", "select", "area"] as const)("supports pinch while mode is %s", (mode) => {
    render(<ViewportHarness mode={mode} />);
    performTwoPointerPinch(screen.getByRole("region", { name: "테스트 지도" }));
    expect(screen.getByRole("region", { name: "테스트 지도" })).toHaveAttribute("data-zoom", "2");
  });

  it("clamps wheel and button zoom to 0.1 through 4", () => {
    render(<ViewportHarness mode="pan" />);
    const viewport = screen.getByRole("region", { name: "테스트 지도" });
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
    const commandWheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      deltaY: -120,
      clientX: 100,
      clientY: 80
    });
    expect(fireEvent(viewport, commandWheelEvent)).toBe(false);
    expect(commandWheelEvent.defaultPrevented).toBe(true);
    expect(viewport).toHaveAttribute("data-zoom", "1.2");
    repeatZoomIn(50);
    expect(screen.getByRole("region", { name: "테스트 지도" })).toHaveAttribute("data-zoom", "4");
  });

  it("restores the initial map point after a centered fitted surface changes size", () => {
    const animationFrames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    render(<ViewportHarness mode="pan" />);
    const viewport = screen.getByRole("region", { name: "테스트 지도" });
    const surface = document.querySelector<HTMLElement>("[data-floor-map-surface]")!;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(0, 0, 800, 500));
    vi.spyOn(surface, "getBoundingClientRect").mockImplementation(() => (
      viewport.getAttribute("data-zoom") === "2"
        ? rect(50, 20, 1200, 800)
        : rect(100, 70, 600, 400)
    ));

    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "touch", clientX: 250, clientY: 170 });
    dispatchPointer(viewport, "pointerdown", { pointerId: 2, pointerType: "touch", clientX: 350, clientY: 170 });
    dispatchPointer(viewport, "pointermove", { pointerId: 2, pointerType: "touch", clientX: 450, clientY: 170 });
    animationFrames.splice(0).forEach((callback) => callback(0));
    requestAnimationFrame.mockRestore();

    // The original map point now sits under the moving midpoint (350, 170).
    expect(viewport.scrollLeft).toBe(100);
    expect(viewport.scrollTop).toBe(50);
  });

  it("disables native touch gestures on the scroll viewport", () => {
    render(<ViewportHarness mode="pan" />);
    expect(screen.getByRole("region", { name: "테스트 지도" })).toHaveClass("touch-none");
  });

  it("returns normalized map coordinates for area selection", () => {
    const onAreaSelect = vi.fn();
    render(<ViewportHarness mode="area" onAreaSelect={onAreaSelect} />);
    dragAreaFromBottomRightToTopLeft(screen.getByRole("region", { name: "테스트 지도" }));
    expect(onAreaSelect).toHaveBeenCalledWith({ left: 100, top: 80, right: 300, bottom: 240 });
  });

  it("pans the map with a mouse drag", () => {
    render(<ViewportHarness mode="pan" />);
    const viewport = screen.getByRole("region", { name: "테스트 지도" });
    viewport.scrollLeft = 40;
    viewport.scrollTop = 30;

    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 70, clientY: 75 });

    expect(viewport.scrollLeft).toBe(70);
    expect(viewport.scrollTop).toBe(55);
  });

  it("fits the map back to 100 percent", () => {
    render(<ViewportHarness mode="pan" />);
    repeatZoomIn(1);
    fireEvent.click(screen.getByRole("button", { name: "지도 화면 맞춤" }));
    expect(screen.getByRole("region", { name: "테스트 지도" })).toHaveAttribute("data-zoom", "1");
  });

  it("removes an active selection rectangle when the pointer is cancelled", () => {
    render(<ViewportHarness mode="area" />);
    const viewport = screen.getByRole("region", { name: "테스트 지도" });
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 300, clientY: 240 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 80 });
    expect(screen.getByTestId("map-area-selection")).toBeInTheDocument();

    dispatchPointer(viewport, "pointercancel", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 80 });
    expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();
  });

  it("suppresses the click that immediately follows a pinch", () => {
    const onMarkerClick = vi.fn();
    render(<ViewportHarness mode="select" onMarkerClick={onMarkerClick} />);
    const viewport = screen.getByRole("region", { name: "테스트 지도" });
    performTwoPointerPinch(viewport);
    dispatchPointer(viewport, "pointerup", { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });

    fireEvent.click(screen.getByRole("button", { name: "테스트 조명" }));
    expect(onMarkerClick).not.toHaveBeenCalled();
  });
});

function ViewportHarness({
  mode,
  onAreaSelect,
  onMarkerClick
}: {
  mode: MapInteractionMode;
  onAreaSelect?: (rect: MapSelectionRect) => void;
  onMarkerClick?: () => void;
}) {
  return (
    <FloorMapViewport snapshot={snapshot} ariaLabel="테스트 지도" mode={mode} onAreaSelect={onAreaSelect}>
      <button type="button" aria-label="테스트 조명" onClick={onMarkerClick}>테스트 조명</button>
    </FloorMapViewport>
  );
}

function performTwoPointerPinch(viewport: HTMLElement) {
  dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
  dispatchPointer(viewport, "pointerdown", { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
  dispatchPointer(viewport, "pointermove", { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });
}

function repeatZoomIn(count: number) {
  const zoomIn = screen.getByRole("button", { name: "지도 확대" });
  for (let index = 0; index < count; index += 1) fireEvent.click(zoomIn);
}

function dragAreaFromBottomRightToTopLeft(viewport: HTMLElement) {
  dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 300, clientY: 240 });
  dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 80 });
  dispatchPointer(viewport, "pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 80 });
}

function dispatchPointer(target: HTMLElement, type: string, init: Record<string, string | number>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, Object.fromEntries(
    Object.entries(init).map(([key, value]) => [key, { configurable: true, value }])
  ));
  fireEvent(target, event);
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}
