import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { encodeMapDisplayTile } from "../../../../api/src/floor-import/cad-scene-codec";
import type { MapElement } from "@led-control/shared/map-document-contracts";
import type { MapDisplayTile } from "@led-control/shared/map-display-contracts";
import type { CadRasterDisplayRequest } from "../cad-scene/CadSceneRenderer";
import { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import { buildMapGeometryBatches } from "./map-scene-geometry";

const calls = vi.hoisted(() => ({ bake: vi.fn(), remove: vi.fn(), paint: vi.fn(), render: vi.fn(), visible: vi.fn() }));
vi.mock("../cad-scene/CadSceneRenderer", () => ({ PixiCadSceneRenderBackend: class {
  replaceRaster(...args: unknown[]) { calls.bake(...args); }
  removeTile(...args: unknown[]) { calls.remove(...args); }
  render() { calls.render(); }
  setCamera() {}
  setRasterVisible(...args: unknown[]) { calls.visible(...args); }
  suspend() {}
  destroy() { this.suspend(); }
} }));
vi.mock("./map-native-painter", () => ({ paintMapElement: calls.paint, paintDisplayPrimitive: calls.paint }));
import { MapRasterBackend } from "./map-raster-backend";

const line: MapElement = { id: "edge", layerId: "layer", groupId: null, type: "line", zIndex: 0,
  geometry: { start: { x: 512, y: 30 }, end: { x: 512, y: 120 } },
  style: { fillColor: null, strokeColor: "#ffffff", strokeWidth: 10, opacity: 0.5 },
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, visible: true, locked: false, provenance: null };
const descriptor: MapDisplayTile = { version: 2, sceneId: "scene", assetId: "tile", tileX: 0, tileY: 0, lod: 0, part: 0,
  primitiveCount: 1, byteSize: 100, sha256: "a".repeat(64), bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 } };
function setup(maximum = 32 * 1024 * 1024, onPaintReady?: (ready: boolean) => void) {
  const budget = new CadSceneMemoryBudget(maximum), backend = new MapRasterBackend(budget, undefined, onPaintReady);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform() {}, beginPath() {} } as unknown as GPUCanvasContext);
  const request: CadRasterDisplayRequest<MapDisplayTile> = {
    camera: { centerX: 512, centerY: 100, viewportWidth: 200, viewportHeight: 200, zoom: 1 }, resolution: 1,
    manifest: { version: 2, sceneId: "scene", regionId: "region", manifestAssetId: "manifest", width: 1024, height: 512,
      padding: 0, gridSize: 10, tileSize: 512, lodMode: "additive", primitiveCount: 0, tileCount: 0,
      byteSize: 1, sha256: "a".repeat(64), sourceBounds: { minX: 0, minY: 0, maxX: 1024, maxY: 512 },
      transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [] },
    loadTile: vi.fn(async () => new Uint8Array()),
    worker: { decode: vi.fn(async (_bytes, tile) => ({ descriptor: tile, byteSize: 100,
      ...buildMapGeometryBatches([], 1, true), nativePrimitives: [] })), destroy() {} },
    signal: new AbortController().signal, excludedIds: new Set(), onError: vi.fn(), onDegraded: vi.fn()
  };
  return { budget, backend, request };
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("bounded ordered raster lifecycle", () => {
  it("finishes a still-wanted pending cell when the next camera only adds coverage", async () => {
    const { backend, request, budget } = setup();
    request.manifest = { ...request.manifest, version: 2, width: 2048, tiles: [descriptor] };
    request.camera = { ...request.camera, centerX: 256, centerY: 256, viewportWidth: 100, viewportHeight: 100 };
    let release!: () => Promise<void>;
    let signal!: AbortSignal;
    const load = request.loadTile;
    let started = false;
    request.loadTile = vi.fn((tile, currentSignal) => {
      if (started) return load(tile, currentSignal);
      started = true;
      signal = currentSignal;
      return new Promise<Uint8Array>(resolve => { release = async () => resolve(await load(tile, currentSignal)); });
    });
    try {
      const first = backend.renderDisplay(request);
      await vi.waitFor(() => expect(request.loadTile).toHaveBeenCalledOnce());
      const next = backend.renderDisplay({ ...request, camera: { ...request.camera, centerX: 500, viewportWidth: 600 } });
      const wasAborted = signal.aborted;
      await release(); await first; await next;
      expect(wasAborted).toBe(false);
      expect(request.loadTile).toHaveBeenCalledOnce();
      expect(request.onError).not.toHaveBeenCalled();
    } finally { backend.destroy(); expect(budget.totalBytes).toBe(0); }
  });

  it("does not schedule another draw after a camera frame already displays complete coverage", async () => {
    const frames = new Map<number, FrameRequestCallback>(); let id = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
    vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
    const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
    const ready = vi.fn(), { backend, request, budget } = setup(undefined, ready);
    try {
      backend.setCamera(request.camera); backend.render(); await backend.renderDisplay(request); flush();
      calls.render.mockClear();
      const camera = { ...request.camera, centerX: request.camera.centerX + 0.25 };
      backend.setCamera(camera); backend.render(); await backend.renderDisplay({ ...request, camera });
      await Promise.resolve(); flush();
      expect(calls.render).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenLastCalledWith(true, request.manifest);
    } finally { backend.destroy(); expect(budget.totalBytes).toBe(0); vi.unstubAllGlobals(); }
  });

  it("reuses a validated ordered asset across density refreshes within the aggregate budget", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const { backend, request, budget } = setup();
    const primitive = { type: "line" as const, elementId: "base", zIndex: 0, fragmentOrder: 0,
      layerName: "layer", groupId: null, sourceType: "line", clipBounds: null,
      bounds: { minX: 20, minY: 20, maxX: 40, maxY: 40 }, style: line.style,
      geometry: { start: { x: 20, y: 20 }, end: { x: 40, y: 40 } } };
    const bytes = encodeMapDisplayTile([primitive]), key = { elementId: "base", zIndex: 0, fragmentOrder: 0 };
    const tile = { ...descriptor, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      pages: [{ layerId: "layer", sequence: 0, primitiveStart: 0, primitiveCount: 1, firstKey: key, lastKey: key }] };
    request.manifest = { ...request.manifest, orderedPages: { version: 1 }, tiles: [tile] } as typeof request.manifest;
    request.loadTile = vi.fn(async () => bytes);
    try {
      await backend.renderDisplay(request);
      await backend.renderDisplay({ ...request, camera: { ...request.camera, zoom: 1.1 } });
      await new Promise(resolve => setTimeout(resolve, 160));
      expect(request.loadTile).toHaveBeenCalledOnce();
      expect(budget.totalBytes).toBeLessThanOrEqual(budget.maximumBytes);
      backend.suspend(); expect(budget.totalBytes).toBe(0);
    } finally { backend.destroy(); vi.unstubAllGlobals(); }
  });

  it("pins pending successor coverage across a same-signature pan under memory pressure", async () => {
    const { backend, request, budget } = setup();
    request.manifest.tiles = [descriptor, { ...descriptor, assetId: "right", tileX: 1 }];
    backend.replaceTile("transient", { descriptor, byteSize: 100, ...buildMapGeometryBatches([line], 1, true) });
    let release!: (bytes: Uint8Array) => void;
    try {
      await backend.renderDisplay(request);
      calls.bake.mockClear(); calls.remove.mockClear();
      request.loadTile = vi.fn(async tile => tile.tileX === 1
        ? new Promise<Uint8Array>(resolve => { release = resolve; }) : new Uint8Array());
      const detail = { ...request, camera: { ...request.camera, zoom: 2 } };
      await backend.renderDisplay(detail);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(calls.bake).toHaveBeenCalledOnce();
      const successor = calls.bake.mock.calls[0][0];
      calls.remove.mockClear();
      const pan = { ...detail, camera: { ...detail.camera, centerX: 512.25 } };
      backend.setCamera(pan.camera);
      const pending = backend.renderDisplay(pan);
      expect(budget.reserve("pressure", "probe", budget.maximumBytes - budget.totalBytes + 1)).toBe(false);
      expect(calls.remove).not.toHaveBeenCalledWith(successor);
      release(new Uint8Array()); await pending;
      expect(calls.visible).toHaveBeenCalledWith(successor, true);
      expect(request.onError).not.toHaveBeenCalled();
    } finally { release?.(new Uint8Array()); budget.releaseOwner("pressure"); backend.destroy(); }
  });

  it("announces coverage only after its frame, resets on input and fences disposal", async () => {
    const ready = vi.fn();
    const { backend, request } = setup(undefined, ready);
    let publish!: FrameRequestCallback;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { publish = callback; return 99; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    await backend.renderDisplay(request);
    expect(ready).not.toHaveBeenCalledWith(true, expect.anything());
    publish(0);
    expect(ready).toHaveBeenLastCalledWith(true, request.manifest);
    backend.setCamera(request.camera);
    expect(ready).toHaveBeenLastCalledWith(false, request.manifest);
    backend.render();
    expect(ready).toHaveBeenLastCalledWith(false, request.manifest);
    await backend.renderDisplay(request); publish(0);
    expect(ready).toHaveBeenLastCalledWith(true, request.manifest);
    backend.invalidateDisplay();
    expect(ready).toHaveBeenLastCalledWith(false, request.manifest);
    await backend.renderDisplay(request);
    backend.destroy(); ready.mockClear(); publish(0);
    expect(ready).not.toHaveBeenCalled();
  });
  it("invalidates influence neighbours at every retained raster density", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const { backend, request, budget } = setup();
    const primitive = { type: "polyline" as const, elementId: "tip", groupId: null, layerName: "layer",
      sourceType: "polyline", zIndex: 0, fragmentOrder: 0, bounds: { minX: 499, minY: 10, maxX: 511, maxY: 12 },
      clipBounds: descriptor.bounds, geometry: { closed: true,
        points: [{ x: 500, y: 10 }, { x: 510.5, y: 11 }, { x: 500, y: 12 }] },
      style: { ...line.style, strokeWidth: 0.1 } };
    const bytes = encodeMapDisplayTile([primitive]);
    const key = { elementId: "tip", zIndex: 0, fragmentOrder: 0 };
    const tile = { ...descriptor, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      pages: [{ layerId: "layer", sequence: 0, primitiveStart: 0, primitiveCount: 1, firstKey: key, lastKey: key }] };
    request.manifest = { ...request.manifest, orderedPages: { version: 1 }, tiles: [tile] } as typeof request.manifest;
    request.loadTile = vi.fn(async () => bytes);
    const overview = { ...request, camera: { ...request.camera, zoom: 0.1 } };
    try {
      await backend.renderDisplay(overview);
      const neighbour = calls.bake.mock.calls.find(([id]) => id.startsWith("raster:1024:0:-1:"))![0];
      await backend.renderDisplay(request);
      await new Promise(resolve => setTimeout(resolve, 150));
      request.excludedIds = new Set(["tip"]); overview.excludedIds = request.excludedIds;
      backend.invalidateDisplay([primitive.bounds]);
      await backend.renderDisplay(request);
      calls.bake.mockClear();
      await backend.renderDisplay(overview);
      expect(calls.bake).toHaveBeenCalledWith(neighbour, expect.any(HTMLCanvasElement), expect.any(Object));
      expect(request.onError).not.toHaveBeenCalled();
    } finally { backend.destroy(); expect(budget.totalBytes).toBe(0); vi.unstubAllGlobals(); }
  });
  it("drops and rebakes an influence-only neighbor when a persisted hairline is masked", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const { backend, request, budget } = setup();
    const primitive = { type: "polyline" as const, elementId: "tip", groupId: null, layerName: "layer",
      sourceType: "polyline", zIndex: 0, fragmentOrder: 0, bounds: { minX: 499.5, minY: 98.4, maxX: 511, maxY: 101.6 },
      clipBounds: descriptor.bounds, geometry: { closed: true,
        points: [{ x: 500, y: 98.9 }, { x: 510.5, y: 100 }, { x: 500, y: 101.1 }] },
      style: { ...line.style, strokeWidth: 0.1 } };
    const bytes = encodeMapDisplayTile([primitive]);
    const key = { elementId: "tip", zIndex: 0, fragmentOrder: 0 };
    const tile = { ...descriptor, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      pages: [{ layerId: "layer", sequence: 0, primitiveStart: 0, primitiveCount: 1, firstKey: key, lastKey: key }] };
    request.manifest = { ...request.manifest, orderedPages: { version: 1 }, tiles: [tile] } as typeof request.manifest;
    request.loadTile = vi.fn(async () => bytes);
    try {
      await backend.renderDisplay(request);
      expect(request.onError).not.toHaveBeenCalled();
      expect(calls.bake.mock.calls.some(([id]) => id.startsWith("raster:512:1:0"))).toBe(true);
      calls.remove.mockClear(); calls.bake.mockClear(); calls.paint.mockClear();
      request.excludedIds = new Set(["tip"]);
      backend.invalidateDisplay([{ minX: 500, minY: 98.9, maxX: 510.5, maxY: 101.1 }]);
      await backend.renderDisplay(request);
      expect(calls.remove).toHaveBeenCalledWith(expect.stringMatching(/^raster:512:1:0/));
      expect(calls.bake.mock.calls.some(([id]) => id.startsWith("raster:512:1:0"))).toBe(true);
      expect(calls.paint).not.toHaveBeenCalled();
    } finally { backend.destroy(); expect(budget.totalBytes).toBe(0); vi.unstubAllGlobals(); }
  });
  it("uses bounded ordered pages, preserves draft positions and skips masked base without whole-cell decode", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const { backend, request, budget } = setup();
    const primitives = [0, 2].map(zIndex => ({ type: "line" as const, elementId: `base-${zIndex}`, zIndex, fragmentOrder: 0,
      layerName: "layer", groupId: null, sourceType: "line", clipBounds: null,
      bounds: { minX: 20, minY: 20, maxX: 40, maxY: 40 }, style: line.style,
      geometry: { start: { x: 20, y: 20 }, end: { x: 40, y: 40 } } }));
    const bytes = encodeMapDisplayTile(primitives), key = (index: number) => ({ zIndex: index * 2, elementId: `base-${index * 2}`, fragmentOrder: 0 });
    const tile = { ...descriptor, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), primitiveCount: 2,
      pages: [{ layerId: "layer", sequence: 0, primitiveStart: 0, primitiveCount: 2, firstKey: key(0), lastKey: key(1) }] };
    request.manifest = { ...request.manifest, orderedPages: { version: 1 }, tiles: [tile] } as typeof request.manifest;
    request.camera = { ...request.camera, centerX: 256, centerY: 256, viewportWidth: 100, viewportHeight: 100 };
    request.loadTile = vi.fn(async () => bytes);
    backend.setLayerStates(new Map([["layer", { order: 0, visible: true }]]));
    backend.replaceTile("transient", { descriptor, byteSize: 100, ...buildMapGeometryBatches([{ ...line, id: "draft",
      zIndex: 1, geometry: { start: { x: 20, y: 20 }, end: { x: 40, y: 40 } } }], 1, true) });
    await backend.renderDisplay(request);
    expect(request.onError).not.toHaveBeenCalled(); expect(request.worker.decode).not.toHaveBeenCalled();
    expect(calls.paint.mock.calls.map(([_, p]) => p.elementId ?? p.id)).toEqual(["base-0", "draft", "base-2"]);
    calls.paint.mockClear(); request.excludedIds = new Set(["base-0"]); backend.invalidateDisplay();
    await backend.renderDisplay(request);
    expect(calls.paint.mock.calls.map(([_, p]) => p.elementId ?? p.id)).toEqual(["draft", "base-2"]);
    backend.destroy(); expect(budget.totalBytes).toBe(0); vi.unstubAllGlobals();
  });
  it("coalesces cell publication into one animation frame and cancels it on disposal", async () => {
    const { backend, request } = setup();
    let publish!: FrameRequestCallback;
    const schedule = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { publish = callback; return 99; });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    backend.replaceTile("transient", { descriptor, byteSize: 100, ...buildMapGeometryBatches([line], 1, true) });
    await backend.renderDisplay(request);
    expect(calls.bake).toHaveBeenCalledTimes(2);
    expect(calls.render).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledOnce();
    publish(0); expect(calls.render).toHaveBeenCalledOnce();
    backend.invalidateDisplay(); await backend.renderDisplay(request);
    backend.destroy(); expect(cancel).toHaveBeenCalledWith(99);
  });

  it("reuses completed cells across fractional pan and repeated camera settles", async () => {
    const { backend, request, budget } = setup();
    const primitive = { type: "line" as const, elementId: "base", zIndex: 0, fragmentOrder: 0,
      layerName: "layer", groupId: null, sourceType: "line", clipBounds: null,
      bounds: { minX: 20, minY: 20, maxX: 40, maxY: 40 }, style: line.style,
      geometry: { start: { x: 20, y: 20 }, end: { x: 40, y: 40 } } };
    const bytes = encodeMapDisplayTile([primitive]);
    const key = { elementId: "base", zIndex: 0, fragmentOrder: 0 };
    const tile = { ...descriptor, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      pages: [{ layerId: "layer", sequence: 0, primitiveStart: 0, primitiveCount: 1, firstKey: key, lastKey: key }] };
    request.manifest = { ...request.manifest, orderedPages: { version: 1 }, tiles: [tile] } as typeof request.manifest;
    request.loadTile = vi.fn(async () => bytes);
    try {
      await backend.renderDisplay(request);
      calls.bake.mockClear();
      await backend.renderDisplay({ ...request, camera: { ...request.camera, centerX: 520 } });
      await backend.renderDisplay({ ...request, camera: { ...request.camera, centerX: 540.5 } });
      expect(calls.bake).not.toHaveBeenCalled();
      await new Promise(resolve => setTimeout(resolve, 150));
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(calls.bake).not.toHaveBeenCalled();
    } finally {
      backend.destroy();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(budget.totalBytes).toBe(0); vi.unstubAllGlobals();
    }
  });

  it("adds newly visible cells during pan and reuses hidden cells on return", async () => {
    const { backend, request, budget } = setup();
    request.manifest = { ...request.manifest, width: 2048 };
    request.camera = { ...request.camera, centerX: 256, centerY: 256, viewportWidth: 100, viewportHeight: 100 };
    try {
      await backend.renderDisplay(request);
      calls.bake.mockClear(); calls.remove.mockClear();
      await backend.renderDisplay({ ...request, camera: { ...request.camera, centerX: 768.25 } });
      // Coverage must not wait for a settle timer at a newly entered cell.
      expect(budget.totalBytes).toBeGreaterThan(0);
      expect(calls.visible).toHaveBeenCalledWith(expect.stringMatching(/^raster:512:0:0/), false);
      calls.remove.mockClear();
      await backend.renderDisplay({ ...request, camera: { ...request.camera, centerX: 256.25 } });
      expect(calls.remove).not.toHaveBeenCalled();
      expect(request.worker.decode).not.toHaveBeenCalled();
      expect(calls.visible).toHaveBeenCalledWith(expect.stringMatching(/^raster:512:0:0/), true);
    } finally { backend.destroy(); expect(budget.totalBytes).toBe(0); }
  });

  it("transforms cached zoom coverage until one exact detail refresh after settle", async () => {
    const { backend, request, budget } = setup();
    backend.replaceTile("transient", { descriptor, byteSize: 100, ...buildMapGeometryBatches([line], 1, true) });
    try {
      await backend.renderDisplay(request);
      calls.bake.mockClear();
      await backend.renderDisplay({ ...request, camera: { ...request.camera, zoom: 1.05 } });
      await backend.renderDisplay({ ...request, camera: { ...request.camera, zoom: 1.1 } });
      expect(calls.bake).not.toHaveBeenCalled();
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(calls.bake).toHaveBeenCalledTimes(2);
      calls.bake.mockClear();
      await backend.renderDisplay({ ...request, camera: { ...request.camera, zoom: 1.1, centerX: 512.25 } });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(calls.bake).not.toHaveBeenCalled();
    } finally { backend.destroy(); expect(budget.totalBytes).toBe(0); }
  });

  it("paints a boundary stroke in both cells and invalidates its old extents", async () => {
    const { backend, request, budget } = setup();
    backend.replaceTile("transient", { descriptor, byteSize: 100, ...buildMapGeometryBatches([line], 1, true) });
    await backend.renderDisplay(request);
    expect(calls.paint).toHaveBeenCalledTimes(2);
    expect(calls.bake).toHaveBeenCalledTimes(2);
    const moved = { ...line, transform: { ...line.transform, x: 100 } };
    backend.replaceTile("transient", { descriptor, byteSize: 100, ...buildMapGeometryBatches([moved], 1, true) });
    await backend.renderDisplay(request);
    expect(calls.remove).toHaveBeenCalledWith(expect.stringMatching(/^raster:512:0:0/));
    expect(calls.paint).toHaveBeenCalledTimes(3);
    backend.destroy(); expect(budget.totalBytes).toBe(0);
  });

  it("retains old coverage while a different zoom grid is being painted", async () => {
    const { backend, request, budget } = setup();
    request.manifest.tiles = [descriptor];
    try {
      await backend.renderDisplay(request);
      const originalKeys = new Set(calls.visible.mock.calls.filter(([, visible]) => visible).map(([key]) => key));
      calls.visible.mockClear();
      let resolveDetail!: (bytes: Uint8Array) => void;
      request.loadTile = vi.fn(() => new Promise<Uint8Array>(resolve => { resolveDetail = resolve; }));
      await backend.renderDisplay({ ...request, camera: { ...request.camera, zoom: 2 } });
      await vi.waitFor(() => expect(request.loadTile).toHaveBeenCalledOnce());
      expect(calls.visible.mock.calls.filter(([key, visible]) => originalKeys.has(key) && !visible)).toEqual([]);
      resolveDetail(new Uint8Array());
      await vi.waitFor(() => expect(calls.visible.mock.calls.some(([key, visible]) => originalKeys.has(key) && !visible)).toBe(true));
      expect(request.onError).not.toHaveBeenCalled();
    } finally { backend.destroy(); expect(budget.totalBytes).toBe(0); }
  });

  it("rejects an over-budget cell before fetching instead of truncating", async () => {
    const { backend, request, budget } = setup(1024);
    request.manifest.tiles = [{ ...descriptor, primitiveCount: 500000 }];
    await backend.renderDisplay(request);
    expect(request.loadTile).not.toHaveBeenCalled();
    expect(request.onError).toHaveBeenCalledOnce();
    expect(request.onDegraded).toHaveBeenCalledWith(expect.objectContaining({ reason: "memory-budget" }));
    expect(calls.bake).not.toHaveBeenCalled();
    backend.destroy(); expect(budget.totalBytes).toBe(0);
  });

  it("releases a source ignoring abort and does not resurrect after dispose", async () => {
    const { backend, request, budget } = setup();
    request.manifest.tiles = [descriptor];
    let finish!: (bytes: Uint8Array) => void;
    request.loadTile = vi.fn(() => new Promise<Uint8Array>(resolve => { finish = resolve; }));
    const pending = backend.renderDisplay(request);
    await vi.waitFor(() => expect(request.loadTile).toHaveBeenCalledOnce());
    expect(budget.totalBytes).toBeGreaterThan(0);
    backend.destroy(); await pending;
    expect(budget.totalBytes).toBe(0);
    finish(new Uint8Array()); await Promise.resolve();
    expect(request.worker.decode).not.toHaveBeenCalled();
    expect(calls.bake).not.toHaveBeenCalled();
    expect(request.onError).not.toHaveBeenCalled();
  });

  it("keeps a visible raster until its delayed replacement is completely decoded", async () => {
    const { backend, request, budget } = setup();
    request.manifest.tiles = [descriptor];
    const primitive = { type: "line" as const, elementId: "base", groupId: null, layerName: "layer", sourceType: "line",
      zIndex: 0, fragmentOrder: 0, clipBounds: null, bounds: { minX: 20, minY: 20, maxX: 40, maxY: 40 },
      geometry: { start: { x: 20, y: 20 }, end: { x: 40, y: 40 } }, style: line.style };
    request.worker.decode = vi.fn(async (_bytes, tile) => ({ descriptor: tile, byteSize: 100,
      ...buildMapGeometryBatches([], 1, true), nativePrimitives: [primitive] }));
    try {
      await backend.renderDisplay(request);
      calls.remove.mockClear(); calls.bake.mockClear();
      let resolveReplacement!: (bytes: Uint8Array) => void;
      request.loadTile = vi.fn(() => new Promise<Uint8Array>(resolve => { resolveReplacement = resolve; }));

      backend.invalidateDisplay();
      const replacement = backend.renderDisplay(request);
      await vi.waitFor(() => expect(request.loadTile).toHaveBeenCalledOnce());
      // The old canvas is still the active PIXI cell while the new one waits
      // for decode/paint. This was previously removed before loadTile settled.
      expect(calls.remove).not.toHaveBeenCalled();
      expect(calls.bake).not.toHaveBeenCalled();

      resolveReplacement(new Uint8Array());
      await replacement;
      expect(calls.remove).toHaveBeenCalledWith(expect.stringMatching(/^raster:512:0:0/));
      expect(calls.bake).toHaveBeenCalledWith(expect.stringMatching(/^raster:512:0:0/), expect.any(HTMLCanvasElement), expect.any(Object));
    } finally {
      backend.destroy();
      expect(budget.totalBytes).toBe(0);
    }
  });
});
