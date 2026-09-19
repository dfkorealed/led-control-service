import { describe, expect, it, vi } from "vitest";
import type { MapDocumentRef, MapElement, MapOp } from "@led-control/shared/map-document-contracts";
import { inspectMapSelection, streamMapSelection } from "./map-editor-selection-stream";

const document = { generationId: "gen", revision: 1, elementCount: 500_000 } as MapDocumentRef;
const element = (i: number): MapElement => ({ id: `e${i}`, type: "rectangle", layerId: "map", groupId: "g", zIndex: i,
  visible: true, locked: false, provenance: null, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 },
  geometry: { origin: { x: i, y: 0 }, width: 1, height: 1 } });
function query(count: number) {
  const source = {
    getSelection: vi.fn(async (_ref, input) => { const start = Number(input.cursor ?? 0), end = Math.min(count, start + 128);
      return { generationId: "gen", revision: 1, ids: Array.from({ length: end - start }, (_, n) => `e${start + n}`), nextCursor: end < count ? String(end) : null }; }),
    getElements: vi.fn(async (_ref, ids: readonly string[]) => ids.map(id => element(Number(id.slice(1)))))
  };
  return { document, source, selection: { elementIds: [], groupIds: ["g"] }, operations: [] as MapOp[],
    groups: new Map([["g", { id: "g", name: "G", parentId: null, visible: true, locked: false }]]),
    layers: new Map([["map", { id: "map", name: "Map", order: 0, visible: true, locked: false }]]), signal: new AbortController().signal };
}
describe("lazy common selection", () => {
  it("pulls at most one page before the consumer requests more, including early cancellation", async () => {
    const input = query(500_000), stream = streamMapSelection(input);
    await stream.next(); expect(input.source.getSelection).toHaveBeenCalledTimes(1);
    expect(input.source.getElements).toHaveBeenCalledTimes(1);
    await stream.return(undefined);
    expect(input.source.getSelection).toHaveBeenCalledTimes(1);
  });
  it("summarizes every selected element beyond the old cap without retaining its IDs or originals", async () => {
    const input = query(5000), summary = await inspectMapSelection(input);
    expect(summary.count).toBe(5000); expect(summary.inline).toBeNull();
    expect(summary.bounds).toEqual({ minX: 0, minY: 0, maxX: 5000, maxY: 1 });
    expect(summary.locked).toBe(false);
    expect(input.source.getElements.mock.calls.every(([, ids]) => ids.length <= 128)).toBe(true);
  });
  it("retains all 65 small originals for normal bbox transactions, not a prefix", async () => {
    const summary = await inspectMapSelection(query(65));
    expect(summary.inline).toHaveLength(65); expect(summary.count).toBe(65);
  });
  it("deduplicates overlapping groups/ranges and overlays changed membership without a whole-ID set", async () => {
    const input = query(3);
    input.operations = [{ kind: "delete", id: "e0" }, { kind: "update", element: { ...element(1), groupId: null } }, { kind: "add", element: element(5) }];
    const result: MapElement[] = [];
    for await (const value of streamMapSelection({ ...input, filters: [{ groupId: "g" }, { layerId: "map" }] })) result.push(value);
    expect(result.map(value => value.id).sort()).toEqual(["e1", "e2", "e5"]);
  });
  it("aggregates locked members after the inline budget and rejects stale or cyclic pages", async () => {
    const input = query(3000);
    input.source.getElements.mockImplementation(async (_ref, ids) => ids.map(id => ({ ...element(Number(id.slice(1))), locked: id === "e2999" })));
    expect((await inspectMapSelection(input)).locked).toBe(true);
    input.source.getSelection.mockResolvedValue({ generationId: "other", revision: 1, ids: [], nextCursor: null });
    await expect(inspectMapSelection(input)).rejects.toThrow();
    input.source.getSelection.mockResolvedValue({ generationId: "gen", revision: 1, ids: [], nextCursor: "same" });
    await expect(inspectMapSelection(input)).rejects.toThrow();
    await expect(inspectMapSelection({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
