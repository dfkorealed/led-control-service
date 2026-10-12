import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Konva from "konva";
import { StrictMode } from "react";
import { FloorEditorCanvas } from "./FloorEditorCanvas";
import { useFloorEditorStore } from "./editor-store";
import { useMapEditor } from "./use-map-editor";
import { createFixturePlacementRowRegistry } from "./FixturePlacementList";
import type { FloorEditorState } from "./editor-types";
import { ConfirmDialog } from "../../components/ui";
import { CustomerThemeContext } from "../../components/ui/theme/CustomerThemeProvider";
import { readThemePalette } from "../../components/ui/theme/customer-theme";
import { CadElementPropertiesPanel } from "./CadElementPropertiesPanel";
import { EditorMinimap } from "./EditorMinimap";
import * as mapDocumentApi from "../../api/map-document";
import { createMapElementFromDrag } from "./map-element-tools";
import type { MapElement } from "@led-control/shared/map-document-contracts";

vi.mock("../map-scene/MapSceneCanvas", () => ({ MapSceneCanvas: () => <canvas data-testid="map-scene" /> }));
vi.mock("../../api/map-document", () => ({ createMapDocumentSource: () => ({ scopeKey: "test",
  getElements: async () => [], getSelection: async () => ({ generationId: "gen", revision: 1, ids: [], nextCursor: null }) }) }));
const base: FloorEditorState = { floor: { id: "floor", siteId: "site", name: "Floor", level: 1, mapRevision: 1, floorPlan: null,
  mapDocument: { formatVersion: 1, generationId: "gen", revision: 1, width: 16384, height: 13222, gridSize: 10, elementCount: 0,
    manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } }, fixtures: [], objects: [], lightSlots: [] };
const store = useFloorEditorStore.getState;
function Canvas({ readOnly = false }: { readOnly?: boolean } = {}) { const map = useMapEditor({ floorId: "floor", authScope: "user", readOnly });
  return <><input aria-label="Outside text" /><FloorEditorCanvas rowRegistry={createFixturePlacementRowRegistry()} mapEditor={map} readOnly={readOnly} />
    <ConfirmDialog isOpen={map.removeRequested} title="선택 전체 삭제" confirmLabel="전체 삭제" onClose={map.cancelRemove} onConfirm={() => { void map.confirmRemove(); }} /></>; }
describe("actual common editor Canvas", () => {
  it.each([false, true])("commits the final aligned legacy position after a frame already ran: %s", (frameAlreadyRan) => {
    const object = (id: string, x: number) => ({ id, floorId: "floor", type: "rectangle" as const,
      x, y: 100, width: 100, height: 80, rotation: 0, points: null, text: "", fontSize: null,
      strokeColor: "#2563eb", fillColor: "#dbeafe", strokeWidth: 2, zIndex: 0, visible: true, locked: false });
    store().initialize({ ...structuredClone(base), floor: { ...base.floor, mapDocument: null,
      floorPlan: { imageUrl: "", sourceType: "none", width: 1200, height: 800, gridSize: 10, version: 1 } },
      objects: [object("moving", 100), object("target", 300)] }, "user");
    render(<FloorEditorCanvas rowRegistry={createFixturePlacementRowRegistry()} readOnly={false} />);
    act(() => { store().setZoom(1); store().setPan({ x: 0, y: 0 }); });
    const node = Konva.stages.at(-1)!.findOne<Konva.Node>(".map-object-moving")!;
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frame = callback; return 42; });
    act(() => node.fire("dragstart", { evt: new MouseEvent("mousedown") }));
    act(() => { node.position({ x: 197, y: 145 }); node.fire("dragmove", { evt: new MouseEvent("mousemove") }); });
    if (frameAlreadyRan) {
      act(() => frame?.(0));
      // Konva can publish its last raw pointer position again before dragend.
      node.position({ x: 197, y: 145 });
    }
    act(() => node.fire("dragend", { evt: new MouseEvent("mouseup") }));
    expect(store().state!.objects[0]).toMatchObject({ x: 200, y: 140 });
    expect(store().past).toHaveLength(1);
  });

  it("dispatches overlay child drill once and retains current geometry during child hydration", async () => {
    let release!: (elements: readonly MapElement[]) => void;
    const pending = new Promise<readonly MapElement[]>(resolve => { release = resolve; });
    const source = mapDocumentApi.createMapDocumentSource({ floorId: "floor", authScope: "user" });
    vi.spyOn(source, "getElements").mockReturnValue(pending);
    vi.spyOn(mapDocumentApi, "createMapDocumentSource").mockReturnValue(source);
    const group = { id: "group", parentId: null, name: "Group", visible: true, locked: false };
    const elements = Array.from({ length: 3 }, (_, index) => ({
      ...createMapElementFromDrag("rectangle", { x: 100 + index * 300, y: 100 }, { x: 200 + index * 300, y: 200 }, `child-${index}`)!,
      layerId: "map", groupId: group.id,
      style: { fillColor: "#ffaa00", strokeColor: null, strokeWidth: 0, opacity: 1 },
      // The visible selection has moved; canonical origins must not be used
      // to drill the promoted overlay or restored by clearing its paint mask.
      transform: { x: 300, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }
    }));
    store().applyMapTransaction({ scope: store().mapScope!, operations: [
      { kind: "group.put", group }, ...elements.map(element => ({ kind: "add" as const, element }))
    ] });
    store().selectMapGroups([group.id]);
    let currentPick!: ReturnType<typeof useMapEditor>["pick"];
    const dispatch = vi.fn<ReturnType<typeof useMapEditor>["pick"]>((...args) => currentPick(...args));
    function SelectionCanvas() {
      const map = useMapEditor({ floorId: "floor", authScope: "user", readOnly: false });
      currentPick = map.pick;
      return <FloorEditorCanvas rowRegistry={createFixturePlacementRowRegistry()} mapEditor={{ ...map, pick: dispatch }} readOnly={false} />;
    }
    render(<SelectionCanvas />);
    const canvas = screen.getByTestId("floor-editor-canvas");
    try {
      await waitFor(() => expect(canvas).toHaveAttribute("data-promoted-count", "3"));
      act(() => { store().setZoom(1); store().setPan({ x: 0, y: 0 }); });
      const stage = Konva.stages.at(-1)!;
      Object.defineProperties(stage.content, { clientWidth: { value: 900 }, clientHeight: { value: 600 } });
      stage.setPointersPositions(new MouseEvent("mousemove", { clientX: 450, clientY: 150 }));
      const overlay = stage.findOne<Konva.Group>(".map-element-overlay")!;
      act(() => overlay.fire("click", { evt: new MouseEvent("click", { detail: 2 }) }, true));
      expect(store().mapSelection.elementIds).toEqual(["child-0"]);
      expect(source.getElements).toHaveBeenCalledOnce();
      expect(canvas).toHaveAttribute("data-map-selection-count", "0");
      fireEvent.doubleClick(stage.content, { clientX: 450, clientY: 150, detail: 2 });
      await act(async () => { await Promise.resolve(); });
      expect(store().mapSelection.elementIds).toEqual(["child-0"]);
      expect(dispatch).toHaveBeenCalledOnce();
      release([]);
      await waitFor(() => expect(canvas).toHaveAttribute("data-map-selection-count", "1"));
      expect(store().mapElements.get("child-0")).toEqual(elements[0]);
    } finally { release([]); }
  });

  it("keeps background mouseup detail-two drilling without a duplicate DOM pick", () => {
    const dispatch = vi.fn<ReturnType<typeof useMapEditor>["pick"]>(async () => undefined);
    function BackgroundCanvas() {
      const map = useMapEditor({ floorId: "floor", authScope: "user", readOnly: false });
      return <FloorEditorCanvas rowRegistry={createFixturePlacementRowRegistry()} mapEditor={{ ...map, pick: dispatch }} readOnly={false} />;
    }
    render(<BackgroundCanvas />);
    const canvas = screen.getByTestId("floor-editor-canvas"), stage = Konva.stages.at(-1)!;
    vi.spyOn(stage, "getIntersection").mockReturnValue(null);
    fireEvent.mouseDown(canvas, { clientX: 450, clientY: 150, button: 0, detail: 2, shiftKey: true });
    fireEvent.mouseUp(canvas, { clientX: 450, clientY: 150, button: 0, detail: 2, shiftKey: true });
    fireEvent.doubleClick(canvas, { clientX: 450, clientY: 150, detail: 2, shiftKey: true });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ x: 450, y: 150 }, true, true);
  });

  it("still completes a drafted path on DOM double-click", () => {
    render(<Canvas />);
    act(() => { store().resetZoom(); store().setPan({ x: 0, y: 0 }); store().setActiveTool("polyline"); });
    const canvas = screen.getByTestId("floor-editor-canvas");
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.doubleClick(canvas, { clientX: 200, clientY: 100, detail: 2 });
    expect([...store().mapElements.values()]).toMatchObject([{ type: "polyline",
      geometry: { points: [{ x: 100, y: 100 }, { x: 200, y: 100 }] } }]);
  });
  it("repaints editor guides while retaining the actual canvas, camera, selection and undo history", () => {
    const child = <Canvas />;
    const value = { theme: "light" as const, setTheme() {}, persistence: "available" as const,
      palette: { ...readThemePalette(), "fixture-editor-guide": "#123456" } };
    const view = render(<CustomerThemeContext.Provider value={value}>{child}</CustomerThemeContext.Provider>);
    const stage = Konva.stages.at(-1)!, canvas = stage.getLayers()[0].getCanvas()._canvas;
    const guide = stage.findOne<Konva.Line>(".alignment-guide-vertical")!;
    act(() => { store().setZoom(1.7); store().setPan({ x: -41, y: 29 }); });
    const before = { pan: store().pan, zoom: store().zoom, selection: store().selection, past: store().past, state: store().state };
    expect(guide.stroke()).toBe("#123456");
    view.rerender(<CustomerThemeContext.Provider value={{ ...value, theme: "dark", palette: { ...value.palette, "fixture-editor-guide": "#abcdef" } }}>{child}</CustomerThemeContext.Provider>);
    expect(guide.stroke()).toBe("#abcdef");
    expect(Konva.stages.at(-1)).toBe(stage); expect(stage.getLayers()[0].getCanvas()._canvas).toBe(canvas);
    expect({ pan: store().pan, zoom: store().zoom, selection: store().selection, past: store().past, state: store().state }).toEqual(before);
  });

  it("preserves a user's unsaved CAD color draft across palette publication", () => {
    const onChange = vi.fn();
    const element = { elementId: "cad-element-00000000000000000000000000000001", groupId: null, layerName: "WALL",
      locator: { tileX: 0, tileY: 0, lod: 1 as const, part: 0 }, bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
      points: [{ x: 0, y: 0 }, { x: 20, y: 20 }], fragments: [], closed: true, text: null, fontSize: null, textGeometry: null,
      strokeColor: "#111111", fillColor: "#222222", strokeWidth: 1, zOrder: 0, override: null };
    const child = <CadElementPropertiesPanel selection={{ mode: "element", targetId: element.elementId, element }} readOnly={false} isSaving={false} onChange={onChange} />;
    const value = { theme: "light" as const, setTheme() {}, persistence: "available" as const, palette: readThemePalette() };
    const view = render(<CustomerThemeContext.Provider value={value}>{child}</CustomerThemeContext.Provider>);
    fireEvent.change(screen.getByLabelText("선 색상"), { target: { value: "#123456" } });
    fireEvent.change(screen.getByLabelText("채우기 색상"), { target: { value: "#abcdef" } });
    view.rerender(<CustomerThemeContext.Provider value={{ ...value, theme: "dark", palette: { ...value.palette, "fixture-editor-label": "#eeeeee" } }}>{child}</CustomerThemeContext.Provider>);
    expect(screen.getByLabelText("선 색상")).toHaveValue("#123456"); expect(screen.getByLabelText("채우기 색상")).toHaveValue("#abcdef");
    expect(onChange).not.toHaveBeenCalled(); expect(element.strokeColor).toBe("#111111");
  });

  it("redraws minimap chrome on the same canvas without changing editor camera", () => {
    // The global JSDOM canvas proxy always reads properties as no-op functions.
    // Supply only the missing browser 2D state; the production draw effect runs.
    const context = { clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillStyle: "", strokeStyle: "", lineWidth: 0 };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => context) as unknown as HTMLCanvasElement["getContext"]);
    const child = <EditorMinimap />;
    const value = { theme: "light" as const, setTheme() {}, persistence: "available" as const,
      palette: { ...readThemePalette(), "fixture-editor-selected": "#123456" } };
    const view = render(<CustomerThemeContext.Provider value={value}>{child}</CustomerThemeContext.Provider>);
    const canvas = screen.getByRole("button", { name: "미니맵" }) as HTMLCanvasElement;
    expect(context.strokeStyle).toBe("#123456");
    const before = { pan: store().pan, zoom: store().zoom };
    view.rerender(<CustomerThemeContext.Provider value={{ ...value, theme: "dark", palette: { ...value.palette, "fixture-editor-selected": "#abcdef" } }}>{child}</CustomerThemeContext.Provider>);
    expect(context.strokeStyle).toBe("#abcdef"); expect(screen.getByRole("button", { name: "미니맵" })).toBe(canvas);
    expect({ pan: store().pan, zoom: store().zoom }).toEqual(before);
  });
  beforeEach(() => { store().initialize(structuredClone(base), "user");
    store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }] });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600, toJSON() {} }); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  function denseCanvas(readOnly = false) {
    const initial = structuredClone(base);
    initial.floor.mapDocument = null;
    initial.floor.floorPlan = { imageUrl: "", sourceType: "none", width: 1200, height: 800, gridSize: 10, version: 1 };
    initial.fixtures = [[20, 20], [49, 20], [20, 50], [49, 50]].map(([x, y], index) => ({
      id: `dense-${index}`, name: `Dense ${index}`, x, y, size: 20, ratedWatt: 40, brightness: 70, status: "online"
    }));
    store().initialize(initial, "user");
    render(<StrictMode><Canvas readOnly={readOnly} /></StrictMode>);
    act(() => { store().setZoom(0.38375); store().setPan({ x: 0, y: 0 }); store().setSnap(false); });
    const stage = Konva.stages.at(-1)!;
    Object.defineProperties(stage.content, { clientWidth: { value: 900 }, clientHeight: { value: 600 } });
    const fixtureLayer = stage.findOne<Konva.Layer>(".editor-fixture-layer")!;
    const groups = initial.fixtures.map(fixture => stage.findOne<Konva.Group>(`.fixture-${fixture.id}`)!);
    // JSDOM has no raster hit buffer. Supply only the overlapping last-painted
    // fixture hit from the actual browser trace; Stage dispatch stays real.
    vi.spyOn(fixtureLayer, "getIntersection").mockImplementation(() => fixtureLayer.isVisible() && fixtureLayer.isListening() ? groups[3].findOne<Konva.Circle>("Circle")! : null);
    const mouse = (type: "mouseDown" | "mouseUp", x: number, y: number, shiftKey = false) => {
      fireEvent[type](stage.content, { clientX: x * store().zoom, clientY: y * store().zoom, button: 0, shiftKey });
    };
    const click = (x: number, y: number, shift = false) => { mouse("mouseDown", x, y, shift); mouse("mouseUp", x, y, shift); };
    return { stage, groups, click, mouse, initial };
  }
  it.each([0, 1, 2, 3])("picks dense fixture %s at its actual center instead of the overlapping painted hit", index => {
    const { click, initial } = denseCanvas();
    click(initial.fixtures[index].x, initial.fixtures[index].y);
    expect(store().selectedFixtureIds).toEqual([`dense-${index}`]);
  });
  it("picks the nearest padded candidate and uses draw order only for equal distances", () => {
    const { click } = denseCanvas();
    click(68, 20);
    expect(store().selectedFixtureIds).toEqual(["dense-1"]);
    click(34.5, 20);
    expect(store().selectedFixtureIds).toEqual(["dense-1"]);
  });
  it("keeps Shift selection on the resolved dense fixture", () => {
    const { click } = denseCanvas();
    act(() => store().selectFixture("dense-0"));
    click(49, 20, true);
    expect(store().selectedFixtureIds).toEqual(["dense-0", "dense-1"]);
  });
  it("dispatches a real Konva tap to the resolved fixture", () => {
    const { stage } = denseCanvas();
    const touch = { identifier: 1, clientX: 20 * store().zoom, clientY: 20 * store().zoom };
    fireEvent.touchStart(stage.content, { touches: [touch], changedTouches: [touch] });
    fireEvent.touchEnd(stage.content, { touches: [], changedTouches: [touch] });
    expect(store().selectedFixtureIds).toEqual(["dense-0"]);
  });
  it("drags the resolved node and stores only that fixture movement", async () => {
    const { groups, mouse, initial } = denseCanvas();
    mouse("mouseDown", 20, 20);
    fireEvent.mouseMove(window, { clientX: 90 * store().zoom, clientY: 20 * store().zoom, buttons: 1 });
    expect(groups[0].isDragging()).toBe(true);
    expect(groups[3].isDragging()).toBe(false);
    mouse("mouseUp", 90, 20);
    await waitFor(() => expect(store().state!.fixtures[0].x).toBeCloseTo(90));
    expect(store().state!.fixtures.slice(1)).toEqual(initial.fixtures.slice(1));
    expect(store().past).toHaveLength(1);
    act(() => store().undo());
    expect(store().state!.fixtures).toEqual(initial.fixtures);
  });
  it("does not drag through a locked visible body into its unlocked neighbour", () => {
    const { groups, mouse, initial } = denseCanvas();
    act(() => useFloorEditorStore.setState({ lockedFixtureIds: ["dense-0"] }));
    mouse("mouseDown", 20, 20);
    fireEvent.mouseMove(window, { clientX: 50 * store().zoom, clientY: 20 * store().zoom, buttons: 1 });
    expect(groups.every(group => !group.isDragging())).toBe(true);
    mouse("mouseUp", 50, 20);
    expect(store().state!.fixtures).toEqual(initial.fixtures);
  });
  it("preserves the hidden layer and read-only movement guards", () => {
    const { groups, mouse, click, initial } = denseCanvas(true);
    mouse("mouseDown", 20, 20);
    fireEvent.mouseMove(window, { clientX: 50 * store().zoom, clientY: 20 * store().zoom, buttons: 1 });
    mouse("mouseUp", 50, 20);
    expect(groups.every(group => !group.isDragging())).toBe(true);
    expect(store().state!.fixtures).toEqual(initial.fixtures);
    act(() => { store().clearSelection(); useFloorEditorStore.setState({ layers: { ...store().layers, fixtures: { ...store().layers.fixtures, visible: false } } }); });
    click(20, 20);
    expect(store().selectedFixtureIds).toEqual([]);
  });
  it("uses the pending imperative wheel camera rather than the settled store camera for hits", () => {
    const { stage } = denseCanvas();
    const canvas = screen.getByTestId("floor-editor-canvas");
    fireEvent.wheel(stage.content, { clientX: 250, clientY: 200, deltaY: -100 });
    const zoom = Number(canvas.dataset.zoom), pan = { x: Number(canvas.dataset.panX), y: Number(canvas.dataset.panY) };
    expect(zoom).not.toBe(store().zoom);
    fireEvent.mouseDown(stage.content, { clientX: pan.x + 20 * zoom, clientY: pan.y + 20 * zoom, button: 0 });
    fireEvent.mouseUp(stage.content, { clientX: pan.x + 20 * zoom, clientY: pan.y + 20 * zoom, button: 0 });
    expect(store().selectedFixtureIds).toEqual(["dense-0"]);
  });
  it("does not reintroduce unplaced fixture nodes into padded picking", () => {
    const { stage } = denseCanvas();
    act(() => store().unplaceFixture("dense-0"));
    expect(stage.findOne(".fixture-dense-0")).toBeUndefined();
    expect(stage.getIntersection({ x: 20 * store().zoom, y: 20 * store().zoom })?.getParent()?.name()).not.toBe("fixture-dense-0");
  });
  it("commits a single fixture resize with a fixed corner and one undo entry", () => {
    const initial = structuredClone(base);
    initial.fixtures = [{ id: "fixture", name: "Fixture", x: 103, y: 107, size: 20, ratedWatt: 40, brightness: 80, status: "online" }];
    store().initialize(initial, "user"); store().selectFixture("fixture");
    render(<Canvas />);
    const stage = Konva.stages.at(-1)!, node = stage.findOne<Konva.Group>(".fixture-fixture")!;
    const transformer = stage.findOne<Konva.Transformer>("Transformer")!;
    expect(transformer.nodes()).toEqual([node]);
    vi.spyOn(transformer, "getActiveAnchor").mockReturnValue("bottom-right");
    act(() => { transformer.fire("transformstart"); node.setAttrs({ x: 106.7, y: 110.7, scaleX: 1.37, scaleY: 1.37 }); });
    expect(store().state!.fixtures[0]).toEqual(initial.fixtures[0]);
    act(() => node.fire("transformend"));
    const result = store().state!.fixtures[0];
    expect(result.x - result.size! / 2).toBeCloseTo(93); expect(result.y - result.size! / 2).toBeCloseTo(97);
    expect(result.x + result.size! / 2).toBeCloseTo(120); expect(store().past).toHaveLength(1);
    act(() => store().undo()); expect(store().state!.fixtures).toEqual(initial.fixtures);
  });
  it("keeps legacy fixture arrow movement and resize handles without a common document", async () => {
    const initial = structuredClone(base); initial.floor.mapDocument = null;
    initial.fixtures = [{ id: "legacy", name: "Legacy", x: 100, y: 100, size: 20, ratedWatt: 40, brightness: 80, status: "online" }];
    store().initialize(initial, "user"); store().selectFixture("legacy");
    render(<Canvas />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(store().state!.fixtures[0].x).toBe(110);
    const transformer = Konva.stages.at(-1)!.findOne<Konva.Transformer>("Transformer")!;
    expect(transformer.nodes()).toHaveLength(1);
  });
  it("fits once using measured dimensions and does not refit after pan", () => {
    render(<Canvas />);
    expect(store().zoom).toBeCloseTo(Math.min(852 / 16384, 552 / 13222));
    act(() => store().setPan({ x: 40, y: 50 }));
    act(() => store().setViewport({ width: 800, height: 500 }));
    expect(store().pan).toEqual({ x: 40, y: 50 });
  });
  it("waits for viewport measurement without resetting an existing user camera", () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} });
    store().setZoom(1.5); store().setPan({ x: 40, y: 50 });
    render(<Canvas />);
    expect(store().zoom).toBe(1.5);
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

  it("paints only viewport grid lines using the live imperative camera", () => {
    render(<Canvas />);
    act(() => store().resetZoom());
    const stage = Konva.stages.at(-1)!;
    const grid = stage.findOne<Konva.Shape>(".map-grid")!;
    const context = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), strokeShape: vi.fn() };
    stage.getLayers()[0].setAttrs({ x: -1000, y: -2000, scaleX: 1, scaleY: 1 });
    grid.sceneFunc()!(context as unknown as Konva.Context, grid);
    expect(context.lineTo.mock.calls.length).toBeLessThan(200);
    expect(context.moveTo.mock.calls.every(([x, y]) => x >= 1000 && y >= 2000)).toBe(true);
    expect(context.lineTo.mock.calls.every(([x, y]) => x <= 1900 && y <= 2600)).toBe(true);
    expect(grid.strokeScaleEnabled()).toBe(false);
  });

  it("reuses React overlay culling during small pans and refreshes beyond overscan", async () => {
    render(<Canvas />);
    act(() => { store().resetZoom(); store().setActiveTool("pan"); });
    const canvas = screen.getByTestId("floor-editor-canvas");
    const version = canvas.dataset.cameraRenderVersion;
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 100 });
    await waitFor(() => expect(Number(canvas.dataset.panX)).toBe(20));
    expect(canvas.dataset.cameraRenderVersion).toBe(version);
    fireEvent.mouseMove(canvas, { clientX: 190, clientY: 100 });
    await waitFor(() => expect(Number(canvas.dataset.panX)).toBe(90));
    expect(Number(canvas.dataset.cameraRenderVersion)).toBeGreaterThan(Number(version));
    fireEvent.mouseUp(canvas, { clientX: 190, clientY: 100 });
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
    expect(store().mapElements.size).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "전체 삭제" }));
    await waitFor(() => expect(store().mapElements.size).toBe(0));
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
