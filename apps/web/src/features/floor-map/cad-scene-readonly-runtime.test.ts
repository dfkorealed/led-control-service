import type { CadElementOverride, CadSceneManifest, CadSceneTile } from "@led-control/shared";
import { afterEach, expect, it, vi } from "vitest";
import type { CadSceneRenderBackend } from "../cad-scene/CadSceneRenderer";
import { buildCadGeometryBatches, type DecodedCadSceneTile } from "../cad-scene/cad-scene-worker";
import { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import { createReadOnlyCadSceneRenderer } from "./cad-scene-readonly-runtime";
import { assertBoundedCadTransforms } from "./cad-moved-preload";

const decoding = vi.hoisted(() => ({ decode: vi.fn(), destroy: vi.fn() }));
vi.mock("../cad-scene/cad-scene-worker", async importOriginal => ({
  ...await importOriginal<typeof import("../cad-scene/cad-scene-worker")>(),
  createCadSceneWorkerClient: () => decoding
}));
afterEach(() => vi.clearAllMocks());

it("does not rebuild or reject a spatial index for a tile with no affected overrides", () => {
  const tile = { pickEntries: [{ elementId: "unchanged", bounds: { minX: 0, minY: 0, maxX: 32768, maxY: 32768 } }] } as DecodedCadSceneTile;
  expect(() => assertBoundedCadTransforms(tile, new Map())).not.toThrow();
});

const source: CadSceneTile = {
  version: 1, sceneId: "11111111-1111-4111-8111-111111111111", assetId: "source",
  tileX: 0, tileY: 0, lod: 0, part: 0, primitiveCount: 1, byteSize: 1,
  sha256: "0".repeat(64), bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }
};
const moved: CadElementOverride = {
  elementId: "moved", hidden: false, locator: { tileX: 0, tileY: 0, lod: 0, part: 0 },
  transform: { translateX: 2500, translateY: 2500, scaleX: 1, scaleY: 1, rotation: 0 },
  strokeColor: "#ff0000", fillColor: "#ff0000", strokeWidth: null, text: null
};
const camera = { centerX: 2600, centerY: 2600, zoom: 1, viewportWidth: 200, viewportHeight: 200 };

function harness(tiles = [source], override = moved) {
  const drawn = new Map<string, DecodedCadSceneTile>();
  const backend: CadSceneRenderBackend = {
    mount: vi.fn(async () => undefined), resize: vi.fn(), setCamera: vi.fn(),
    replaceTile: (key, tile) => { drawn.set(key, tile); },
    removeTile: key => { drawn.delete(key); }, suspend: () => { drawn.clear(); }, render: vi.fn(),
    destroy: () => { drawn.clear(); }
  };
  decoding.decode.mockImplementation(async (_payload, descriptor: CadSceneTile) => ({
    descriptor, byteSize: 1,
    ...buildCadGeometryBatches([{
      elementId: "moved", groupId: null, layerName: "WALLS", sourceType: "LWPOLYLINE",
      type: "rectangle", bounds: { minX: 80, minY: 80, maxX: 120, maxY: 120 }, clipBounds: null,
      style: { strokeColor: null, fillColor: "#ffffff", strokeWidth: 0, opacity: 1 },
      geometry: { origin: { x: 80, y: 80 }, width: 40, height: 40, rotation: 0 }
    }])
  }));
  const loadTile = vi.fn(async (_tile: CadSceneTile, _signal: AbortSignal) => new Uint8Array([1]));
  const memoryBudget = new CadSceneMemoryBudget(32 * 1024 * 1024);
  return {
    drawn, loadTile, memoryBudget,
    create: () => createReadOnlyCadSceneRenderer({
      manifest: { width: 4096, height: 4096, tileSize: 512, tiles } as CadSceneManifest,
      loadTile, backendFactory: () => backend, memoryBudget
    }, new Map([[override.elementId, override]]))
  };
}

it("cold-loads a persisted source locator outside the destination preload ring", async () => {
  const { create, drawn, loadTile, memoryBudget } = harness();
  const renderer = await create();
  try {
    await renderer.mount(document.createElement("canvas"));
    await renderer.setCamera(camera);
    expect(loadTile).toHaveBeenCalledWith(source, expect.any(AbortSignal));
    const tile = [...drawn.values()].find(tile => tile.pickEntries.some(entry => entry.elementId === "moved"));
    expect(tile?.pickEntries[0].bounds).toEqual({ minX: 2580, minY: 2580, maxX: 2620, maxY: 2620 });
    expect(memoryBudget.totalBytes).toBeGreaterThan(0);
    await renderer.setCamera({ ...camera, centerX: 100, centerY: 100 });
    await renderer.setCamera(camera);
    expect([...drawn.values()].filter(tile => tile.pickEntries.some(entry => entry.elementId === "moved"))).toHaveLength(1);
  } finally { renderer.destroy(); }
  expect(memoryBudget.totalBytes).toBe(0);
  expect(drawn.size).toBe(0);
});

it("fails closed on a persisted locator not present in the manifest", async () => {
  const { create } = harness([], moved);
  await expect(create().then(async renderer => {
    try { await renderer.mount(document.createElement("canvas")); }
    finally { renderer.destroy(); }
  })).rejects.toThrow(/locator/);
});

it("fails closed when moved preload cannot fit the aggregate memory budget", async () => {
  const { create, memoryBudget } = harness();
  memoryBudget.reserve("other", "pinned", memoryBudget.maximumBytes);
  memoryBudget.setPinned("other", "pinned", true);
  await expect(create().then(async renderer => {
    try { await renderer.mount(document.createElement("canvas")); }
    finally { renderer.destroy(); }
  })).rejects.toThrow(/memory budget/);
  expect(memoryBudget.totalBytes).toBe(memoryBudget.maximumBytes);
});

it("bounds connected fragment preloading to 32 tiles instead of scanning the scene", async () => {
  const tiles = Array.from({ length: 40 }, (_, tileX) => ({
    ...source, tileX, assetId: `source-${tileX}`,
    bounds: { minX: tileX * 512, minY: 0, maxX: (tileX + 1) * 512, maxY: 512 }
  }));
  const { create, loadTile, memoryBudget } = harness(tiles);
  decoding.decode.mockImplementation(async (_payload, descriptor: CadSceneTile) => ({
    descriptor, byteSize: 1,
    ...buildCadGeometryBatches([{
      elementId: "moved", groupId: null, layerName: "WALLS", sourceType: "LINE", type: "line",
      bounds: { ...descriptor.bounds, minY: 80, maxY: 80 }, clipBounds: null,
      style: { strokeColor: "#ffffff", fillColor: null, strokeWidth: 1, opacity: 1 },
      geometry: { start: { x: descriptor.bounds.minX, y: 80 }, end: { x: descriptor.bounds.maxX, y: 80 } }
    }])
  }));
  const renderer = await create();
  try { await expect(renderer.mount(document.createElement("canvas"))).rejects.toThrow(/tile\/byte limit/); }
  finally { renderer.destroy(); }
  expect(loadTile).toHaveBeenCalledTimes(32);
  expect(memoryBudget.totalBytes).toBe(0);
});

it("aborts pending moved geometry on destroy without late allocations", async () => {
  const { create, loadTile, drawn, memoryBudget } = harness();
  let resolve!: (bytes: Uint8Array<ArrayBuffer>) => void;
  loadTile.mockImplementation(() => new Promise(done => { resolve = done; }));
  const renderer = await create();
  const mounting = renderer.mount(document.createElement("canvas"));
  renderer.destroy();
  expect(loadTile.mock.calls[0][1].aborted).toBe(true);
  resolve(new Uint8Array([1]));
  await expect(mounting).rejects.toThrow();
  expect(decoding.decode).not.toHaveBeenCalled();
  expect(drawn.size).toBe(0);
  expect(memoryBudget.totalBytes).toBe(0);
});

it("rejects visible legacy transforms without source locators instead of a partial map", async () => {
  const { create } = harness([source], { ...moved, locator: null });
  await expect(create().then(async renderer => {
    try { await renderer.mount(document.createElement("canvas")); }
    finally { renderer.destroy(); }
  })).rejects.toThrow(/locator/);
});

it("restores pinned moved geometry after WebGL context loss", async () => {
  const { create, drawn } = harness();
  const renderer = await create();
  const canvas = document.createElement("canvas");
  try {
    await renderer.mount(canvas);
    await renderer.setCamera(camera);
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(drawn.size).toBe(0);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    await renderer.setCamera(camera);
    expect([...drawn.values()].some(tile => tile.pickEntries.some(entry => entry.elementId === "moved"))).toBe(true);
  } finally { renderer.destroy(); }
});
