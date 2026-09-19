import type { CadBounds } from "@led-control/shared";
import type { MapDisplayTile, OrderedMapDisplayPrimitive } from "@led-control/shared/map-display-contracts";
import type { MapElement } from "@led-control/shared/map-document-contracts";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";
import { PixiCadSceneRenderBackend, type CadRasterDisplayRequest, type CadSceneLayerState } from "../cad-scene/CadSceneRenderer";
import { computeVisibleTileCoordinates } from "../cad-scene/cad-scene-camera";
import type { SceneTile } from "../cad-scene/cad-scene-display-types";
import type { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import type { DecodedCadSceneTile } from "../cad-scene/cad-scene-worker";
import { paintDisplayPrimitive, paintDisplayFillRun, canJoinDisplayFill, paintMapElement } from "./map-native-painter";

type Request = CadRasterDisplayRequest<MapDisplayTile>;
interface Cell { signature: string; bounds: CadBounds; canvas: HTMLCanvasElement | null }
const intersects = (a: CadBounds, b: CadBounds) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const expand = (b: CadBounds, margin: number): CadBounds => ({ minX: b.minX - margin, minY: b.minY - margin,
  maxX: b.maxX + margin, maxY: b.maxY + margin });
let sequence = 0;

/** One cell is decoded, ordered and baked at a time. Only its raster remains:
 * no retained overview geometry, per-element scene nodes, or full-map clone. */
export class MapRasterBackend extends PixiCadSceneRenderBackend {
  private readonly owner = `map-raster:${++sequence}`;
  private readonly cells = new Map<string, Cell>();
  private readonly versions = new Map<string, number>();
  private layers = new Map<string, CadSceneLayerState>();
  private drafts: readonly MapElement[] = [];
  private draftBounds: CadBounds[] = [];
  private transient: DecodedCadSceneTile<SceneTile> | null = null;
  private lastRequest: Request | null = null;
  private request: { signature: string; controller: AbortController; promise: Promise<void> } | null = null;
  private drain = Promise.resolve();
  private readonly stagingOwners = new Set<string>();
  private revision = 0;
  private queued = false;
  private stopped = false;

  constructor(private readonly budget: CadSceneMemoryBudget) { super(); }

  override replaceTile(key: string, tile: DecodedCadSceneTile<SceneTile>): void {
    if (key !== "transient") throw new Error("Ordered map display must be baked by cell");
    if (tile === this.transient) return;
    const previous = this.invalidationBounds();
    this.transient = tile;
    if (!tile.nativeDrafts) throw new Error("Ordered map draft paint input is missing");
    this.drafts = tile.nativeDrafts;
    // Native strokes are world-width paths, with Canvas's default miter limit
    // of ten. Canonical geometry bounds alone exclude boundary-line coverage.
    this.draftBounds = this.drafts.map(element => expand(getMapElementBounds(element),
      element.style.strokeColor ? element.style.strokeWidth * 5 : 0));
    this.invalidateDisplay([...previous, ...this.invalidationBounds()]);
  }

  override removeTile(key: string): void {
    if (key === "transient") {
      const previous = this.invalidationBounds();
      this.transient = null; this.drafts = []; this.draftBounds = [];
      this.invalidateDisplay(previous); return;
    }
    super.removeTile(key);
  }

  setLayerStates(states: ReadonlyMap<string, CadSceneLayerState>): void {
    if (states.size === this.layers.size && [...states].every(([id, value]) => {
      const previous = this.layers.get(id); return previous?.visible === value.visible && previous?.order === value.order;
    })) return;
    this.layers = new Map(states); this.invalidateDisplay();
  }

  invalidateDisplay(bounds?: readonly (CadBounds | undefined)[]): void {
    this.revision++;
    this.request?.controller.abort();
    for (const [key, cell] of this.cells) {
      const margin = this.lastRequest ? 1 / this.lastRequest.camera.zoom : 0;
      if (bounds?.length && !bounds.some(bound => !bound || intersects(cell.bounds, expand(bound, margin)))) continue;
      this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
      // Never leave a masked old element visible while the replacement loads.
      this.drop(key);
    }
    this.queueRefresh();
  }

  renderDisplay(request: Request): Promise<void> {
    this.stopped = false;
    this.lastRequest = request;
    if (request.signal.aborted) return Promise.resolve();
    const { camera, manifest } = request;
    if (manifest.version !== 2) return Promise.reject(new Error("Ordered map painter requires v2"));
    const band = camera.zoom, scale = band * request.resolution;
    const offsetX = (camera.viewportWidth / 2 - camera.centerX * camera.zoom) * request.resolution;
    const offsetY = (camera.viewportHeight / 2 - camera.centerY * camera.zoom) * request.resolution;
    const phase = `${(offsetX - Math.floor(offsetX)).toFixed(8)}:${(offsetY - Math.floor(offsetY)).toFixed(8)}`;
    // Subdivide high-zoom source cells without changing codec ownership. This
    // keeps each CPU/GPU bitmap <=1024px per side, including high DPR screens.
    const size = Math.min(manifest.tileSize, 2 ** Math.floor(Math.log2(1024 / scale)));
    if (!(size > 0)) return Promise.reject(new Error("Invalid map raster cell scale"));
    const coordinates = computeVisibleTileCoordinates({ ...manifest, tileSize: size }, camera, 0);
    const parts = new Map<string, MapDisplayTile[]>();
    for (const tile of manifest.tiles) {
      const key = `${tile.tileX}:${tile.tileY}`, list = parts.get(key) ?? [];
      list.push(tile); parts.set(key, list);
    }
    const jobs = coordinates.map(({ tileX, tileY }) => {
      const bounds = { minX: tileX * size, minY: tileY * size,
        maxX: Math.min(manifest.width, (tileX + 1) * size), maxY: Math.min(manifest.height, (tileY + 1) * size) };
      const key = `${size}:${tileX}:${tileY}`;
      const tiles = parts.get(`${Math.floor(bounds.minX / manifest.tileSize)}:${Math.floor(bounds.minY / manifest.tileSize)}`) ?? [];
      const signature = `${manifest.sceneId}:${band}:${request.resolution}:${phase}:${this.versions.get(key) ?? 0}:` +
        tiles.map(tile => `${tile.assetId}:${tile.sha256}:${tile.byteSize}`).join("|");
      return { key, bounds, tiles, signature };
    });
    const signature = `${this.revision}:` + jobs.map(job => `${job.key}:${job.signature}`).join(";");
    if (this.request?.signature === signature && !this.request.controller.signal.aborted) return this.request.promise;
    const previousRequest = this.request;
    const drained = this.drain;
    previousRequest?.controller.abort();
    const controller = new AbortController();
    const cancel = () => controller.abort(); request.signal.addEventListener("abort", cancel, { once: true });
    const wanted = new Set(jobs.map(job => job.key));
    for (const key of this.cells.keys()) if (!wanted.has(key)) this.drop(key);
    const current = { signature, controller, promise: Promise.resolve() };
    this.request = current;
    current.promise = (async () => {
      // Serialize the one-cell staging window, including cancelled Worker work.
      await drained;
      for (const job of jobs) {
        if (controller.signal.aborted || this.stopped) return;
        if (this.cells.get(job.key)?.signature === job.signature) continue;
        const stagingOwner = `${this.owner}:decode:${++sequence}`;
        this.stagingOwners.add(stagingOwner);
        const primitives: OrderedMapDisplayPrimitive[] = [];
        const release = () => { primitives.length = 0; this.budget.releaseOwner(stagingOwner); };
        controller.signal.addEventListener("abort", release, { once: true });
        let pendingCanvas: HTMLCanvasElement | null = null;
        try {
          let stagedBytes = 0;
          for (const tile of job.tiles) {
            // Reserve a conservative decode/transfer window before allocation,
            // then replace it by measured retained native-input accounting.
            const peak = stagedBytes + tile.byteSize * 4 + tile.primitiveCount * 768;
            this.reserve(stagingOwner, "cell", peak);
            const bytes = await abortable(request.loadTile(tile, controller.signal), controller.signal);
            if (controller.signal.aborted) return;
            const decoded = await request.worker.decode(bytes, tile, { nativePaint: true, zoomBand: band, maxErrorPixels: 0.5,
              excludedIds: [...request.excludedIds], excludedGroupIds: [...(request.excludedGroupIds ?? [])] });
            if (controller.signal.aborted) return;
            if (!decoded.nativePrimitives) throw new Error("Ordered map worker paint input is missing");
            stagedBytes += decoded.memory.cpuBytes + decoded.nativePrimitives.length * 12;
            this.reserve(stagingOwner, "cell", stagedBytes);
            for (const primitive of decoded.nativePrimitives) {
              if (this.layers.get(primitive.layerName)?.visible !== false) primitives.push(primitive);
            }
          }
          const drafts = this.drafts.filter((element, index) => this.layers.get(element.layerId)?.visible !== false &&
            intersects(job.bounds, expand(this.draftBounds[index], this.minimumStrokeMargin(element, band) + 1 / band)));
          const count = primitives.length + drafts.length;
          // The only sort index is a bounded single-cell typed array. Metadata
          // and canonical geometry are referenced, never cloned into a full map.
          this.reserve(stagingOwner, "cell", stagedBytes + count * 4 + 131072 * 32);
          const order = Uint32Array.from({ length: count }, (_, index) => index);
          const keyOf = (index: number) => index < primitives.length ? primitives[index] : drafts[index - primitives.length];
          const layerOf = (value: OrderedMapDisplayPrimitive | MapElement) => "layerName" in value ? value.layerName : value.layerId;
          const idOf = (value: OrderedMapDisplayPrimitive | MapElement) => "elementId" in value ? value.elementId : value.id;
          order.sort((a, b) => {
            const left = keyOf(a), right = keyOf(b), l = layerOf(left), r = layerOf(right);
            return (this.layers.get(l)?.order ?? 0) - (this.layers.get(r)?.order ?? 0) || ordinal(l, r) ||
              left.zIndex - right.zIndex || ordinal(idOf(left), idOf(right)) ||
              ("fragmentOrder" in left ? left.fragmentOrder : 0) - ("fragmentOrder" in right ? right.fragmentOrder : 0);
          });
          // Shared half-open device-pixel ownership. Integer-pixel pans reuse
          // the raster; fractional phase/zoom rebuild exact resting coverage.
          const left = Math.ceil(job.bounds.minX * scale + offsetX), top = Math.ceil(job.bounds.minY * scale + offsetY);
          const width = Math.max(1, Math.ceil(job.bounds.maxX * scale + offsetX) - left);
          const height = Math.max(1, Math.ceil(job.bounds.maxY * scale + offsetY) - top);
          const rasterBounds = { minX: (left - offsetX) / scale, minY: (top - offsetY) / scale,
            maxX: (left + width - offsetX) / scale, maxY: (top + height - offsetY) / scale };
          // Canvas pixels + GPU texture + small per-cell scene/descriptor state.
          const rasterBytes = count ? width * height * 8 + 1024 : 256;
          this.drop(job.key);
          this.reserve(this.owner, job.key, rasterBytes);
          let canvas: HTMLCanvasElement | null = null;
          if (count) {
            canvas = document.createElement("canvas"); pendingCanvas = canvas; canvas.width = width; canvas.height = height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Map raster painter is unavailable");
            context.setTransform(scale, 0, 0, scale, offsetX - left, offsetY - top);
            for (let cursor = 0; cursor < order.length; cursor++) {
              const index = order[cursor];
              if (index >= primitives.length) { paintMapElement(context, drafts[index - primitives.length], band); continue; }
              let end = cursor + 1;
              while (end < order.length && order[end] < primitives.length &&
                canJoinDisplayFill(primitives[index], primitives[order[end]])) end++;
              if (end > cursor + 1) paintDisplayFillRun(context, primitives, order.subarray(cursor, end));
              else paintDisplayPrimitive(context, primitives[index], band);
              cursor = end - 1;
            }
            this.replaceRaster(`raster:${job.key}`, canvas, rasterBounds);
          }
          this.cells.set(job.key, { signature: job.signature, bounds: job.bounds, canvas });
          pendingCanvas = null;
          // Yield between cells so camera and cancellation never wait for the
          // entire 300k/500k scene. This is not a sample or primitive truncation.
          super.render();
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        } catch (error) {
          this.drop(job.key);
          if (pendingCanvas) { pendingCanvas.width = 0; pendingCanvas.height = 0; }
          throw error;
        } finally {
          release(); controller.signal.removeEventListener("abort", release); this.stagingOwners.delete(stagingOwner);
        }
      }
    })().catch(error => {
      if (controller.signal.aborted || this.stopped) return;
      this.request = null;
      if (error instanceof RasterBudgetError) request.onDegraded({ requestedTileCount: jobs.length,
        renderedTileCount: this.cells.size, reason: "memory-budget" });
      request.onError(error instanceof Error ? error : new Error("Ordered map display failed"));
    }).finally(() => request.signal.removeEventListener("abort", cancel));
    this.drain = current.promise;
    return current.promise;
  }

  override render(): void { super.render(); this.queueRefresh(); }

  override suspend(): void {
    this.stopped = true; this.request?.controller.abort(); this.request = null; this.lastRequest = null;
    for (const key of this.cells.keys()) this.drop(key);
    for (const owner of this.stagingOwners) this.budget.releaseOwner(owner);
    super.suspend();
  }

  override destroy(): void { super.destroy(); this.versions.clear(); this.drafts = []; this.draftBounds = []; this.transient = null; }

  private queueRefresh(): void {
    if (this.queued || this.stopped || !this.lastRequest) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; if (!this.stopped && this.lastRequest) void this.renderDisplay(this.lastRequest); });
  }

  private reserve(owner: string, key: string, bytes: number): void {
    if (!this.budget.reserve(owner, key, Math.max(1, Math.ceil(bytes)))) throw new RasterBudgetError("Ordered map cell exceeds aggregate memory budget");
    this.budget.setPinned(owner, key, true);
  }

  private minimumStrokeMargin(element: MapElement, zoom: number): number {
    return element.style.strokeColor && element.style.strokeWidth > 0
      ? Math.max(0, 0.5 / zoom - element.style.strokeWidth) * 5 : 0;
  }

  private invalidationBounds(): CadBounds[] {
    const zoom = this.lastRequest?.camera.zoom ?? 1;
    return this.draftBounds.map((bound, index) => expand(bound, this.minimumStrokeMargin(this.drafts[index], zoom)));
  }

  private drop(key: string): void {
    const cell = this.cells.get(key);
    super.removeTile(`raster:${key}`);
    this.cells.delete(key); this.budget.release(this.owner, key);
    if (cell?.canvas) { cell.canvas.width = 0; cell.canvas.height = 0; }
  }
}

class RasterBudgetError extends Error {}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) { promise.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
