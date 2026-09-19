import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMapDocumentSource } from "../../api/map-document";
import { useMapEditor } from "./use-map-editor";
import { useFloorEditorStore } from "./editor-store";
import { createMapElementFromDrag } from "./map-element-tools";
import type { MapSceneCanvasHandle } from "../map-scene/MapSceneCanvas";

vi.mock("../../api/map-document", () => ({ createMapDocumentSource: vi.fn() }));
const store = useFloorEditorStore.getState;
const elements = Array.from({ length: 129 }, (_, i) => createMapElementFromDrag("rectangle", { x: 100, y: 100 }, { x: 120, y: 120 }, `s${i}`)!);
const extra = { ...createMapElementFromDrag("rectangle", { x: 800, y: 100 }, { x: 820, y: 120 }, "extra")!, layerId: "other" };
beforeEach(() => {
  store().reset();
  store().initialize({ floor: { id: "floor", siteId: "site", name: "F", level: 1, mapRevision: 1, floorPlan: null,
    mapDocument: { formatVersion: 1, generationId: "gen", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: 130,
      manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } }, fixtures: [], objects: [], lightSlots: [] }, "user");
  store().loadMapStructures(store().mapScope!, { groups: [{ id: "extra-group", name: "Extra", parentId: null, visible: true, locked: false }],
    layers: ["map", "other"].map((id, order) => ({ id, name: id, order, visible: true, locked: false })) });
  vi.mocked(createMapDocumentSource).mockReturnValue({ scopeKey: "test",
    getSelection: vi.fn(async (document, query) => {
      const matches = query.groupId ? [extra] : elements;
      const start = Number(query.cursor ?? 0), end = Math.min(matches.length, start + 128);
      return { generationId: document.generationId, revision: document.revision, ids: matches.slice(start, end).map(e => e.id), nextCursor: end < matches.length ? String(end) : null };
    }), getElements: vi.fn(async (_document, ids: string[]) => [...elements, extra].filter(e => ids.includes(e.id)))
  } as unknown as ReturnType<typeof createMapDocumentSource>);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["layer", "bounds", "group"])("retains a bounded query through additive %s picking, then replaces it on plain picking", async mode => {
  extra.groupId = mode === "group" ? "extra-group" : null;
  const view = renderHook(() => useMapEditor({ floorId: "floor", authScope: "user", readOnly: false, lease: { leaseToken: "lease", leaseFence: 1 } }));
  act(() => view.result.current.selectQuery(mode === "bounds" ? { bounds: { minX: 90, minY: 90, maxX: 130, maxY: 130 } } : { layerId: "map" }));
  await waitFor(() => expect(view.result.current.selectionCount).toBe(129));
  const renderer = { pick: vi.fn(async () => ({ element: extra })), setDraftChanges: vi.fn(), setPromotedElementIds: vi.fn() } as unknown as MapSceneCanvasHandle;
  act(() => view.result.current.onReady(renderer));
  await act(async () => { await view.result.current.pick({ x: 800, y: 100 }, false, true); });
  await waitFor(() => expect(view.result.current.selectionCount).toBe(130));
  expect(view.result.current.selection).toHaveLength(0);
  expect(store().mapSelection.elementIds.length + store().mapSelection.groupIds.length).toBe(1);
  const deleted: string[] = [];
  vi.spyOn(store(), "prepareMapStream").mockImplementation(async transaction => {
    for await (const op of transaction.operations()) if (op.kind === "delete") deleted.push(op.id);
    return "ready";
  });
  await act(async () => { await view.result.current.editSelection(e => [{ kind: "delete", id: e.id }]); });
  expect(new Set(deleted)).toEqual(new Set([...elements, extra].map(e => e.id)));
  await act(async () => { await view.result.current.pick({ x: 800, y: 100 }, true, false); });
  await waitFor(() => expect(view.result.current.selectionCount).toBe(1));
});
