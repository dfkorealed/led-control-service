import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { validateMapOperations, type MapOp } from "@led-control/shared/map-document-contracts";
import { createMapDocumentSource } from "../../api/map-document";
import type { MapSceneCanvasHandle } from "../map-scene/MapSceneCanvas";
import { useFloorEditorStore } from "./editor-store";
import { createMapElementFromDrag } from "./map-element-tools";
import { useMapEditor } from "./use-map-editor";

vi.mock("../../api/map-document", () => ({ createMapDocumentSource: vi.fn() }));
const store = useFloorEditorStore.getState;
const lease = { leaseToken: "lease", leaseFence: 1 };
afterEach(() => { cleanup(); vi.restoreAllMocks(); store().reset(); });

async function setup(count: number, locked = false, readOnly = false) {
  const groups = [
    { id: "parent", name: "Parent", parentId: null, visible: true, locked: false },
    { id: "child", name: "Child", parentId: "parent", visible: true, locked },
    { id: "grandchild", name: "Grandchild", parentId: "child", visible: true, locked: false }
  ];
  const layers = ["map", "target"].map((id, order) => ({ id, name: id, order, visible: true, locked: false }));
  const elements = Array.from({ length: count }, (_, i) => ({
    ...createMapElementFromDrag("rectangle", { x: 100 + i % 5 * 100, y: 100 }, { x: 120 + i % 5 * 100, y: 120 }, `s${i}`)!,
    groupId: i === 2 ? "child" : i === 3 ? "grandchild" : "parent"
  }));
  store().reset();
  store().initialize({ floor: { id: "floor", siteId: "site", name: "F", level: 1, mapRevision: 1, floorPlan: null,
    mapDocument: { formatVersion: 1, generationId: "gen", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: count,
      manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } }, fixtures: [], objects: [], lightSlots: [] }, "user");
  store().loadMapStructures(store().mapScope!, { groups, layers });
  if (count <= 128) store().loadMapElements(store().mapScope!, elements);
  vi.mocked(createMapDocumentSource).mockReturnValue({ scopeKey: "metadata",
    getElements: async (_document: unknown, ids: string[]) => elements.filter(e => ids.includes(e.id)),
    getSelection: async (_document: unknown, query: { cursor?: string }) => {
      const start = Number(query.cursor ?? 0), end = Math.min(count, start + 128);
      return { generationId: "gen", revision: 1, ids: elements.slice(start, end).map(e => e.id), nextCursor: end < count ? String(end) : null };
    }
  } as unknown as ReturnType<typeof createMapDocumentSource>);
  const view = renderHook(({ readOnly }) => useMapEditor({ floorId: "floor", authScope: "user", readOnly, lease }), { initialProps: { readOnly: false } });
  act(() => { view.result.current.toggleQuery({ layerId: "map" }, true); store().resetZoom(); });
  await waitFor(() => expect(view.result.current.selectionCount).toBe(count));
  const renderer = { pick: vi.fn(), setDraftChanges: vi.fn(), setPromotedElementIds: vi.fn() };
  act(() => view.result.current.onReady(renderer as unknown as MapSceneCanvasHandle));
  renderer.pick.mockResolvedValue({ element: elements[1] });
  await act(async () => { await view.result.current.pick({ x: 210, y: 110 }, true, true); });
  await waitFor(() => expect(view.result.current.selectionCount).toBe(count - 1));
  renderer.pick.mockResolvedValue({ element: elements[2] });
  await act(async () => { await view.result.current.pick({ x: 310, y: 110 }, false, true); });
  await waitFor(() => expect(view.result.current.selectionCount).toBe(count - 3));
  if (readOnly) view.rerender({ readOnly: true });
  return { view, elements, groups, layers };
}

it.each([4, 132])("whole-layer editing ignores shape/group exclusions and validates an atomic %i-element move/delete", async count => {
  const { view, elements, groups, layers } = await setup(count);
  const operations: MapOp[] = [];
  if (count > 128) vi.spyOn(store(), "prepareMapStream").mockImplementation(async transaction => {
    for await (const op of transaction.operations()) operations.push(op);
    validateMapOperations({ elements, groups, layers }, operations);
    expect(transaction.scope).toBe(store().mapScope);
    return "ready";
  });
  let saved = false;
  await act(async () => { saved = await view.result.current.editQuery({ layerId: "map" }, element => [{ kind: "update", element: { ...element, layerId: "target" } }], [], [{ kind: "layer.delete", id: "map" }]); });
  expect(saved).toBe(true);
  const payload = count > 128 ? operations : store().prepareSave(lease).payload.documentChanges!.operations;
  expect(payload.filter(op => op.kind === "update")).toHaveLength(count);
  expect(payload.at(-1)).toEqual({ kind: "layer.delete", id: "map" });
  expect(() => validateMapOperations({ elements, groups, layers }, payload)).not.toThrow();
  if (count <= 128) {
    expect(store().past).toHaveLength(1);
    expect([...store().mapElements.values()].every(e => e.layerId === "target")).toBe(true);
    act(() => store().undo());
    expect(store().mapLayers.has("map")).toBe(true);
    expect([...store().mapElements.values()].every(e => e.layerId === "map")).toBe(true);
    act(() => store().redo());
    expect(store().mapLayers.has("map")).toBe(false);
  }
});

it.each([4, 132])("ungroups excluded direct shapes while preserving excluded descendant groups and their contents (%i elements)", async count => {
  const { view, elements, groups, layers } = await setup(count);
  const operations: MapOp[] = [];
  if (count > 128) vi.spyOn(store(), "prepareMapStream").mockImplementation(async transaction => {
    for await (const op of transaction.operations()) operations.push(op);
    validateMapOperations({ elements, groups, layers }, operations);
    return "ready";
  });
  let saved = false;
  await act(async () => { saved = await view.result.current.editQuery({ groupId: "parent" }, element => element.groupId === "parent"
    ? [{ kind: "update", element: { ...element, groupId: null } }] : [], [], [
    { kind: "group.put", group: { ...groups[1], parentId: null } }, { kind: "group.delete", id: "parent" }
  ]); });
  expect(saved).toBe(true);
  const payload = count > 128 ? operations : store().prepareSave(lease).payload.documentChanges!.operations;
  expect(payload.filter(op => op.kind === "update")).toHaveLength(count - 2);
  expect(() => validateMapOperations({ elements, groups, layers }, payload)).not.toThrow();
  if (count > 128) return;
  expect(store().mapElements.get("s1")!.groupId).toBeNull();
  expect(store().mapElements.get("s2")!.groupId).toBe("child");
  expect(store().mapElements.get("s3")!.groupId).toBe("grandchild");
  expect(store().past).toHaveLength(1);
  act(() => store().undo());
  expect(store().mapElements.get("s1")!.groupId).toBe("parent");
  expect(store().mapGroups.get("child")!.parentId).toBe("parent");
});

it.each([4, 132])("selection edits still honor the same excluded shape and descendant group (%i elements)", async count => {
  const { view } = await setup(count);
  const operations: MapOp[] = [];
  if (count > 128) vi.spyOn(store(), "prepareMapStream").mockImplementation(async transaction => {
    for await (const op of transaction.operations()) operations.push(op);
    return "ready";
  });
  await act(async () => { await view.result.current.editSelection(element => [{ kind: "update", element: { ...element, zIndex: 9 } }]); });
  const updated = (count > 128 ? operations : store().mapOperations).filter(op => op.kind === "update").map(op => op.element.id);
  expect(updated).toHaveLength(count - 3);
  expect(updated).not.toEqual(expect.arrayContaining(["s1"]));
  expect(updated).not.toEqual(expect.arrayContaining(["s2"]));
  expect(updated).not.toEqual(expect.arrayContaining(["s3"]));
});

it.each(["locked", "readOnly"])("fails closed for a %s whole query even when locked members were excluded", async mode => {
  const { view } = await setup(4, mode === "locked", mode === "readOnly");
  let saved = true;
  await act(async () => { saved = await view.result.current.editQuery({ layerId: "map" }, element => [{ kind: "update", element: { ...element, layerId: "target" } }], [], [{ kind: "layer.delete", id: "map" }]); });
  expect(saved).toBe(false);
  expect(store().past).toHaveLength(0);
  expect(store().mapLayers.has("map")).toBe(true);
});
