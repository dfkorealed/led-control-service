import { MapElement, MapOp } from "@led-control/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBulkMap } from "./map-document-bulk";

const layer = { id: "map", name: "map", order: 0, visible: true, locked: false };
const element = (id: string): MapElement => ({ id, type: "rectangle", layerId: "map", groupId: null,
  geometry: { origin: { x: 10, y: 10 }, width: 20, height: 20 },
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, zIndex: 0, visible: true, locked: false,
  style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 }, provenance: null });
async function* stream<T>(values: T[]) { yield* values; }
describe("bounded bulk map preparation", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "led-bulk-test-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const prepare = async (elements: MapElement[], operations: MapOp[], patch = {}) => prepareBulkMap(await mkdtemp(join(directory, "attempt-")),
    stream(elements), stream(operations), { width: 1200, height: 800, groups: [], layers: [layer], ...patch });
  async function collect(prepared: Awaited<ReturnType<typeof prepare>>) {
    const elements = []; for await (const item of prepared.elements()) elements.push(item); return elements;
  }
  it("merges over 2000 changes by disk partitions without a whole-document geometry map", async () => {
    const operations: MapOp[] = Array.from({ length: 2101 }, (_, i) => ({ kind: "add", element: element(String(i)) }));
    const prepared = await prepare([element("original")], operations);
    expect(await collect(prepared)).toHaveLength(2102);
    expect(prepared.layers).toEqual([layer]);
  });
  it("deletes a group subtree while retaining unrelated elements", async () => {
    const groups = [{ id: "root", parentId: null, name: "root", locked: false, visible: true },
      { id: "child", parentId: "root", name: "child", locked: false, visible: true }];
    const prepared = await prepare([{ ...element("one"), groupId: "child" }, element("two")],
      [{ kind: "group.delete", id: "root" }], { groups });
    expect(await collect(prepared)).toEqual([element("two")]); expect(prepared.groups).toEqual([]);
  });
  it("rejects duplicates, missing targets and locked subtree members without publishing a prefix", async () => {
    await expect(collect(await prepare([element("x")], [{ kind: "add", element: element("x") }]))).rejects.toThrow();
    await expect(collect(await prepare([], [{ kind: "delete", id: "missing" }]))).rejects.toThrow();
    await expect(collect(await prepare([], [{ kind: "add", element: element("x") }, { kind: "add", element: element("x") }]))).rejects.toThrow();
    await expect(collect(await prepare([{ ...element("x"), locked: true }], [{ kind: "layer.delete", id: "map" }]))).rejects.toThrow(/locked/);
  });
  it("validates every retained geometry on resize rather than truncating", async () => {
    await expect(collect(await prepare([{ ...element("x"), transform: { ...element("x").transform, x: 900 } }], [], { width: 512 }))).rejects.toThrow(/bounds/);
  });
  it("supports explicit unlock and new structure references but rejects cycles", async () => {
    const prepared = await prepare([{ ...element("x"), locked: true }], [{ kind: "update", element: element("x") }]);
    expect(await collect(prepared)).toEqual([element("x")]);
    await expect(prepare([], [{ kind: "group.put", group: { id: "cycle", name: "cycle", parentId: "cycle", locked: false, visible: true } }])).rejects.toThrow();
  });
});
