import type { CadSceneManifest, CadSceneTile } from "@led-control/shared";
import { Container, Mesh, MeshGeometry, Texture, WebGLRenderer } from "pixi.js";
import {
  capCadRendererResolution,
  computeVisibleTileCoordinates,
  screenToCadWorld,
  selectCadSceneLods,
  validateCadSceneCamera,
  type CadRendererPlatform,
  type CadSceneCamera
} from "./cad-scene-camera";
import { CadSceneTileCache } from "./cad-scene-tile-cache";
import {
  createCadSceneWorkerClient,
  type CadGeometryBatch,
  type CadPickEntry,
  type CadSceneWorkerClient,
  type CadTextBatch,
  type CadTextEntry,
  type DecodedCadSceneTile
} from "./cad-scene-worker";

const DEFAULT_DESKTOP_CACHE_BYTES = 128 * 1_024 * 1_024;
const DEFAULT_MOBILE_CACHE_BYTES = 32 * 1_024 * 1_024;
const DEFAULT_DESKTOP_GPU_BYTES = 128 * 1_024 * 1_024;
const DEFAULT_MOBILE_GPU_BYTES = 32 * 1_024 * 1_024;
const DEFAULT_DESKTOP_TEXT_ATLAS_BYTES = 64 * 1_024 * 1_024;
const DEFAULT_MOBILE_TEXT_ATLAS_BYTES = 16 * 1_024 * 1_024;
const DEFAULT_PICK_RADIUS_PIXELS = 8;

interface ScheduledTileLoad {
  task: () => Promise<unknown>;
  signal: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  started: boolean;
  handleAbort: () => void;
}

class CadTileLoadScheduler {
  private readonly queue: ScheduledTileLoad[] = [];
  private activeCount = 0;

  constructor(private readonly maximumConcurrency: number) {}

  run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
      const item: ScheduledTileLoad = {
        task,
        signal,
        resolve: value => resolve(value as T),
        reject,
        started: false,
        handleAbort: () => {
          if (item.started) return;
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          signal.removeEventListener("abort", item.handleAbort);
          reject(abortReason(signal));
        }
      };
      signal.addEventListener("abort", item.handleAbort, { once: true });
      this.queue.push(item);
      this.pump();
    });
  }

  private pump(): void {
    while (this.activeCount < this.maximumConcurrency) {
      const item = this.queue.shift();
      if (!item) return;
      if (item.signal.aborted) {
        item.signal.removeEventListener("abort", item.handleAbort);
        item.reject(abortReason(item.signal));
        continue;
      }
      item.started = true;
      this.activeCount++;
      void item.task().then(item.resolve, item.reject).finally(() => {
        item.signal.removeEventListener("abort", item.handleAbort);
        this.activeCount--;
        this.pump();
      });
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

export interface CadSceneRenderBackend {
  mount(canvas: HTMLCanvasElement, options: { resolution: number }): Promise<void>;
  resize(width: number, height: number, resolution: number): void;
  setCamera(camera: CadSceneCamera): void;
  replaceTile(
    key: string,
    tile: DecodedCadSceneTile,
    excludedElementIds: ReadonlySet<string>,
    hiddenLayerNames?: ReadonlySet<string>
  ): void;
  removeTile(key: string): void;
  suspend(): void;
  render(): void;
  destroy(): void;
}

export type CadSceneRenderBackendFactory = () => CadSceneRenderBackend;

export interface CadSceneRendererOptions {
  manifest: CadSceneManifest;
  loadTile: (tile: CadSceneTile, signal: AbortSignal) => Promise<Uint8Array>;
  worker?: CadSceneWorkerClient;
  backendFactory?: CadSceneRenderBackendFactory;
  platform?: CadRendererPlatform;
  devicePixelRatio?: number;
  maximumCacheBytes?: number;
  maximumGpuBytes?: number;
  maximumTextAtlasBytes?: number;
  maximumConcurrentTileLoads?: number;
  onError?: (error: Error) => void;
  onDegraded?: (result: CadSceneDegradation) => void;
}

export interface CadSceneDegradation {
  requestedTileCount: number;
  renderedTileCount: number;
  reason: "memory-budget";
}

export interface CadScenePickResult {
  elementId: string;
  groupId: string | null;
  layerName: string;
}

export interface CadSceneLayerState {
  visible: boolean;
}

function tileKey(tile: CadSceneTile): string {
  return `${tile.sceneId}:${tile.lod}:${tile.tileX}:${tile.tileY}:${tile.part}`;
}

function isExcluded(
  value: { elementId: string; groupId: string | null },
  excludedIds: ReadonlySet<string>
): boolean {
  return excludedIds.has(value.elementId) || (value.groupId !== null && excludedIds.has(value.groupId));
}

function filteredIndices(batch: CadGeometryBatch, excludedIds: ReadonlySet<string>): Uint32Array {
  if (excludedIds.size === 0) return batch.indices;
  let includedIndexCount = 0;
  for (const span of batch.spans) {
    if (!isExcluded(span, excludedIds)) includedIndexCount += span.indexCount;
  }
  if (includedIndexCount === batch.indices.length) return batch.indices;
  const indices = new Uint32Array(includedIndexCount);
  let offset = 0;
  for (const span of batch.spans) {
    if (isExcluded(span, excludedIds)) continue;
    indices.set(batch.indices.subarray(span.indexStart, span.indexStart + span.indexCount), offset);
    offset += span.indexCount;
  }
  return indices;
}

export class PixiCadSceneRenderBackend implements CadSceneRenderBackend {
  private renderer: WebGLRenderer<HTMLCanvasElement> | null = null;
  private stage: Container | null = null;
  private world: Container | null = null;
  private readonly tileContainers = new Map<string, Container>();
  private readonly tileGeometries = new Map<string, MeshGeometry[]>();
  private readonly tileTextures = new Map<string, Texture[]>();

  async mount(canvas: HTMLCanvasElement, options: { resolution: number }): Promise<void> {
    if (this.renderer) throw new Error("CAD scene WebGL renderer is already mounted");
    const width = Math.max(1, canvas.clientWidth || canvas.width || 1);
    const height = Math.max(1, canvas.clientHeight || canvas.height || 1);
    const renderer = new WebGLRenderer<HTMLCanvasElement>();
    await renderer.init({
      canvas,
      width,
      height,
      resolution: options.resolution,
      autoDensity: true,
      antialias: true,
      backgroundAlpha: 0,
      clearBeforeRender: true,
      powerPreference: "high-performance",
      preferWebGLVersion: 2
    });
    this.renderer = renderer;
    this.stage = new Container({ isRenderGroup: true });
    this.world = new Container({ isRenderGroup: true });
    this.stage.addChild(this.world);
  }

  resize(width: number, height: number, resolution: number): void {
    this.requireRenderer().resize(width, height, resolution);
  }

  setCamera(camera: CadSceneCamera): void {
    const world = this.requireWorld();
    world.scale.set(camera.zoom);
    world.position.set(
      camera.viewportWidth / 2 - camera.centerX * camera.zoom,
      camera.viewportHeight / 2 - camera.centerY * camera.zoom
    );
  }

  replaceTile(
    key: string,
    tile: DecodedCadSceneTile,
    excludedElementIds: ReadonlySet<string>,
    hiddenLayerNames: ReadonlySet<string> = new Set()
  ): void {
    this.removeTile(key);
    const tileContainer = new Container();
    const geometries: MeshGeometry[] = [];
    for (const batch of tile.batches) {
      if (hiddenLayerNames.has(batch.layerName)) continue;
      const indices = filteredIndices(batch, excludedElementIds);
      if (indices.length === 0) continue;
      const geometry = new MeshGeometry({
        positions: batch.positions,
        indices,
        shrinkBuffersToFit: true
      });
      const mesh = new Mesh({ geometry, texture: Texture.WHITE });
      mesh.tint = batch.color;
      mesh.alpha = batch.opacity;
      tileContainer.addChild(mesh);
      geometries.push(geometry);
    }
    const textures: Texture[] = [];
    for (const textBatch of tile.textBatches) {
      if (hiddenLayerNames.has(textBatch.layerName)) continue;
      const textMeshes = createTextMeshes(textBatch, excludedElementIds);
      textMeshes.forEach(({ mesh, geometry, texture }) => {
        tileContainer.addChild(mesh);
        geometries.push(geometry);
        textures.push(texture);
      });
    }
    this.tileContainers.set(key, tileContainer);
    this.tileGeometries.set(key, geometries);
    this.tileTextures.set(key, textures);
    this.requireWorld().addChild(tileContainer);
  }

  removeTile(key: string): void {
    const existing = this.tileContainers.get(key);
    if (!existing) return;
    this.tileContainers.delete(key);
    existing.removeFromParent();
    existing.destroy({ children: true });
    this.tileGeometries.get(key)?.forEach(geometry => geometry.destroy(true));
    this.tileGeometries.delete(key);
    this.tileTextures.get(key)?.forEach(texture => texture.destroy(true));
    this.tileTextures.delete(key);
  }

  render(): void {
    const stage = this.stage;
    if (stage) this.requireRenderer().render(stage);
  }

  suspend(): void {
    for (const key of [...this.tileContainers.keys()]) this.removeTile(key);
  }

  destroy(): void {
    this.suspend();
    this.stage?.destroy({ children: true });
    this.stage = null;
    this.world = null;
    this.renderer?.destroy({ removeView: false });
    this.renderer = null;
  }

  private requireRenderer(): WebGLRenderer<HTMLCanvasElement> {
    if (!this.renderer) throw new Error("CAD scene WebGL renderer is not mounted");
    return this.renderer;
  }

  private requireWorld(): Container {
    if (!this.world) throw new Error("CAD scene WebGL renderer is not mounted");
    return this.world;
  }
}

export class CadSceneRenderer {
  private readonly manifest: CadSceneManifest;
  private readonly worker: CadSceneWorkerClient;
  private readonly backendFactory: CadSceneRenderBackendFactory;
  private readonly platform: CadRendererPlatform;
  private readonly resolution: number;
  private readonly cache: CadSceneTileCache<DecodedCadSceneTile>;
  private readonly tilesByCell = new Map<string, CadSceneTile[]>();
  private readonly loadTile: CadSceneRendererOptions["loadTile"];
  private readonly onError: (error: Error) => void;
  private readonly onDegraded: (result: CadSceneDegradation) => void;
  private readonly maximumCacheBytes: number;
  private readonly maximumGpuBytes: number;
  private readonly maximumTextAtlasBytes: number;
  private readonly maximumConcurrentTileLoads: number;
  private readonly tileLoadScheduler: CadTileLoadScheduler;
  private backend: CadSceneRenderBackend;
  private canvas: HTMLCanvasElement | null = null;
  private currentCamera: CadSceneCamera | null = null;
  private activeTileKeys = new Set<string>();
  private excludedIds = new Set<string>();
  private hiddenLayerNames = new Set<string>();
  private requestGeneration = 0;
  private tileLoadSignature = "";
  private backendGeneration = 0;
  private loadAbortController = new AbortController();
  private mounted = false;
  private backendMounted = false;
  private resumeBackendAfterContextRestore = false;
  private contextLost = false;
  private destroyed = false;

  constructor(options: CadSceneRendererOptions) {
    this.manifest = options.manifest;
    this.worker = options.worker ?? createCadSceneWorkerClient();
    this.backendFactory = options.backendFactory ?? (() => new PixiCadSceneRenderBackend());
    this.backend = this.backendFactory();
    this.platform = options.platform ?? "desktop";
    const devicePixelRatio = options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
    this.resolution = capCadRendererResolution(devicePixelRatio, this.platform);
    this.loadTile = options.loadTile;
    this.onError = options.onError ?? (() => undefined);
    this.onDegraded = options.onDegraded ?? (() => undefined);
    this.maximumCacheBytes = options.maximumCacheBytes ?? (
      this.platform === "mobile" ? DEFAULT_MOBILE_CACHE_BYTES : DEFAULT_DESKTOP_CACHE_BYTES
    );
    this.maximumGpuBytes = options.maximumGpuBytes ?? (
      this.platform === "mobile" ? DEFAULT_MOBILE_GPU_BYTES : DEFAULT_DESKTOP_GPU_BYTES
    );
    this.maximumTextAtlasBytes = options.maximumTextAtlasBytes ?? (
      this.platform === "mobile" ? DEFAULT_MOBILE_TEXT_ATLAS_BYTES : DEFAULT_DESKTOP_TEXT_ATLAS_BYTES
    );
    this.maximumConcurrentTileLoads = options.maximumConcurrentTileLoads ?? (
      this.platform === "mobile" ? 2 : 4
    );
    for (const [name, value] of [
      ["GPU byte budget", this.maximumGpuBytes],
      ["text atlas byte budget", this.maximumTextAtlasBytes],
      ["concurrent tile load limit", this.maximumConcurrentTileLoads]
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`CAD scene ${name} must be a positive safe integer`);
      }
    }
    this.tileLoadScheduler = new CadTileLoadScheduler(this.maximumConcurrentTileLoads);
    this.cache = new CadSceneTileCache({
      maximumBytes: this.maximumCacheBytes,
      onEvict: key => {
        this.activeTileKeys.delete(key);
        if (this.backendMounted) this.backend.removeTile(key);
      }
    });
    for (const tile of this.manifest.tiles) {
      const key = `${tile.lod}:${tile.tileX}:${tile.tileY}`;
      const parts = this.tilesByCell.get(key) ?? [];
      parts.push(tile);
      parts.sort((left, right) => left.part - right.part);
      this.tilesByCell.set(key, parts);
    }
  }

  async mount(canvas: HTMLCanvasElement): Promise<void> {
    this.assertAlive();
    if (this.mounted) throw new Error("CAD scene renderer is already mounted");
    this.canvas = canvas;
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
    if (!await this.mountBackend()) return;
    this.mounted = true;
    this.backend.render();
  }

  async setCamera(camera: CadSceneCamera): Promise<void> {
    this.assertAlive();
    if (!this.mounted) throw new Error("CAD scene renderer must be mounted before setting its camera");
    const nextCamera = { ...validateCadSceneCamera(camera) };
    this.currentCamera = nextCamera;
    if (this.contextLost || !this.backendMounted) return;

    this.backend.resize(nextCamera.viewportWidth, nextCamera.viewportHeight, this.resolution);
    this.backend.setCamera(nextCamera);
    this.backend.render();

    const descriptors = this.visibleTileDescriptors(nextCamera);
    const loadSignature = descriptors.map(tileKey).join("|");
    const generation = ++this.requestGeneration;
    if (loadSignature !== this.tileLoadSignature || this.loadAbortController.signal.aborted) {
      this.loadAbortController.abort();
      this.cache.cancelPending();
      this.loadAbortController = new AbortController();
      this.tileLoadSignature = loadSignature;
    }
    const loadSignal = this.loadAbortController.signal;
    this.cache.pin(new Set());
    const loaded: Array<[CadSceneTile, DecodedCadSceneTile]> = [];
    const requestedKeys = new Set<string>();
    let cpuBytes = 0;
    let gpuBytes = 0;
    let textAtlasBytes = 0;
    let degraded = false;
    try {
      for (let offset = 0; offset < descriptors.length; offset += this.maximumConcurrentTileLoads) {
        if (generation !== this.requestGeneration || this.destroyed || this.contextLost) return;
        const window = descriptors.slice(offset, offset + this.maximumConcurrentTileLoads);
        const windowLoaded = await Promise.all(window.map(async descriptor => [
          descriptor,
          await this.cache.getOrLoad(tileKey(descriptor), async () => {
            return this.tileLoadScheduler.run(async () => {
              const payload = await this.loadTile(descriptor, loadSignal);
              throwIfAborted(loadSignal);
              const decoded = await this.worker.decode(payload, descriptor);
              throwIfAborted(loadSignal);
              return { value: decoded, byteSize: decoded.memory.cpuBytes };
            }, loadSignal);
          })
        ] as [CadSceneTile, DecodedCadSceneTile]));
        for (let index = 0; index < windowLoaded.length; index++) {
          const [descriptor, decoded] = windowLoaded[index];
          const memory = decoded.memory;
          if (cpuBytes + memory.cpuBytes > this.maximumCacheBytes ||
              gpuBytes + memory.gpuBytes > this.maximumGpuBytes ||
              textAtlasBytes + memory.textAtlasBytes > this.maximumTextAtlasBytes) {
            degraded = true;
            for (let rejected = index; rejected < windowLoaded.length; rejected++) {
              const rejectedKey = tileKey(windowLoaded[rejected][0]);
              if (!this.activeTileKeys.has(rejectedKey)) this.cache.delete(rejectedKey);
            }
            break;
          }
          cpuBytes += memory.cpuBytes;
          gpuBytes += memory.gpuBytes;
          textAtlasBytes += memory.textAtlasBytes;
          const key = tileKey(descriptor);
          requestedKeys.add(key);
          this.cache.pin(requestedKeys);
          if (!this.cache.has(key)) {
            await this.cache.getOrLoad(key, async () => ({
              value: decoded,
              byteSize: decoded.memory.cpuBytes
            }));
          }
          loaded.push([descriptor, decoded]);
        }
        this.cache.pin(requestedKeys);
        if (degraded) break;
      }
    } catch (error: unknown) {
      if (generation === this.requestGeneration && !this.destroyed && !this.contextLost) {
        this.onError(error instanceof Error ? error : new Error("CAD scene tile loading failed"));
      }
      return;
    }
    if (generation !== this.requestGeneration || this.destroyed || this.contextLost || !this.backendMounted) return;

    for (const key of this.activeTileKeys) {
      if (!requestedKeys.has(key)) this.backend.removeTile(key);
    }
    for (const [descriptor, decoded] of loaded) {
      const key = tileKey(descriptor);
      if (!this.activeTileKeys.has(key)) {
        this.backend.replaceTile(key, decoded, this.excludedIds, this.hiddenLayerNames);
      }
    }
    this.activeTileKeys = requestedKeys;
    this.cache.pin(requestedKeys);
    this.backend.render();
    if (degraded) {
      this.onDegraded({
        requestedTileCount: descriptors.length,
        renderedTileCount: requestedKeys.size,
        reason: "memory-budget"
      });
    }
  }

  pick(
    point: { x: number; y: number },
    options: { radiusPixels?: number } = {}
  ): CadScenePickResult | null {
    const camera = this.currentCamera;
    if (!camera || this.destroyed || this.contextLost) return null;
    const world = screenToCadWorld(point, camera);
    const radius = (options.radiusPixels ?? DEFAULT_PICK_RADIUS_PIXELS) / camera.zoom;
    let best: { entry: CadPickEntry; distance: number } | null = null;
    for (const key of this.activeTileKeys) {
      const tile = this.cache.get(key);
      if (!tile) continue;
      for (const entryIndex of spatialCandidates(tile, world, radius)) {
        const entry = tile.pickEntries[entryIndex];
        if (!entry) continue;
        if (isExcluded(entry, this.excludedIds)) continue;
        if (this.hiddenLayerNames.has(entry.layerName)) continue;
        const distance = distanceToPickEntry(tile, entry, world);
        if (distance > radius) continue;
        if (!best || entry.zOrder > best.entry.zOrder ||
            (entry.zOrder === best.entry.zOrder && distance < best.distance)) {
          best = { entry, distance };
        }
      }
    }
    if (!best) return null;
    return {
      elementId: best.entry.elementId,
      groupId: best.entry.groupId,
      layerName: best.entry.layerName
    };
  }

  setSelectionExclusion(elementOrGroupIds: ReadonlySet<string>): void {
    this.assertAlive();
    this.excludedIds = new Set(elementOrGroupIds);
    if (!this.backendMounted || this.contextLost) return;
    for (const key of this.activeTileKeys) {
      const tile = this.cache.get(key);
      if (tile) this.backend.replaceTile(key, tile, this.excludedIds, this.hiddenLayerNames);
    }
    this.backend.render();
  }

  setLayerStates(states: ReadonlyMap<string, CadSceneLayerState>): void {
    this.assertAlive();
    const nextHiddenLayerNames = new Set<string>();
    for (const [layerName, state] of states) {
      if (!state.visible) nextHiddenLayerNames.add(layerName);
    }
    if (setsEqual(this.hiddenLayerNames, nextHiddenLayerNames)) return;
    this.hiddenLayerNames = nextHiddenLayerNames;
    if (!this.backendMounted || this.contextLost) return;
    for (const key of this.activeTileKeys) {
      const tile = this.cache.get(key);
      if (tile) this.backend.replaceTile(key, tile, this.excludedIds, this.hiddenLayerNames);
    }
    this.backend.render();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.requestGeneration++;
    this.backendGeneration++;
    this.loadAbortController.abort();
    this.tileLoadSignature = "";
    this.canvas?.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas?.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.canvas = null;
    if (this.backendMounted || this.resumeBackendAfterContextRestore) this.backend.destroy();
    this.backendMounted = false;
    this.resumeBackendAfterContextRestore = false;
    this.activeTileKeys.clear();
    this.cache.clear();
    this.worker.destroy();
  }

  private visibleTileDescriptors(camera: CadSceneCamera): CadSceneTile[] {
    const coordinates = computeVisibleTileCoordinates(this.manifest, camera, 1);
    const lods = selectCadSceneLods(camera.zoom);
    const descriptors: CadSceneTile[] = [];
    for (const lod of lods) {
      for (const coordinate of coordinates) {
        descriptors.push(...(this.tilesByCell.get(`${lod}:${coordinate.tileX}:${coordinate.tileY}`) ?? []));
      }
    }
    return descriptors.sort((left, right) => {
      if (left.lod !== right.lod) return left.lod - right.lod;
      const leftX = (left.tileX + 0.5) * this.manifest.tileSize;
      const leftY = (left.tileY + 0.5) * this.manifest.tileSize;
      const rightX = (right.tileX + 0.5) * this.manifest.tileSize;
      const rightY = (right.tileY + 0.5) * this.manifest.tileSize;
      const distance = Math.hypot(leftX - camera.centerX, leftY - camera.centerY) -
        Math.hypot(rightX - camera.centerX, rightY - camera.centerY);
      return distance || left.tileY - right.tileY || left.tileX - right.tileX || left.part - right.part;
    });
  }

  private async mountBackend(): Promise<boolean> {
    const canvas = this.canvas;
    if (!canvas) throw new Error("CAD scene renderer canvas is unavailable");
    const backend = this.backend;
    const generation = ++this.backendGeneration;
    await backend.mount(canvas, { resolution: this.resolution });
    if (this.destroyed || this.contextLost || generation !== this.backendGeneration || backend !== this.backend) {
      backend.destroy();
      return false;
    }
    this.backendMounted = true;
    return true;
  }

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    if (this.destroyed || this.contextLost) return;
    this.contextLost = true;
    this.requestGeneration++;
    this.backendGeneration++;
    this.loadAbortController.abort();
    this.loadAbortController = new AbortController();
    this.tileLoadSignature = "";
    this.cache.cancelPending();
    this.resumeBackendAfterContextRestore = this.backendMounted;
    if (this.resumeBackendAfterContextRestore) this.backend.suspend();
    this.backendMounted = false;
    this.activeTileKeys.clear();
  };

  private readonly handleContextRestored = () => {
    if (this.destroyed || !this.contextLost) return;
    this.contextLost = false;
    const canResume = this.resumeBackendAfterContextRestore;
    this.resumeBackendAfterContextRestore = false;
    if (canResume) this.backendMounted = true;
    else this.backend = this.backendFactory();
    const ready = canResume ? Promise.resolve(true) : this.mountBackend();
    void ready.then(async mounted => {
      if (!mounted || this.destroyed) return;
      await Promise.resolve();
      if (this.currentCamera) await this.setCamera(this.currentCamera);
      else this.backend.render();
    }).catch((error: unknown) => {
      this.backendMounted = false;
      this.contextLost = true;
      this.onError(error instanceof Error ? error : new Error("CAD scene WebGL recovery failed"));
    });
  };

  private assertAlive(): void {
    if (this.destroyed) throw new Error("CAD scene renderer is destroyed");
  }
}

function distanceToBounds(point: { x: number; y: number }, bounds: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): number {
  const deltaX = point.x < bounds.minX
    ? bounds.minX - point.x
    : point.x > bounds.maxX ? point.x - bounds.maxX : 0;
  const deltaY = point.y < bounds.minY
    ? bounds.minY - point.y
    : point.y > bounds.maxY ? point.y - bounds.maxY : 0;
  return Math.hypot(deltaX, deltaY);
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function distanceToPickEntry(
  tile: DecodedCadSceneTile,
  entry: CadPickEntry,
  point: { x: number; y: number }
): number {
  if (entry.pointCount < 2) return distanceToBounds(point, entry.bounds);
  if (entry.filled && pointInPolygon(tile.pickPoints, entry, point)) return 0;

  let distance = Number.POSITIVE_INFINITY;
  const segmentCount = entry.closed ? entry.pointCount : entry.pointCount - 1;
  for (let index = 0; index < segmentCount; index++) {
    const start = pickPointAt(tile.pickPoints, entry.pointStart + index);
    const end = pickPointAt(tile.pickPoints, entry.pointStart + (index + 1) % entry.pointCount);
    distance = Math.min(distance, distanceToSegment(point, start, end));
  }
  return Math.max(0, distance - entry.strokeWidth / 2);
}

function pickPointAt(points: Float32Array, pointIndex: number): { x: number; y: number } {
  const offset = pointIndex * 2;
  return { x: points[offset], y: points[offset + 1] };
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number }
): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  if (squaredLength === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(0, Math.min(1,
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / squaredLength
  ));
  return Math.hypot(
    point.x - (start.x + deltaX * projection),
    point.y - (start.y + deltaY * projection)
  );
}

function pointInPolygon(
  points: Float32Array,
  entry: CadPickEntry,
  point: { x: number; y: number }
): boolean {
  let inside = false;
  for (let current = 0, previous = entry.pointCount - 1; current < entry.pointCount; previous = current++) {
    const a = pickPointAt(points, entry.pointStart + current);
    const b = pickPointAt(points, entry.pointStart + previous);
    if ((a.y > point.y) !== (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function spatialCandidates(
  tile: DecodedCadSceneTile,
  point: { x: number; y: number },
  radius: number
): number[] {
  const { cellSize, buckets } = tile.spatialIndex;
  const firstX = Math.floor((point.x - radius) / cellSize);
  const lastX = Math.floor((point.x + radius) / cellSize);
  const firstY = Math.floor((point.y - radius) / cellSize);
  const lastY = Math.floor((point.y + radius) / cellSize);
  const candidates = new Set<number>();
  for (let cellY = firstY; cellY <= lastY; cellY++) {
    for (let cellX = firstX; cellX <= lastX; cellX++) {
      const bucket = buckets[`${cellX}:${cellY}`];
      if (bucket) bucket.forEach(entryIndex => candidates.add(entryIndex));
    }
  }
  return [...candidates];
}

interface TextPlacement {
  entry: CadTextEntry;
  x: number;
  y: number;
  width: number;
  measuredWidth: number;
}

const TEXT_ATLAS_MAX_SIZE = 2_048;
const TEXT_ATLAS_FONT_SIZE = 32;
const TEXT_ATLAS_ROW_HEIGHT = 40;
const TEXT_ATLAS_PADDING = 2;

function createTextMeshes(
  batch: CadTextBatch,
  excludedIds: ReadonlySet<string>
): Array<{ mesh: Mesh; geometry: MeshGeometry; texture: Texture }> {
  const entries = batch.entries.filter(entry => !isExcluded(entry, excludedIds));
  if (entries.length === 0) return [];
  const measurementCanvas = document.createElement("canvas");
  const measurementContext = measurementCanvas.getContext("2d");
  if (!measurementContext) return [];
  measurementContext.font = `${TEXT_ATLAS_FONT_SIZE}px sans-serif`;

  const pages: TextPlacement[][] = [[]];
  let x = 0;
  let y = 0;
  for (const entry of entries) {
    const measuredWidth = Math.max(1, measurementContext.measureText(entry.text).width);
    const width = Math.min(
      TEXT_ATLAS_MAX_SIZE,
      Math.max(8, Math.ceil(measuredWidth) + TEXT_ATLAS_PADDING * 2)
    );
    if (x + width > TEXT_ATLAS_MAX_SIZE) {
      x = 0;
      y += TEXT_ATLAS_ROW_HEIGHT;
    }
    if (y + TEXT_ATLAS_ROW_HEIGHT > TEXT_ATLAS_MAX_SIZE) {
      pages.push([]);
      x = 0;
      y = 0;
    }
    pages.at(-1)!.push({ entry, x, y, width, measuredWidth });
    x += width;
  }

  return pages.filter(page => page.length > 0).map(page => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(...page.map(placement => placement.x + placement.width));
    canvas.height = Math.max(...page.map(placement => placement.y + TEXT_ATLAS_ROW_HEIGHT));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("CAD scene text atlas canvas is unavailable");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.font = `${TEXT_ATLAS_FONT_SIZE}px sans-serif`;
    context.textBaseline = "top";

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    page.forEach(placement => {
      const availableWidth = placement.width - TEXT_ATLAS_PADDING * 2;
      const rasterScaleX = Math.min(1, availableWidth / placement.measuredWidth);
      context.save();
      context.translate(placement.x + TEXT_ATLAS_PADDING, placement.y + TEXT_ATLAS_PADDING);
      context.scale(rasterScaleX, 1);
      context.fillText(placement.entry.text, 0, 0);
      context.restore();

      const vertexOffset = positions.length / 2;
      const quad = clipCadTextQuad(placement.entry);
      quad.forEach(point => positions.push(point.x, point.y));
      const left = placement.x / canvas.width;
      const right = (placement.x + placement.width) / canvas.width;
      const top = placement.y / canvas.height;
      const bottom = (placement.y + TEXT_ATLAS_ROW_HEIGHT) / canvas.height;
      quad.forEach(point => uvs.push(
        left + (right - left) * point.u,
        top + (bottom - top) * point.v
      ));
      for (let index = 1; index < quad.length - 1; index++) {
        indices.push(vertexOffset, vertexOffset + index, vertexOffset + index + 1);
      }
    });

    const texture = Texture.from(canvas);
    const geometry = new MeshGeometry({
      positions: Float32Array.from(positions),
      uvs: Float32Array.from(uvs),
      indices: Uint32Array.from(indices),
      shrinkBuffersToFit: true
    });
    const mesh = new Mesh({ geometry, texture });
    mesh.tint = batch.color;
    mesh.alpha = batch.opacity;
    return { mesh, geometry, texture };
  });
}

export interface CadTextQuadVertex {
  x: number;
  y: number;
  u: number;
  v: number;
}

export function clipCadTextQuad(entry: CadTextEntry): CadTextQuadVertex[] {
  const radians = entry.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const transform = (x: number, y: number) => ({
    x: entry.position.x + x * cosine - y * sine,
    y: entry.position.y + x * sine + y * cosine
  });
  let vertices: CadTextQuadVertex[] = [
    { ...transform(0, -entry.height), u: 0, v: 0 },
    { ...transform(entry.width, -entry.height), u: 1, v: 0 },
    { ...transform(entry.width, 0), u: 1, v: 1 },
    { ...transform(0, 0), u: 0, v: 1 }
  ];
  const bounds = entry.clipBounds;
  if (!bounds) return vertices;

  type Edge = "left" | "right" | "top" | "bottom";
  const inside = (vertex: CadTextQuadVertex, edge: Edge) => {
    if (edge === "left") return vertex.x >= bounds.minX;
    if (edge === "right") return vertex.x <= bounds.maxX;
    if (edge === "top") return vertex.y >= bounds.minY;
    return vertex.y <= bounds.maxY;
  };
  const intersect = (start: CadTextQuadVertex, end: CadTextQuadVertex, edge: Edge) => {
    const ratio = edge === "left" || edge === "right"
      ? ((edge === "left" ? bounds.minX : bounds.maxX) - start.x) / (end.x - start.x)
      : ((edge === "top" ? bounds.minY : bounds.maxY) - start.y) / (end.y - start.y);
    return {
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
      u: start.u + (end.u - start.u) * ratio,
      v: start.v + (end.v - start.v) * ratio
    };
  };
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    const input = vertices;
    vertices = [];
    if (input.length === 0) break;
    let start = input.at(-1)!;
    for (const end of input) {
      const startInside = inside(start, edge);
      const endInside = inside(end, edge);
      if (endInside) {
        if (!startInside) vertices.push(intersect(start, end, edge));
        vertices.push(end);
      } else if (startInside) {
        vertices.push(intersect(start, end, edge));
      }
      start = end;
    }
  }
  return vertices;
}
