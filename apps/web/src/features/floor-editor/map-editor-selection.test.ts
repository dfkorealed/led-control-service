import { describe, expect, it, vi } from "vitest";
import type { MapDocumentRef, MapElement, MapGroup, MapLayer } from "@led-control/shared/map-document-contracts";
import { createMapElementFromDrag } from "./map-element-tools";
import { isMapSelectionLocked, planMapLayerRemoval, planMapUngroup } from "./map-editor-selection";
import { inspectMapSelection } from "./map-editor-selection-stream";

const ref = { generationId: "generation", revision: 1 } as MapDocumentRef;
const layer: MapLayer = { id: "map", name: "Shapes", order: 0, visible: true, locked: false };
const group: MapGroup = { id: "group", name: "Group", parentId: null, visible: true, locked: false };
const shape = (index: number): MapElement => ({ ...createMapElementFromDrag("rectangle", { x: index, y: 20 }, { x: index + 10, y: 30 }, `shape-${index}`)!, groupId: "group" });

describe("complete map selection", () => {
  it("resolves all group pages including hidden children, not a 64-element prefix", async () => {
    const elements = Array.from({ length: 65 }, (_, i) => shape(i));
    elements[64].visible = false;
    const getSelection = vi.fn(async (_ref, input) => ({ generationId: "generation", revision: 1,
      ids: input.cursor ? [elements[64].id] : elements.slice(0, 64).map(e => e.id), nextCursor: input.cursor ? null : "next" }));
    const result = await inspectMapSelection({ document: ref, selection: { elementIds: [], groupIds: ["group"] },
      source: { getSelection, getElements: async (_ref, ids) => elements.filter(e => ids.includes(e.id)) },
      operations: [], groups: new Map([[group.id, group]]), signal: new AbortController().signal });
    expect(result.inline).toEqual(elements);
    expect(getSelection).toHaveBeenCalledTimes(2);
  });
  it("merges draft membership and deletions with canonical pages", async () => {
    const moved = { ...shape(1), groupId: null };
    const added = shape(3);
    const result = await inspectMapSelection({ document: ref, selection: { elementIds: [], groupIds: ["group"] },
      source: { getSelection: async () => ({ ...ref, ids: ["shape-1", "shape-2"], nextCursor: null }), getElements: async () => [shape(1), shape(2)] },
      operations: [{ kind: "update", element: moved }, { kind: "delete", id: "shape-2" }, { kind: "add", element: added }],
      groups: new Map([[group.id, group]]), signal: new AbortController().signal });
    expect(result.inline).toEqual([added]);
  });
  it("fails closed for cyclic cursor and abort before returning a prefix", async () => {
    const input = { document: ref, selection: { elementIds: [], groupIds: ["group"] },
      source: { getSelection: async () => ({ ...ref, ids: [], nextCursor: "cycle" }), getElements: async () => [] },
      operations: [], groups: new Map([[group.id, group]]), signal: new AbortController().signal };
    await expect(inspectMapSelection(input)).rejects.toThrow();
    await expect(inspectMapSelection({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
  });
  it("includes new local shapes in a range selection", async () => {
    const result = await inspectMapSelection({ document: ref, selection: { elementIds: [], groupIds: [] },
      filter: { bounds: { minX: 0, minY: 0, maxX: 50, maxY: 50 } },
      source: { getSelection: async () => ({ ...ref, ids: [], nextCursor: null }), getElements: async () => [] },
      operations: [{ kind: "add", element: shape(1) }, { kind: "add", element: shape(100) }],
      groups: new Map(), signal: new AbortController().signal });
    expect(result.inline?.map(element => element.id)).toEqual(["shape-1"]);
  });
  it("honors locked ancestors and layers for the whole selection", () => {
    const child = { ...group, id: "child", parentId: "group" };
    expect(isMapSelectionLocked([{ ...shape(1), groupId: "child" }], new Map<string, MapGroup>([["group", { ...group, locked: true }], ["child", child]]), new Map([["map", layer]]))).toBe(true);
    expect(isMapSelectionLocked([shape(1)], new Map([["group", group]]), new Map([["map", { ...layer, locked: true }]]))).toBe(true);
  });
  it("ungroups without changing geometry or dropping nested groups", () => {
    const child = { ...group, id: "child", parentId: "group" };
    const ops = planMapUngroup(group, [shape(1)], [group, child]);
    expect(ops).toEqual([{ kind: "update", element: { ...shape(1), groupId: null } },
      { kind: "group.put", group: { ...child, parentId: null } }, { kind: "group.delete", id: "group" }]);
  });
  it("moves every layer reference before removing the layer", () => {
    const ops = planMapLayerRemoval("map", "other", [shape(1), shape(2)]);
    expect(ops).toEqual([1, 2].map(i => ({ kind: "update", element: { ...shape(i), layerId: "other" } })).concat([{ kind: "layer.delete", id: "map" }] as never));
  });
});
