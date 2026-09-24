import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Konva from "konva";
import { FloorEditorCanvas } from "./FloorEditorCanvas";
import { useFloorEditorStore } from "./editor-store";
import { useMapEditor } from "./use-map-editor";
import { createFixturePlacementRowRegistry } from "./FixturePlacementList";
import type { FloorEditorState } from "./editor-types";

vi.mock("../map-scene/MapSceneCanvas", () => ({ MapSceneCanvas: () => <canvas data-testid="map-scene" /> }));
vi.mock("../../api/map-document", () => ({ createMapDocumentSource: () => ({ scopeKey: "test",
  getElements: async () => [], getSelection: async () => ({ generationId: "gen", revision: 1, ids: [], nextCursor: null }) }) }));
const base: FloorEditorState = { floor: { id: "floor", siteId: "site", name: "Floor", level: 1, mapRevision: 1, floorPlan: null,
  mapDocument: { formatVersion: 1, generationId: "gen", revision: 1, width: 16384, height: 13222, gridSize: 10, elementCount: 0,
    manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } }, fixtures: [], objects: [], lightSlots: [] };
const store = useFloorEditorStore.getState;
function Canvas() { const map = useMapEditor({ floorId: "floor", authScope: "user", readOnly: false });
  return <><input aria-label="Outside text" /><FloorEditorCanvas rowRegistry={createFixturePlacementRowRegistry()} mapEditor={map} /></>; }
describe("actual common editor Canvas", () => {
  beforeEach(() => { store().initialize(structuredClone(base), "user");
    store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }] });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600, toJSON() {} }); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("fits once using measured dimensions and does not refit after pan", () => {
    render(<Canvas />);
    expect(store().zoom).toBeCloseTo(Math.min(852 / 16384, 552 / 13222));
    act(() => store().setPan({ x: 40, y: 50 }));
    act(() => store().setViewport({ width: 800, height: 500 }));
    expect(store().pan).toEqual({ x: 40, y: 50 });
  });
  it("commits wheel zoom once after the gesture instead of updating Zustand per wheel event", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      render(<Canvas />);
      act(() => store().resetZoom());
      const canvas = screen.getByTestId("floor-editor-canvas").querySelector(".konvajs-content")!;
      const before = store().zoom;
      fireEvent.wheel(canvas, { clientX: 450, clientY: 300, deltaY: -100 });
      fireEvent.wheel(canvas, { clientX: 450, clientY: 300, deltaY: -100 });
      expect(store().zoom).toBe(before);
      expect(Number(screen.getByTestId("floor-editor-canvas").dataset.zoom)).toBeGreaterThan(before);
      await act(async () => { await vi.advanceTimersByTimeAsync(120); });
      expect(store().zoom).toBeGreaterThan(before);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("keeps an external 100% reset when a wheel gesture is still pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      render(<Canvas />);
      act(() => store().resetZoom());
      const canvas = screen.getByTestId("floor-editor-canvas");
      fireEvent.wheel(canvas.querySelector(".konvajs-content")!, { clientX: 450, clientY: 300, deltaY: -100 });
      act(() => store().resetZoom());
      await act(async () => { await vi.advanceTimersByTimeAsync(120); });
      expect(store().zoom).toBe(1);
      expect(Number(canvas.dataset.zoom)).toBe(1);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("recomputes visible fixtures after an external reset supersedes wheel culling", () => {
    const fixture = (id: string, x: number) => ({ id, name: id, x, y: 100, size: 20, ratedWatt: 40,
      brightness: 70, status: "online" as const, placementStatus: "placed" as const, positionVerifiedAt: null });
    store().initialize({ ...base, fixtures: [fixture("near", 100), fixture("far", 1200)] }, "user");
    render(<Canvas />);
    act(() => store().resetZoom());
    const canvas = screen.getByTestId("floor-editor-canvas");
    const konva = canvas.querySelector(".konvajs-content")!;
    expect(canvas.dataset.renderedFixtureCount).toBe("1");
    for (let step = 0; step < 6; step++) fireEvent.wheel(konva, { clientX: 450, clientY: 300, deltaY: 100 });
    act(() => store().setSnap(false));
    expect(canvas.dataset.renderedFixtureCount).toBe("2");

    act(() => store().resetZoom());
    expect(canvas.dataset.zoom).toBe("1");
    expect(canvas.dataset.renderedFixtureCount).toBe("1");
  });

  it("continues panning after an in-flight wheel camera is committed", async () => {
    render(<Canvas />);
    act(() => { store().resetZoom(); store().setActiveTool("pan"); });
    const canvas = screen.getByTestId("floor-editor-canvas");
    fireEvent.wheel(canvas.querySelector(".konvajs-content")!, { clientX: 450, clientY: 300, deltaY: -100 });
    const wheelPanX = Number(canvas.dataset.panX);
    fireEvent.mouseDown(canvas, { clientX: 120, clientY: 120 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 120 });
    await waitFor(() => expect(Number(canvas.dataset.panX)).toBeGreaterThan(wheelPanX + 40));
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 120 });
    expect(store().pan.x).toBeGreaterThan(wheelPanX + 40);
  });

  it("uses Pointer Events to apply a two-finger editor zoom before its settled store commit", async () => {
    render(<Canvas />);
    act(() => { store().resetZoom(); store().setActiveTool("pan"); });
    const canvas = screen.getByTestId("floor-editor-canvas");
    const before = store().zoom;

    // JSDOM's PointerEvent shim drops pointerType passed to fireEvent. Keep the
    // production touch branch under test by defining it on the native event.
    const touch = (type: "pointerDown" | "pointerMove" | "pointerUp", pointerId: number, clientX: number, clientY: number) => {
      const event = createEvent[type](canvas);
      Object.defineProperty(event, "pointerType", { value: "touch" });
      Object.defineProperties(event, {
        pointerId: { value: pointerId },
        clientX: { value: clientX },
        clientY: { value: clientY },
        button: { value: 0 }
      });
      fireEvent(canvas, event);
    };
    touch("pointerDown", 1, 120, 120);
    touch("pointerDown", 2, 220, 120);
    touch("pointerMove", 2, 320, 120);

    await waitFor(() => expect(Number(canvas.dataset.zoom)).toBeGreaterThan(before));
    expect(store().zoom).toBe(before);

    touch("pointerUp", 2, 320, 120);
    await waitFor(() => expect(store().zoom).toBeGreaterThan(before));
  });

  it("restores the committed camera when a touch pinch is cancelled", async () => {
    render(<Canvas />);
    act(() => { store().resetZoom(); store().setActiveTool("pan"); });
    const canvas = screen.getByTestId("floor-editor-canvas");
    const before = store().zoom;
    const touch = (type: "pointerDown" | "pointerMove" | "pointerCancel", pointerId: number, clientX: number, clientY: number) => {
      const event = createEvent[type](canvas);
      Object.defineProperties(event, { pointerType: { value: "touch" }, pointerId: { value: pointerId }, clientX: { value: clientX }, clientY: { value: clientY }, button: { value: 0 } });
      fireEvent(canvas, event);
    };
    touch("pointerDown", 1, 120, 120);
    touch("pointerDown", 2, 220, 120);
    touch("pointerMove", 2, 320, 120);
    await waitFor(() => expect(Number(canvas.dataset.zoom)).toBeGreaterThan(before));

    touch("pointerCancel", 2, 320, 120);
    await waitFor(() => expect(Number(canvas.dataset.zoom)).toBe(before));
    expect(store().zoom).toBe(before);
  });
  it("keeps an external 100% reset after an active pinch moves or ends", async () => {
    render(<Canvas />);
    act(() => { store().resetZoom(); store().setActiveTool("pan"); });
    const canvas = screen.getByTestId("floor-editor-canvas");
    const touch = (type: "pointerDown" | "pointerMove" | "pointerUp", pointerId: number, clientX: number, clientY: number) => {
      const event = createEvent[type](canvas);
      Object.defineProperties(event, { pointerType: { value: "touch" }, pointerId: { value: pointerId },
        clientX: { value: clientX }, clientY: { value: clientY }, button: { value: 0 } });
      fireEvent(canvas, event);
    };
    touch("pointerDown", 1, 120, 120);
    touch("pointerDown", 2, 220, 120);
    touch("pointerMove", 2, 320, 120);
    await waitFor(() => expect(Number(canvas.dataset.zoom)).toBeGreaterThan(1));

    touch("pointerMove", 2, 340, 120);
    act(() => store().resetZoom());
    expect(Number(canvas.dataset.zoom)).toBe(1);
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    expect(Number(canvas.dataset.zoom)).toBe(1);
    touch("pointerMove", 2, 360, 120);
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    expect(Number(canvas.dataset.zoom)).toBe(1);
    touch("pointerUp", 2, 360, 120);
    expect(Number(canvas.dataset.zoom)).toBe(1);
    expect(store().zoom).toBe(1);
    expect(store().pan).toEqual({ x: 0, y: 0 });
  });
  it("corrects a transient small initial viewport to the actual 1886x753 measurement", () => {
    render(<Canvas />);
    act(() => store().setViewport({ width: 1886, height: 180 }));
    act(() => store().setViewport({ width: 1886, height: 753 }));
    expect(store().zoom).toBeCloseTo(705 / 13222);
  });
  it("fits a newly initialized generation using the measured viewport", () => {
    store().initialize({ ...base, floor: { ...base.floor, mapDocument: null, floorPlan: { imageUrl: "", sourceType: "none", width: 16384, height: 13222, gridSize: 10, version: 1 } } });
    render(<Canvas />);
    act(() => store().setViewport({ width: 1886, height: 753 }));
    act(() => store().adoptBaseline(base));
    expect(store().zoom).toBeCloseTo(705 / 13222);
  });
  it.each(["rectangle", "triangle", "line", "text", "ellipse", "arc", "polyline", "polygon"] as const)("drops %s into the common document", async tool => {
    render(<Canvas />);
    act(() => { store().resetZoom(); store().setActiveTool(tool); });
    const event = createEvent.drop(screen.getByTestId("floor-editor-canvas"));
    Object.defineProperties(event, { clientX: { value: 120 }, clientY: { value: 120 }, dataTransfer: { value: {
      types: ["application/x-floor-editor-tool"], getData: (type: string) => type === "application/x-floor-editor-tool" ? tool : "" } } });
    fireEvent(screen.getByTestId("floor-editor-canvas"), event);
    expect([...store().mapElements.values()]).toMatchObject([{ type: tool }]);
    expect(store().state!.objects).toEqual([]);
    await waitFor(() => expect(store().mapSelection.elementIds).toHaveLength(1));
  });
  it("draws an ellipse, protects editable targets, deletes a primitive and undoes", async () => {
    render(<Canvas />);
    act(() => { store().resetZoom(); store().setActiveTool("ellipse"); });
    const canvas = screen.getByTestId("floor-editor-canvas");
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 180 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 180 });
    await waitFor(() => expect(store().mapElements.size).toBe(1));
    await waitFor(() => expect(canvas.getAttribute("data-map-selection-count")).toBe("1"));
    fireEvent.keyDown(screen.getByLabelText("Outside text"), { key: "Backspace" });
    expect(store().mapElements.size).toBe(1);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(store().mapElements.size).toBe(0);
    act(() => store().undo());
    expect(store().mapElements.size).toBe(1);
  });
  it("clears the common drawing preview when the pointer leaves without committing", async () => {
    render(<Canvas />);
    act(() => { store().resetZoom(); store().setActiveTool("ellipse"); });
    const canvas = screen.getByTestId("floor-editor-canvas");
    const overlays = () => Konva.stages.flatMap(stage => stage.find(".map-element-overlay"));
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 180 });
    await waitFor(() => expect(overlays()).toHaveLength(1));
    fireEvent.mouseLeave(canvas, { clientX: -10, clientY: 180 });
    fireEvent.mouseUp(document.body, { clientX: -10, clientY: 180 });
    expect(overlays()).toHaveLength(0);
    expect(store().mapElements.size).toBe(0);
    expect(store().isDirty).toBe(false);
    expect(store().past).toHaveLength(0);
  });
});
