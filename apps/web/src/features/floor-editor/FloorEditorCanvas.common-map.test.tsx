import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
