import type { CadScenePrimitive } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import { buildCadGeometryBatches, extractCadSourceElement } from "./cad-scene-worker";
import { CadSceneRenderer, type CadSceneRenderBackend } from "./CadSceneRenderer";
import { CadSceneMemoryBudget } from "./cad-scene-memory-budget";
import { selectCadSceneLods } from "./cad-scene-camera";
import type { CadSceneManifest, CadSceneTile } from "@led-control/shared";
import { vi } from "vitest";

const line: Extract<CadScenePrimitive, { type: "line" }> = {
  elementId: "tiny-line", groupId: null, layerName: "walls", sourceType: "LINE",
  bounds: { minX: 10, minY: 10, maxX: 10.01, maxY: 10 }, clipBounds: null,
  style: { strokeColor: "#112233", fillColor: null, strokeWidth: 0.1, opacity: 1 },
  type: "line", geometry: { start: { x: 10, y: 10 }, end: { x: 10.01, y: 10 } }
};
const quality = { zoomBand: 0.0625, maxErrorPixels: 0.5, excludedIds: [] };

describe("CAD display quality", () => {
  it("keeps a native mark for subpixel lines, deduplicates display geometry, and leaves exact sources intact", () => {
    const sources = Array.from({ length: 1000 }, (_, i) => ({ ...line, elementId: `line-${i}` }));
    const display = buildCadGeometryBatches(sources, quality);
    expect(display.batches).toHaveLength(1);
    expect(display.batches[0].indices.length).toBe(6);
    expect(display.pickEntries).toHaveLength(0);
    expect(display.batches[0].spans).toHaveLength(0);
    expect(display.memory.cpuBytes + display.memory.gpuBytes).toBeLessThan(2048);
    const exact = buildCadGeometryBatches(sources);
    expect(exact.pickEntries).toHaveLength(1000);
    expect(exact.pickPoints[2]).toBeCloseTo(10.01);
    expect(sources[0].geometry.end.x).toBe(10.01);
  });

  it("retains structural polyline segments at overview quality and respects exclusions before merging", () => {
    const polyline: CadScenePrimitive = {
      ...line, type: "polyline", sourceType: "LWPOLYLINE",
      geometry: { points: [{ x: 10, y: 10 }, { x: 300, y: 10 }, { x: 300, y: 400 }], closed: false }
    };
    const display = buildCadGeometryBatches([polyline], quality);
    expect(display.batches[0].indices.length).toBe(12);
    expect(buildCadGeometryBatches([polyline], { ...quality, excludedIds: [line.elementId] }).batches).toHaveLength(0);
  });

  it("uses fewer curve segments at overview but increases detail with zoom", () => {
    const arc: CadScenePrimitive = {
      ...line, type: "arc", sourceType: "ARC",
      geometry: { center: { x: 100, y: 100 }, radius: 50, startAngle: 0, endAngle: 270, counterClockwise: true }
    };
    const coarse = buildCadGeometryBatches([arc], quality);
    const fine = buildCadGeometryBatches([arc], { ...quality, zoomBand: 2 });
    expect(coarse.batches[0].indices.length).toBeLessThan(fine.batches[0].indices.length);
    expect(coarse.batches[0].indices.length).toBeGreaterThan(0);
  });

  it("merges touching and overlapping collinear display segments without bridging gaps", () => {
    const sources = [[0, 20], [10, 40], [40, 60], [80, 100]].map(([x, end], index) => ({
      ...line, elementId: `segment-${index}`, geometry: { start: { x, y: 0 }, end: { x: end, y: 0 } }
    }));
    const display = buildCadGeometryBatches(sources, quality);
    expect(display.batches[0].indices.length).toBe(12);
    expect(Math.max(...display.batches[0].positions)).toBe(100);
  });

  it("applies global affine and styles before display merging without mutating the exact source", () => {
    const source = { ...line, geometry: { start: { x: 10, y: 20 }, end: { x: 30, y: 20 } },
      clipBounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 } };
    const display = buildCadGeometryBatches([source], { ...quality, zoomBand: 1, overrides: [{
      elementId: source.elementId, hidden: false, locator: null,
      transform: { scaleX: 2, scaleY: 1, rotation: 90, translateX: 100, translateY: 200 },
      strokeColor: "#ff0000", fillColor: null, strokeWidth: 4, text: null
    }] });
    expect(display.batches[0].color).toBe("#ff0000");
    expect([...display.batches[0].positions]).toEqual([78, 220, 82, 220, 82, 260, 78, 260]);
    expect(source.geometry.start).toEqual({ x: 10, y: 20 });
  });

  it("bounds tiny text atlas residency by display size and reuses repeated glyph strings", () => {
    const text: CadScenePrimitive = { ...line, type: "text", sourceType: "TEXT", geometry: {
      position: { x: 10, y: 20 }, width: 20, height: 2, rotation: 0, fontSize: 2, text: "ROOM"
    } };
    const display = buildCadGeometryBatches(Array.from({ length: 1000 }, (_, i) => ({ ...text, elementId: `text-${i}` })), quality);
    expect(display.textBatches[0].entries).toHaveLength(1000);
    expect(display.memory.textAtlasBytes).toBeLessThan(2048);
    expect(display.textBatches[0].entries[0].text).toBe("ROOM");
  });
});

describe("CAD bounded display renderer", () => {
  it("releases pick leases and leaves only evictable display CPU data on context loss", async () => {
    const tiles = [0, 4].map(tileX => ({
      version: 1, sceneId: "scene", tileX, tileY: 0, lod: 0, part: 0,
      assetId: `asset-${tileX}`, primitiveCount: 1, byteSize: 1, sha256: "a".repeat(64),
      bounds: { minX: tileX * 512, minY: 0, maxX: (tileX + 1) * 512, maxY: 512 }
    })) as CadSceneTile[];
    const manifest = { width: 2560, height: 512, tileSize: 512, tiles, lodMode: "additive" } as CadSceneManifest;
    const resident = new Set<string>();
    const backend: CadSceneRenderBackend = {
      mount: vi.fn(async () => undefined), resize: vi.fn(), setCamera: vi.fn(), render: vi.fn(),
      replaceTile: vi.fn((_key, tile) => { resident.add(tile.descriptor.assetId); }),
      removeTile: vi.fn(), suspend: vi.fn(() => resident.clear()), destroy: vi.fn()
    };
    const worker = { decode: vi.fn(async (_payload, descriptor, quality) => ({
      ...buildCadGeometryBatches([line], quality), descriptor, byteSize: 1,
      ...(quality ? { memory: { cpuBytes: descriptor.tileX === 0 ? 1000 : 3000,
        gpuBytes: descriptor.tileX === 0 ? 1000 : 3000, textAtlasBytes: 0 } } : {})
    })), destroy: vi.fn() };
    const budget = new CadSceneMemoryBudget(6000);
    const onDegraded = vi.fn();
    const onError = vi.fn();
    const renderer = new CadSceneRenderer({ manifest, worker, displayQuality: true, memoryBudget: budget,
      backendFactory: () => backend, loadTile: async () => new Uint8Array(1), onDegraded, onError });
    const canvas = document.createElement("canvas");
    await renderer.mount(canvas);
    const camera = { centerX: 256, centerY: 256, viewportWidth: 512, viewportHeight: 512, zoom: 1 };
    await renderer.setCamera(camera);
    const picked = await renderer.pickExact({ x: 10, y: 10 }, { radiusPixels: 1 });
    expect(picked?.sourceTile).toBeDefined();
    expect(budget.totalBytes).toBeGreaterThan(2000);

    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(backend.suspend).toHaveBeenCalledOnce();
    expect(budget.totalBytes).toBe(1000);
    picked?.releaseSourceTile?.();
    expect(budget.totalBytes).toBe(1000);
    await renderer.setCamera({ ...camera, centerX: 2304 });
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    await vi.waitFor(() => expect(resident).toEqual(new Set(["asset-4"])));
    expect(budget.totalBytes).toBe(6000);
    expect(onDegraded).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    renderer.destroy();
    expect(budget.totalBytes).toBe(0);
  });

  it("covers all additive source LODs, reuses a zoom band, and fetches exact geometry only in the clicked cell", async () => {
    expect(selectCadSceneLods(0.25, "display")).toEqual([0, 1, 2]);
    const tiles = [0, 1, 2].map((lod, index) => ({
      version: 1, sceneId: "scene", tileX: index === 2 ? 1 : 0, tileY: 0, lod, part: 0,
      assetId: `asset-${index}`, primitiveCount: 1, byteSize: 1, sha256: "a".repeat(64),
      bounds: { minX: index === 2 ? 512 : 0, minY: 0, maxX: index === 2 ? 1024 : 512, maxY: 512 }
    })) as CadSceneTile[];
    const manifest = { width: 1024, height: 512, tileSize: 512, tiles, lodMode: "additive" } as CadSceneManifest;
    const resident = new Map<string, unknown>();
    const backend: CadSceneRenderBackend = {
      mount: vi.fn(async () => undefined), resize: vi.fn(), setCamera: vi.fn(), render: vi.fn(),
      replaceTile: vi.fn((key, tile) => { resident.set(key, tile); }),
      removeTile: vi.fn(key => { resident.delete(key); }), suspend: vi.fn(), destroy: vi.fn()
    };
    const worker = { decode: vi.fn(async (_payload, descriptor, quality) => ({
      ...buildCadGeometryBatches([{ ...line, elementId: `source-${descriptor.lod}` }], quality),
      descriptor, byteSize: 1
    })), decodeSource: vi.fn(async (_payload, descriptor) => ({
      ...buildCadGeometryBatches([{ ...line, elementId: `source-${descriptor.lod}`,
        geometry: { start: { x: 5, y: 10 }, end: { x: 5.01, y: 10 } } }]), descriptor, byteSize: 1
    })), destroy: vi.fn() };
    const budget = new CadSceneMemoryBudget(8192);
    const renderer = new CadSceneRenderer({ manifest, worker, displayQuality: true, memoryBudget: budget,
      backendFactory: () => backend, loadTile: async () => new Uint8Array(1) });
    await renderer.mount(document.createElement("canvas"));
    const camera = { centerX: 512, centerY: 256, viewportWidth: 1024, viewportHeight: 256, zoom: 0.25 };
    await renderer.setCamera(camera);
    expect(resident.size).toBe(3);
    expect(worker.decode.mock.calls.every(call => call[2] !== undefined)).toBe(true);
    await renderer.setCamera({ ...camera, centerX: 513 });
    expect(worker.decode).toHaveBeenCalledTimes(3);
    const picked = await renderer.pickExact({ x: 386.25, y: 66.5 }, { radiusPixels: 1 });
    expect(picked?.elementId).toMatch(/^source-[01]$/);
    expect(picked?.sourceTile?.pickEntries).toHaveLength(1);
    expect(picked?.sourceTile?.pickPoints[0]).toBe(5);
    expect(worker.decode.mock.calls.filter(call => call[2] === undefined).map(call => call[1].tileX)).toEqual([0, 0]);
    expect(budget.totalBytes).toBeLessThanOrEqual(8192);
    const held = budget.totalBytes;
    picked?.releaseSourceTile?.();
    expect(budget.totalBytes).toBeLessThan(held);
    renderer.setSelectionExclusion(new Set(["source-0"]));
    await renderer.setCamera({ ...camera, centerX: 513 });
    expect(worker.decode.mock.calls.at(-1)?.[2]?.excludedIds).toContain("source-0");
    expect(worker.decode.mock.calls.filter(call => call[2] !== undefined)).toHaveLength(5);
    renderer.destroy();
    expect(budget.totalBytes).toBe(0);
  });

  it("retains only the exact winning element for an accounted selection handoff", () => {
    const primitives = Array.from({ length: 1000 }, (_, i) => ({ ...line, elementId: `line-${i}` }));
    const exact = { ...buildCadGeometryBatches(primitives), descriptor: {} as CadSceneTile, byteSize: 1 };
    const seed = extractCadSourceElement(exact, "line-9");
    expect(seed.pickEntries).toHaveLength(1);
    expect(seed.pickEntries[0].elementId).toBe("line-9");
    expect(seed.pickPoints[2]).toBeCloseTo(10.01);
    expect(seed.batches[0].spans).toHaveLength(1);
    expect(seed.memory.cpuBytes).toBeLessThan(2048);
    expect(exact.pickEntries).toHaveLength(1000);
  });
});
