import type { CadSceneManifest, CadSceneTile } from "@led-control/shared";
import { mapElementSchema, type Bounds, type MapDocumentRef, type MapElement, type MapGroup,
  type MapLayer, type MapOp, type Point } from "@led-control/shared/map-document-contracts";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";
import { CadSceneRenderer, type CadSceneRendererOptions } from "../cad-scene/CadSceneRenderer";
import { cadDisplayZoomBand, screenToCadWorld, validateCadSceneCamera, type CadSceneCamera } from "../cad-scene/cad-scene-camera";
import { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import { CadSceneTileCache } from "../cad-scene/cad-scene-tile-cache";
import { createCadSceneWorkerClient, type DecodedCadSceneTile } from "../cad-scene/cad-scene-worker";
import { buildMapGeometryBatches, hitMapElement } from "./map-scene-geometry";
import type { MapSceneManifest, MapSceneSource } from "./map-scene-source";

const MiB = 1024 * 1024;
const MAX_SELECTION_IDS = 128;
const MAX_CANONICAL_BYTES = 8 * MiB;
const MAX_DRAFT_IDS = 2000;

export interface MapSceneRendererOptions extends Pick<CadSceneRendererOptions,
  "backendFactory" | "platform" | "devicePixelRatio" | "maximumConcurrentTileLoads" | "onError" | "onDegraded"> {
  source: MapSceneSource;
  maximumMemoryBytes?: number;
  maximumOriginalBytes?: number;
}

export interface MapScenePickResult { element: MapElement }

/** Common lifecycle over the existing compact-tile renderer. No canonical
 * document is materialized for display, and no legacy storage adapter lives here.
 */
export class MapSceneRenderer {
  private readonly scene: CadSceneRenderer;
  private readonly budget: CadSceneMemoryBudget;
  private readonly originals: CadSceneTileCache<Uint8Array>;
  private readonly source: MapSceneSource;
  private readonly scopeKey: string;
  private readonly owner = "map-source";
  private readonly onError: (error: Error) => void;
  private document: MapDocumentRef | null = null;
  private manifest: MapSceneManifest | null = null;
  private displayLayerIds = new Map<string, string>();
  private camera: CadSceneCamera | null = null;
  private controller = new AbortController();
  private epoch = 0;
  private changeEpoch = 0;
  private frame: number | null = null;
  private mounted = false;
  private disposed = false;
  private picking = false;
  private readingElements = false;
  private drafts = new Map<string, MapElement | null>();
  private groups = new Map<string, MapGroup | null>();
  private layers = new Map<string, MapLayer | null>();
  private draftBand = 0;

  constructor(options: MapSceneRendererOptions) {
    this.source = options.source;
    this.scopeKey = options.source.scopeKey;
    if (!this.scopeKey) throw new Error("Map source requires an authenticated scope key");
    this.onError = options.onError ?? (() => undefined);
    const mobile = options.platform === "mobile";
    this.budget = new CadSceneMemoryBudget(options.maximumMemoryBytes ?? (mobile ? 32 : 128) * MiB);
    this.originals = new CadSceneTileCache({
      maximumBytes: options.maximumOriginalBytes ?? (mobile ? 8 : 32) * MiB,
      onEvict: key => this.budget.release(this.owner, key)
    });
    const worker = this.source.decodeDisplayTile
      ? { decode: this.source.decodeDisplayTile.bind(this.source), destroy() {} } : createCadSceneWorkerClient();
    this.scene = new CadSceneRenderer({ ...options, manifest: emptyDisplay(), displayQuality: true,
      maximumCacheBytes: this.budget.maximumBytes, memoryBudget: this.budget,
      loadTile: (tile, signal) => this.loadDisplayTile(tile, signal),
      worker: { destroy: () => worker.destroy(), decode: async (bytes, descriptor, quality) => {
        const bindings = this.displayLayerIds;
        const tile = await worker.decode(bytes, descriptor, quality);
        let addedBytes = 0;
        const layerId = (name: string) => {
          const id = bindings.get(name);
          if (id === undefined) throw new Error("Map display layer binding is missing");
          addedBytes += Math.max(0, id.length - name.length) * 2;
          return id;
        };
        const batches = tile.batches.map(batch => ({ ...batch, layerName: layerId(batch.layerName) }));
        const textBatches = tile.textBatches.map(batch => ({ ...batch, layerName: layerId(batch.layerName) }));
        const pickEntries = tile.pickEntries.map(entry => ({ ...entry, layerName: layerId(entry.layerName) }));
        return { ...tile, batches, textBatches, pickEntries, memory: { ...tile.memory, cpuBytes: tile.memory.cpuBytes + addedBytes } };
      } }
    });
  }

  get memoryBytes(): number { return this.budget.totalBytes; }

  async mount(canvas: HTMLCanvasElement): Promise<void> {
    this.assertAlive();
    await this.scene.mount(canvas);
    if (this.disposed) return;
    this.mounted = true;
    if (this.camera) this.scheduleCamera();
  }

  /** Resolves when the manifest is adopted, not when every display tile loads.
   * Same-generation revisions retain local drafts; acknowledgement/rebase is
   * an explicit integration concern, never inferred from revision equality.
   */
  async setDocument(ref: MapDocumentRef): Promise<void> {
    this.assertAlive();
    if (this.document?.generationId === ref.generationId && ref.revision < this.document.revision) {
      throw new Error("Cannot adopt an older map revision");
    }
    const epoch = ++this.epoch;
    this.controller.abort();
    this.controller = new AbortController();
    this.originals.cancelPending();
    if (this.document?.generationId !== ref.generationId) {
      this.originals.clear();
      this.drafts.clear(); this.groups.clear(); this.layers.clear();
      this.budget.release(this.owner, "drafts");
      this.manifest = null;
      this.displayLayerIds = new Map();
      this.scene.setTransientTile(null);
      this.scene.setManifest(emptyDisplay(ref));
      this.scene.setSelectionExclusion(new Set());
      this.scene.setLayerStates(new Map());
    }
    this.document = structuredClone(ref);
    const signal = this.controller.signal;
    let manifest: MapSceneManifest;
    try { manifest = await this.source.getManifest(ref, signal); }
    catch (error) { if (!this.current(epoch) || signal.aborted) return; throw error; }
    if (!this.current(epoch) || signal.aborted) return;
    if (manifest.generationId !== ref.generationId || manifest.revision !== ref.revision ||
        manifest.canonical.assetId !== ref.manifest.assetId || manifest.canonical.sha256 !== ref.manifest.sha256 ||
        manifest.canonical.byteSize !== ref.manifest.byteSize || manifest.canonical.decodedByteSize !== ref.manifest.decodedByteSize ||
        manifest.display.width !== ref.width || manifest.display.height !== ref.height || manifest.display.tiles.length > 16_384) {
      throw new Error("Map display manifest does not match the canonical document");
    }
    const layerIds = new Set(manifest.layers.map(layer => layer.id));
    if (!Array.isArray(manifest.displayLayerBindings) ||
        new Set(manifest.displayLayerBindings.map(binding => binding.layerName)).size !== manifest.displayLayerBindings.length ||
        manifest.displayLayerBindings.some(binding => !layerIds.has(binding.layerId))) {
      throw new Error("Map display layer bindings must explicitly reference canonical layers");
    }
    this.manifest = manifest;
    this.displayLayerIds = new Map(manifest.displayLayerBindings.map(binding => [binding.layerName, binding.layerId]));
    this.scene.setManifest(manifest.display);
    this.applyVisibility();
    this.refreshDraft();
    if (this.camera) this.scheduleCamera();
  }

  setCamera(camera: CadSceneCamera): void {
    this.assertAlive();
    this.camera = { ...validateCadSceneCamera(camera) };
    this.scheduleCamera();
  }

  applyChanges(operations: MapOp[], changedBounds: Bounds[]): void {
    this.assertAlive();
    if (!this.document) throw new Error("Map document is not set");
    if (operations.length > MAX_DRAFT_IDS) throw new RangeError("Map draft operation limit exceeded");
    const drafts = new Map(this.drafts), groups = new Map(this.groups), layers = new Map(this.layers);
    const dirty = [...changedBounds];
    for (const operation of operations) {
      if (operation.kind === "add" || operation.kind === "update" || operation.kind === "delete") {
        const id = operation.kind === "delete" ? operation.id : operation.element.id;
        const before = drafts.get(id);
        if (before) dirty.push(getMapElementBounds(before));
        const after = operation.kind === "delete" ? null : mapElementSchema.parse(operation.element);
        drafts.set(id, after);
        if (after) dirty.push(getMapElementBounds(after));
      } else if (operation.kind === "group.put") groups.set(operation.group.id, structuredClone(operation.group));
      else if (operation.kind === "group.delete") groups.set(operation.id, null);
      else if (operation.kind === "layer.put") layers.set(operation.layer.id, structuredClone(operation.layer));
      else layers.set(operation.id, null);
    }
    if (drafts.size + groups.size + layers.size > MAX_DRAFT_IDS) throw new RangeError("Map draft ID limit exceeded");
    const bytes = serializedBytes([[...drafts], [...groups], [...layers]]);
    if (bytes > MAX_CANONICAL_BYTES) throw new RangeError("Map draft byte limit exceeded");
    const tile = this.buildDraft(drafts, groups, layers);
    const previousBytes = this.draftBytes();
    if (!this.budget.reserve(this.owner, "drafts", Math.max(1, bytes * 4))) throw new Error("Map draft exceeds aggregate memory budget");
    this.budget.setPinned(this.owner, "drafts", true);
    try { this.scene.setTransientTile(tile); }
    catch (error) {
      if (previousBytes) this.budget.reserve(this.owner, "drafts", previousBytes);
      else this.budget.release(this.owner, "drafts");
      throw error;
    }
    this.drafts = drafts; this.groups = groups; this.layers = layers;
    this.changeEpoch++;
    this.applyVisibility(dirty);
  }

  /** Bounded multi-selection lookup; the caller owns returned canonical values. */
  async getElements(ids: readonly string[]): Promise<readonly MapElement[]> {
    this.assertAlive();
    if (!this.document) return [];
    if (ids.length > MAX_SELECTION_IDS || new Set(ids).size !== ids.length) throw new RangeError("Map selection ID limit exceeded");
    if (this.readingElements) throw new Error("Map canonical lookup is already in progress");
    const missing = ids.filter(id => !this.drafts.has(id));
    const epoch = this.epoch, changes = this.changeEpoch;
    this.readingElements = true;
    try {
      const result = missing.length ? await this.source.getElements(this.document, missing, this.controller.signal) : [];
      if (!this.current(epoch) || changes !== this.changeEpoch) return [];
      if (result.length > missing.length || serializedBytes(result) > MAX_CANONICAL_BYTES ||
          result.some(element => !missing.includes(element.id)) || new Set(result.map(element => element.id)).size !== result.length) {
        throw new Error("Map canonical lookup exceeded its requested scope or byte budget");
      }
      const resolved = new Map(result.map(element => [element.id, element]));
      return ids.flatMap(id => { const element = this.drafts.has(id) ? this.drafts.get(id) : resolved.get(id); return element ? [element] : []; });
    } catch (error) {
      if (!this.current(epoch) || changes !== this.changeEpoch) return [];
      throw error;
    } finally { this.readingElements = false; }
  }

  async pick(point: Point, options: { radiusPixels?: number } = {}): Promise<MapScenePickResult | null> {
    this.assertAlive();
    if (!this.camera || this.picking || !this.manifest) return null;
    const camera = this.camera, epoch = this.epoch, changes = this.changeEpoch;
    const radiusPixels = options.radiusPixels ?? 8;
    if (!Number.isFinite(radiusPixels) || radiusPixels < 0 || radiusPixels > 64) throw new RangeError("Invalid map selection radius");
    const world = screenToCadWorld(point, camera);
    const drafts = [...this.drafts.values()].filter((element): element is MapElement => !!element && this.visible(element));
    drafts.sort((a, b) => b.zIndex - a.zIndex);
    const local = drafts.find(element => hitMapElement(element, world, radiusPixels / camera.zoom, camera.zoom));
    if (local) return { element: local };
    this.picking = true;
    let release: (() => void) | undefined;
    try {
      const candidateIds = new Set<string>();
      const picked = await this.scene.pickExact(point, { radiusPixels, maximumTiles: 32,
        maximumEncodedBytes: 16 * MiB, maximumDecodedBytes: Math.min(16 * MiB, this.budget.maximumBytes),
        candidateIds, maximumCandidateIds: MAX_SELECTION_IDS });
      release = picked?.releaseSourceTile;
      if (!picked || !this.current(epoch) || changes !== this.changeEpoch || this.drafts.has(picked.elementId)) return null;
      const candidates = await this.getElements([...candidateIds]);
      if (!this.current(epoch) || changes !== this.changeEpoch || this.camera !== camera) return null;
      const element = [...candidates].sort((a, b) => this.layerOrder(b.layerId) - this.layerOrder(a.layerId) || b.zIndex - a.zIndex)
        .find(value => this.visible(value) && hitMapElement(value, world, radiusPixels / camera.zoom, camera.zoom));
      if (!element) return null;
      this.scene.registerSourceBounds(element.id, getMapElementBounds(element));
      return { element };
    } finally { release?.(); this.picking = false; }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.epoch++;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.controller.abort();
    this.scene.destroy();
    this.originals.clear();
    this.budget.releaseOwner(this.owner);
    this.drafts.clear(); this.groups.clear(); this.layers.clear();
    this.document = null; this.manifest = null;
    this.displayLayerIds.clear();
  }

  private async loadDisplayTile(tile: CadSceneTile, signal: AbortSignal): Promise<Uint8Array> {
    this.assertAlive();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const epoch = this.epoch, documentSignal = this.controller.signal;
    const key = JSON.stringify([this.scopeKey, this.document?.generationId, tile.assetId, tile.sha256, tile.byteSize]);
    const result = await this.originals.getOrLoad(key, async () => {
      const bytes = await this.source.loadDisplayTile(tile, documentSignal);
      if (!this.current(epoch) || documentSignal.aborted) throw new DOMException("Aborted", "AbortError");
      if (bytes.byteLength !== tile.byteSize || bytes.byteLength > 16 * MiB) throw new Error("Map display tile byte limit mismatch");
      if (!this.budget.reserve(this.owner, key, bytes.byteLength, () => this.originals.delete(key))) {
        throw new Error("Map original cache exceeds aggregate memory budget");
      }
      return { value: bytes, byteSize: bytes.byteLength };
    });
    if (signal.aborted || !this.current(epoch)) throw new DOMException("Aborted", "AbortError");
    this.budget.touch(this.owner, key);
    return result;
  }

  private scheduleCamera(): void {
    if (!this.mounted || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.disposed || !this.camera) return;
      // setCamera transforms/renders synchronously before starting asynchronous
      // display work. Never await a previous viewport's request here.
      void this.scene.setCamera(this.camera).catch(error => this.onError(asError(error)));
      try { if (cadDisplayZoomBand(this.camera.zoom) !== this.draftBand) this.refreshDraft(); }
      catch (error) { this.onError(asError(error)); }
    });
  }

  private applyVisibility(dirty?: Bounds[]): void {
    const masks = new Set(this.drafts.keys());
    const groups = new Map(this.manifest?.groups.map(group => [group.id, group]));
    for (const [id, group] of this.groups) { if (group) groups.set(id, group); else groups.delete(id); }
    for (const group of groups.values()) {
      let current: MapGroup | undefined = group;
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (!current.visible) { masks.add(group.id); break; }
        current = current.parentId ? groups.get(current.parentId) : undefined;
      }
    }
    // Group visibility can affect unseen descendants, so don't narrow a
    // structural mask update to just the edited element's bounds.
    this.scene.setSelectionExclusion(masks, this.groups.size ? undefined : dirty);
    const layers = new Map(this.manifest?.layers.map(layer => [layer.id, layer]));
    for (const [id, layer] of this.layers) { if (layer) layers.set(id, layer); else layers.delete(id); }
    this.scene.setLayerStates(layers);
  }

  private visible(element: MapElement, groups = this.groups, layers = this.layers): boolean {
    if (!element.visible) return false;
    const layer = layers.has(element.layerId) ? layers.get(element.layerId) : this.manifest?.layers.find(value => value.id === element.layerId);
    if (layer && !layer.visible) return false;
    const seen = new Set<string>();
    let id = element.groupId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const group = groups.has(id) ? groups.get(id) : this.manifest?.groups.find(value => value.id === id);
      if (group && !group.visible) return false;
      id = group?.parentId ?? null;
    }
    return true;
  }

  private buildDraft(drafts = this.drafts, groups = this.groups, layers = this.layers): DecodedCadSceneTile | null {
    const elements = [...drafts.values()].filter((element): element is MapElement => !!element && this.visible(element, groups, layers));
    if (!elements.length) return null;
    const band = cadDisplayZoomBand(this.camera?.zoom ?? 1);
    const geometry = buildMapGeometryBatches(elements, band);
    return { ...geometry, byteSize: geometry.memory.cpuBytes, descriptor: {
      version: 1, sceneId: this.document!.generationId, tileX: 0, tileY: 0, lod: 0, part: 0,
      assetId: "local-draft", sha256: "0".repeat(64), byteSize: geometry.memory.cpuBytes, primitiveCount: elements.length,
      bounds: { minX: 0, minY: 0, maxX: this.document!.width, maxY: this.document!.height }
    } };
  }

  private refreshDraft(): void {
    this.scene.setTransientTile(this.buildDraft());
    this.draftBand = cadDisplayZoomBand(this.camera?.zoom ?? 1);
  }

  private draftBytes(): number {
    return this.drafts.size + this.groups.size + this.layers.size ? serializedBytes([[...this.drafts], [...this.groups], [...this.layers]]) * 4 : 0;
  }

  private layerOrder(id: string): number {
    return (this.layers.has(id) ? this.layers.get(id) : this.manifest?.layers.find(layer => layer.id === id))?.order ?? 0;
  }

  private current(epoch: number): boolean { return !this.disposed && epoch === this.epoch && this.source.scopeKey === this.scopeKey; }
  private assertAlive(): void {
    if (this.disposed) throw new Error("Map scene renderer is disposed");
    if (this.source.scopeKey !== this.scopeKey) throw new Error("Map source scope changed; dispose the old renderer first");
  }
}

function serializedBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error("Map scene rendering failed"); }

function emptyDisplay(ref?: MapDocumentRef): CadSceneManifest {
  return { version: 1, sceneId: ref?.generationId ?? "empty", regionId: "empty", manifestAssetId: "empty",
    width: ref?.width ?? 1024, height: ref?.height ?? 1024, gridSize: ref?.gridSize ?? 50, padding: 0,
    tileSize: 512, lodMode: "additive", primitiveCount: 0, tileCount: 0, byteSize: 0, sha256: "0".repeat(64),
    sourceBounds: { minX: 0, minY: 0, maxX: ref?.width ?? 1024, maxY: ref?.height ?? 1024 },
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [] };
}
