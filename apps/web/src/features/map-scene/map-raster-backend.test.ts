import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapElement } from "@led-control/shared/map-document-contracts";
import type { MapDisplayTile } from "@led-control/shared/map-display-contracts";
import type { CadRasterDisplayRequest } from "../cad-scene/CadSceneRenderer";
import { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import { buildMapGeometryBatches } from "./map-scene-geometry";

const calls = vi.hoisted(() => ({ bake: vi.fn(), remove: vi.fn(), paint: vi.fn() }));
vi.mock("../cad-scene/CadSceneRenderer", () => ({ PixiCadSceneRenderBackend: class {
  replaceRaster(...args: unknown[]) { calls.bake(...args); }
  removeTile(...args: unknown[]) { calls.remove(...args); }
  render() {}
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
function setup(maximum = 32 * 1024 * 1024) {
  const budget = new CadSceneMemoryBudget(maximum), backend = new MapRasterBackend(budget);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform() {} } as unknown as GPUCanvasContext);
  const request: CadRasterDisplayRequest<MapDisplayTile> = {
    camera: { centerX: 512, centerY: 100, viewportWidth: 200, viewportHeight: 200, zoom: 1 }, resolution: 1,
    manifest: { version: 2, sceneId: "scene", width: 1024, height: 512, tileSize: 512, tiles: [] } as unknown as CadRasterDisplayRequest<MapDisplayTile>["manifest"],
    loadTile: vi.fn(async () => new Uint8Array()),
    worker: { decode: vi.fn(async (_bytes, tile) => ({ descriptor: tile, byteSize: 100,
      ...buildMapGeometryBatches([], 1, true), nativePrimitives: [] })), destroy() {} },
    signal: new AbortController().signal, excludedIds: new Set(), onError: vi.fn(), onDegraded: vi.fn()
  };
  return { budget, backend, request };
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("bounded ordered raster lifecycle", () => {
  it("paints a boundary stroke in both cells and invalidates its old extents", async () => {
    const { backend, request, budget } = setup();
    backend.replaceTile("transient", { descriptor, byteSize: 100, ...buildMapGeometryBatches([line], 1, true) });
    await backend.renderDisplay(request);
    expect(calls.paint).toHaveBeenCalledTimes(2);
    expect(calls.bake).toHaveBeenCalledTimes(2);
    const moved = { ...line, transform: { ...line.transform, x: 100 } };
    backend.replaceTile("transient", { descriptor, byteSize: 100, ...buildMapGeometryBatches([moved], 1, true) });
    await backend.renderDisplay(request);
    expect(calls.remove).toHaveBeenCalledWith("raster:512:0:0");
    expect(calls.paint).toHaveBeenCalledTimes(3);
    backend.destroy(); expect(budget.totalBytes).toBe(0);
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
});
