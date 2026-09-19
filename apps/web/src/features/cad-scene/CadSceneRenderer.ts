import type { CadBounds, CadSceneManifest, CadSceneTile } from "@led-control/shared";
import type { SceneManifest, SceneTile } from "./cad-scene-display-types";
import { Color, Container, Mesh, MeshGeometry, Texture, WebGLRenderer } from "pixi.js";
import {
  capCadRendererResolution,
  cadDisplayZoomBand,
  computeVisibleTileCoordinates,
  screenToCadWorld,
  selectCadSceneLods,
  validateCadSceneCamera,
  type CadRendererPlatform,
  type CadSceneCamera
} from "./cad-scene-camera";
import { CadSceneTileCache } from "./cad-scene-tile-cache";
import { CadSceneMemoryBudget } from "./cad-scene-memory-budget";
import { packCadDisplayText } from "./cad-scene-text-layout";
import {
  createCadSceneWorkerClient,
  extractCadSourceElement,
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

export interface CadSceneRenderBackend<TTile extends SceneTile = CadSceneTile> {
  renderDisplay?(request: CadRasterDisplayRequest<TTile>): Promise<void>;
  invalidateDisplay?(bounds?: readonly (CadBounds | undefined)[]): void;
  setLayerStates?(states: ReadonlyMap<string, CadSceneLayerState>): void;
  mount(canvas: HTMLCanvasElement, options: { resolution: number }): Promise<void>;
  resize(width: number, height: number, resolution: number): void;
  setCamera(camera: CadSceneCamera): void;
  replaceTile(
    key: string,
    tile: DecodedCadSceneTile<TTile>,
    excludedElementIds: ReadonlySet<string>,
    hiddenLayerNames?: ReadonlySet<string>,
    excludedGroupIds?: ReadonlySet<string>
  ): void;
  removeTile(key: string): void;
  suspend(): void;
  render(): void;
  destroy(): void;
}

export interface CadRasterDisplayRequest<TTile extends SceneTile> {
  manifest: SceneManifest;
  camera: CadSceneCamera;
  resolution: number;
  loadTile: (tile: TTile, signal: AbortSignal) => Promise<Uint8Array>;
  worker: CadSceneWorkerClient<TTile>;
  signal: AbortSignal;
  excludedIds: ReadonlySet<string>;
  excludedGroupIds?: ReadonlySet<string>;
  onError: (error: Error) => void;
  onDegraded: (result: CadSceneDegradation) => void;
}

export type CadSceneRenderBackendFactory<TTile extends SceneTile = CadSceneTile> = () => CadSceneRenderBackend<TTile>;

export interface CadSceneRendererOptions<TManifest extends SceneManifest = CadSceneManifest> {
  manifest: TManifest;
  loadTile: (tile: TManifest["tiles"][number], signal: AbortSignal) => Promise<Uint8Array>;
  worker?: CadSceneWorkerClient<TManifest["tiles"][number]>;
  backendFactory?: CadSceneRenderBackendFactory<TManifest["tiles"][number]>;
  platform?: CadRendererPlatform;
  devicePixelRatio?: number;
  maximumCacheBytes?: number;
  maximumGpuBytes?: number;
  maximumTextAtlasBytes?: number;
  maximumConcurrentTileLoads?: number;
  memoryBudget?: CadSceneMemoryBudget;
  onError?: (error: Error) => void;
  onDegraded?: (result: CadSceneDegradation) => void;
  displayQuality?: boolean;
}

export interface CadSceneDegradation {
  requestedTileCount: number;
  renderedTileCount: number;
  reason: "memory-budget";
}

export interface CadScenePickResult<TTile extends SceneTile = CadSceneTile> {
  elementId: string;
  groupId: string | null;
  layerName: string;
  sourceTile?: DecodedCadSceneTile<TTile>;
  releaseSourceTile?: () => void;
}

export interface CadSceneLayerState {
  visible: boolean;
  order?: number;
}

function tileKey(tile: SceneTile): string {
  return `${tile.sceneId}:${tile.lod}:${tile.tileX}:${tile.tileY}:${tile.part}`;
}

function isExcluded(
  value: { elementId: string; groupId: string | null },
  excludedIds: ReadonlySet<string>,
  excludedGroupIds: ReadonlySet<string> = excludedIds
): boolean {
  return excludedIds.has(value.elementId) || (value.groupId !== null && excludedGroupIds.has(value.groupId));
}

function filteredIndices(batch: CadGeometryBatch, excludedIds: ReadonlySet<string>, excludedGroupIds: ReadonlySet<string> = excludedIds): Uint32Array {
  if (excludedIds.size === 0 && excludedGroupIds.size === 0) return batch.indices;
  let includedIndexCount = 0;
  for (const span of batch.spans) {
    if (!isExcluded(span, excludedIds, excludedGroupIds)) includedIndexCount += span.indexCount;
  }
  if (includedIndexCount === batch.indices.length) return batch.indices;
  const indices = new Uint32Array(includedIndexCount);
  let offset = 0;
  for (const span of batch.spans) {
    if (isExcluded(span, excludedIds, excludedGroupIds)) continue;
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
    tile: DecodedCadSceneTile<SceneTile>,
    excludedElementIds: ReadonlySet<string>,
    hiddenLayerNames: ReadonlySet<string> = new Set(),
    excludedGroupIds?: ReadonlySet<string>
  ): void {
    this.removeTile(key);
    const tileContainer = new Container();
    const geometries: MeshGeometry[] = [];
    for (const batch of tile.batches) {
      if (hiddenLayerNames.has(batch.layerName)) continue;
      const indices = filteredIndices(batch, excludedElementIds, excludedGroupIds);
      if (indices.length === 0) continue;
      const geometry = new MeshGeometry({
        positions: batch.positions,
        // Solid white geometry does not need a second CPU coordinate array.
        uvs: batch.positions,
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
      const textMeshes = createTextMeshes(textBatch, excludedElementIds, excludedGroupIds);
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

  protected requireRenderer(): WebGLRenderer<HTMLCanvasElement> {
    if (!this.renderer) throw new Error("CAD scene WebGL renderer is not mounted");
    return this.renderer;
  }

  protected requireWorld(): Container {
    if (!this.world) throw new Error("CAD scene WebGL renderer is not mounted");
    return this.world;
  }

  protected replaceRaster(key: string, canvas: HTMLCanvasElement, bounds: CadBounds): void {
    this.removeTile(key);
    const geometry = new MeshGeometry({ positions: new Float32Array([
      bounds.minX, bounds.minY, bounds.maxX, bounds.minY, bounds.maxX, bounds.maxY, bounds.minX, bounds.maxY
    ]), uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
    const texture = Texture.from(canvas);
    const container = new Container(); container.addChild(new Mesh({ geometry, texture }));
    this.tileContainers.set(key, container); this.tileGeometries.set(key, [geometry]); this.tileTextures.set(key, [texture]);
    this.requireWorld().addChild(container);
  }
}

export class CadSceneRenderer<TManifest extends SceneManifest = CadSceneManifest> {
  private static ownerSequence = 0;
  private manifest: TManifest;
  private readonly worker: CadSceneWorkerClient<TManifest["tiles"][number]>;
  private readonly backendFactory: CadSceneRenderBackendFactory<TManifest["tiles"][number]>;
  private readonly platform: CadRendererPlatform;
  private readonly resolution: number;
  private readonly cache: CadSceneTileCache<DecodedCadSceneTile<TManifest["tiles"][number]>>;
  private readonly tilesByCell = new Map<string, TManifest["tiles"][number][]>();
  private readonly loadTile: CadSceneRendererOptions<TManifest>["loadTile"];
  private readonly onError: (error: Error) => void;
  private readonly onDegraded: (result: CadSceneDegradation) => void;
  private readonly maximumCacheBytes: number;
  private readonly maximumGpuBytes: number;
  private readonly maximumTextAtlasBytes: number;
  private readonly maximumConcurrentTileLoads: number;
  private readonly tileLoadScheduler: CadTileLoadScheduler;
  private readonly memoryBudget?: CadSceneMemoryBudget;
  private readonly memoryOwner: string;
  private backend: CadSceneRenderBackend<TManifest["tiles"][number]>;
  private canvas: HTMLCanvasElement | null = null;
  private currentCamera: CadSceneCamera | null = null;
  private activeTileKeys = new Set<string>();
  private excludedIds = new Set<string>();
  private excludedGroupIds: Set<string> | undefined;
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
  private readonly displayQuality: boolean;
  private readonly displayBudget: CadSceneMemoryBudget;
  private readonly displayTiles = new Map<string, { tile: DecodedCadSceneTile<TManifest["tiles"][number]>; qualityKey: string }>();
  private displayVersion = 0;
  private readonly displayTileVersions = new Map<string, number>();
  private readonly sourceBounds = new Map<string, CadBounds>();
  private displayRequest: Promise<void> | null = null;
  private pickSequence = 0;
  private readonly pickLeases = new Set<() => void>();
  private displayRenderFrame: number | null = null;
  private contextRestoreFrame: number | null = null;
  private transientTile: DecodedCadSceneTile<TManifest["tiles"][number]> | null = null;

  constructor(options: CadSceneRendererOptions<TManifest>) {
    this.manifest = options.manifest;
    this.worker = options.worker ?? createCadSceneWorkerClient<TManifest["tiles"][number]>();
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
    this.memoryBudget = options.memoryBudget;
    this.displayQuality = options.displayQuality ?? false;
    this.displayBudget = options.memoryBudget ?? new CadSceneMemoryBudget(this.maximumCacheBytes);
    this.memoryOwner = `renderer-${++CadSceneRenderer.ownerSequence}`;
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
        this.memoryBudget?.release(this.memoryOwner, `cpu:${key}`);
        this.memoryBudget?.release(this.memoryOwner, `active:${key}`);
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

  /** Replace derived descriptors without replacing the canvas or WebGL context. */
  setManifest(manifest: TManifest): void {
    this.assertAlive();
    this.requestGeneration++;
    this.loadAbortController.abort();
    this.loadAbortController = new AbortController();
    this.cache.cancelPending();
    this.tileLoadSignature = "";
    this.displayRequest = null;
    const previous = new Map(this.manifest.tiles.map(tile => [tileKey(tile), tile]));
    const next = new Map(manifest.tiles.map(tile => [tileKey(tile), tile]));
    for (const [key, tile] of previous) {
      const replacement = next.get(key);
      if (replacement && replacement.assetId === tile.assetId && replacement.sha256 === tile.sha256 &&
          replacement.byteSize === tile.byteSize) continue;
      this.cache.delete(key);
      this.displayTiles.delete(key);
      this.displayTileVersions.delete(key);
      this.displayBudget.release(this.memoryOwner, `display:${key}`);
      if (this.activeTileKeys.delete(key) && this.backendMounted) this.backend.removeTile(key);
    }
    for (const release of this.pickLeases) release();
    this.sourceBounds.clear();
    this.manifest = manifest;
    this.tilesByCell.clear();
    for (const tile of manifest.tiles) {
      const key = `${tile.lod}:${tile.tileX}:${tile.tileY}`;
      const parts = this.tilesByCell.get(key) ?? [];
      parts.push(tile);
      this.tilesByCell.set(key, parts);
    }
    if (this.currentCamera && this.mounted) void this.setCamera(this.currentCamera);
  }

  /** A bounded local-edit batch, not one display object per edited element. */
  setTransientTile(tile: DecodedCadSceneTile<TManifest["tiles"][number]> | null): void {
    this.assertAlive();
    const key = "transient";
    if (tile) {
      const memory = tile.memory;
      const bytes = memory.cpuBytes + (this.contextLost ? 0 : memory.gpuBytes + memory.textAtlasBytes);
      if (!this.fitsDisplayResources(tile, key) ||
          !this.displayBudget.reserve(this.memoryOwner, key, Math.max(1, bytes))) {
        throw new Error("Map draft render batch exceeds the available memory budget");
      }
      this.displayBudget.setPinned(this.memoryOwner, key, true);
    } else this.displayBudget.release(this.memoryOwner, key);
    this.transientTile = tile;
    if (!this.backendMounted || this.contextLost) return;
    if (tile) this.backend.replaceTile(key, tile, new Set(), this.hiddenLayerNames);
    else this.backend.removeTile(key);
    this.scheduleDisplayRender();
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

    if (this.displayQuality) return this.setDisplayCamera(nextCamera);
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
    const desiredKeys = new Set(descriptors.map(tileKey));
    for (const key of [...this.activeTileKeys]) {
      if (desiredKeys.has(key)) continue;
      this.backend.removeTile(key);
      this.activeTileKeys.delete(key);
      this.memoryBudget?.setPinned(this.memoryOwner, `cpu:${key}`, false);
      this.memoryBudget?.release(this.memoryOwner, `active:${key}`);
    }
    this.cache.pin(new Set());
    const loaded: Array<[TManifest["tiles"][number], DecodedCadSceneTile<TManifest["tiles"][number]>]> = [];
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
              const key = tileKey(descriptor);
              if (this.memoryBudget && !this.memoryBudget.reserve(
                this.memoryOwner,
                `cpu:${key}`,
                Math.max(1, decoded.memory.cpuBytes),
                () => this.cache.delete(key)
              )) throw new CadSceneAggregateMemoryExceededError();
              return { value: decoded, byteSize: decoded.memory.cpuBytes };
            }, loadSignal);
          })
        ] as [TManifest["tiles"][number], DecodedCadSceneTile<TManifest["tiles"][number]>]));
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
          this.memoryBudget?.setPinned(this.memoryOwner, `cpu:${key}`, true);
          if (this.memoryBudget && !this.memoryBudget.reserve(
            this.memoryOwner,
            `active:${key}`,
            Math.max(1, memory.gpuBytes + memory.textAtlasBytes),
            () => {
              this.activeTileKeys.delete(key);
              this.memoryBudget?.setPinned(this.memoryOwner, `cpu:${key}`, false);
              if (this.backendMounted) this.backend.removeTile(key);
            }
          )) {
            this.memoryBudget.setPinned(this.memoryOwner, `cpu:${key}`, false);
            degraded = true;
            break;
          }
          requestedKeys.add(key);
          this.memoryBudget?.setPinned(this.memoryOwner, `active:${key}`, true);
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
      if (error instanceof CadSceneAggregateMemoryExceededError) {
        degraded = true;
      } else {
        if (generation === this.requestGeneration && !this.destroyed && !this.contextLost) {
          this.onError(error instanceof Error ? error : new Error("CAD scene tile loading failed"));
        }
        return;
      }
    }
    if (generation !== this.requestGeneration || this.destroyed || this.contextLost || !this.backendMounted) return;

    for (const key of this.activeTileKeys) {
      if (!requestedKeys.has(key)) {
        this.backend.removeTile(key);
        this.memoryBudget?.setPinned(this.memoryOwner, `cpu:${key}`, false);
        this.memoryBudget?.release(this.memoryOwner, `active:${key}`);
      }
    }
    for (const [descriptor, decoded] of loaded) {
      const key = tileKey(descriptor);
      if (!this.activeTileKeys.has(key)) {
        this.backend.replaceTile(key, decoded, this.excludedIds, this.hiddenLayerNames, this.excludedGroupIds);
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

  private setDisplayCamera(camera: CadSceneCamera): Promise<void> {
    if (this.backend.renderDisplay) return this.backend.renderDisplay({ manifest: this.manifest, camera,
      resolution: this.resolution, loadTile: this.loadTile, worker: this.worker, signal: this.loadAbortController.signal,
      excludedIds: this.excludedIds, excludedGroupIds: this.excludedGroupIds, onError: this.onError, onDegraded: this.onDegraded });
    const descriptors = this.visibleTileDescriptors(camera);
    const zoomBand = cadDisplayZoomBand(camera.zoom);
    const qualityFor = (key: string) => `${zoomBand}:${this.displayTileVersions.get(key) ?? 0}`;
    const signature = `${zoomBand}:${this.displayVersion}:${descriptors.map(tileKey).join("|")}`;
    if (signature === this.tileLoadSignature) return this.displayRequest ?? Promise.resolve();
    this.tileLoadSignature = signature;
    this.loadAbortController.abort();
    this.loadAbortController = new AbortController();
    const signal = this.loadAbortController.signal;
    const generation = ++this.requestGeneration;
    const desired = new Set(descriptors.map(tileKey));
    for (const key of [...this.activeTileKeys]) {
      if (desired.has(key)) continue;
      this.activeTileKeys.delete(key);
      this.backend.removeTile(key);
      this.displayBudget.setPinned(this.memoryOwner, `display:${key}`, false);
      const cached = this.displayTiles.get(key);
      if (cached) this.displayBudget.reserve(this.memoryOwner, `display:${key}`, Math.max(1, cached.tile.memory.cpuBytes), () => this.displayTiles.delete(key));
    }
    const maxErrorPixels = this.manifest.tiles.reduce((sum, tile) => sum + tile.primitiveCount, 0) > 20_000 ? 1.5 : 0.5;
    const quality = { zoomBand, maxErrorPixels, minimumStrokePixels: 0.5, excludedIds: [...this.excludedIds],
      ...(this.excludedGroupIds === undefined ? {} : { excludedGroupIds: [...this.excludedGroupIds] }) };
    const request = (async () => {
      let degraded = false;
      let completedParts = 0;
      const uncached = descriptors.filter(tile => this.displayTiles.get(tileKey(tile))?.qualityKey !== qualityFor(tileKey(tile)));
      const prefetched = new Map<string, Promise<{ payload: Uint8Array } | { error: unknown }>>();
      let fetchIndex = 0;
      const prefetch = () => {
        while (prefetched.size < 4 && fetchIndex < uncached.length && !signal.aborted) {
          const descriptor = uncached[fetchIndex++];
          // Bounded encoded prefetch overlaps RTT with one-at-a-time decoding;
          // failures are observed when consumed, never unhandled promises.
          prefetched.set(tileKey(descriptor), this.tileLoadScheduler.run(() => this.loadTile(descriptor, signal), signal)
            .then(payload => ({ payload }), error => ({ error })));
        }
      };
      prefetch();
      // Decode only one original part at a time. Exact metadata is transient in
      // the worker; only compact display geometry is admitted and pinned here.
      for (const descriptor of descriptors) {
        if (signal.aborted || generation !== this.requestGeneration || this.destroyed || this.contextLost) return;
        const key = tileKey(descriptor);
        const qualityKey = qualityFor(key);
        const previous = this.displayTiles.get(key);
        if (previous?.qualityKey === qualityKey && this.activeTileKeys.has(key)) continue;
        let decoded: DecodedCadSceneTile<TManifest["tiles"][number]>;
        if (previous?.qualityKey === qualityKey) decoded = previous.tile;
        else {
          const fetched = await prefetched.get(key)!;
          if ("error" in fetched) throw fetched.error;
          decoded = await this.worker.decode(fetched.payload, descriptor, quality);
          prefetched.delete(key);
          prefetch();
        }
        if (signal.aborted || generation !== this.requestGeneration || this.destroyed || this.contextLost) return;
        const bytes = decoded.memory.cpuBytes + decoded.memory.gpuBytes + decoded.memory.textAtlasBytes;
        if (!this.fitsDisplayResources(decoded, key) || !this.displayBudget.reserve(this.memoryOwner, `display:${key}`, Math.max(1, bytes), () => {
          this.displayTiles.delete(key);
          if (this.activeTileKeys.delete(key) && this.backendMounted) this.backend.removeTile(key);
        })) {
          // Never delete the old overview merely because finer geometry cannot
          // be admitted. Report incomplete refinement/coverage explicitly.
          degraded = true;
          continue;
        }
        this.displayTiles.set(key, { tile: decoded, qualityKey });
        this.displayBudget.setPinned(this.memoryOwner, `display:${key}`, true);
        // Exclusions were applied before geometry merged; ID-free display
        // batches must not pass through the exact span-based exclusion filter.
        this.backend.replaceTile(key, decoded, new Set(), this.hiddenLayerNames);
        this.activeTileKeys.add(key);
        // A full-stage draw for each async part is still quadratic during a
        // large import. Flush progress in bounded windows and once at the end.
        if (++completedParts % 16 === 0) this.scheduleDisplayRender();
      }
      this.flushDisplayRender();
      if (degraded) this.onDegraded({ requestedTileCount: descriptors.length, renderedTileCount: this.activeTileKeys.size, reason: "memory-budget" });
    })().catch(error => {
      if (!signal.aborted && generation === this.requestGeneration && !this.destroyed) {
        this.tileLoadSignature = "";
        this.loadAbortController.abort();
        this.onError(error instanceof Error ? error : new Error("CAD display loading failed"));
      }
    });
    this.displayRequest = request;
    return request;
  }

  private scheduleDisplayRender(): void {
    if (this.displayRenderFrame !== null) return;
    this.displayRenderFrame = requestAnimationFrame(() => {
      this.displayRenderFrame = null;
      if (!this.destroyed && this.backendMounted && !this.contextLost) this.backend.render();
    });
  }

  private fitsDisplayResources(tile: DecodedCadSceneTile<TManifest["tiles"][number]>, replacingKey: string): boolean {
    let gpu = tile.memory.gpuBytes;
    let atlas = tile.memory.textAtlasBytes;
    for (const key of this.activeTileKeys) {
      if (key === replacingKey) continue;
      const memory = this.displayTiles.get(key)?.tile.memory;
      gpu += memory?.gpuBytes ?? 0;
      atlas += memory?.textAtlasBytes ?? 0;
    }
    if (replacingKey !== "transient" && this.transientTile) {
      gpu += this.transientTile.memory.gpuBytes;
      atlas += this.transientTile.memory.textAtlasBytes;
    }
    return gpu <= this.maximumGpuBytes && atlas <= this.maximumTextAtlasBytes;
  }

  private flushDisplayRender(): void {
    if (this.displayRenderFrame !== null) cancelAnimationFrame(this.displayRenderFrame);
    this.displayRenderFrame = null;
    if (!this.destroyed && this.backendMounted && !this.contextLost) {
      // Keep the small in-progress edit overlay above newly admitted base tiles.
      if (this.transientTile) this.backend.replaceTile("transient", this.transientTile, new Set(), this.hiddenLayerNames);
      this.backend.render();
    }
  }

  async pickExact(point: { x: number; y: number }, options: {
    radiusPixels?: number; maximumTiles?: number; maximumEncodedBytes?: number; maximumDecodedBytes?: number;
    candidateIds?: Set<string>; maximumCandidateIds?: number;
  } = {}): Promise<CadScenePickResult<TManifest["tiles"][number]> | null> {
    if (!this.displayQuality) return this.pick(point, options);
    const camera = this.currentCamera;
    if (!camera || this.destroyed || this.contextLost) return null;
    const world = screenToCadWorld(point, camera);
    const radius = (options.radiusPixels ?? DEFAULT_PICK_RADIUS_PIXELS) / camera.zoom;
    const signal = this.loadAbortController.signal;
    const candidates = this.manifest.tiles.filter(tile => world.x + radius >= tile.bounds.minX && world.x - radius <= tile.bounds.maxX &&
      world.y + radius >= tile.bounds.minY && world.y - radius <= tile.bounds.maxY);
    if (candidates.length > (options.maximumTiles ?? Infinity) ||
        candidates.reduce((sum, tile) => sum + tile.byteSize, 0) > (options.maximumEncodedBytes ?? Infinity)) {
      throw new Error("Map exact selection budget exceeded; zoom in before selecting");
    }
    let best: { entry: CadPickEntry; distance: number; tile: DecodedCadSceneTile<TManifest["tiles"][number]> } | null = null;
    for (const descriptor of candidates) {
      if (signal.aborted || this.destroyed || this.contextLost) return null;
      // No quality means exact geometry. The editor wrapper can retain this
      // single spatial tile in its evictable raw cache, never all overview tiles.
      const payload = await this.loadTile(descriptor, signal);
      const tile = await this.worker.decode(payload, descriptor);
      if (tile.memory.cpuBytes > (options.maximumDecodedBytes ?? Infinity)) {
        throw new Error("Map exact selection budget exceeded by decoded geometry");
      }
      if (signal.aborted || this.destroyed || this.contextLost) return null;
      let tileBest: { entry: CadPickEntry; distance: number } | null = null;
      for (const index of spatialCandidates(tile, world, radius)) {
        const entry = tile.pickEntries[index];
        if (!entry || isExcluded(entry, this.excludedIds, this.excludedGroupIds) || this.hiddenLayerNames.has(entry.layerName)) continue;
        const distance = distanceToPickEntry(tile, entry, world);
        if (distance <= radius && options.candidateIds) {
          options.candidateIds.add(entry.elementId);
          if (options.candidateIds.size > (options.maximumCandidateIds ?? 128)) {
            throw new Error("Map exact selection budget exceeded by candidate IDs");
          }
        }
        if (distance <= radius && (!tileBest || distance < tileBest.distance || (distance === tileBest.distance && entry.zOrder > tileBest.entry.zOrder))) {
          tileBest = { entry, distance };
        }
      }
      if (tileBest && (!best || tileBest.distance < best.distance || (tileBest.distance === best.distance && tileBest.entry.zOrder > best.entry.zOrder))) {
        const source = this.worker.decodeSource ? await this.worker.decodeSource(payload, descriptor) : tile;
        if (signal.aborted || this.destroyed || this.contextLost) return null;
        best = { ...tileBest, tile: extractCadSourceElement(source, tileBest.entry.elementId) };
      }
    }
    if (!best) return null;
    for (const entry of best.tile.pickEntries) this.registerSourceBounds(entry.elementId, entry.bounds);
    const leaseKey = `pick:${++this.pickSequence}`;
    if (!this.displayBudget.reserve(this.memoryOwner, leaseKey, Math.max(1, best.tile.memory.cpuBytes))) {
      throw new Error("CAD exact selection exceeds the available memory budget");
    }
    this.displayBudget.setPinned(this.memoryOwner, leaseKey, true);
    const releaseSourceTile = () => {
      this.displayBudget.release(this.memoryOwner, leaseKey);
      this.pickLeases.delete(releaseSourceTile);
    };
    this.pickLeases.add(releaseSourceTile);
    return { elementId: best.entry.elementId, groupId: best.entry.groupId, layerName: best.entry.layerName, sourceTile: best.tile, releaseSourceTile };
  }

  registerSourceBounds(elementId: string, bounds: CadBounds): void {
    const previous = this.sourceBounds.get(elementId);
    this.sourceBounds.delete(elementId);
    this.sourceBounds.set(elementId, previous ? {
      minX: Math.min(previous.minX, bounds.minX), minY: Math.min(previous.minY, bounds.minY),
      maxX: Math.max(previous.maxX, bounds.maxX), maxY: Math.max(previous.maxY, bounds.maxY)
    } : { ...bounds });
    // Only selected/moved elements register source extents, not every primitive
    // encountered in a decoded source tile. Bound deselected history as well.
    for (const id of this.sourceBounds.keys()) {
      if (this.sourceBounds.size <= 128 + this.excludedIds.size) break;
      if (!this.excludedIds.has(id)) this.sourceBounds.delete(id);
    }
  }

  pick(
    point: { x: number; y: number },
    options: { radiusPixels?: number } = {}
  ): CadScenePickResult<TManifest["tiles"][number]> | null {
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
        if (isExcluded(entry, this.excludedIds, this.excludedGroupIds)) continue;
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

  setSelectionExclusion(elementOrGroupIds: ReadonlySet<string>, dirtyBounds?: readonly CadBounds[], groupIds?: ReadonlySet<string>): void {
    this.assertAlive();
    const previousGroups = this.excludedGroupIds ?? this.excludedIds;
    const nextGroups = groupIds ?? elementOrGroupIds;
    const groupsChanged = !setsEqual(previousGroups, nextGroups);
    if (setsEqual(this.excludedIds, elementOrGroupIds) && !groupsChanged) return;
    const changed = new Set([...this.excludedIds, ...elementOrGroupIds].filter(id => this.excludedIds.has(id) !== elementOrGroupIds.has(id)));
    this.excludedIds = new Set(elementOrGroupIds);
    this.excludedGroupIds = groupIds === undefined ? undefined : new Set(groupIds);
    if (this.displayQuality) {
      // Common group IDs are a separate namespace with no element bounds entry.
      // A group visibility change may touch unseen descendants anywhere, while
      // element-only edits retain their adjacent-batch invalidation behavior.
      const bounds = groupIds !== undefined && groupsChanged ? [undefined]
        : dirtyBounds?.length ? dirtyBounds : [...changed].map(id => this.sourceBounds.get(id));
      this.backend.invalidateDisplay?.(bounds);
      for (const tile of this.manifest.tiles) {
        if (!bounds.some(bound => !bound || (bound.maxX >= tile.bounds.minX && bound.minX <= tile.bounds.maxX &&
          bound.maxY >= tile.bounds.minY && bound.minY <= tile.bounds.maxY))) continue;
        const key = tileKey(tile);
        this.displayTileVersions.set(key, (this.displayTileVersions.get(key) ?? 0) + 1);
        // Display batches have merged away IDs. Remove the dirty old batch
        // immediately so an async rebuild cannot leave a deleted shape visible.
        if (this.activeTileKeys.delete(key) && this.backendMounted) this.backend.removeTile(key);
        this.displayTiles.delete(key);
        this.displayBudget.release(this.memoryOwner, `display:${key}`);
      }
      this.displayVersion++;
      if (this.currentCamera && this.backendMounted && !this.contextLost) void this.setCamera(this.currentCamera);
      return;
    }
    if (!this.backendMounted || this.contextLost) return;
    for (const key of this.activeTileKeys) {
      const tile = this.displayQuality ? this.displayTiles.get(key)?.tile : this.cache.get(key);
      if (tile) this.backend.replaceTile(key, tile, this.displayQuality ? new Set() : this.excludedIds, this.hiddenLayerNames,
        this.displayQuality ? undefined : this.excludedGroupIds);
    }
    this.backend.render();
  }

  setLayerStates(states: ReadonlyMap<string, CadSceneLayerState>): void {
    this.assertAlive();
    this.backend.setLayerStates?.(states);
    const nextHiddenLayerNames = new Set<string>();
    for (const [layerName, state] of states) {
      if (!state.visible) nextHiddenLayerNames.add(layerName);
    }
    if (setsEqual(this.hiddenLayerNames, nextHiddenLayerNames)) return;
    this.hiddenLayerNames = nextHiddenLayerNames;
    if (!this.backendMounted || this.contextLost) return;
    for (const key of this.activeTileKeys) {
      const tile = this.displayQuality ? this.displayTiles.get(key)?.tile : this.cache.get(key);
      if (tile) this.backend.replaceTile(key, tile, this.displayQuality ? new Set() : this.excludedIds, this.hiddenLayerNames,
        this.displayQuality ? undefined : this.excludedGroupIds);
    }
    if (this.transientTile) this.backend.replaceTile("transient", this.transientTile, new Set(), this.hiddenLayerNames);
    this.backend.render();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.displayRenderFrame !== null) cancelAnimationFrame(this.displayRenderFrame);
    this.displayRenderFrame = null;
    if (this.contextRestoreFrame !== null) cancelAnimationFrame(this.contextRestoreFrame);
    this.contextRestoreFrame = null;
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
    this.displayTiles.clear();
    this.transientTile = null;
    for (const release of this.pickLeases) release();
    this.displayBudget.releaseOwner(this.memoryOwner);
    this.memoryBudget?.releaseOwner(this.memoryOwner);
    this.worker.destroy();
  }

  private visibleTileDescriptors(camera: CadSceneCamera): TManifest["tiles"][number][] {
    const coordinates = computeVisibleTileCoordinates(this.manifest, camera, 1);
    const lods = selectCadSceneLods(camera.zoom, this.displayQuality ? "display" : "source");
    const descriptors: TManifest["tiles"][number][] = [];
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
    if (this.contextRestoreFrame !== null) cancelAnimationFrame(this.contextRestoreFrame);
    this.contextRestoreFrame = null;
    this.requestGeneration++;
    this.backendGeneration++;
    this.loadAbortController.abort();
    this.loadAbortController = new AbortController();
    this.tileLoadSignature = "";
    this.cache.cancelPending();
    this.resumeBackendAfterContextRestore = this.backendMounted;
    if (this.resumeBackendAfterContextRestore) this.backend.suspend();
    for (const key of this.activeTileKeys) {
      this.memoryBudget?.setPinned(this.memoryOwner, `cpu:${key}`, false);
      this.memoryBudget?.release(this.memoryOwner, `active:${key}`);
      const display = this.displayTiles.get(key);
      if (display) {
        // suspend removed the GPU resources. Retain only evictable CPU data:
        // after active keys are cleared, a changed restore camera cannot unpin it.
        this.displayBudget.setPinned(this.memoryOwner, `display:${key}`, false);
        this.displayBudget.reserve(this.memoryOwner, `display:${key}`,
          Math.max(1, display.tile.memory.cpuBytes), () => this.displayTiles.delete(key));
      }
    }
    for (const release of this.pickLeases) release();
    this.backendMounted = false;
    this.activeTileKeys.clear();
    if (this.transientTile) this.displayBudget.reserve(this.memoryOwner, "transient", Math.max(1, this.transientTile.memory.cpuBytes));
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
      // Browser event listeners have microtask checkpoints. A resolved Promise
      // can run before Pixi's later context-restored listener rebuilds GL state.
      // Recreate cached resources on the next frame, after every listener ran.
      await new Promise<void>(resolve => {
        this.contextRestoreFrame = requestAnimationFrame(() => { this.contextRestoreFrame = null; resolve(); });
      });
      if (this.destroyed || this.contextLost || !this.backendMounted) return;
      if (this.transientTile) this.setTransientTile(this.transientTile);
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

class CadSceneAggregateMemoryExceededError extends Error {}

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
  tile: DecodedCadSceneTile<SceneTile>,
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
  tile: DecodedCadSceneTile<SceneTile>,
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
  excludedIds: ReadonlySet<string>,
  excludedGroupIds?: ReadonlySet<string>
): Array<{ mesh: Mesh; geometry: MeshGeometry; texture: Texture }> {
  const entries = batch.entries.filter(entry => !isExcluded(entry, excludedIds, excludedGroupIds));
  if (entries.length === 0) return [];
  const measurementCanvas = document.createElement("canvas");
  const measurementContext = measurementCanvas.getContext("2d");
  if (!measurementContext) return [];
  const fontSize = batch.fontPixelSize ?? TEXT_ATLAS_FONT_SIZE;
  const rowHeight = batch.fontPixelSize === undefined ? TEXT_ATLAS_ROW_HEIGHT : fontSize + TEXT_ATLAS_PADDING * 2;
  measurementContext.font = `${fontSize}px sans-serif`;

  const pages: TextPlacement[][] = batch.fontPixelSize === undefined ? [[]]
    : packCadDisplayText({ ...batch, entries }).pages.map(page => page.map(placement => ({
      ...placement, measuredWidth: Math.max(1, measurementContext.measureText(placement.entry.text).width)
    })));
  let x = 0;
  let y = 0;
  for (const entry of batch.fontPixelSize === undefined ? entries : []) {
    const measuredWidth = Math.max(1, measurementContext.measureText(entry.text).width);
    const width = Math.min(
      TEXT_ATLAS_MAX_SIZE,
      Math.max(8, Math.ceil(measuredWidth) + TEXT_ATLAS_PADDING * 2)
    );
    if (x + width > TEXT_ATLAS_MAX_SIZE) {
      x = 0;
      y += rowHeight;
    }
    if (y + rowHeight > TEXT_ATLAS_MAX_SIZE) {
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
    canvas.height = Math.max(...page.map(placement => placement.y + rowHeight));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("CAD scene text atlas canvas is unavailable");
    context.clearRect(0, 0, canvas.width, canvas.height);
    // Atlas RGB must be the neutral multiplicative identity: mesh.tint applies
    // the imported CAD color below, so a theme color here would alter CAD data.
    context.fillStyle = Color.shared.setValue([1, 1, 1]).toHex();
    context.font = `${fontSize}px sans-serif`;
    context.textBaseline = "top";

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const drawnGlyphs = new Set<string>();
    page.forEach(placement => {
      const availableWidth = placement.width - TEXT_ATLAS_PADDING * 2;
      const rasterScaleX = Math.min(1, availableWidth / placement.measuredWidth);
      const glyphKey = `${placement.x}:${placement.y}`;
      if (!drawnGlyphs.has(glyphKey)) {
        drawnGlyphs.add(glyphKey);
        context.save();
        context.translate(placement.x + TEXT_ATLAS_PADDING, placement.y + TEXT_ATLAS_PADDING);
        context.scale(rasterScaleX, 1);
        context.fillText(placement.entry.text, 0, 0);
        context.restore();
      }

      const vertexOffset = positions.length / 2;
      const quad = clipCadTextQuad(placement.entry);
      quad.forEach(point => positions.push(point.x, point.y));
      const left = placement.x / canvas.width;
      // Display cells are conservatively sized for worker-side admission, not
      // glyph layout. Sample the measured run plus padding so narrow text is
      // not compressed into a fraction of its native world-space quad.
      const sampledWidth = batch.fontPixelSize === undefined ? placement.width : Math.min(
        placement.width, Math.ceil(placement.measuredWidth * rasterScaleX) + TEXT_ATLAS_PADDING * 2
      );
      const right = (placement.x + sampledWidth) / canvas.width;
      const top = placement.y / canvas.height;
      const bottom = (placement.y + rowHeight) / canvas.height;
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
