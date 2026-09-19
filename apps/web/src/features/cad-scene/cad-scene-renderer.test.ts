import { createHash } from "node:crypto";
import type { CadSceneManifest, CadScenePrimitive, CadSceneTile } from "@led-control/shared";
import { describe, expect, it, vi } from "vitest";
import {
  capCadRendererResolution,
  computeVisibleTileCoordinates,
  screenToCadWorld,
  selectCadSceneLods,
  type CadSceneCamera
} from "./cad-scene-camera";
import { CadSceneTileCache } from "./cad-scene-tile-cache";
import { CadSceneMemoryBudget } from "./cad-scene-memory-budget";
import { cadSceneCodecGolden } from "./cad-scene-codec.golden";
import {
  buildCadGeometryBatches,
  decodeCadSceneTilePayload,
  type CadSceneWorkerClient,
  type DecodedCadSceneTile
} from "./cad-scene-worker";
import {
  CadSceneRenderer,
  clipCadTextQuad,
  type CadSceneRenderBackend,
  type CadSceneRenderBackendFactory
} from "./CadSceneRenderer";

const SCENE_ID = "11111111-1111-4111-8111-111111111111";
const MANIFEST_ASSET_ID = "22222222-2222-4222-8222-222222222222";

const camera = (overrides: Partial<CadSceneCamera> = {}): CadSceneCamera => ({
  centerX: 256,
  centerY: 256,
  zoom: 1,
  viewportWidth: 512,
  viewportHeight: 512,
  ...overrides
});

function linePrimitive(index = 0, color = "#112233"): Extract<CadScenePrimitive, { type: "line" }> {
  return {
    elementId: `line-${index}`,
    groupId: index % 2 === 0 ? "group-a" : null,
    layerName: "walls",
    sourceType: "LINE",
    bounds: { minX: index, minY: 10, maxX: index + 10, maxY: 10 },
    clipBounds: null,
    style: { strokeColor: color, fillColor: null, strokeWidth: 1, opacity: 1 },
    type: "line",
    geometry: { start: { x: index, y: 10 }, end: { x: index + 10, y: 10 } }
  };
}

function descriptor(overrides: Partial<CadSceneTile> = {}): CadSceneTile {
  return {
    version: 1,
    sceneId: SCENE_ID,
    tileX: 0,
    tileY: 0,
    lod: 0,
    part: 0,
    assetId: "33333333-3333-4333-8333-333333333333",
    primitiveCount: 1,
    byteSize: 1,
    sha256: "0".repeat(64),
    bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 },
    ...overrides
  };
}

function manifest(tiles: CadSceneTile[] = [descriptor()]): CadSceneManifest {
  return {
    version: 1,
    sceneId: SCENE_ID,
    regionId: "region-a",
    manifestAssetId: MANIFEST_ASSET_ID,
    width: 1_536,
    height: 1_024,
    padding: 64,
    gridSize: 50,
    tileSize: 512,
    lodMode: "additive",
    primitiveCount: tiles.length,
    tileCount: tiles.length,
    byteSize: 1,
    sha256: "0".repeat(64),
    sourceBounds: { minX: 0, minY: 0, maxX: 1_408, maxY: 896 },
    transform: { scaleX: 1, scaleY: -1, translateX: 64, translateY: 960 },
    tiles
  };
}

class ByteWriter {
  private readonly bytes: number[] = [];

  uint8(value: number): void {
    this.bytes.push(value);
  }

  uint32(value: number): void {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32LE(value);
    this.bytes.push(...buffer);
  }

  float64(value: number): void {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleLE(value);
    this.bytes.push(...buffer);
  }

  utf8(value: string): void {
    const buffer = Buffer.from(value, "utf8");
    this.uint32(buffer.byteLength);
    this.bytes.push(...buffer);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function encodeLineTile(primitive: Extract<CadScenePrimitive, { type: "line" }>): Uint8Array {
  const strings = [
    primitive.elementId,
    primitive.groupId,
    primitive.layerName,
    primitive.sourceType,
    primitive.style.strokeColor,
    primitive.style.fillColor
  ].filter((value): value is string => value !== null);
  const indexOf = (value: string | null) => value === null ? 0xffff_ffff : strings.indexOf(value);
  const body = new ByteWriter();
  body.uint32(strings.length);
  strings.forEach(value => body.utf8(value));
  body.uint8(1);
  body.uint32(indexOf(primitive.elementId));
  body.uint32(indexOf(primitive.groupId));
  body.uint32(indexOf(primitive.layerName));
  body.uint32(indexOf(primitive.sourceType));
  body.float64(primitive.bounds.minX);
  body.float64(primitive.bounds.minY);
  body.float64(primitive.bounds.maxX);
  body.float64(primitive.bounds.maxY);
  body.uint8(0);
  body.uint32(indexOf(primitive.style.strokeColor));
  body.uint32(indexOf(primitive.style.fillColor));
  body.float64(primitive.style.strokeWidth);
  body.float64(primitive.style.opacity);
  body.float64(primitive.geometry.start.x);
  body.float64(primitive.geometry.start.y);
  body.float64(primitive.geometry.end.x);
  body.float64(primitive.geometry.end.y);

  const bodyBytes = body.finish();
  const payload = Buffer.alloc(48 + bodyBytes.byteLength);
  payload.write("CDTL", 0, "ascii");
  payload.writeUInt16LE(1, 4);
  payload.writeUInt16LE(0, 6);
  payload.writeUInt32LE(bodyBytes.byteLength, 8);
  payload.writeUInt32LE(1, 12);
  createHash("sha256").update(bodyBytes).digest().copy(payload, 16);
  Buffer.from(bodyBytes).copy(payload, 48);
  return payload;
}

function withIntegrity(tile: CadSceneTile, payload: Uint8Array): CadSceneTile {
  return {
    ...tile,
    byteSize: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex")
  };
}

describe("CAD scene camera", () => {
  it("requests only the viewport and one surrounding tile ring", () => {
    expect(computeVisibleTileCoordinates(
      { width: 1_536, height: 1_024, tileSize: 512 },
      camera({ centerX: 768, centerY: 512, viewportWidth: 512, viewportHeight: 256 }),
      1
    )).toEqual([
      { tileX: 0, tileY: 0 },
      { tileX: 1, tileY: 0 },
      { tileX: 2, tileY: 0 },
      { tileX: 0, tileY: 1 },
      { tileX: 1, tileY: 1 },
      { tileX: 2, tileY: 1 }
    ]);
  });

  it("uses additive LODs and caps mobile and desktop resolution", () => {
    expect(selectCadSceneLods(0.3)).toEqual([0]);
    expect(selectCadSceneLods(0.75)).toEqual([0, 1]);
    expect(selectCadSceneLods(2)).toEqual([0, 1, 2]);
    expect(capCadRendererResolution(3, "mobile")).toBe(1);
    expect(capCadRendererResolution(3, "desktop")).toBe(1.5);
  });

  it("converts screen coordinates with the same camera used for rendering", () => {
    expect(screenToCadWorld({ x: 266, y: 246 }, camera({ zoom: 2 }))).toEqual({ x: 261, y: 251 });
  });
});

describe("CadSceneTileCache", () => {
  it("deduplicates concurrent requests for the same tile", async () => {
    const cache = new CadSceneTileCache<string>({ maximumBytes: 100 });
    const loader = vi.fn(async () => ({ value: "tile-a", byteSize: 20 }));

    const [first, second] = await Promise.all([
      cache.getOrLoad("a", loader),
      cache.getOrLoad("a", loader)
    ]);

    expect(first).toBe("tile-a");
    expect(second).toBe("tile-a");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("evicts least-recently-used unpinned tiles within the byte budget", async () => {
    const evicted: string[] = [];
    const cache = new CadSceneTileCache<string>({
      maximumBytes: 25,
      onEvict: (key) => evicted.push(key)
    });
    await cache.getOrLoad("a", async () => ({ value: "a", byteSize: 10 }));
    await cache.getOrLoad("b", async () => ({ value: "b", byteSize: 10 }));
    cache.pin(new Set(["a"]));
    await cache.getOrLoad("c", async () => ({ value: "c", byteSize: 10 }));

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(evicted).toEqual(["b"]);
    expect(cache.totalBytes).toBe(20);
  });

  it("does not repopulate the cache when an in-flight generation is cleared", async () => {
    let release!: (value: { value: string; byteSize: number }) => void;
    const deferred = new Promise<{ value: string; byteSize: number }>(resolve => {
      release = resolve;
    });
    const cache = new CadSceneTileCache<string>({ maximumBytes: 100 });
    const request = cache.getOrLoad("stale", () => deferred);

    cache.clear();
    release({ value: "late", byteSize: 10 });
    await expect(request).resolves.toBe("late");
    expect(cache.has("stale")).toBe(false);
    expect(cache.totalBytes).toBe(0);
  });
});

describe("CAD scene worker codec and batching", () => {
  it("decodes the Task 4 API encoder golden payload for every primitive type", async () => {
    const payload = Buffer.from(cadSceneCodecGolden.payloadBase64, "base64");
    const tile = descriptor({
      primitiveCount: cadSceneCodecGolden.primitives.length,
      byteSize: cadSceneCodecGolden.byteSize,
      sha256: cadSceneCodecGolden.sha256
    });

    await expect(decodeCadSceneTilePayload(payload, tile)).resolves.toEqual(
      cadSceneCodecGolden.primitives
    );
  });

  it("decodes the Task 4 tile wire format and verifies descriptor integrity", async () => {
    const primitive = linePrimitive();
    const payload = encodeLineTile(primitive);
    const tile = withIntegrity(descriptor(), payload);

    await expect(decodeCadSceneTilePayload(payload, tile)).resolves.toEqual([primitive]);
    await expect(decodeCadSceneTilePayload(payload.slice(0, -1), tile)).rejects.toThrow(/byte size/i);
  });

  it("builds one geometry batch per tile/style instead of one display object per primitive", () => {
    const primitives = Array.from({ length: 1_000 }, (_, index) => linePrimitive(index));
    const result = buildCadGeometryBatches(primitives);

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].spans).toHaveLength(1_000);
    expect(result.batches[0].positions).toHaveLength(8_000);
    expect(result.batches[0].indices).toHaveLength(6_000);
    expect(result.pickEntries).toHaveLength(1_000);
    expect("displayObject" in result.batches[0]).toBe(false);
    expect(result.memory.gpuBytes).toBe(
      result.batches[0].positions.byteLength * 2 + result.batches[0].indices.byteLength
    );
  });

  it("keeps equal styles on different CAD layers in separate batches", () => {
    const first = linePrimitive(0);
    const second = { ...linePrimitive(1), layerName: "ELECTRICAL" };

    const result = buildCadGeometryBatches([first, second]);

    expect(result.batches).toHaveLength(2);
    expect(result.batches.map(batch => batch.layerName)).toEqual(["walls", "ELECTRICAL"]);
  });

  it("indexes pick candidates into bounded world-space buckets", () => {
    const primitives = Array.from({ length: 1_000 }, (_, index) => linePrimitive(index * 100));
    const result = buildCadGeometryBatches(primitives);
    const bucket = result.spatialIndex.buckets["0:0"];

    expect(result.spatialIndex.cellSize).toBe(64);
    expect(bucket).toBeInstanceOf(Uint32Array);
    expect([...bucket]).toEqual([0]);
  });

  it("triangulates concave closed polylines without overdraw outside the polygon", () => {
    const primitive: CadScenePrimitive = {
      ...linePrimitive(),
      type: "polyline",
      bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 },
      style: { strokeColor: null, fillColor: "#112233", strokeWidth: 0, opacity: 1 },
      geometry: {
        closed: true,
        points: [
          { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 3, y: 4 },
          { x: 3, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 4 }, { x: 0, y: 4 }
        ]
      }
    };
    const batch = buildCadGeometryBatches([primitive]).batches[0];
    let triangleArea = 0;
    for (let index = 0; index < batch.indices.length; index += 3) {
      const a = batch.indices[index] * 2;
      const b = batch.indices[index + 1] * 2;
      const c = batch.indices[index + 2] * 2;
      triangleArea += Math.abs(
        (batch.positions[b] - batch.positions[a]) * (batch.positions[c + 1] - batch.positions[a + 1]) -
        (batch.positions[c] - batch.positions[a]) * (batch.positions[b + 1] - batch.positions[a + 1])
      ) / 2;
    }
    expect(triangleArea).toBe(10);
  });

  it("clips duplicated shape geometry to the Task 4 tile bounds", () => {
    const primitive: CadScenePrimitive = {
      ...linePrimitive(),
      type: "rectangle",
      bounds: { minX: 0, minY: 0, maxX: 5, maxY: 5 },
      clipBounds: { minX: 0, minY: 0, maxX: 5, maxY: 5 },
      style: { strokeColor: "#112233", fillColor: "#445566", strokeWidth: 1, opacity: 1 },
      geometry: { origin: { x: -5, y: 0 }, width: 10, height: 5, rotation: 0 }
    };
    const result = buildCadGeometryBatches([primitive]);

    for (const batch of result.batches) {
      for (let index = 0; index < batch.positions.length; index += 2) {
        expect(batch.positions[index]).toBeGreaterThanOrEqual(-0.5);
        expect(batch.positions[index]).toBeLessThanOrEqual(5.5);
        expect(batch.positions[index + 1]).toBeGreaterThanOrEqual(-0.5);
        expect(batch.positions[index + 1]).toBeLessThanOrEqual(5.5);
      }
    }
  });

  it("keeps text in tile/style atlas batches rather than primitive display objects", () => {
    const primitive: CadScenePrimitive = {
      ...linePrimitive(),
      type: "text",
      bounds: { minX: 10, minY: 10, maxX: 110, maxY: 30 },
      style: { strokeColor: "#112233", fillColor: null, strokeWidth: 1, opacity: 1 },
      geometry: {
        position: { x: 10, y: 30 },
        text: "주차 구역 A",
        width: 100,
        height: 20,
        rotation: 0,
        fontSize: 20
      }
    };
    const result = buildCadGeometryBatches([primitive]);

    expect(result.batches).toHaveLength(0);
    expect(result.textBatches).toHaveLength(1);
    expect(result.textBatches[0].entries).toEqual([expect.objectContaining({
      elementId: primitive.elementId,
      text: "주차 구역 A"
    })]);
    expect(result.memory.cpuBytes).toBeGreaterThan(primitive.geometry.text.length * 2);
    expect(result.memory.gpuBytes).toBeGreaterThanOrEqual(256);
    expect(result.memory.textAtlasBytes).toBeGreaterThan(0);
  });

  it("clips a rotated text quad with proportional UV coordinates", () => {
    const vertices = clipCadTextQuad({
      elementId: "text-clip",
      groupId: null,
      text: "회전 안내",
      position: { x: 5, y: 5 },
      width: 10,
      height: 4,
      rotation: 90,
      fontSize: 12,
      bounds: { minX: 5, minY: 5, maxX: 8, maxY: 10 },
      clipBounds: { minX: 0, minY: 0, maxX: 8, maxY: 10 }
    });

    expect(vertices.length).toBeGreaterThanOrEqual(4);
    expect(vertices.every(vertex => vertex.x <= 8 && vertex.y <= 10)).toBe(true);
    expect(Math.min(...vertices.map(vertex => vertex.u))).toBeCloseTo(0);
    expect(Math.max(...vertices.map(vertex => vertex.u))).toBeCloseTo(0.5);
    expect(Math.min(...vertices.map(vertex => vertex.v))).toBeCloseTo(0.25);
    expect(Math.max(...vertices.map(vertex => vertex.v))).toBeCloseTo(1);
  });

  it("benchmark: batches 300,000 same-style lines without primitive display objects", () => {
    const primitives = Array.from({ length: 300_000 }, (_, index) => linePrimitive(index));
    const startedAt = performance.now();
    const result = buildCadGeometryBatches(primitives);
    const elapsedMs = performance.now() - startedAt;

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].spans).toHaveLength(300_000);
    expect(result.batches[0].indices).toHaveLength(1_800_000);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 20_000);
});

class FakeBackend implements CadSceneRenderBackend {
  mountCalls = 0;
  renderCalls = 0;
  replaceCalls = 0;
  suspendCalls = 0;
  destroyCalls = 0;
  meshCount = 0;
  lastResolution = 0;
  readonly tileMeshCounts = new Map<string, number>();

  async mount(_canvas: HTMLCanvasElement, options: { resolution: number }): Promise<void> {
    this.mountCalls++;
    this.lastResolution = options.resolution;
  }

  resize(): void {}

  setCamera(): void {}

  replaceTile(
    key: string,
    tile: DecodedCadSceneTile,
    excludedElementIds: ReadonlySet<string>,
    hiddenLayerNames: ReadonlySet<string> = new Set()
  ): void {
    this.replaceCalls++;
    const geometryMeshes = tile.batches.filter(batch => !hiddenLayerNames.has(batch.layerName) && batch.spans.some(
      span => !excludedElementIds.has(span.elementId)
    )).length;
    const textMeshes = tile.textBatches.filter(batch => !hiddenLayerNames.has(batch.layerName) && batch.entries.some(
      entry => !excludedElementIds.has(entry.elementId) &&
        (entry.groupId === null || !excludedElementIds.has(entry.groupId))
    )).length;
    this.tileMeshCounts.set(key, geometryMeshes + textMeshes);
    this.meshCount = [...this.tileMeshCounts.values()].reduce((sum, count) => sum + count, 0);
  }

  removeTile(key: string): void {
    this.tileMeshCounts.delete(key);
    this.meshCount = [...this.tileMeshCounts.values()].reduce((sum, count) => sum + count, 0);
  }

  render(): void {
    this.renderCalls++;
  }

  suspend(): void {
    this.suspendCalls++;
    this.tileMeshCounts.clear();
    this.meshCount = 0;
  }

  destroy(): void {
    this.destroyCalls++;
    this.tileMeshCounts.clear();
    this.meshCount = 0;
  }
}

function rendererFixture(primitive = linePrimitive(100)) {
  const payload = encodeLineTile(primitive);
  const tile = withIntegrity(descriptor(), payload);
  const sceneManifest = manifest([tile]);
  const decoded: DecodedCadSceneTile = {
    ...buildCadGeometryBatches([primitive]),
    descriptor: tile,
    byteSize: payload.byteLength
  };
  const worker: CadSceneWorkerClient = {
    decode: vi.fn(async () => decoded),
    destroy: vi.fn()
  };
  const backend = new FakeBackend();
  const backendFactory: CadSceneRenderBackendFactory = () => backend;
  const loadTile = vi.fn(async () => payload);
  const renderer = new CadSceneRenderer({
    manifest: sceneManifest,
    loadTile,
    worker,
    backendFactory,
    platform: "desktop",
    devicePixelRatio: 3,
    maximumCacheBytes: 1_024 * 1_024
  });
  return { backend, loadTile, primitive, renderer, worker };
}

describe("CadSceneRenderer", () => {
  it("uses viewport-sized explicit batches, renders only on changes, and deduplicates visible loads", async () => {
    const { backend, loadTile, renderer } = rendererFixture();
    const canvas = document.createElement("canvas");
    await renderer.mount(canvas);
    await Promise.all([renderer.setCamera(camera()), renderer.setCamera(camera())]);

    expect(backend.mountCalls).toBe(1);
    expect(backend.lastResolution).toBe(1.5);
    expect(backend.meshCount).toBe(1);
    expect(loadTile).toHaveBeenCalledTimes(1);
    const settledRenderCount = backend.renderCalls;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(backend.renderCalls).toBe(settledRenderCount);
  });

  it("does not rebuild GPU tile resources when the active tile set is unchanged", async () => {
    const { backend, renderer } = rendererFixture();
    await renderer.mount(document.createElement("canvas"));

    await renderer.setCamera(camera());
    await renderer.setCamera(camera({ centerX: 300 }));

    expect(backend.replaceCalls).toBe(1);
  });

  it("picks loaded primitives and excludes a selected element from its tile batch", async () => {
    const { backend, primitive, renderer } = rendererFixture();
    await renderer.mount(document.createElement("canvas"));
    await renderer.setCamera(camera());

    expect(renderer.pick({ x: 105, y: 10 })).toEqual({
      elementId: primitive.elementId,
      groupId: primitive.groupId,
      layerName: primitive.layerName
    });
    renderer.setSelectionExclusion(new Set([primitive.elementId]));
    expect(backend.meshCount).toBe(0);
    expect(renderer.pick({ x: 105, y: 10 })).toBeNull();
  });

  it("applies CAD layer visibility to drawing and picking", async () => {
    const { backend, primitive, renderer } = rendererFixture();
    await renderer.mount(document.createElement("canvas"));
    await renderer.setCamera(camera());

    renderer.setLayerStates(new Map([[primitive.layerName, { visible: false }]]));

    expect(backend.meshCount).toBe(0);
    expect(renderer.pick({ x: 105, y: 10 })).toBeNull();
    renderer.setLayerStates(new Map([[primitive.layerName, { visible: true }]]));
    expect(backend.meshCount).toBe(1);
  });

  it("rejects pointer hits that are inside line bounds but outside the pick radius", async () => {
    const primitive: Extract<CadScenePrimitive, { type: "line" }> = {
      ...linePrimitive(),
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      geometry: { start: { x: 0, y: 0 }, end: { x: 100, y: 100 } }
    };
    const { renderer } = rendererFixture(primitive);
    await renderer.mount(document.createElement("canvas"));
    await renderer.setCamera(camera());

    expect(renderer.pick({ x: 10, y: 90 })).toBeNull();
  });

  it("prevents context loss and recreates the current viewport on restoration", async () => {
    const { backend, loadTile, renderer } = rendererFixture();
    const canvas = document.createElement("canvas");
    await renderer.mount(canvas);
    await renderer.setCamera(camera());
    const loss = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(loss);

    expect(loss.defaultPrevented).toBe(true);
    expect(backend.suspendCalls).toBe(1);
    expect(backend.destroyCalls).toBe(0);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    await vi.waitFor(() => {
      expect(backend.meshCount).toBe(1);
    });
    expect(backend.mountCalls).toBe(1);
    expect(backend.destroyCalls).toBe(0);
    expect(loadTile).toHaveBeenCalledTimes(1);
  });

  it("retries a tile request aborted by context loss after restoration", async () => {
    const primitive = linePrimitive(100);
    const payload = encodeLineTile(primitive);
    const tile = withIntegrity(descriptor(), payload);
    const backend = new FakeBackend();
    const worker: CadSceneWorkerClient = {
      decode: vi.fn(async () => ({
        ...buildCadGeometryBatches([primitive]),
        descriptor: tile,
        byteSize: payload.byteLength
      })),
      destroy: vi.fn()
    };
    const loadTile = vi.fn((_tile: CadSceneTile, signal: AbortSignal) => {
      if (loadTile.mock.calls.length > 1) return Promise.resolve(payload);
      return new Promise<Uint8Array>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true
        });
      });
    });
    const renderer = new CadSceneRenderer({
      manifest: manifest([tile]),
      loadTile,
      worker,
      backendFactory: () => backend,
      devicePixelRatio: 1
    });
    const canvas = document.createElement("canvas");
    await renderer.mount(canvas);
    const pendingCamera = renderer.setCamera(camera());
    await vi.waitFor(() => expect(loadTile).toHaveBeenCalledTimes(1));

    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    await pendingCamera;

    await vi.waitFor(() => {
      expect(loadTile).toHaveBeenCalledTimes(2);
      expect(backend.meshCount).toBe(1);
    });
  });

  it("keeps the previous additive LOD visible until the next LOD is ready", async () => {
    const lowPrimitive = linePrimitive(10, "#111111");
    const detailPrimitive = linePrimitive(20, "#445566");
    const lowPayload = encodeLineTile(lowPrimitive);
    const detailPayload = encodeLineTile(detailPrimitive);
    const lowTile = withIntegrity(descriptor(), lowPayload);
    const detailTile = withIntegrity(descriptor({
      lod: 1,
      assetId: "44444444-4444-4444-8444-444444444444"
    }), detailPayload);
    let releaseDetail!: () => void;
    const detailBarrier = new Promise<void>(resolve => {
      releaseDetail = resolve;
    });
    const backend = new FakeBackend();
    const worker: CadSceneWorkerClient = {
      decode: vi.fn(async (payload, tile) => ({
        ...buildCadGeometryBatches([tile.lod === 0 ? lowPrimitive : detailPrimitive]),
        descriptor: tile,
        byteSize: payload.byteLength
      })),
      destroy: vi.fn()
    };
    const renderer = new CadSceneRenderer({
      manifest: manifest([lowTile, detailTile]),
      loadTile: vi.fn(async tile => {
        if (tile.lod === 1) await detailBarrier;
        return tile.lod === 0 ? lowPayload : detailPayload;
      }),
      worker,
      backendFactory: () => backend,
      devicePixelRatio: 1
    });
    await renderer.mount(document.createElement("canvas"));
    await renderer.setCamera(camera({ zoom: 0.3 }));
    expect(backend.meshCount).toBe(1);

    const transition = renderer.setCamera(camera({ zoom: 0.75 }));
    await Promise.resolve();
    expect(backend.meshCount).toBe(1);
    releaseDetail();
    await transition;
    expect(backend.meshCount).toBe(2);
  });

  it("fetches a bounded queue in low-LOD then center-distance order", async () => {
    const payload = encodeLineTile(linePrimitive());
    const tiles = [
      withIntegrity(descriptor({ tileX: 0 }), payload),
      withIntegrity(descriptor({ tileX: 1, assetId: "44444444-4444-4444-8444-444444444444" }), payload),
      withIntegrity(descriptor({ tileX: 2, assetId: "55555555-5555-4555-8555-555555555555" }), payload),
      withIntegrity(descriptor({
        tileX: 1,
        lod: 1,
        assetId: "66666666-6666-4666-8666-666666666666"
      }), payload)
    ];
    const order: string[] = [];
    let activeLoads = 0;
    let maximumActiveLoads = 0;
    const backend = new FakeBackend();
    const worker: CadSceneWorkerClient = {
      decode: vi.fn(async (value, tile) => ({
        ...buildCadGeometryBatches([linePrimitive(tile.tileX)]),
        descriptor: tile,
        byteSize: value.byteLength
      })),
      destroy: vi.fn()
    };
    const renderer = new CadSceneRenderer({
      manifest: manifest(tiles),
      loadTile: vi.fn(async tile => {
        order.push(`${tile.lod}:${tile.tileX}`);
        activeLoads++;
        maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
        await new Promise(resolve => setTimeout(resolve, 5));
        activeLoads--;
        return payload;
      }),
      worker,
      backendFactory: () => backend,
      maximumConcurrentTileLoads: 2
    });
    await renderer.mount(document.createElement("canvas"));

    await renderer.setCamera(camera({ centerX: 768, viewportWidth: 1_536, zoom: 0.75 }));

    expect(maximumActiveLoads).toBe(2);
    expect(order).toEqual(["0:1", "0:0", "0:2", "1:1"]);
  });

  it("shares one tile-load concurrency bound across overlapping camera generations", async () => {
    const payload = encodeLineTile(linePrimitive());
    const tileXs = [0, 1, 8, 9, 16, 17];
    const tiles = tileXs.map((tileX, index) => withIntegrity(descriptor({
      tileX,
      assetId: `${index + 3}5555555-5555-4555-8555-555555555555`
    }), payload));
    const sceneManifest = { ...manifest(tiles), width: 9_216, height: 512 };
    let activeLoads = 0;
    let maximumActiveLoads = 0;
    const startedTileXs: number[] = [];
    const loadSignals: AbortSignal[] = [];
    let releaseFirstGeneration!: () => void;
    const firstGenerationBarrier = new Promise<void>(resolve => {
      releaseFirstGeneration = resolve;
    });
    const loadTile = vi.fn(async (tile: CadSceneTile, signal: AbortSignal) => {
      const callNumber = loadTile.mock.calls.length;
      startedTileXs.push(tile.tileX);
      loadSignals.push(signal);
      activeLoads++;
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
      if (callNumber <= 2) await firstGenerationBarrier;
      activeLoads--;
      return payload;
    });
    const worker: CadSceneWorkerClient = {
      decode: vi.fn(async (value, tile) => ({
        ...buildCadGeometryBatches([linePrimitive(tile.tileX)]),
        descriptor: tile,
        byteSize: value.byteLength
      })),
      destroy: vi.fn()
    };
    const renderer = new CadSceneRenderer({
      manifest: sceneManifest,
      loadTile,
      worker,
      backendFactory: () => new FakeBackend(),
      maximumConcurrentTileLoads: 2
    });
    await renderer.mount(document.createElement("canvas"));
    const firstCamera = renderer.setCamera(camera({ centerX: 256, viewportWidth: 256, viewportHeight: 256 }));
    await vi.waitFor(() => expect(loadTile).toHaveBeenCalledTimes(2));

    const secondCamera = renderer.setCamera(camera({
      centerX: 4_352,
      centerY: 256,
      viewportWidth: 256,
      viewportHeight: 256
    }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const thirdCamera = renderer.setCamera(camera({
      centerX: 8_448,
      centerY: 256,
      viewportWidth: 256,
      viewportHeight: 256
    }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(maximumActiveLoads).toBe(2);
    expect(loadSignals.slice(0, 2).every(signal => signal.aborted)).toBe(true);
    releaseFirstGeneration();
    await Promise.all([firstCamera, secondCamera, thirdCamera]);

    expect(maximumActiveLoads).toBe(2);
    expect(loadTile).toHaveBeenCalledTimes(4);
    expect(startedTileXs).toEqual([0, 1, 16, 17]);
  });

  it("degrades the visible set before exceeding decoded GPU and text budgets", async () => {
    const payload = encodeLineTile(linePrimitive());
    const tiles = [0, 1, 2].map((tileX, index) => withIntegrity(descriptor({
      tileX,
      assetId: `${index + 3}3333333-3333-4333-8333-333333333333`
    }), payload));
    const backend = new FakeBackend();
    const onDegraded = vi.fn();
    const worker: CadSceneWorkerClient = {
      decode: vi.fn(async (value, tile) => ({
        ...buildCadGeometryBatches([linePrimitive(tile.tileX)]),
        descriptor: tile,
        byteSize: value.byteLength
      })),
      destroy: vi.fn()
    };
    const loadTile = vi.fn(async () => payload);
    const renderer = new CadSceneRenderer({
      manifest: manifest(tiles),
      loadTile,
      worker,
      backendFactory: () => backend,
      maximumConcurrentTileLoads: 2,
      maximumGpuBytes: 1,
      maximumTextAtlasBytes: 1,
      onDegraded
    });
    await renderer.mount(document.createElement("canvas"));

    await renderer.setCamera(camera({ centerX: 768, viewportWidth: 1_536, zoom: 0.3 }));

    expect(backend.meshCount).toBe(0);
    expect(loadTile.mock.calls.length).toBeLessThanOrEqual(2);
    expect(onDegraded).toHaveBeenCalledWith({
      requestedTileCount: 3,
      renderedTileCount: 0,
      reason: "memory-budget"
    });
  });

  it("requires GPU budget for Pixi's generated UV buffer before admitting a tile", async () => {
    const primitive = linePrimitive();
    const payload = encodeLineTile(primitive);
    const tile = withIntegrity(descriptor(), payload);
    const decoded: DecodedCadSceneTile = {
      ...buildCadGeometryBatches([primitive]),
      descriptor: tile,
      byteSize: payload.byteLength
    };
    const positionsAndIndices = decoded.batches[0].positions.byteLength +
      decoded.batches[0].indices.byteLength;
    const createRenderer = (maximumGpuBytes: number, backend: FakeBackend) => new CadSceneRenderer({
      manifest: manifest([tile]),
      loadTile: async () => payload,
      worker: {
        decode: async () => decoded,
        destroy: () => undefined
      },
      backendFactory: () => backend,
      maximumGpuBytes
    });
    const underBudgetBackend = new FakeBackend();
    const underBudgetRenderer = createRenderer(positionsAndIndices, underBudgetBackend);
    await underBudgetRenderer.mount(document.createElement("canvas"));

    await underBudgetRenderer.setCamera(camera());

    expect(decoded.memory.gpuBytes).toBeGreaterThan(positionsAndIndices);
    expect(underBudgetBackend.meshCount).toBe(0);

    const exactBudgetBackend = new FakeBackend();
    const exactBudgetRenderer = createRenderer(decoded.memory.gpuBytes, exactBudgetBackend);
    await exactBudgetRenderer.mount(document.createElement("canvas"));

    await exactBudgetRenderer.setCamera(camera());

    expect(exactBudgetBackend.meshCount).toBe(1);
  });

  it("keeps an admitted center tile in the CPU cache when the same fetch window exceeds its budget", async () => {
    const payload = encodeLineTile(linePrimitive());
    const tiles = [0, 1, 2].map((tileX, index) => withIntegrity(descriptor({
      tileX,
      assetId: `${index + 3}4444444-4444-4444-8444-444444444444`
    }), payload));
    const centerPrimitive: Extract<CadScenePrimitive, { type: "line" }> = {
      ...linePrimitive(),
      bounds: { minX: 760, minY: 256, maxX: 776, maxY: 256 },
      geometry: { start: { x: 760, y: 256 }, end: { x: 776, y: 256 } }
    };
    const centerBuild = buildCadGeometryBatches([centerPrimitive]);
    const worker: CadSceneWorkerClient = {
      decode: vi.fn(async (value, tile) => ({
        ...(tile.tileX === 1 ? centerBuild : buildCadGeometryBatches([linePrimitive(tile.tileX)])),
        descriptor: tile,
        byteSize: value.byteLength
      })),
      destroy: vi.fn()
    };
    const renderer = new CadSceneRenderer({
      manifest: manifest(tiles),
      loadTile: async () => payload,
      worker,
      backendFactory: () => new FakeBackend(),
      maximumConcurrentTileLoads: 2,
      maximumCacheBytes: centerBuild.memory.cpuBytes
    });
    await renderer.mount(document.createElement("canvas"));

    await renderer.setCamera(camera({ centerX: 768, viewportWidth: 1_536, zoom: 0.3 }));

    expect(renderer.pick({ x: 768, y: 256 })).toEqual(expect.objectContaining({
      elementId: centerPrimitive.elementId
    }));
  });

  it("destroys worker, GPU resources, listeners, and cache exactly once", async () => {
    const { backend, renderer, worker } = rendererFixture();
    const canvas = document.createElement("canvas");
    await renderer.mount(canvas);
    await renderer.setCamera(camera());
    renderer.destroy();
    renderer.destroy();

    expect(backend.destroyCalls).toBe(1);
    expect(worker.destroy).toHaveBeenCalledTimes(1);
    expect(() => canvas.dispatchEvent(new Event("webglcontextrestored"))).not.toThrow();
  });

  it("accounts decoded and active GPU memory in one shared budget and releases it on destroy", async () => {
    const primitive = linePrimitive();
    const payload = encodeLineTile(primitive);
    const tile = withIntegrity(descriptor(), payload);
    const decoded: DecodedCadSceneTile = {
      ...buildCadGeometryBatches([primitive]),
      descriptor: tile,
      byteSize: payload.byteLength
    };
    const maximumBytes = decoded.memory.cpuBytes + decoded.memory.gpuBytes + decoded.memory.textAtlasBytes;
    const budget = new CadSceneMemoryBudget(maximumBytes);
    const backend = new FakeBackend();
    const renderer = new CadSceneRenderer({
      manifest: manifest([tile]),
      loadTile: async () => payload,
      worker: { decode: async () => decoded, destroy: () => undefined },
      backendFactory: () => backend,
      memoryBudget: budget
    });
    await renderer.mount(document.createElement("canvas"));

    await renderer.setCamera(camera());

    expect(backend.meshCount).toBe(1);
    expect(budget.totalBytes).toBe(maximumBytes);
    renderer.destroy();
    expect(budget.totalBytes).toBe(0);
  });

  it("destroys the suspended backend when disposed during context loss", async () => {
    const { backend, renderer } = rendererFixture();
    const canvas = document.createElement("canvas");
    await renderer.mount(canvas);
    await renderer.setCamera(camera());
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));

    renderer.destroy();

    expect(backend.suspendCalls).toBe(1);
    expect(backend.destroyCalls).toBe(1);
  });

  it("destroys a backend whose asynchronous mount finishes after renderer destruction", async () => {
    let finishMount!: () => void;
    const mountBarrier = new Promise<void>(resolve => {
      finishMount = resolve;
    });
    const { backend, loadTile, worker } = rendererFixture();
    backend.mount = vi.fn(async () => mountBarrier);
    const renderer = new CadSceneRenderer({
      manifest: manifest(),
      loadTile,
      worker,
      backendFactory: () => backend
    });

    const mounting = renderer.mount(document.createElement("canvas"));
    renderer.destroy();
    finishMount();
    await mounting;

    expect(backend.destroyCalls).toBe(1);
    expect(backend.renderCalls).toBe(0);
  });
});
