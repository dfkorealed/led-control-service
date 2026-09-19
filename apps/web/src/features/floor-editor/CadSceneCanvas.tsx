import type {
  CadBounds,
  CadSceneDescriptor,
  CadSceneManifest,
  CadSceneState,
  CadSceneTile
} from "@led-control/shared";
import { TriangleAlert } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref
} from "react";
import {
  CadSceneRenderer,
  type CadScenePickResult,
  type CadSceneRendererOptions
} from "../cad-scene/CadSceneRenderer";
import { createCadSceneWorkerClient, type CadSceneWorkerClient, type DecodedCadSceneTile } from "../cad-scene/cad-scene-worker";
import { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import { getCadSceneManifest, getCadSceneTile } from "../../api/floor-editor";
import { themeColor } from "../../components/ui/utils/theme-color";
import { Button, FeedbackState } from "../../components/ui";
import {
  createCadOverrideWorker,
  editableElementDisplayBounds,
  editorTransformToCadCamera,
  estimateCadEditableElementBytes,
  findCadEditableElement,
  mergeCadEditableElements,
  pickPersistedCadElement,
  resolveCadTileContentPath,
  transformCadBounds,
  type CadEditableElement
} from "./cad-editor-runtime";
import type { CadEditorSelection } from "./editor-types";
import type { Point } from "./geometry";

const DEFAULT_EDITOR_DECODED_CACHE_BYTES = 32 * 1_024 * 1_024;

export interface CadSceneRendererLike {
  mount(canvas: HTMLCanvasElement): Promise<void>;
  setCamera(camera: ReturnType<typeof editorTransformToCadCamera>): Promise<void>;
  pick(point: Point): CadScenePickResult | null;
  pickExact?(point: Point, options?: { radiusPixels?: number }): Promise<CadScenePickResult | null>;
  registerSourceBounds?(elementId: string, bounds: CadBounds): void;
  setSelectionExclusion(ids: ReadonlySet<string>): void;
  setLayerStates(states: ReadonlyMap<string, { visible: boolean }>): void;
  destroy(): void;
}

export interface CadSceneCanvasHandle {
  pick(point: Point, mode: "group" | "element"): Promise<CadEditorSelection | null>;
}

interface CadSceneCanvasProps {
  descriptor: CadSceneDescriptor;
  sceneState: CadSceneState;
  pan: Point;
  zoom: number;
  viewport: { width: number; height: number };
  selection: CadEditorSelection | null;
  onSelectionChange: (selection: CadEditorSelection | null) => void;
  onError?: (error: Error) => void;
  loadManifest?: (path: CadSceneDescriptor["manifestContentPath"], signal?: AbortSignal) => Promise<CadSceneManifest>;
  loadTile?: (path: string, signal?: AbortSignal) => Promise<Uint8Array>;
  createRenderer?: (options: CadSceneRendererOptions) => CadSceneRendererLike;
  createWorker?: () => CadSceneWorkerClient;
  decodedCacheMaximumBytes?: number;
}

interface DecodedEntry {
  tile: DecodedCadSceneTile;
  bytes: number;
  lastUsed: number;
}

export class CadDecodedTileStore {
  private static sequence = 0;
  private readonly entries = new Map<string, DecodedEntry>();
  private readonly elements = new Map<string, CadEditableElement>();
  private readonly owner = `editor-${++CadDecodedTileStore.sequence}`;

  constructor(
    readonly budget: CadSceneMemoryBudget,
    private readonly onElementEvicted: () => void = () => undefined
  ) {}

  get totalBytes() {
    return this.budget.totalBytes;
  }

  get(descriptor: CadSceneTile) {
    const entry = this.entries.get(tileKey(descriptor));
    if (!entry) return undefined;
    this.budget.touch(this.owner, `tile:${tileKey(descriptor)}`);
    return entry.tile;
  }

  set(tile: DecodedCadSceneTile) {
    const key = tileKey(tile.descriptor);
    const bytes = Math.max(1, tile.memory.cpuBytes);
    if (!this.budget.reserve(this.owner, `tile:${key}`, bytes, () => this.entries.delete(key))) return false;
    this.entries.set(key, { tile, bytes, lastUsed: 0 });
    return true;
  }

  values() {
    return [...this.entries.values()].map((entry) => entry.tile).values();
  }

  getElement(elementId: string) {
    const element = this.elements.get(elementId);
    if (element) this.budget.touch(this.owner, `element:${elementId}`);
    return element;
  }

  setElement(element: CadEditableElement) {
    const key = element.elementId;
    if (!this.budget.reserve(
      this.owner,
      `element:${key}`,
      estimateCadEditableElementBytes(element),
      () => {
        if (this.elements.delete(key)) this.onElementEvicted();
      }
    )) return false;
    this.elements.set(key, element);
    return true;
  }

  deleteElement(elementId: string) {
    const deleted = this.elements.delete(elementId);
    this.budget.release(this.owner, `element:${elementId}`);
    return deleted;
  }

  elementValues() {
    return this.elements.values();
  }

  pinElements(predicate: (element: CadEditableElement) => boolean) {
    for (const element of this.elements.values()) {
      this.budget.setPinned(this.owner, `element:${element.elementId}`, predicate(element));
    }
  }

  get elementCount() {
    return this.elements.size;
  }

  clear() {
    this.entries.clear();
    this.elements.clear();
    this.budget.releaseOwner(this.owner);
  }
}

const ignoreCadSceneError = () => undefined;
const createDefaultCadSceneRenderer = (options: CadSceneRendererOptions) => new CadSceneRenderer(options);
const createDefaultWorker = () => createCadSceneWorkerClient();

function CadSceneCanvasComponent({
  descriptor,
  sceneState,
  pan,
  zoom,
  viewport,
  selection,
  onSelectionChange,
  onError = ignoreCadSceneError,
  loadManifest = getCadSceneManifest,
  loadTile = getCadSceneTile,
  createRenderer = createDefaultCadSceneRenderer,
  createWorker = createDefaultWorker,
  decodedCacheMaximumBytes = DEFAULT_EDITOR_DECODED_CACHE_BYTES
}: CadSceneCanvasProps, ref: Ref<CadSceneCanvasHandle>) {
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const movedCanvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CadSceneRendererLike | null>(null);
  const manifestRef = useRef<CadSceneManifest | null>(null);
  const lookupWorkerRef = useRef<CadSceneWorkerClient | null>(null);
  const sceneAbortRef = useRef<AbortController | null>(null);
  const [elementIndexRevision, setElementIndexRevision] = useState(0);
  const [hasRenderError, setHasRenderError] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const reportError = useCallback((error: Error) => {
    setHasRenderError(true);
    onError(error);
  }, [onError]);
  const memoryBudgetRef = useRef<CadSceneMemoryBudget | null>(null);
  if (!memoryBudgetRef.current) memoryBudgetRef.current = new CadSceneMemoryBudget(decodedCacheMaximumBytes);
  const decodedTiles = useRef<CadDecodedTileStore | null>(null);
  if (!decodedTiles.current) {
    decodedTiles.current = new CadDecodedTileStore(
      memoryBudgetRef.current,
      () => setElementIndexRevision(value => value + 1)
    );
  }
  const decodedPendingRef = useRef(new Map<string, Promise<DecodedCadSceneTile | null>>());
  const overrides = useMemo(
    () => new Map(sceneState.overrides.map((override) => [override.elementId, override])),
    [sceneState.overrides]
  );
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const cameraRef = useRef(editorTransformToCadCamera(pan, zoom, viewport));
  cameraRef.current = editorTransformToCadCamera(pan, zoom, viewport);
  const pickRequestRef = useRef(0);
  const pickContext = useMemo(() => ({}), [descriptor.id, sceneState.revision, pan.x, pan.y, zoom, viewport.width, viewport.height]);
  const pickContextRef = useRef(pickContext);
  pickContextRef.current = pickContext;
  const transformRef = useRef({ pan, zoom });
  transformRef.current = { pan, zoom };
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const layerVisibility = useMemo(
    () => new Map(sceneState.layers.map(layer => [layer.layerName, layer.visible])),
    [sceneState.layers]
  );
  const layerVisibilityRef = useRef(layerVisibility);
  layerVisibilityRef.current = layerVisibility;
  const isLayerVisible = useCallback(
    (layerName: string) => layerVisibilityRef.current.get(layerName) !== false,
    []
  );

  const exclusionIds = useCallback(() => {
    const ids = new Set([...decodedTiles.current!.elementValues()].map(element => element.elementId));
    const currentSelection = selectionRef.current;
    if (currentSelection?.mode === "element" && currentSelection.element) ids.add(currentSelection.targetId);
    return ids;
  }, []);

  const syncExclusion = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    for (const element of decodedTiles.current!.elementValues()) {
      renderer.registerSourceBounds?.(element.elementId, element.bounds);
    }
    const selected = selectionRef.current;
    if (selected?.mode === "element" && selected.element) {
      renderer.registerSourceBounds?.(selected.element.elementId, selected.element.bounds);
    }
    renderer.setSelectionExclusion(exclusionIds());
  }, [exclusionIds]);

  const rememberDecoded = useCallback((tile: DecodedCadSceneTile) => {
    decodedTiles.current!.set(tile);
    let changed = false;
    const elementIds = new Set(tile.pickEntries.map(entry => entry.elementId));
    for (const elementId of elementIds) {
      const override = overridesRef.current.get(elementId);
      if (!override) continue;
      if (!override.transform) continue;
      const next = findCadEditableElement(
        uniqueDecodedTiles(tile, decodedTiles.current!.values()),
        elementId,
        overridesRef.current,
        override.locator ?? undefined
      );
      if (!next) continue;
      changed = decodedTiles.current!.setElement(
        mergeCadEditableElements(decodedTiles.current!.getElement(elementId), next)
      ) || changed;
    }
    if (changed) {
      setElementIndexRevision((value) => value + 1);
      syncExclusion();
    }
  }, [syncExclusion]);

  const loadDecodedTile = useCallback(async (tile: CadSceneTile) => {
    const cached = decodedTiles.current!.get(tile);
    if (cached) return cached;
    const key = tileKey(tile);
    const pending = decodedPendingRef.current.get(key);
    if (pending) return pending;
    const worker = lookupWorkerRef.current;
    const signal = sceneAbortRef.current?.signal;
    if (!worker || !signal || signal.aborted) return null;
    const request = (async () => {
      const payload = await loadTile(resolveCadTileContentPath(descriptor.tileContentPathTemplate, tile), signal);
      if (signal.aborted) return null;
      const decoded = await worker.decode(payload, tile);
      if (signal.aborted) return null;
      rememberDecoded(decoded);
      return decoded;
    })().finally(() => decodedPendingRef.current.delete(key));
    decodedPendingRef.current.set(key, request);
    return request;
  }, [descriptor.tileContentPathTemplate, loadTile, rememberDecoded]);

  const collectElement = useCallback(async (elementId: string, seed?: DecodedCadSceneTile) => {
    const initial = findCadEditableElement(
      seed ? uniqueDecodedTiles(seed, decodedTiles.current!.values()) : decodedTiles.current!.values(),
      elementId,
      overridesRef.current,
      overridesRef.current.get(elementId)?.locator ?? undefined
    );
    if (!initial) return decodedTiles.current!.getElement(elementId) ?? null;
    const manifest = manifestRef.current;
    if (!manifest) return initial;
    const collected = new Map<string, DecodedCadSceneTile>();
    const queue: DecodedCadSceneTile[] = [];
    for (const tile of seed ? uniqueDecodedTiles(seed, decodedTiles.current!.values()) : decodedTiles.current!.values()) {
      if (tile.pickEntries.some((entry) => entry.elementId === elementId) && tile.descriptor.lod === initial.locator.lod) {
        collected.set(tileKey(tile.descriptor), tile);
        queue.push(tile);
      }
    }
    const attempted = new Set(collected.keys());
    while (queue.length > 0) {
      const current = queue.shift()!;
      const entry = current.pickEntries.find((candidate) => candidate.elementId === elementId);
      if (!entry) continue;
      const cells = connectedCells(current.descriptor, entry.bounds);
      const candidates = manifest.tiles.filter((candidate) => candidate.lod === current.descriptor.lod &&
        cells.some((cell) => cell.x === candidate.tileX && cell.y === candidate.tileY));
      for (const candidate of candidates) {
        const key = tileKey(candidate);
        if (attempted.has(key)) continue;
        attempted.add(key);
        const decoded = await loadDecodedTile(candidate);
        if (decoded?.pickEntries.some((item) => item.elementId === elementId)) {
          collected.set(key, decoded);
          queue.push(decoded);
        }
      }
    }
    const result = findCadEditableElement(collected.values(), elementId, overridesRef.current, initial.locator);
    if (result?.override?.transform) {
      if (decodedTiles.current!.setElement(
        mergeCadEditableElements(decodedTiles.current!.getElement(elementId), result)
      )) {
        setElementIndexRevision((value) => value + 1);
        syncExclusion();
      }
    }
    return result;
  }, [loadDecodedTile, syncExclusion]);

  const preloadMovedOverrides = useCallback(async (manifest: CadSceneManifest, camera = cameraRef.current) => {
    const tilesByLocator = new Map(manifest.tiles.map(tile => [locatorKey(tile), tile]));
    const viewportBounds = cameraWorldBounds(camera);
    decodedTiles.current!.pinElements(element =>
      !element.override?.hidden && isLayerVisible(element.layerName) &&
      boundsIntersect(editableElementDisplayBounds(element), viewportBounds));
    const jobs = sceneState.overrides.flatMap(override => {
      if (!override.transform || override.hidden || !override.locator) return [];
      const tile = tilesByLocator.get(locatorKey(override.locator));
      if (!tile) return [];
      const destinationBounds = transformCadBounds(tile.bounds, override.transform);
      if (!boundsIntersect(destinationBounds, viewportBounds)) return [];
      return [{
        elementId: override.elementId,
        tile,
        priority: boundsCenterDistance(destinationBounds, camera.centerX, camera.centerY)
      }];
    }).sort((left, right) => left.priority - right.priority);

    await runBounded(jobs, 2, async job => {
      const decoded = await loadDecodedTile(job.tile);
      if (decoded) await collectElement(job.elementId, decoded);
    });
    const latestViewportBounds = cameraWorldBounds(cameraRef.current);
    decodedTiles.current!.pinElements(element =>
      !element.override?.hidden && isLayerVisible(element.layerName) &&
      boundsIntersect(editableElementDisplayBounds(element), latestViewportBounds));
  }, [collectElement, isLayerVisible, loadDecodedTile, sceneState.overrides]);

  useImperativeHandle(ref, () => ({
    async pick(point, mode) {
      const request = ++pickRequestRef.current;
      const context = pickContextRef.current;
      const renderer = rendererRef.current;
      const signal = sceneAbortRef.current?.signal;
      const isCurrent = () => request === pickRequestRef.current && context === pickContextRef.current &&
        renderer === rendererRef.current && !signal?.aborted;
      const { pan: currentPan, zoom: currentZoom } = transformRef.current;
      const world = { x: (point.x - currentPan.x) / currentZoom, y: (point.y - currentPan.y) / currentZoom };
      const persisted = pickPersistedCadElement(
        decodedTiles.current!.elementValues(),
        world,
        8 / currentZoom,
        isLayerVisible
      );
      let picked: CadScenePickResult | null = null;
      try {
        picked = persisted ? {
          elementId: persisted.elementId,
          groupId: persisted.groupId,
          layerName: persisted.layerName
        } : renderer?.pickExact ? await renderer.pickExact(point) : renderer?.pick(point) ?? null;
        // Exact picks load source tiles asynchronously. Do not let an earlier
        // click, camera, or disposed scene overwrite the user's current selection.
        if (!isCurrent()) return null;
        if (!picked) {
          onSelectionChange(null);
          return null;
        }
        if (mode === "group" && picked.groupId) {
          const next: CadEditorSelection = {
            mode: "group",
            targetId: picked.groupId,
            elementId: picked.elementId,
            groupId: picked.groupId,
            layerName: picked.layerName
          };
          onSelectionChange(next);
          return next;
        }
        const element = persisted ?? await collectElement(picked.elementId, picked.sourceTile);
        if (!isCurrent()) return null;
        if (!element) {
          onSelectionChange(null);
          return null;
        }
        const next: CadEditorSelection = { mode: "element", targetId: picked.elementId, element };
        onSelectionChange(next);
        return next;
      } catch (error) {
        if (isCurrent()) reportError(error instanceof Error ? error : new Error("CAD 요소를 선택하지 못했습니다."));
        return null;
      } finally {
        // The renderer pins only the winning exact source seed during promotion.
        // Release on every path, including stale results and failed collection.
        picked?.releaseSourceTile?.();
      }
    }
  }), [collectElement, isLayerVisible, onSelectionChange, reportError]);

  useEffect(() => () => {
    decodedPendingRef.current.clear();
    decodedTiles.current!.clear();
  }, [descriptor.id]);

  useEffect(() => {
    const valid = new Set<string>();
    let changed = false;
    for (const override of sceneState.overrides) {
      if (!override.transform) continue;
      valid.add(override.elementId);
      const existing = decodedTiles.current!.getElement(override.elementId);
      if (existing) {
        decodedTiles.current!.setElement({ ...existing, override });
        changed = true;
      }
    }
    for (const element of [...decodedTiles.current!.elementValues()]) {
      const id = element.elementId;
      if (!valid.has(id)) {
        decodedTiles.current!.deleteElement(id);
        changed = true;
      }
    }
    if (changed) setElementIndexRevision((value) => value + 1);
    syncExclusion();
  }, [sceneState.overrides, syncExclusion]);

  const hasViewport = viewport.width > 0 && viewport.height > 0;
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host || !hasViewport) return;
    setHasRenderError(false);
    // Pixi destroy()는 WebGL context를 폐기한다. 같은 canvas를 다시 init하면
    // 잃어버린 context의 shader 검사에서 멈출 수 있어 effect마다 새 표면을 소유한다.
    const canvas = document.createElement("canvas");
    canvas.className = "h-full w-full";
    canvas.width = Math.max(1, cameraRef.current.viewportWidth);
    canvas.height = Math.max(1, cameraRef.current.viewportHeight);
    canvas.setAttribute("aria-hidden", "true");
    canvas.dataset.testid = "cad-scene-canvas";
    canvas.dataset.sceneId = descriptor.id;
    host.appendChild(canvas);
    const controller = new AbortController();
    sceneAbortRef.current?.abort();
    sceneAbortRef.current = controller;
    let disposed = false;
    let renderer: CadSceneRendererLike | null = null;
    const lookupWorker = createWorker();
    lookupWorkerRef.current = lookupWorker;

    void loadManifest(descriptor.manifestContentPath, controller.signal).then(async (manifest) => {
      if (disposed) return;
      assertMatchingManifest(descriptor, manifest);
      manifestRef.current = manifest;
      const worker = createCadOverrideWorker(createWorker(), () => overridesRef.current, rememberDecoded);
      renderer = createRenderer({
        manifest,
        worker,
        displayQuality: true,
        memoryBudget: memoryBudgetRef.current!,
        loadTile: (tile, signal) => loadTile(resolveCadTileContentPath(descriptor.tileContentPathTemplate, tile), signal),
        onError: error => { if (!controller.signal.aborted) reportError(error); }
      });
      await renderer.mount(canvas);
      if (disposed) return;
      rendererRef.current = renderer;
      renderer.setLayerStates(new Map(sceneState.layers.map((layer) => [layer.layerName, { visible: layer.visible }])));
      syncExclusion();
      await preloadMovedOverrides(manifest, cameraRef.current);
      await renderer.setCamera(cameraRef.current);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) reportError(error instanceof Error ? error : new Error("CAD 장면을 불러오지 못했습니다."));
    });

    return () => {
      disposed = true;
      controller.abort();
      if (sceneAbortRef.current === controller) sceneAbortRef.current = null;
      if (rendererRef.current === renderer) rendererRef.current = null;
      renderer?.destroy();
      canvas.remove();
      if (lookupWorkerRef.current === lookupWorker) lookupWorkerRef.current = null;
      lookupWorker.destroy();
      if (manifestRef.current?.sceneId === descriptor.id) manifestRef.current = null;
    };
  }, [createRenderer, createWorker, descriptor.id, descriptor.manifestContentPath, descriptor.tileContentPathTemplate,
    descriptor.version, exclusionIds, hasViewport, loadManifest, loadTile, reportError, retryVersion, preloadMovedOverrides, rememberDecoded,
    sceneState.layers, sceneState.revision, syncExclusion]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || viewport.width <= 0 || viewport.height <= 0) return;
    const signal = sceneAbortRef.current?.signal;
    let current = true;
    const camera = editorTransformToCadCamera(pan, zoom, viewport);
    const manifest = manifestRef.current;
    void (manifest ? preloadMovedOverrides(manifest, camera) : Promise.resolve()).then(() => {
      if (!current || signal?.aborted) return;
      return renderer.setCamera(camera);
    }).then(() => {
      if (!current || signal?.aborted) return;
      const manifest = manifestRef.current;
      if (manifest) decodedTiles.current!.pinElements(element =>
        !element.override?.hidden && isLayerVisible(element.layerName) &&
        boundsIntersect(editableElementDisplayBounds(element), cameraWorldBounds(camera)));
    }).catch((error: unknown) => {
      if (current && !signal?.aborted) {
        reportError(error instanceof Error ? error : new Error("CAD 카메라를 갱신하지 못했습니다."));
      }
    });
    return () => { current = false; };
  }, [isLayerVisible, reportError, pan.x, pan.y, preloadMovedOverrides, viewport.height, viewport.width, zoom]);

  useEffect(() => {
    syncExclusion();
  }, [elementIndexRevision, selection?.mode, selection?.targetId, syncExclusion]);

  useEffect(() => {
    rendererRef.current?.setLayerStates(new Map(
      sceneState.layers.map((layer) => [layer.layerName, { visible: layer.visible }])
    ));
  }, [sceneState.layers]);

  useEffect(() => {
    drawPersistedElements(
      movedCanvasRef.current,
      decodedTiles.current!.elementValues(),
      selection,
      pan,
      zoom,
      viewport,
      isLayerVisible
    );
  }, [elementIndexRevision, isLayerVisible, layerVisibility, pan.x, pan.y, selection, viewport.height, viewport.width, zoom]);

  return (
    <>
      {hasRenderError ? <div className="absolute left-3 right-3 top-3 z-2">
        <FeedbackState tone="danger" icon={TriangleAlert} title="CAD 맵을 표시하지 못했습니다."
          action={<Button size="sm" variant="secondary" onClick={() => setRetryVersion(value => value + 1)}>CAD 맵 다시 시도</Button>} />
      </div> : null}
      <div ref={canvasHostRef} className="pointer-events-none absolute inset-0 z-0 h-full w-full" />
      <canvas ref={movedCanvasRef} className="pointer-events-none absolute inset-0 z-0 h-full w-full"
        width={Math.max(1, viewport.width)} height={Math.max(1, viewport.height)} aria-hidden="true"
        data-testid="cad-moved-elements-canvas" data-element-count={decodedTiles.current!.elementCount}
        data-visible-element-count={[...decodedTiles.current!.elementValues()].filter(element =>
          !element.override?.hidden && isLayerVisible(element.layerName)).length} />
    </>
  );
}

export const CadSceneCanvas = forwardRef(CadSceneCanvasComponent);

function tileKey(tile: CadSceneTile) {
  return `${tile.sceneId}:${tile.lod}:${tile.tileX}:${tile.tileY}:${tile.part}`;
}

function uniqueDecodedTiles(seed: DecodedCadSceneTile, tiles: Iterable<DecodedCadSceneTile>) {
  const unique = new Map<string, DecodedCadSceneTile>();
  for (const tile of tiles) unique.set(tileKey(tile.descriptor), tile);
  unique.set(tileKey(seed.descriptor), seed);
  return unique.values();
}

function locatorKey(locator: { lod: number; tileX: number; tileY: number; part: number }) {
  return `${locator.lod}:${locator.tileX}:${locator.tileY}:${locator.part}`;
}

function cameraWorldBounds(camera: ReturnType<typeof editorTransformToCadCamera>) {
  const halfWidth = camera.viewportWidth / (2 * camera.zoom);
  const halfHeight = camera.viewportHeight / (2 * camera.zoom);
  return {
    minX: camera.centerX - halfWidth,
    minY: camera.centerY - halfHeight,
    maxX: camera.centerX + halfWidth,
    maxY: camera.centerY + halfHeight
  };
}

function boundsIntersect(left: { minX: number; minY: number; maxX: number; maxY: number }, right: typeof left) {
  return left.maxX >= right.minX && left.minX <= right.maxX && left.maxY >= right.minY && left.minY <= right.maxY;
}

function boundsCenterDistance(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  centerX: number,
  centerY: number
) {
  return Math.hypot((bounds.minX + bounds.maxX) / 2 - centerX, (bounds.minY + bounds.maxY) / 2 - centerY);
}

async function runBounded<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await task(item);
    }
  }));
}

function assertMatchingManifest(descriptor: CadSceneDescriptor, manifest: CadSceneManifest) {
  if (manifest.sceneId !== descriptor.id || manifest.version !== descriptor.version ||
      manifest.width !== descriptor.width || manifest.height !== descriptor.height ||
      manifest.manifestAssetId !== descriptor.manifestAssetId) {
    throw new Error("CAD manifest가 현재 층 scene과 일치하지 않습니다.");
  }
}

function connectedCells(tile: CadSceneTile, bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
  const cells = [{ x: tile.tileX, y: tile.tileY }];
  const epsilon = 0.5;
  if (bounds.minX <= tile.bounds.minX + epsilon && tile.tileX > 0) cells.push({ x: tile.tileX - 1, y: tile.tileY });
  if (bounds.maxX >= tile.bounds.maxX - epsilon) cells.push({ x: tile.tileX + 1, y: tile.tileY });
  if (bounds.minY <= tile.bounds.minY + epsilon && tile.tileY > 0) cells.push({ x: tile.tileX, y: tile.tileY - 1 });
  if (bounds.maxY >= tile.bounds.maxY - epsilon) cells.push({ x: tile.tileX, y: tile.tileY + 1 });
  return cells;
}

function drawPersistedElements(
  canvas: HTMLCanvasElement | null,
  elements: Iterable<CadEditableElement>,
  selection: CadEditorSelection | null,
  pan: Point,
  zoom: number,
  viewport: { width: number; height: number },
  isLayerVisible: (layerName: string) => boolean
) {
  if (!canvas) return;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext("2d");
  } catch {
    return;
  }
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.setTransform(zoom, 0, 0, zoom, pan.x, pan.y);
  for (const element of elements) {
    if (element.override?.hidden || !isLayerVisible(element.layerName) ||
        selection?.mode === "element" && selection.targetId === element.elementId) continue;
    const bounds = editableElementDisplayBounds(element);
    if (bounds.maxX * zoom + pan.x < 0 || bounds.minX * zoom + pan.x > viewport.width ||
        bounds.maxY * zoom + pan.y < 0 || bounds.minY * zoom + pan.y > viewport.height) continue;
    drawPersistedElement(context, element);
  }
  context.restore();
}

function drawPersistedElement(context: CanvasRenderingContext2D, element: CadEditableElement) {
  const override = element.override;
  const transform = override?.transform;
  if (!transform) return;
  const radians = transform.rotation * Math.PI / 180;
  context.save();
  context.transform(
    Math.cos(radians) * transform.scaleX,
    Math.sin(radians) * transform.scaleX,
    -Math.sin(radians) * transform.scaleY,
    Math.cos(radians) * transform.scaleY,
    transform.translateX,
    transform.translateY
  );
  context.strokeStyle = override?.strokeColor ?? element.strokeColor ?? themeColor("fixture-editor-selected");
  context.fillStyle = override?.fillColor ?? element.fillColor ?? "transparent";
  context.lineWidth = override?.strokeWidth ?? element.strokeWidth;
  if (element.text !== null && element.textGeometry) {
    context.save();
    context.translate(element.textGeometry.position.x, element.textGeometry.position.y);
    context.rotate(element.textGeometry.rotation * Math.PI / 180);
    context.font = `${element.fontSize ?? element.textGeometry.height}px sans-serif`;
    context.textBaseline = "bottom";
    context.fillStyle = override?.strokeColor ?? element.strokeColor ?? themeColor("fixture-editor-label");
    context.fillText(override?.text ?? element.text, 0, 0, element.textGeometry.width);
    context.restore();
  } else {
    for (const fragment of element.fragments) {
      if (fragment.points.length < 2) continue;
      context.beginPath();
      context.moveTo(fragment.points[0].x, fragment.points[0].y);
      fragment.points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
      if (fragment.closed) context.closePath();
      if (fragment.closed && (override?.fillColor ?? element.fillColor)) context.fill();
      context.stroke();
    }
  }
  context.restore();
}
