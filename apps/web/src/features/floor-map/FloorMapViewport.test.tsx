import type { FloorMapSnapshot } from "@led-control/shared";
import { StrictMode, useEffect, createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloorMapViewport, useFloorMapViewportOverlay } from "./FloorMapViewport";
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

  it.each(["touch", "mouse"])("manual-cad pans from a marker with %s navigation without a ghost click", pointerType => {
    const toggle = vi.fn(), select = vi.fn();
    render(<FloorMapViewport snapshot={snapshot} ariaLabel="manual" interactionPolicy="direct-selection" toolModePolicy="manual-cad" onAreaSelect={select}><button data-spatial-map-marker onClick={toggle}>pin</button></FloorMapViewport>);
    const viewport = screen.getByRole("region", { name: "manual" });
    const pin = screen.getByText("pin");
    dispatchPointer(pin, "pointerdown", { pointerId: 1, pointerType, button: pointerType === "mouse" ? 1 : 0, clientX: 100, clientY: 100 });
    dispatchPointer(pin, "pointermove", { pointerId: 1, pointerType, clientX: 93, clientY: 100 });
    expect(viewport.scrollLeft).toBe(0);
    dispatchPointer(pin, "pointermove", { pointerId: 1, pointerType, clientX: 80, clientY: 90 });
    dispatchPointer(pin, "pointerup", { pointerId: 1, pointerType, clientX: 80, clientY: 90 });
    fireEvent.click(pin, { detail: 1 });
    expect(viewport.scrollLeft).toBe(20); expect(viewport.scrollTop).toBe(10);
    expect(select).not.toHaveBeenCalled(); expect(toggle).not.toHaveBeenCalled();
    fireEvent.click(pin, { detail: 0 }); expect(toggle).toHaveBeenCalledOnce();
  });

  it("manual-cad touch hold never creates an area and swipe still pans", () => {
    vi.useFakeTimers();
    try {
      const select = vi.fn();
      render(<FloorMapViewport snapshot={snapshot} ariaLabel="manual" interactionPolicy="direct-selection" toolModePolicy="manual-cad" onAreaSelect={select}><span /></FloorMapViewport>);
      const viewport = screen.getByRole("region", { name: "manual" });
      dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
      act(() => vi.advanceTimersByTime(700));
      expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();
      dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "touch", clientX: 80, clientY: 100 });
      dispatchPointer(viewport, "pointerup", { pointerId: 1, pointerType: "touch", clientX: 80, clientY: 100 });
      expect(viewport.scrollLeft).toBe(20); expect(select).not.toHaveBeenCalled();
    } finally { cleanup(); vi.useRealTimers(); }
  });

  it("manual-cad left marker drag starts area at 8px and uses world coordinates", () => {
    const select = vi.fn();
    render(<FloorMapViewport snapshot={snapshot} ariaLabel="manual" interactionPolicy="direct-selection" toolModePolicy="manual-cad" onAreaSelect={select}><button data-spatial-map-marker>pin</button></FloorMapViewport>);
    const pin = screen.getByText("pin");
    vi.spyOn(document.querySelector<HTMLElement>("[data-floor-map-surface]")!, "getBoundingClientRect").mockReturnValue(rect(20, 40, 300, 200));
    dispatchPointer(pin, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 70, clientY: 90 });
    dispatchPointer(pin, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 77, clientY: 90 });
    expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();
    dispatchPointer(pin, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 78, clientY: 90 });
    expect(screen.getByTestId("map-area-selection")).toBeInTheDocument();
    dispatchPointer(pin, "pointerup", { pointerId: 1, pointerType: "mouse", clientX: 170, clientY: 140 });
    expect(select).toHaveBeenCalledWith({ left: 100, top: 100, right: 300, bottom: 200 });
  });

  it.each(["pointercancel", "lostpointercapture", "blur", "Escape"])("manual-cad cancels marquee on %s without a commit", cancel => {
    const select = vi.fn();
    render(<FloorMapViewport snapshot={snapshot} ariaLabel="manual" interactionPolicy="direct-selection" toolModePolicy="manual-cad" onAreaSelect={select}><span /></FloorMapViewport>);
    const viewport = screen.getByRole("region", { name: "manual" });
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 120, clientY: 100 });
    expect(screen.getByTestId("map-area-selection")).toBeInTheDocument();
    if (cancel === "Escape") fireEvent.keyDown(viewport, { key: "Escape" });
    else if (cancel === "blur") fireEvent(window, new Event("blur"));
    else dispatchPointer(viewport, cancel, { pointerId: 1, pointerType: "mouse" });
    dispatchPointer(viewport, "pointerup", { pointerId: 1, pointerType: "mouse", clientX: 120, clientY: 100 });
    expect(select).not.toHaveBeenCalled(); expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();
  });

  it("manual-cad gives pinch precedence and keeps locked left drag immutable while permitting navigation", () => {
    const select = vi.fn();
    const view = render(<FloorMapViewport snapshot={snapshot} ariaLabel="manual" interactionPolicy="direct-selection" toolModePolicy="manual-cad" onAreaSelect={select}><span /></FloorMapViewport>);
    const viewport = screen.getByRole("region", { name: "manual" });
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientX: 200, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });
    dispatchPointer(viewport, "pointerup", { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });
    dispatchPointer(viewport, "pointerup", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
    expect(viewport).toHaveAttribute("data-zoom", "2"); expect(select).not.toHaveBeenCalled();
    view.rerender(<FloorMapViewport snapshot={snapshot} ariaLabel="manual" interactionPolicy="pan" toolModePolicy="manual-cad" onAreaSelect={select}><span /></FloorMapViewport>);
    dispatchPointer(viewport, "pointerdown", { pointerId: 3, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 3, pointerType: "mouse", clientX: 80, clientY: 100 });
    dispatchPointer(viewport, "pointerup", { pointerId: 3, pointerType: "mouse", clientX: 80, clientY: 100 });
    expect(viewport.scrollLeft).toBe(0); expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(viewport, { key: " " });
    dispatchPointer(viewport, "pointerdown", { pointerId: 4, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 4, pointerType: "mouse", clientX: 80, clientY: 100 });
    dispatchPointer(viewport, "pointerup", { pointerId: 4, pointerType: "mouse", clientX: 80, clientY: 100 });
    fireEvent.keyUp(viewport, { key: " " });
    expect(viewport.scrollLeft).toBe(20); expect(select).not.toHaveBeenCalled();
  });

  it("explicit pan suppresses pin selection while retaining drag and middle-button navigation", () => {
    const toggle = vi.fn(), select = vi.fn();
    const view = render(<FloorMapViewport snapshot={snapshot} ariaLabel="explicit" interactionPolicy="direct-selection" toolModePolicy="explicit" mode="pan" onAreaSelect={select}><button data-spatial-map-marker onClick={toggle}>pin</button></FloorMapViewport>);
    const viewport = screen.getByRole("region", { name: "explicit" });
    fireEvent.click(screen.getByText("pin")); expect(toggle).not.toHaveBeenCalled();
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 120, clientY: 100 });
    dispatchPointer(viewport, "pointerup", { pointerId: 1, pointerType: "mouse", clientX: 120, clientY: 100 });
    expect(viewport.scrollLeft).toBe(-20); expect(select).not.toHaveBeenCalled();
    view.rerender(<FloorMapViewport snapshot={snapshot} ariaLabel="explicit" interactionPolicy="direct-selection" toolModePolicy="explicit" mode="select" onAreaSelect={select}><button data-spatial-map-marker onClick={toggle}>pin</button></FloorMapViewport>);
    // A fresh physical tap starts a new gesture; a click alone after a drag is
    // deliberately suppressed by the existing ghost-click protection.
    dispatchPointer(screen.getByText("pin"), "pointerdown", { pointerId: 4, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(screen.getByText("pin"), "pointerup", { pointerId: 4, pointerType: "mouse", clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByText("pin")); expect(toggle).toHaveBeenCalledOnce();
    dispatchPointer(viewport, "pointerdown", { pointerId: 2, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 2, pointerType: "mouse", clientX: 130, clientY: 100 });
    dispatchPointer(viewport, "pointerup", { pointerId: 2, pointerType: "mouse", clientX: 130, clientY: 100 });
    expect(select).not.toHaveBeenCalled();
    dispatchPointer(viewport, "pointerdown", { pointerId: 3, pointerType: "mouse", button: 1, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 3, pointerType: "mouse", clientX: 120, clientY: 100 });
    dispatchPointer(viewport, "pointerup", { pointerId: 3, pointerType: "mouse", clientX: 120, clientY: 100 });
    expect(viewport.scrollLeft).toBe(-40);
  });

  it("explicit area commits a world-space rectangle and blocks pin clicks", () => {
    const select = vi.fn(), toggle = vi.fn();
    render(<FloorMapViewport snapshot={snapshot} ariaLabel="explicit area" interactionPolicy="direct-selection" toolModePolicy="explicit" mode="area" onAreaSelect={select}><button data-spatial-map-marker onClick={toggle}>pin</button></FloorMapViewport>);
    const viewport = screen.getByRole("region", { name: "explicit area" });
    const surface = document.querySelector<HTMLElement>("[data-floor-map-surface]")!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(rect(20, 40, 300, 200));
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 70, clientY: 90 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 170, clientY: 140 });
    dispatchPointer(viewport, "pointerup", { pointerId: 1, pointerType: "mouse", clientX: 170, clientY: 140 });
    expect(select).toHaveBeenCalledWith({ left: 100, top: 100, right: 300, bottom: 200 });
    fireEvent.click(screen.getByText("pin")); expect(toggle).not.toHaveBeenCalled();
  });

  it.each(["select", "area"] as const)("retains Space navigation in explicit %s without selecting", mode => {
    const select = vi.fn();
    render(<FloorMapViewport snapshot={snapshot} ariaLabel="explicit navigation" interactionPolicy="direct-selection" toolModePolicy="explicit" mode={mode} onAreaSelect={select}><span /></FloorMapViewport>);
    const viewport = screen.getByRole("region", { name: "explicit navigation" });
    fireEvent.keyDown(viewport, { key: " " });
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 120, clientY: 100 });
    dispatchPointer(viewport, "pointerup", { pointerId: 1, pointerType: "mouse", clientX: 120, clientY: 100 });
    fireEvent.keyUp(viewport, { key: " " });
    expect(viewport.scrollLeft).toBe(-20); expect(select).not.toHaveBeenCalled();
  });

  it("retains explicit area touch hold, pinch precedence and cancellation without a ghost commit", () => {
    vi.useFakeTimers();
    try {
      const select = vi.fn();
      render(<FloorMapViewport snapshot={snapshot} ariaLabel="explicit touch" interactionPolicy="direct-selection" toolModePolicy="explicit" mode="area" onAreaSelect={select}><span /></FloorMapViewport>);
      const viewport = screen.getByRole("region", { name: "explicit touch" });
      dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
      act(() => vi.advanceTimersByTime(399)); expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1)); expect(screen.getByTestId("map-area-selection")).toBeInTheDocument();
      dispatchPointer(viewport, "pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientX: 200, clientY: 100 });
      expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();
      dispatchPointer(viewport, "pointercancel", { pointerId: 2, pointerType: "touch" });
      dispatchPointer(viewport, "pointerup", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
      expect(select).not.toHaveBeenCalled();
    } finally { cleanup(); vi.useRealTimers(); }
  });

  it("cancels a pre-hold touch and a dragged marker without a ghost toggle", () => {
    const toggle = vi.fn(); const select = vi.fn();
    render(<FloorMapViewport snapshot={snapshot} ariaLabel="direct" interactionPolicy="direct-selection" onAreaSelect={select}><button data-spatial-map-marker onClick={toggle}>pin</button></FloorMapViewport>);
    const viewport = screen.getByRole("region", { name: "direct" });
    const pin = screen.getByRole("button", { name: "pin" });
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    dispatchPointer(viewport, "pointercancel", { pointerId: 1, pointerType: "touch" });
    fireEvent.click(pin); expect(toggle).not.toHaveBeenCalled();
    dispatchPointer(pin, "pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    dispatchPointer(pin, "pointermove", { pointerId: 2, pointerType: "touch", clientX: 18, clientY: 10 });
    dispatchPointer(pin, "pointerup", { pointerId: 2, pointerType: "touch", clientX: 18, clientY: 10 });
    fireEvent.click(pin); expect(toggle).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  });

  it("direct_gestures_cancel_and_never_cross_input_focus", () => {
    const select = vi.fn();
    render(<FloorMapViewport snapshot={snapshot} ariaLabel="direct" interactionPolicy="direct-selection" onAreaSelect={select}><input aria-label="draft" /></FloorMapViewport>);
    const viewport = screen.getByRole("region", { name: "direct" });
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 107, clientY: 100 });
    expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();
    dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 108, clientY: 100 });
    expect(screen.getByTestId("map-area-selection")).toBeInTheDocument();
    fireEvent.keyDown(viewport, { key: "Escape" });
    dispatchPointer(viewport, "pointerup", { pointerId: 1, pointerType: "mouse", clientX: 110, clientY: 100 });
    expect(select).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox"); input.focus();
    fireEvent.keyDown(input, { key: " " });
    dispatchPointer(viewport, "pointerdown", { pointerId: 3, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 3, pointerType: "mouse", clientX: 120, clientY: 100 });
    dispatchPointer(viewport, "pointerup", { pointerId: 3, pointerType: "mouse", clientX: 120, clientY: 100 });
    expect(select).toHaveBeenCalledOnce();
  });

  it.each(["pointercancel", "lostpointercapture", "blur"])("cancels a direct area on %s without committing", (cancel) => {
    const select = vi.fn();
    render(<FloorMapViewport snapshot={snapshot} ariaLabel="direct" interactionPolicy="direct-selection" onAreaSelect={select}><span /></FloorMapViewport>);
    const viewport = screen.getByRole("region", { name: "direct" });
    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 120, clientY: 100 });
    expect(screen.getByTestId("map-area-selection")).toBeInTheDocument();
    if (cancel === "blur") fireEvent(window, new Event("blur")); else dispatchPointer(viewport, cancel, { pointerId: 1 });
    dispatchPointer(viewport, "pointerup", { pointerId: 1, pointerType: "mouse", clientX: 120, clientY: 100 });
    expect(select).not.toHaveBeenCalled();
    expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();
  });

  it("longpress_second_pointer_cancel_has_no_ghost_click", () => {
    vi.useFakeTimers();
    try {
      const select = vi.fn(), click = vi.fn();
      render(<FloorMapViewport snapshot={snapshot} ariaLabel="direct" interactionPolicy="direct-selection" onAreaSelect={select}><button onClick={click}>pin</button></FloorMapViewport>);
      const viewport = screen.getByRole("region", { name: "direct" });
      dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
      act(() => vi.advanceTimersByTime(399));
      expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByTestId("map-area-selection")).toBeInTheDocument();
      dispatchPointer(viewport, "pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientX: 200, clientY: 100 });
      expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();
      dispatchPointer(viewport, "pointerup", { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
      dispatchPointer(viewport, "pointerup", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
      fireEvent.click(screen.getByText("pin"));
      expect(click).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
    } finally { cleanup(); vi.useRealTimers(); }
  });

  it("can reserve a controls footer without changing the default overlay", () => {
    const view = render(<FloorMapViewport snapshot={snapshot} ariaLabel="footer camera" controlsPlacement="footer"><span /></FloorMapViewport>);
    expect(screen.getByRole("group", { name: "지도 확대 축소" })).toHaveClass("shrink-0");
    expect(screen.getByRole("group", { name: "지도 확대 축소" })).not.toHaveClass("absolute");
    view.rerender(<FloorMapViewport snapshot={snapshot} ariaLabel="footer camera"><span /></FloorMapViewport>);
    expect(screen.getByRole("group", { name: "지도 확대 축소" })).toHaveClass("absolute");
  });

  it("combines footerStart and camera in one flow bar without remounting viewport children", () => {
    const mounted = vi.fn(), unmounted = vi.fn();
    function Canvas() {
      useEffect(() => { mounted(); return unmounted; }, []);
      return <canvas data-testid="stable-renderer" />;
    }
    const view = render(<FloorMapViewport snapshot={snapshot} ariaLabel="combined" controlsPlacement="footer" footerStart={<span>정상 0</span>}><Canvas /></FloorMapViewport>);
    const viewport = screen.getByRole("region", { name: "combined" });
    const canvas = screen.getByTestId("stable-renderer");
    const footer = screen.getByText("정상 0").closest("[data-floor-map-footer]");
    expect(footer).not.toBeNull();
    expect(footer).toContainElement(screen.getByRole("group", { name: "지도 확대 축소" }));
    expect(footer).toHaveClass("flex", "flex-wrap", "px-3.5", "py-2.5");
    expect(footer).not.toHaveClass("absolute");
    fireEvent.click(screen.getByRole("button", { name: "지도 확대" }));
    expect(viewport).toHaveAttribute("data-zoom", "1.1");
    view.rerender(<FloorMapViewport snapshot={snapshot} ariaLabel="combined" footerStart={<span>ignored overlay slot</span>}><Canvas /></FloorMapViewport>);
    expect(screen.queryByText("ignored overlay slot")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "지도 확대 축소" })).toHaveClass("absolute");
    expect(screen.getByRole("region", { name: "combined" })).toBe(viewport);
    expect(screen.getByTestId("stable-renderer")).toBe(canvas);
    expect(viewport).toHaveAttribute("data-zoom", "1.1");
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("exposes a camera handle without requiring measured geometry", () => {
    const ref = createRef<import("./FloorMapViewport").FloorMapViewportHandle>();
    render(<FloorMapViewport ref={ref} snapshot={snapshot} ariaLabel="camera"><span /></FloorMapViewport>);
    expect(ref.current?.getCamera()).toBeNull();
    expect(ref.current?.centerOn).toBeTypeOf("function");
    expect(ref.current?.fit).toBeTypeOf("function");
  });
  it("centers without changing zoom, fits even at 100%, and opt-in resize preserves camera", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    const request = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(cb => { callbacks.set(++id, cb); return id; });
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(id => { callbacks.delete(id); });
    const resize = globalThis.ResizeObserver;
    vi.stubGlobal("ResizeObserver", undefined);
    const ref = createRef<import("./FloorMapViewport").FloorMapViewportHandle>();
    const settled = vi.fn();
    let width = 400;
    function flush() {
      act(() => { for (let i = 0; i < 5 && callbacks.size; i++) { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(cb => cb(0)); } });
    }
    try {
      render(<FloorMapViewport ref={ref} snapshot={snapshot} ariaLabel="camera" maintainCameraOnResize onCameraSettled={settled}><span /></FloorMapViewport>);
      const viewport = screen.getByRole("region", { name: "camera" });
      const surface = document.querySelector<HTMLElement>("[data-floor-map-surface]")!;
      const stage = surface.parentElement!;
      Object.defineProperties(viewport, { clientWidth: { get: () => width }, clientHeight: { get: () => 300 } });
      vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => rect(0, 0, width, 300));
      vi.spyOn(surface, "getBoundingClientRect").mockImplementation(() => {
        const w = parseFloat(surface.style.width) || 600, h = parseFloat(surface.style.height) || 400;
        return rect((parseFloat(stage.style.width) - w) / 2 - viewport.scrollLeft,
          (parseFloat(stage.style.height) - h) / 2 - viewport.scrollTop, w, h);
      });
      fireEvent(window, new Event("resize")); flush();
      act(() => ref.current!.restoreCamera({ centerXRatio: .8, centerYRatio: .6, zoom: 2 })); flush();
      expect(ref.current!.getCamera()?.centerXRatio).toBeCloseTo(.8);
      expect(ref.current!.getCamera()?.centerYRatio).toBeCloseTo(.6);
      act(() => ref.current!.centerOn({ x: 420, y: 200 })); flush();
      expect(ref.current!.getCamera()?.centerXRatio).toBeCloseTo(.7);
      expect(ref.current!.getCamera()?.centerYRatio).toBeCloseTo(.5);
      expect(ref.current!.getCamera()?.zoom).toBe(2);
      width = 500; fireEvent(window, new Event("resize")); flush();
      expect(ref.current!.getCamera()?.centerXRatio).toBeCloseTo(.7);
      expect(ref.current!.getCamera()?.zoom).toBe(2);
      act(() => ref.current!.fit()); flush();
      viewport.scrollLeft = 100; viewport.scrollTop = 100;
      act(() => ref.current!.fit()); flush();
      expect(ref.current!.getCamera()?.centerXRatio).toBeCloseTo(.5);
      expect(ref.current!.getCamera()?.zoom).toBe(1);
      expect(settled).toHaveBeenCalled();
    } finally { cleanup(); request.mockRestore(); cancel.mockRestore(); vi.stubGlobal("ResizeObserver", resize); }
  });

  it("reschedules a cancelled initial camera frame after StrictMode effect replay", () => {
    const pending = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    const request = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => {
      pending.set(++sequence, callback);
      return sequence;
    });
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(id => { pending.delete(id); });
    const onFrame = vi.fn();
    function Observer() {
      const overlay = useFloorMapViewportOverlay();
      useEffect(() => overlay?.subscribe(onFrame), [overlay]);
      return null;
    }
    try {
      render(<StrictMode><FloorMapViewport snapshot={snapshot} ariaLabel="테스트 지도"><Observer /></FloorMapViewport></StrictMode>);
      const viewport = screen.getByRole("region", { name: "테스트 지도" });
      const surface = document.querySelector<HTMLElement>("[data-floor-map-surface]")!;
      vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(0, 0, 800, 500));
      vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(rect(24, 24, 600, 400));
      for (const callback of pending.values()) callback(0);
      expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ width: 600, height: 400 }));
    } finally {
      cleanup();
      request.mockRestore();
      cancel.mockRestore();
    }
  });

  it("uses the map content box rather than its border for CAD camera alignment", () => {
    const pending: FrameRequestCallback[] = [];
    const request = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => pending.push(callback));
    const onFrame = vi.fn();
    function Observer() {
      const overlay = useFloorMapViewportOverlay();
      useEffect(() => overlay?.subscribe(onFrame), [overlay]);
      return null;
    }
    try {
      render(<FloorMapViewport snapshot={snapshot} ariaLabel="테스트 지도"><Observer /></FloorMapViewport>);
      const viewport = screen.getByRole("region", { name: "테스트 지도" });
      const surface = document.querySelector<HTMLElement>("[data-floor-map-surface]")!;
      Object.defineProperties(surface, { clientLeft: { value: 1 }, clientTop: { value: 1 } });
      vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(0, 0, 800, 500));
      vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(rect(24, 24, 602, 402));
      pending.forEach(callback => callback(0));
      expect(onFrame).toHaveBeenLastCalledWith({
        left: 0, top: 0, width: 600, height: 400,
        camera: { centerX: 300, centerY: 200, zoom: 1, viewportWidth: 600, viewportHeight: 400 }
      });
    } finally { cleanup(); request.mockRestore(); }
  });

  it("publishes a clipped physical camera independently of the stored relative zoom", () => {
    const pending: FrameRequestCallback[] = [];
    const request = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => pending.push(callback));
    const onFrame = vi.fn();
    const ref = createRef<import("./FloorMapViewport").FloorMapViewportHandle>();
    function Observer() {
      const overlay = useFloorMapViewportOverlay();
      useEffect(() => overlay?.subscribe(onFrame), [overlay]);
      return null;
    }
    try {
      render(<FloorMapViewport ref={ref} snapshot={snapshot} ariaLabel="physical camera"><Observer /></FloorMapViewport>);
      const viewport = screen.getByRole("region", { name: "physical camera" });
      const surface = document.querySelector<HTMLElement>("[data-floor-map-surface]")!;
      vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 150));
      // 600 world units rendered into 300 CSS px means physical scale .5.
      vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(rect(-60, -10, 300, 200));
      act(() => ref.current!.restoreCamera({ centerXRatio: .5, centerYRatio: .5, zoom: 2 }));
      act(() => pending.splice(0).forEach(callback => callback(0)));
      expect(ref.current!.getCamera()?.zoom).toBe(2);
      expect(onFrame).toHaveBeenLastCalledWith({ left: 60, top: 10, width: 200, height: 150,
        camera: { centerX: 320, centerY: 170, zoom: .5, viewportWidth: 200, viewportHeight: 150 } });
    } finally { cleanup(); request.mockRestore(); }
  });

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

  it("coalesces pinch state publication until the gesture finishes", () => {
    const onZoomChange = vi.fn();
    render(<ViewportHarness mode="pan" onZoomChange={onZoomChange} />);
    const viewport = screen.getByRole("region", { name: "테스트 지도" });
    onZoomChange.mockClear();

    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointerdown", { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 2, pointerType: "touch", clientX: 400, clientY: 100 });

    expect(viewport).toHaveAttribute("data-zoom", "3");
    expect(onZoomChange).not.toHaveBeenCalled();

    dispatchPointer(viewport, "pointerup", { pointerId: 2, pointerType: "touch", clientX: 400, clientY: 100 });
    expect(onZoomChange).toHaveBeenCalledTimes(1);
    expect(onZoomChange).toHaveBeenLastCalledWith(3);
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

  it("opts monitoring into unmodified pointer-anchored wheel zoom without wheel panning", () => {
    render(<ViewportHarness mode="pan" wheelZoomWithoutModifier />);
    const viewport = screen.getByRole("region", { name: "테스트 지도" });
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -80, clientX: 120, clientY: 90 });
    expect(fireEvent(viewport, wheel)).toBe(false);
    expect(wheel.defaultPrevented).toBe(true);
    expect(viewport).toHaveAttribute("data-zoom", "1.1");
    const horizontal = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 90, deltaY: 0 });
    expect(fireEvent(viewport, horizontal)).toBe(false);
    expect(horizontal.defaultPrevented).toBe(true);
    expect(viewport).toHaveAttribute("data-zoom", "1.1");
  });

  it("keeps unmodified wheel behavior unchanged outside monitoring", () => {
    render(<ViewportHarness mode="pan" />);
    const viewport = screen.getByRole("region", { name: "테스트 지도" });
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -80 });
    expect(fireEvent(viewport, wheel)).toBe(true);
    expect(wheel.defaultPrevented).toBe(false);
    expect(viewport).toHaveAttribute("data-zoom", "1");
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

  it("publishes camera changes only inside the web runtime", () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "ReactNativeWebView", {
      configurable: true,
      value: { postMessage }
    });
    render(<ViewportHarness mode="pan" />);
    const viewport = screen.getByRole("region", { name: "테스트 지도" });

    dispatchPointer(viewport, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchPointer(viewport, "pointermove", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 70, clientY: 75 });
    fireEvent.scroll(viewport);
    fireEvent.click(screen.getByRole("button", { name: "지도 확대" }));

    expect(postMessage).not.toHaveBeenCalled();
    delete (window as Window & { ReactNativeWebView?: unknown }).ReactNativeWebView;
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
  onMarkerClick,
  onZoomChange,
  wheelZoomWithoutModifier
}: {
  mode: MapInteractionMode;
  onAreaSelect?: (rect: MapSelectionRect) => void;
  onMarkerClick?: () => void;
  onZoomChange?: (zoom: number) => void;
  wheelZoomWithoutModifier?: boolean;
}) {
  return (
    <FloorMapViewport snapshot={snapshot} ariaLabel="테스트 지도" mode={mode} onAreaSelect={onAreaSelect} onZoomChange={onZoomChange} wheelZoomWithoutModifier={wheelZoomWithoutModifier}>
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
