import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapElement } from "@led-control/shared/map-document-contracts";
import type { FloorEditorState } from "./editor-types";
import { useFloorEditorStore } from "./editor-store";
import { useMapEditor } from "./use-map-editor";
import { createMapElementFromDrag } from "./map-element-tools";

const source = vi.hoisted(() => ({ scopeKey: "user-floor", getSelection: vi.fn(), getElements: vi.fn() }));
vi.mock("../../api/map-document", () => ({ createMapDocumentSource: () => source }));
const base: FloorEditorState = { floor: { id: "floor", siteId: "site", name: "Floor", level: 1, mapRevision: 1, floorPlan: null,
  mapDocument: { formatVersion: 1, generationId: "gen", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: 0,
    manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } }, fixtures: [], objects: [], lightSlots: [] };
const store = useFloorEditorStore.getState;
const layer = { id: "map", name: "Map", order: 0, visible: true, locked: false };

describe("map editor View integration controller", () => {
  beforeEach(() => { vi.clearAllMocks(); store().initialize(structuredClone(base), "user");
    store().loadMapStructures(store().mapScope!, { groups: [], layers: [layer] });
    source.getElements.mockResolvedValue([]); source.getSelection.mockResolvedValue({ generationId: "gen", revision: 1, ids: [], nextCursor: null }); });
  afterEach(cleanup);
  it("creates all eight tools through the common timeline and deletes without touching slots", async () => {
    const { result } = renderHook(() => useMapEditor({ floorId: "floor", authScope: "user", readOnly: false }));
    for (const type of ["rectangle", "triangle", "line", "text", "ellipse", "arc", "polyline", "polygon"] as const) {
      act(() => { result.current.create(createMapElementFromDrag(type, { x: 20, y: 20 }, { x: 100, y: 100 }, type)!); });
      expect(store().mapElements.get(type)?.type).toBe(type);
    }
    await waitFor(() => expect(result.current.selection).toHaveLength(1));
    await act(async () => result.current.remove());
    expect(store().mapElements.has("polygon")).toBe(false);
    act(() => store().undo());
    expect(store().mapElements.has("polygon")).toBe(true);
    expect(store().state!.objects).toEqual([]);
    expect(store().state!.lightSlots).toEqual([]);
  });
  it("keeps all 65 selected elements while falling back with an empty promotion mask", async () => {
    const elements = Array.from({ length: 65 }, (_, i) => ({ ...createMapElementFromDrag("rectangle", { x: i, y: 20 }, { x: i + 10, y: 30 }, `e${i}`)!, groupId: "g" }));
    source.getElements.mockImplementation(async (_ref, ids: string[]) => elements.filter(e => ids.includes(e.id)));
    source.getSelection.mockResolvedValue({ generationId: "gen", revision: 1, ids: elements.map(e => e.id), nextCursor: null });
    store().loadMapStructures(store().mapScope!, { groups: [{ id: "g", parentId: null, name: "Group", locked: false, visible: true }], layers: [layer] });
    const { result } = renderHook(() => useMapEditor({ floorId: "floor", authScope: "user", readOnly: false }));
    act(() => store().selectMapGroups(["g"]));
    await waitFor(() => expect(result.current.selection).toHaveLength(65));
    expect(result.current.promotedIds).toEqual([]);
    expect(result.current.bounds?.maxX).toBe(74);
    await act(async () => result.current.remove());
    expect(store().mapOperations.filter(op => op.kind === "delete")).toHaveLength(65);
    act(() => store().undo());
    expect(store().mapElements.size).toBe(65);
  });
  it("does not apply late selection replies after a floor change", async () => {
    let finish!: (elements: MapElement[]) => void;
    source.getElements.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useMapEditor({ floorId: "floor", authScope: "user", readOnly: false }));
    act(() => store().selectMapElements(["old"]));
    await waitFor(() => expect(finish).toBeDefined());
    act(() => store().initialize({ ...base, floor: { ...base.floor, id: "other" } }, "user"));
    await act(async () => finish([createMapElementFromDrag("rectangle", { x: 20, y: 20 }, { x: 30, y: 30 }, "old")!]));
    expect(result.current.selection).toEqual([]);
    expect(store().mapElements.has("old")).toBe(false);
  });
  it("adds and removes polygon holes as ordinary undoable geometry edits", async () => {
    const { result } = renderHook(() => useMapEditor({ floorId: "floor", authScope: "user", readOnly: false }));
    act(() => result.current.create(createMapElementFromDrag("polygon", { x: 100, y: 100 }, { x: 300, y: 300 }, "polygon")!));
    await waitFor(() => expect(result.current.selection).toHaveLength(1));
    act(() => result.current.beginHole());
    act(() => result.current.finishHole([{ x: 150, y: 150 }, { x: 180, y: 150 }, { x: 180, y: 180 }, { x: 150, y: 180 }]));
    expect(store().mapElements.get("polygon")).toMatchObject({ geometry: { holes: [expect.any(Array)] } });
    act(() => store().undo());
    expect(store().mapElements.get("polygon")).toMatchObject({ geometry: { holes: [] } });
  });
  it("double-clicks a promoted group child without asking a masked renderer to pick it", async () => {
    const element = { ...createMapElementFromDrag("rectangle", { x: 20, y: 20 }, { x: 100, y: 100 }, "child")!, groupId: "g" };
    store().applyMapTransaction({ operations: [{ kind: "group.put", group: { id: "g", name: "Group", parentId: null, visible: true, locked: false } }, { kind: "add", element }] });
    store().selectMapGroups(["g"]); store().resetZoom();
    const { result } = renderHook(() => useMapEditor({ floorId: "floor", authScope: "user", readOnly: false }));
    await waitFor(() => expect(result.current.promotedIds).toEqual(["child"]));
    await act(async () => result.current.pick({ x: 40, y: 40 }, true, false));
    expect(store().mapSelection).toEqual({ elementIds: ["child"], groupIds: [] });
  });
});
