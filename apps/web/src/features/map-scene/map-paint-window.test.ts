import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDisplayTile, OrderedMapDisplayPrimitive } from "@led-control/shared/map-display-contracts";
import { encodeMapDisplayTile } from "../../../../api/src/floor-import/cad-scene-codec";
import { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import { MapPaintAssetCache, MapPaintWindow, createMapPageCursor } from "./map-paint-window";
import { mergeMapPaintStreams } from "./map-ordered-pages";

function fixture(id: string, start: number) {
  const values: OrderedMapDisplayPrimitive[] = Array.from({ length: 4 }, (_, i) => ({
    type: "line", elementId: `${id}-${i}`, zIndex: start + i * 2, fragmentOrder: 0,
    layerName: "display", groupId: null, sourceType: "line",
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, clipBounds: null,
    style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 0.5 },
    geometry: { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }
  }));
  const key = (index: number) => ({ elementId: values[index].elementId, zIndex: values[index].zIndex, fragmentOrder: 0 });
  const bytes = encodeMapDisplayTile(values);
  const tile: MapDisplayTile = { version: 2, sceneId: "test", assetId: id, tileX: start, tileY: 0, lod: 0, part: 0,
    bounds: values[0].bounds, primitiveCount: 4, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    pages: [0, 2].map((index, sequence) => ({ layerId: "canonical", sequence, primitiveStart: index, primitiveCount: 2,
      firstKey: key(index), lastKey: key(index + 1) })) };
  return { tile, bytes };
}
afterEach(() => vi.unstubAllGlobals());
describe("bounded ordered asset and logical-page window", () => {
  it("fences an old acquire and old lease from a cache cleared and refilled at the same key", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const a = fixture("a", 0), budget = new CadSceneMemoryBudget(32 * 1024 * 1024), assets = new MapPaintAssetCache(budget);
    let complete!: (bytes: Uint8Array) => void;
    const pending = assets.acquire(a.tile, new AbortController().signal, () => new Promise(resolve => { complete = resolve; }));
    const rejected = expect(pending).rejects.toThrow("Aborted");
    assets.clear();
    const current = await assets.acquire(a.tile, new AbortController().signal, async () => a.bytes);
    const bytes = budget.totalBytes;
    complete(a.bytes); await rejected;
    expect(budget.totalBytes).toBe(bytes);
    assets.clear();
    const replacement = await assets.acquire(a.tile, new AbortController().signal, async () => a.bytes);
    current.release();
    expect(budget.reserve("pressure", "all", budget.maximumBytes)).toBe(false);
    replacement.release(); assets.clear(); expect(budget.totalBytes).toBe(0);
  });

  it("shares validated assets between windows, evicts idle inputs and reloads after pressure", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const a = fixture("a", 0), b = fixture("b", 1), budget = new CadSceneMemoryBudget(32 * 1024 * 1024);
    const assets = new MapPaintAssetCache(budget), load = vi.fn(async (tile: MapDisplayTile) => tile.assetId === "a" ? a.bytes : b.bytes);
    const read = async (value: ReturnType<typeof fixture>) => {
      const window = new MapPaintWindow({ budget, assets, load, signal: new AbortController().signal, layerId: () => "canonical" });
      try { const record = await window.read(value.tile, value.tile.pages![0], 0); record.release?.(); return record.primitive.elementId; }
      finally { window.close(); }
    };
    try {
      expect(await read(a)).toBe("a-0"); expect(await read(b)).toBe("b-0"); expect(await read(a)).toBe("a-0");
      expect(load).toHaveBeenCalledTimes(2); expect(budget.totalBytes).toBeGreaterThan(0);
      expect(budget.reserve("pressure", "all", budget.maximumBytes)).toBe(true);
      budget.releaseOwner("pressure");
      expect(await read(a)).toBe("a-0"); expect(load).toHaveBeenCalledTimes(3);
    } finally { assets.clear(); expect(budget.totalBytes).toBe(0); }
  });

  it("does not publish an aborted shared asset or reuse bytes with a changed digest", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const a = fixture("same", 0), b = fixture("same", 2), budget = new CadSceneMemoryBudget(32 * 1024 * 1024);
    const assets = new MapPaintAssetCache(budget), controller = new AbortController();
    let complete!: (bytes: Uint8Array) => void;
    const window = new MapPaintWindow({ budget, assets, signal: controller.signal, layerId: () => "canonical",
      load: () => new Promise(resolve => { complete = resolve; }) });
    const pending = window.read(a.tile, a.tile.pages![0], 0);
    controller.abort(); await expect(pending).rejects.toThrow();
    complete(a.bytes); await Promise.resolve(); expect(budget.totalBytes).toBe(0);
    const load = vi.fn(async (tile: MapDisplayTile) => tile.sha256 === a.tile.sha256 ? a.bytes : b.bytes);
    try {
      for (const value of [a, b]) {
        const next = new MapPaintWindow({ budget, assets, load, signal: new AbortController().signal, layerId: () => "canonical" });
        try { const record = await next.read(value.tile, value.tile.pages![0], 0); expect(record.primitive.zIndex).toBe(value === a ? 0 : 2); record.release?.(); }
        finally { next.close(); }
      }
      expect(load).toHaveBeenCalledTimes(2);
    } finally { window.close(); assets.clear(); expect(budget.totalBytes).toBe(0); }
  });

  it("merges interleaved pages with one admitted raw asset and bounded reusable pages", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const a = fixture("a", 0), b = fixture("b", 1), data = new Map([["a", a], ["b", b]]);
    const budget = new CadSceneMemoryBudget(32 * 1024 * 1024);
    let peak = 0, loads = 0;
    const window = new MapPaintWindow({ budget, signal: new AbortController().signal, layerId: () => "canonical",
      async load(tile) { loads++; expect(budget.totalBytes).toBeGreaterThan(tile.byteSize); return data.get(tile.assetId)!.bytes; } });
    const streams = [a, b].map(({ tile }) => createMapPageCursor(tile.pages!.map(page => ({ tile, page })), window));
    const ids: string[] = [];
    for await (const record of mergeMapPaintStreams(streams, { signal: new AbortController().signal, reserveHeads() {} })) {
      ids.push(record.primitive.elementId); peak = Math.max(peak, budget.totalBytes);
    }
    expect(ids).toEqual(["a-0", "b-0", "a-1", "b-1", "a-2", "b-2", "a-3", "b-3"]);
    expect(loads).toBeLessThanOrEqual(4); expect(peak).toBeLessThan(32 * 1024 * 1024);
    window.close(); expect(budget.totalBytes).toBe(0);
  });

  it("evicts previous raw input before replacement fetch and fails admission before network", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const a = fixture("a", 0), b = fixture("b", 1);
    const budget = new CadSceneMemoryBudget(1000), load = vi.fn(async () => a.bytes);
    const window = new MapPaintWindow({ budget, signal: new AbortController().signal, layerId: () => "canonical", load });
    await expect(window.read(a.tile, a.tile.pages![0], 0)).rejects.toThrow("budget");
    expect(load).not.toHaveBeenCalled(); window.close(); expect(budget.totalBytes).toBe(0);
    const enough = new CadSceneMemoryBudget(32 * 1024 * 1024);
    const released: number[] = [];
    const second = new MapPaintWindow({ budget: enough, signal: new AbortController().signal, layerId: () => "canonical",
      async load(tile) { released.push(second.rawBytes); return tile.assetId === "a" ? a.bytes : b.bytes; } });
    (await second.read(a.tile, a.tile.pages![0], 0)).release?.();
    (await second.read(b.tile, b.tile.pages![0], 0)).release?.();
    expect(released).toEqual([0, 0]); second.close(); expect(enough.totalBytes).toBe(0);
  });

  it("drains abort after an uncooperative loader and releases every reservation", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const { tile, bytes } = fixture("a", 0), controller = new AbortController();
    const budget = new CadSceneMemoryBudget(32 * 1024 * 1024);
    let complete!: (value: Uint8Array) => void;
    const window = new MapPaintWindow({ budget, signal: controller.signal, layerId: () => "canonical",
      load: () => new Promise(resolve => { complete = resolve; }) });
    const pending = window.read(tile, tile.pages![0], 0);
    controller.abort();
    await expect(pending).rejects.toThrow(); expect(budget.totalBytes).toBe(0);
    complete(bytes); await Promise.resolve(); window.close(); expect(budget.totalBytes).toBe(0);
  });
});
