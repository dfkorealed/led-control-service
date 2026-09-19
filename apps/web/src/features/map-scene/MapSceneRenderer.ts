import type { MapDisplayManifest, MapDisplayTile } from "@led-control/shared/map-display-contracts";
import { mapElementSchema, mapElementOpSchema, type Bounds, type MapDocumentRef, type MapElement, type MapGroup,
  type MapLayer, type MapOp, type Point } from "@led-control/shared/map-document-contracts";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";
import { CadSceneRenderer, type CadSceneRendererOptions } from "../cad-scene/CadSceneRenderer";
import { cadDisplayZoomBand, screenToCadWorld, validateCadSceneCamera, type CadSceneCamera } from "../cad-scene/cad-scene-camera";
import { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import { CadSceneTileCache } from "../cad-scene/cad-scene-tile-cache";
import { createCadSceneWorkerClient, type DecodedCadSceneTile } from "../cad-scene/cad-scene-worker";
import { buildMapGeometryBatches, hitMapElement } from "./map-scene-geometry";
import type { MapSceneManifest, MapSceneSource } from "./map-scene-source";
import { MapRasterBackend } from "./map-raster-backend";

const MiB = 1024 * 1024;
const MAX_SELECTION_IDS = 128;
const MAX_CANONICAL_BYTES = 8 * MiB;
const MAX_DRAFT_IDS = 2000;

export interface MapSceneRendererOptions extends Pick<CadSceneRendererOptions<MapDisplayManifest>,
  "backendFactory" | "platform" | "devicePixelRatio" | "maximumConcurrentTileLoads" | "onError" | "onDegraded"> {
  source: MapSceneSource;
  onManifest?: (manifest: MapSceneManifest) => void;
  maximumMemoryBytes?: number;
  maximumOriginalBytes?: number;
}

export interface MapScenePickResult { element: MapElement }

/** Common lifecycle over the existing compact-tile renderer. No canonical
 * document is materialized for display, and no legacy storage adapter lives here.
 */
export class MapSceneRenderer {
  private readonly scene: CadSceneRenderer<MapDisplayManifest>;
  private readonly budget: CadSceneMemoryBudget;
  private readonly originals: CadSceneTileCache<Uint8Array>;
  private readonly source: MapSceneSource;
  private readonly scopeKey: string;
  private readonly owner = "map-source";
  private readonly onError: (error: Error) => void;
  private readonly onManifest: (manifest: MapSceneManifest) => void;
  private document: MapDocumentRef | null = null;
  private requestedDocument: MapDocumentRef | null = null;
  private manifest: MapSceneManifest | null = null;
  private displayLayerIds = new Map<string, string>();
  private camera: CadSceneCamera | null = null;
  private renderedCamera: CadSceneCamera | null = null;
  private controller = new AbortController();
  private epoch = 0;
  private changeEpoch = 0;
  private frame: number | null = null;
  private mounted = false;
  private disposed = false;
  private picking = false;
  private readingElements = false;
  private drafts = new Map<string, MapElement | null>();
  private persisted = new Map<string, MapElement | null>();
  private persistedBytes = 0;
  private promoted = new Set<string>();
  private draftVersion = 0;
  private draftVersions = new Map<string, number>();
  private adoption: { key: string; promise: Promise<void>; throughVersion?: number } | null = null;
  private groups = new Map<string, MapGroup | null>();
  private layers = new Map<string, MapLayer | null>();
  private draftBand = 0;
  private readonly nativePaint: boolean;

  constructor(options: MapSceneRendererOptions) {
    this.source = options.source;
    this.scopeKey = options.source.scopeKey;
    if (!this.scopeKey) throw new Error("Map source requires an authenticated scope key");
    this.onError = options.onError ?? (() => undefined);
    this.onManifest = options.onManifest ?? (() => undefined);
    const mobile = options.platform === "mobile";
    this.budget = new CadSceneMemoryBudget(options.maximumMemoryBytes ?? (mobile ? 32 : 128) * MiB);
    this.nativePaint = !options.backendFactory;
    this.originals = new CadSceneTileCache({
      maximumBytes: options.maximumOriginalBytes ?? (mobile ? 8 : 32) * MiB,
      onBeforeInsert: (key, bytes) => {
        if (!this.budget.reserve(this.owner, key, bytes, () => this.originals.delete(key))) {
          throw new Error("Map original cache exceeds aggregate memory budget");
        }
      },
      onEvict: key => this.budget.release(this.owner, key)
    });
    const worker = this.source.decodeDisplayTile
      ? { decode: this.source.decodeDisplayTile.bind(this.source), destroy() {} } : createCadSceneWorkerClient<MapDisplayTile>();
    this.scene = new CadSceneRenderer<MapDisplayManifest>({ ...options, manifest: emptyDisplay(), displayQuality: true,
      backendFactory: options.backendFactory ?? (() => new MapRasterBackend(this.budget, name => this.displayLayerIds.get(name))),
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
        const nativePrimitives = tile.nativePrimitives?.map(primitive => ({ ...primitive, layerName: layerId(primitive.layerName) }));
        return { ...tile, batches, textBatches, pickEntries, nativePrimitives,
          memory: { ...tile.memory, cpuBytes: tile.memory.cpuBytes + addedBytes } };
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

  /** Resolves after metadata and every persisted page are adopted, not after
   * visible tile loading. Ordinary refresh never acknowledges unsaved edits. */
  async setDocument(ref: MapDocumentRef): Promise<void> {
    return this.requestDocument(ref);
  }

  getDraftVersion(): number { return this.draftVersion; }

  async acknowledge(ref: MapDocumentRef, throughVersion: number): Promise<void> {
    this.assertAlive();
    if (!this.document || this.document.generationId !== ref.generationId ||
        !Number.isSafeInteger(throughVersion) || throughVersion < 0 || throughVersion > this.draftVersion) {
      throw new Error("Map acknowledgement does not match this document draft");
    }
    return this.requestDocument(ref, throughVersion);
  }

  private requestDocument(ref: MapDocumentRef, throughVersion?: number): Promise<void> {
    this.assertAlive();
    const key = JSON.stringify(ref);
    // Store ACK and React's documentRef effect can arrive in either order.
    // Join the same in-flight revision and attach its explicit ACK boundary.
    if (this.adoption?.key === key) {
      if (throughVersion !== undefined) this.adoption.throughVersion = Math.max(this.adoption.throughVersion ?? 0, throughVersion);
      return this.adoption.promise;
    }
    const adoption = { key, throughVersion, promise: Promise.resolve() };
    this.adoption = adoption;
    adoption.promise = this.adoptDocument(ref, () => adoption.throughVersion).finally(() => {
      if (this.adoption === adoption) this.adoption = null;
    });
    return adoption.promise;
  }

  private async adoptDocument(ref: MapDocumentRef, acknowledgement: () => number | undefined): Promise<void> {
    this.assertAlive();
    if (this.requestedDocument?.generationId === ref.generationId && ref.revision < this.requestedDocument.revision) {
      throw new Error("Cannot adopt an older map revision");
    }
    const epoch = ++this.epoch;
    this.controller.abort();
    this.controller = new AbortController();
    this.originals.cancelPending();
    this.requestedDocument = structuredClone(ref);
    if (this.document?.generationId !== ref.generationId) {
      this.originals.clear();
      this.drafts.clear(); this.groups.clear(); this.layers.clear();
      this.persisted.clear(); this.persistedBytes = 0; this.promoted.clear(); this.draftVersions.clear();
      this.budget.release(this.owner, "drafts");
      this.budget.release(this.owner, "persisted");
      this.manifest = null;
      this.document = null;
      this.displayLayerIds = new Map();
      this.scene.setTransientTile(null);
      this.scene.setManifest(emptyDisplay(ref));
      this.scene.setSelectionExclusion(new Set(), undefined, new Set());
      this.scene.setLayerStates(new Map());
    }
    const signal = this.controller.signal;
    let manifest: MapSceneManifest;
    try { manifest = await this.source.getManifest(ref, signal); }
    catch (error) { if (!this.current(epoch) || signal.aborted) return; throw error; }
    if (!this.current(epoch) || signal.aborted) return;
    if (manifest.display.version !== 2 || manifest.display.tiles.some(tile => tile.version !== 2)) {
      throw new Error("Unsupported common map display version; ordered v2 assets are required");
    }
    if (manifest.generationId !== ref.generationId || manifest.revision !== ref.revision ||
        manifest.canonical.assetId !== ref.manifest.assetId || manifest.canonical.sha256 !== ref.manifest.sha256 ||
        manifest.canonical.byteSize !== ref.manifest.byteSize || manifest.canonical.decodedByteSize !== ref.manifest.decodedByteSize ||
        manifest.display.width !== ref.width || manifest.display.height !== ref.height || manifest.display.tiles.length > 16_384) {
      throw new Error("Map display manifest does not match the canonical document");
    }
    if (!Array.isArray(manifest.displayLayerBindings) ||
        new Set(manifest.displayLayerBindings.map(binding => binding.layerName)).size !== manifest.displayLayerBindings.length ||
        manifest.displayLayerBindings.some(binding => !binding.layerName || !binding.layerId)) {
      throw new Error("Map display layer bindings must explicitly reference canonical layers");
    }
    const loadingOwner = `${this.owner}:revision:${epoch}`;
    const persisted = new Map<string, MapElement | null>();
    const releaseLoading = () => this.budget.releaseOwner(loadingOwner);
    // A faulty injected source may ignore abort indefinitely. Release the
    // actual staged geometry as well as its accounting while it is waiting.
    const abortLoading = () => { persisted.clear(); releaseLoading(); };
    signal.addEventListener("abort", abortLoading, { once: true });
    try {
      let cursor: string | undefined, bytes = 0, pages = 0;
      const cursors = new Set<string>();
      do {
        const page = await this.source.getChanges(ref, cursor, signal);
        if (!this.current(epoch) || signal.aborted) return;
        if (page.generationId !== ref.generationId || page.revision !== ref.revision ||
            !Array.isArray(page.operations) || page.operations.length > 128 ||
            (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor.length > 8192))) {
          throw new Error("Map persisted page does not match the requested document");
        }
        const pageBytes = serializedBytes(page.operations);
        bytes += pageBytes;
        if (pageBytes > MAX_CANONICAL_BYTES || bytes > 32 * MiB || ++pages > 16_384) {
          throw new RangeError("Map persisted change byte or page limit exceeded");
        }
        if (!this.budget.reserve(loadingOwner, "persisted", Math.max(1, bytes * 4))) {
          throw new Error("Map persisted changes exceed aggregate memory budget");
        }
        this.budget.setPinned(loadingOwner, "persisted", true);
        for (const input of page.operations) {
          const operation = mapElementOpSchema.parse(input);
          persisted.set(operation.kind === "delete" ? operation.id : operation.element.id,
            operation.kind === "delete" ? null : operation.element);
        }
        if (page.nextCursor !== null && cursors.has(page.nextCursor)) throw new Error("Map persisted page cursor cycle");
        if (page.nextCursor !== null) cursors.add(page.nextCursor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      // ACK pruning is evaluated now, not when the request started: edits made
      // during manifest/page I/O retain their newer per-namespace version.
      const throughVersion = acknowledgement();
      const afterAck = <T,>(values: Map<string, T>, namespace: string) => throughVersion === undefined ? values
        : new Map([...values].filter(([id]) => (this.draftVersions.get(`${namespace}:${id}`) ?? 0) > throughVersion));
      const drafts = afterAck(this.drafts, "element"), groups = afterAck(this.groups, "group"), layers = afterAck(this.layers, "layer");
      const previous = { document: this.document, manifest: this.manifest, persisted: this.persisted, drafts: this.drafts, groups: this.groups, layers: this.layers };
      this.document = structuredClone(ref);
      this.manifest = manifest; this.persisted = persisted;
      this.drafts = drafts; this.groups = groups; this.layers = layers;
      try { this.refreshDraft(); }
      catch (error) { Object.assign(this, previous); throw error; }
      // No await between releasing the staging reservation and its retained
      // replacement. Both old and incoming revisions were charged during I/O.
      this.budget.releaseOwner(loadingOwner);
      this.budget.release(this.owner, "persisted");
      this.persistedBytes = persisted.size ? bytes * 4 : 0;
      if (this.persistedBytes) {
        this.budget.reserve(this.owner, "persisted", this.persistedBytes);
        this.budget.setPinned(this.owner, "persisted", true);
      }
      const draftBytes = this.draftBytes();
      if (draftBytes) this.budget.reserve(this.owner, "drafts", draftBytes);
      else this.budget.release(this.owner, "drafts");
      if (throughVersion !== undefined) for (const [key, version] of this.draftVersions) {
        if (version <= throughVersion) this.draftVersions.delete(key);
      }
      this.changeEpoch++;
      this.displayLayerIds = new Map(manifest.displayLayerBindings.map(binding => [binding.layerName, binding.layerId]));
      // Masks must be installed before the new base starts loading.
      this.applyVisibility();
      this.scene.setManifest(manifest.display);
      this.onManifest(manifest);
      if (this.camera) this.scheduleCamera();
    } catch (error) {
      if (!this.current(epoch) || signal.aborted) return;
      throw error;
    } finally { releaseLoading(); signal.removeEventListener("abort", abortLoading); }
  }

  setCamera(camera: CadSceneCamera): void {
    this.assertAlive();
    this.camera = { ...validateCadSceneCamera(camera) };
    this.scheduleCamera();
  }

  applyChanges(operations: MapOp[], changedBounds: Bounds[]): number {
    return this.updateDraft(operations, changedBounds, false);
  }

  /** Replace only sparse unsaved operations after undo/rebase. Persisted
   * changes remain independently visible and never consume the 2k budget. */
  setDraftChanges(operations: MapOp[], changedBounds: Bounds[]): number {
    return this.updateDraft(operations, changedBounds, true);
  }

  setPromotedElementIds(ids: readonly string[]): void {
    this.assertAlive();
    if (ids.length > 64 || new Set(ids).size !== ids.length) throw new RangeError("Map promotion ID limit exceeded");
    const previous = this.promoted;
    this.promoted = new Set(ids);
    try { this.refreshDraft(); }
    catch (error) { this.promoted = previous; throw error; }
    this.changeEpoch++;
    this.applyVisibility();
  }

  private updateDraft(operations: MapOp[], changedBounds: Bounds[], replace: boolean): number {
    this.assertAlive();
    if (!this.document) throw new Error("Map document is not set");
    if (operations.length > MAX_DRAFT_IDS) throw new RangeError("Map draft operation limit exceeded");
    const drafts = replace ? new Map<string, MapElement | null>() : new Map(this.drafts);
    const groups = replace ? new Map<string, MapGroup | null>() : new Map(this.groups);
    const layers = replace ? new Map<string, MapLayer | null>() : new Map(this.layers);
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
    this.draftVersion++;
    if (replace) this.draftVersions.clear();
    for (const operation of operations) this.draftVersions.set(operationKey(operation), this.draftVersion);
    this.changeEpoch++;
    this.applyVisibility(replace ? undefined : dirty);
    return this.draftVersion;
  }

  /** Bounded multi-selection lookup; the caller owns returned canonical values. */
  async getElements(ids: readonly string[]): Promise<readonly MapElement[]> {
    this.assertAlive();
    if (!this.document) return [];
    if (ids.length > MAX_SELECTION_IDS || new Set(ids).size !== ids.length) throw new RangeError("Map selection ID limit exceeded");
    if (this.readingElements) throw new Error("Map canonical lookup is already in progress");
    const missing = ids.filter(id => !this.drafts.has(id) && !this.persisted.has(id));
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
      const elements = ids.flatMap(id => { const element = this.drafts.has(id) ? this.drafts.get(id)
        : this.persisted.has(id) ? this.persisted.get(id) : resolved.get(id); return element ? [element] : []; });
      if (serializedBytes(elements) > MAX_CANONICAL_BYTES) throw new Error("Map canonical lookup exceeded its byte budget");
      // The host owns selected originals, but must not mutate retained draft/
      // persisted display state by reference. Only this bounded selection is copied.
      return structuredClone(elements);
    } catch (error) {
      if (!this.current(epoch) || changes !== this.changeEpoch) return [];
      throw error;
    } finally { this.readingElements = false; }
  }

  async pick(point: Point, options: { radiusPixels?: number } = {}): Promise<MapScenePickResult | null> {
    this.assertAlive();
    if (!this.renderedCamera || this.picking || !this.manifest) return null;
    // Input may be one rAF ahead of the visible scene. Broad-phase candidates
    // and canonical hit tests must use the same last-applied camera snapshot.
    const camera = this.renderedCamera, epoch = this.epoch, changes = this.changeEpoch;
    const radiusPixels = options.radiusPixels ?? 8;
    if (!Number.isFinite(radiusPixels) || radiusPixels < 0 || radiusPixels > 64) throw new RangeError("Invalid map selection radius");
    const world = screenToCadWorld(point, camera);
    const drafts = [...this.displayChanges().values()].filter((element): element is MapElement => !!element && this.visible(element) && !this.promoted.has(element.id));
    drafts.sort((a, b) => this.comparePaint(b, a));
    const local = drafts.find(element => hitMapElement(element, world, radiusPixels / camera.zoom, camera.zoom));
    this.picking = true;
    let release: (() => void) | undefined;
    try {
      const candidateIds = new Set<string>();
      const picked = await this.scene.pickExact(point, { radiusPixels, maximumTiles: 32,
        maximumEncodedBytes: 16 * MiB, maximumDecodedBytes: Math.min(16 * MiB, this.budget.maximumBytes),
        candidateIds, maximumCandidateIds: MAX_SELECTION_IDS });
      release = picked?.releaseSourceTile;
      if (!this.current(epoch) || changes !== this.changeEpoch) return null;
      const candidates = picked ? await this.getElements([...candidateIds]) : [];
      if (!this.current(epoch) || changes !== this.changeEpoch || !sameCamera(this.renderedCamera, camera)) return null;
      const element = [...candidates, ...(local ? [local] : [])].sort((a, b) => this.comparePaint(b, a))
        .find(value => !this.promoted.has(value.id) && this.visible(value) && hitMapElement(value, world, radiusPixels / camera.zoom, camera.zoom));
      if (!element) return null;
      this.scene.registerSourceBounds(element.id, getMapElementBounds(element));
      return { element: structuredClone(element) };
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
    this.persisted.clear(); this.persistedBytes = 0; this.promoted.clear(); this.draftVersions.clear();
    this.document = null; this.manifest = null;
    this.renderedCamera = null;
    this.displayLayerIds.clear();
  }

  private async loadDisplayTile(tile: MapDisplayTile, signal: AbortSignal): Promise<Uint8Array> {
    this.assertAlive();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const epoch = this.epoch, documentSignal = this.controller.signal;
    if (this.nativePaint && this.manifest?.display.orderedPages) {
      // The ordered painter owns its pre-admitted one-asset/page window. A
      // second post-fetch original LRU would double retention and can fail
      // admission after network allocation while the painter window is pinned.
      this.originals.clear();
      const bytes = await this.source.loadDisplayTile(tile, signal);
      if (signal.aborted || !this.current(epoch)) throw new DOMException("Aborted", "AbortError");
      if (bytes.byteLength !== tile.byteSize) throw new Error("Map display tile byte limit mismatch");
      return bytes;
    }
    const key = JSON.stringify([this.scopeKey, this.document?.generationId, tile.assetId, tile.sha256, tile.byteSize]);
    const result = await this.originals.getOrLoad(key, async () => {
      const bytes = await this.source.loadDisplayTile(tile, documentSignal);
      if (!this.current(epoch) || documentSignal.aborted) throw new DOMException("Aborted", "AbortError");
      if (bytes.byteLength !== tile.byteSize || bytes.byteLength > 16 * MiB) throw new Error("Map display tile byte limit mismatch");
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
      this.renderedCamera = this.camera;
      try { if (cadDisplayZoomBand(this.camera.zoom) !== this.draftBand) this.refreshDraft(); }
      catch (error) { this.onError(asError(error)); }
    });
  }

  private applyVisibility(dirty?: Bounds[]): void {
    const masks = new Set([...this.persisted.keys(), ...this.drafts.keys(), ...this.promoted]);
    const groupMasks = new Set<string>();
    const groups = new Map(this.manifest?.groups.map(group => [group.id, group]));
    for (const [id, group] of this.groups) { if (group) groups.set(id, group); else groups.delete(id); }
    for (const group of groups.values()) {
      let current: MapGroup | undefined = group;
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (!current.visible) { groupMasks.add(group.id); break; }
        current = current.parentId ? groups.get(current.parentId) : undefined;
      }
    }
    this.scene.setSelectionExclusion(masks, dirty, groupMasks);
    const layers = new Map(this.manifest?.layers.map(layer => [layer.id, layer]));
    for (const [id, layer] of this.layers) { if (layer) layers.set(id, layer); else layers.delete(id); }
    // Binding membership is immutable base metadata. Missing current layers
    // are retired, not editable tombstones and not malformed manifests.
    for (const id of this.displayLayerIds.values()) if (!layers.has(id)) {
      layers.set(id, { id, name: "", order: 0, visible: false, locked: true });
    }
    this.scene.setLayerStates(layers);
  }

  private visible(element: MapElement, groups = this.groups, layers = this.layers): boolean {
    if (!element.visible) return false;
    const layer = layers.has(element.layerId) ? layers.get(element.layerId) : this.manifest?.layers.find(value => value.id === element.layerId);
    if (!layer || !layer.visible) return false;
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

  private buildDraft(drafts = this.drafts, groups = this.groups, layers = this.layers): DecodedCadSceneTile<MapDisplayTile> | null {
    const elements = [...this.displayChanges(drafts).values()].filter((element): element is MapElement =>
      !!element && !this.promoted.has(element.id) && this.visible(element, groups, layers));
    if (!elements.length) return null;
    const band = cadDisplayZoomBand(this.camera?.zoom ?? 1);
    const geometry = buildMapGeometryBatches(elements, band, this.nativePaint);
    return { ...geometry, byteSize: geometry.memory.cpuBytes, descriptor: {
      version: 2, sceneId: this.document!.generationId, tileX: 0, tileY: 0, lod: 0, part: 0,
      assetId: "local-draft", sha256: "0".repeat(64), byteSize: geometry.memory.cpuBytes, primitiveCount: elements.length,
      bounds: { minX: 0, minY: 0, maxX: this.document!.width, maxY: this.document!.height }
    } };
  }

  private displayChanges(drafts = this.drafts): Map<string, MapElement | null> {
    const changes = new Map(this.persisted);
    for (const [id, element] of drafts) changes.set(id, element);
    return changes;
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

  private comparePaint(a: MapElement, b: MapElement): number {
    const ordinal = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    return this.layerOrder(a.layerId) - this.layerOrder(b.layerId) || ordinal(a.layerId, b.layerId) ||
      a.zIndex - b.zIndex || ordinal(a.id, b.id);
  }

  private current(epoch: number): boolean { return !this.disposed && epoch === this.epoch && this.source.scopeKey === this.scopeKey; }
  private assertAlive(): void {
    if (this.disposed) throw new Error("Map scene renderer is disposed");
    if (this.source.scopeKey !== this.scopeKey) throw new Error("Map source scope changed; dispose the old renderer first");
  }
}

function serializedBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error("Map scene rendering failed"); }
function sameCamera(a: CadSceneCamera | null, b: CadSceneCamera): boolean {
  return !!a && a.centerX === b.centerX && a.centerY === b.centerY && a.zoom === b.zoom &&
    a.viewportWidth === b.viewportWidth && a.viewportHeight === b.viewportHeight;
}
function operationKey(operation: MapOp): string {
  if (operation.kind === "add" || operation.kind === "update") return `element:${operation.element.id}`;
  if (operation.kind === "delete") return `element:${operation.id}`;
  if (operation.kind === "group.put") return `group:${operation.group.id}`;
  if (operation.kind === "layer.put") return `layer:${operation.layer.id}`;
  return `${operation.kind === "group.delete" ? "group" : "layer"}:${operation.id}`;
}

function emptyDisplay(ref?: MapDocumentRef): MapDisplayManifest {
  return { version: 2, sceneId: ref?.generationId ?? "empty", regionId: "empty", manifestAssetId: "empty",
    width: ref?.width ?? 1024, height: ref?.height ?? 1024, gridSize: ref?.gridSize ?? 50, padding: 0,
    tileSize: 512, lodMode: "additive", primitiveCount: 0, tileCount: 0, byteSize: 0, sha256: "0".repeat(64),
    sourceBounds: { minX: 0, minY: 0, maxX: ref?.width ?? 1024, maxY: ref?.height ?? 1024 },
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [] };
}
