import type { CadSceneManifest, CadSceneTile } from "@led-control/shared";
import { mapDocumentStateSchema, type MapDocumentRef, type MapElement } from "@led-control/shared/map-document-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CadSceneRenderBackend } from "../cad-scene/CadSceneRenderer";
import { buildCadGeometryBatches } from "../cad-scene/cad-scene-worker";
import { MapSceneRenderer } from "./MapSceneRenderer";
import type { MapSceneSource } from "./map-scene-source";

const ref: MapDocumentRef = { formatVersion: 1, generationId: "generation-a", revision: 0,
  width: 1536, height: 1024, gridSize: 50, elementCount: 2,
  manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 100 } };
const camera = { centerX: 512, centerY: 256, zoom: 1, viewportWidth: 1024, viewportHeight: 512 };
const tile = (x: number): CadSceneTile => ({ version: 1, sceneId: "display", tileX: x, tileY: 0, lod: 0, part: 0,
  assetId: `asset-${x}`, sha256: `${x}`.repeat(64), byteSize: 1, primitiveCount: 1,
  bounds: { minX: x * 512, minY: 0, maxX: (x + 1) * 512, maxY: 512 } });
const display: CadSceneManifest = { version: 1, sceneId: "display", regionId: "region", manifestAssetId: "manifest",
  width: 1536, height: 1024, padding: 0, gridSize: 50, tileSize: 512, lodMode: "additive", primitiveCount: 2,
  tileCount: 2, byteSize: 2, sha256: "a".repeat(64), sourceBounds: { minX: 0, minY: 0, maxX: 1536, maxY: 1024 },
  transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [tile(0), tile(2)] };
const shape = (id = "element-0"): Extract<MapElement, { type: "rectangle" }> => ({ id, type: "rectangle",
  geometry: { origin: { x: 10, y: 10 }, width: 20, height: 20 },
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  style: { strokeColor: null, fillColor: "#00ff00", strokeWidth: 0, opacity: 1 },
  groupId: null, layerId: "walls", zIndex: 0, visible: true, locked: false, provenance: null });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); });

function harness(sourcePatch: Partial<MapSceneSource> = {}, maximumMemoryBytes?: number, maximumOriginalBytes?: number) {
  let frame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frame, callback); return frame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const flush = async () => {
    for (let i = 0; i < 30; i++) {
      const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(0));
      await Promise.resolve();
    }
  };
  const backend: CadSceneRenderBackend = { mount: vi.fn(async () => {}), resize: vi.fn(), setCamera: vi.fn(),
    replaceTile: vi.fn(), removeTile: vi.fn(), suspend: vi.fn(), render: vi.fn(), destroy: vi.fn() };
  const source: MapSceneSource = {
    scopeKey: "tenant:floor:user",
    getChanges: vi.fn(async document => ({ generationId: document.generationId, revision: document.revision, operations: [], nextCursor: null })),
    getManifest: vi.fn(async document => ({ generationId: document.generationId, revision: document.revision,
      canonical: document.manifest, display, displayLayerBindings: [{ layerName: "walls", layerId: "walls" }],
      groups: [], layers: [{ id: "walls", name: "Walls", order: 0, visible: true, locked: false }] })),
    loadDisplayTile: vi.fn(async descriptor => new Uint8Array([descriptor.tileX])),
    getElements: vi.fn(async (_document: MapDocumentRef, ids: readonly string[]) => ids.map(id => shape(id))),
    decodeDisplayTile: vi.fn(async (_bytes, descriptor, quality) => ({ descriptor, byteSize: 1,
      ...buildCadGeometryBatches([{ type: "rectangle", elementId: `element-${descriptor.tileX}`, groupId: null,
        layerName: "walls", sourceType: "rectangle", bounds: { minX: 10 + descriptor.tileX * 512, minY: 10, maxX: 30 + descriptor.tileX * 512, maxY: 30 },
        clipBounds: null, style: shape().style, geometry: { origin: { x: 10 + descriptor.tileX * 512, y: 10 }, width: 20, height: 20, rotation: 0 } }], quality) })),
    ...sourcePatch
  };
  const onError = vi.fn();
  const onDegraded = vi.fn();
  const renderer = new MapSceneRenderer({ source, backendFactory: () => backend, maximumMemoryBytes, maximumOriginalBytes, onError, onDegraded });
  const canvas = document.createElement("canvas");
  disposals.push(() => renderer.dispose());
  const start = async () => { await renderer.mount(canvas); await renderer.setDocument(ref); renderer.setCamera(camera); await flush(); };
  return { renderer, source, backend, flush, start, canvas, onError, onDegraded };
}

function collisionHarness() {
  const h = harness();
  const group = { id: "shared", parentId: null, name: "Shared", visible: true, locked: false };
  const elements = [shape("shared"), { ...shape("member"), groupId: group.id,
    geometry: { origin: { x: 110, y: 10 }, width: 20, height: 20 } }];
  const getManifest = vi.mocked(h.source.getManifest).getMockImplementation()!;
  vi.mocked(h.source.getManifest).mockImplementation(async (...args) => {
    const manifest = await getManifest(...args);
    mapDocumentStateSchema.parse({ elements, groups: [group], layers: manifest.layers });
    return { ...manifest, groups: [group], display: { ...display, tiles: [tile(0)] } };
  });
  vi.mocked(h.source.decodeDisplayTile!).mockImplementation(async (_bytes, descriptor, quality) => ({ descriptor, byteSize: 1,
    ...buildCadGeometryBatches(elements.map(element => ({ type: "rectangle", elementId: element.id, groupId: element.groupId,
      layerName: "walls", sourceType: "rectangle", clipBounds: null, style: element.style,
      bounds: { minX: element.geometry.origin.x, minY: 10, maxX: element.geometry.origin.x + 20, maxY: 30 },
      geometry: { ...element.geometry, rotation: 0 } })), quality) }));
  vi.mocked(h.source.getElements).mockImplementation(async (_document, ids) => elements.filter(element => ids.includes(element.id)));
  return { ...h, group };
}

describe("bounded common map renderer", () => {
  it("keeps an in-flight pick valid when a frame re-applies the identical visible camera", async () => {
    const h = harness(); await h.start();
    const lookup = deferred<readonly MapElement[]>();
    vi.mocked(h.source.getElements).mockReturnValueOnce(lookup.promise);
    const pick = h.renderer.pick({ x: 20, y: 20 }); await h.flush();
    h.renderer.setCamera({ ...camera }); await h.flush();
    lookup.resolve([shape()]);
    expect((await pick)?.element.id).toBe("element-0");
  });

  it("coalesces a host reference refresh with the in-flight ACK instead of losing its pruning boundary", async () => {
    const h = harness(); await h.start();
    h.renderer.applyChanges([{ kind: "add", element: shape("saved") }], []);
    const through = h.renderer.getDraftVersion();
    const page = deferred<Awaited<ReturnType<MapSceneSource["getChanges"]>>>();
    vi.mocked(h.source.getChanges).mockReturnValue(page.promise);
    const next = { ...ref, revision: 1 };
    const ack = h.renderer.acknowledge(next, through); await h.flush();
    const refresh = h.renderer.setDocument(next); await h.flush();
    page.resolve({ generationId: ref.generationId, revision: 1, operations: [], nextCursor: null });
    await ack; await refresh;
    // The fresh server contains no `saved`: if ACK pruning was superseded by
    // the prop effect, the stale local element incorrectly survives here.
    vi.mocked(h.source.getElements).mockResolvedValue([]);
    expect(await h.renderer.getElements(["saved"])).toEqual([]);
  });

  it("keeps the adopted reference after a rejected refresh and releases in-flight reservations on disposal", async () => {
    const h = harness(); await h.start();
    vi.mocked(h.source.getChanges).mockRejectedValueOnce(new Error("offline"));
    await expect(h.renderer.setDocument({ ...ref, revision: 1 })).rejects.toThrow("offline");
    await h.renderer.getElements(["element-0"]);
    expect(h.source.getElements).toHaveBeenLastCalledWith(ref, ["element-0"], expect.any(AbortSignal));
    const page = deferred<Awaited<ReturnType<MapSceneSource["getChanges"]>>>();
    vi.mocked(h.source.getChanges).mockResolvedValueOnce({ generationId: ref.generationId, revision: 1,
      operations: [{ kind: "add", element: shape("staged") }], nextCursor: "next" }).mockReturnValueOnce(page.promise);
    const pending = h.renderer.setDocument({ ...ref, revision: 1 }); await h.flush();
    h.renderer.dispose();
    expect(h.renderer.memoryBytes).toBe(0);
    page.resolve({ generationId: ref.generationId, revision: 1, operations: [], nextCursor: null });
    await pending;
  });

  it("rejects cursor cycles and mismatched revisions without acknowledging unsaved edits", async () => {
    const h = harness(); await h.start();
    h.renderer.applyChanges([{ kind: "delete", id: "element-0" }], [tile(0).bounds]);
    vi.mocked(h.source.getChanges).mockImplementation(async document => ({ generationId: document.generationId,
      revision: document.revision, operations: [], nextCursor: "cycle" }));
    await expect(h.renderer.acknowledge({ ...ref, revision: 1 }, h.renderer.getDraftVersion())).rejects.toThrow("cursor cycle");
    expect(await h.renderer.getElements(["element-0"])).toEqual([]);
    vi.mocked(h.source.getChanges).mockResolvedValue({ generationId: ref.generationId, revision: 0, operations: [], nextCursor: null });
    await expect(h.renderer.setDocument({ ...ref, revision: 1 })).rejects.toThrow("requested document");
  });

  it("reads 2100 persisted changes in pages outside the unsaved draft budget", async () => {
    const h = harness({ getChanges: vi.fn(async (document, cursor) => {
      const start = Number(cursor ?? 0);
      const end = Math.min(start + 128, 2100);
      return { generationId: document.generationId, revision: document.revision,
        operations: Array.from({ length: end - start }, (_, i) => ({ kind: "add" as const, element: shape(`saved-${start + i}`) })),
        nextCursor: end < 2100 ? String(end) : null };
    }) });
    await h.start();
    expect(h.source.getChanges).toHaveBeenCalledTimes(17);
    expect((await h.renderer.getElements(["saved-2099"]))[0]?.id).toBe("saved-2099");
    expect(h.source.getElements).not.toHaveBeenCalled();
    h.renderer.applyChanges([{ kind: "add", element: shape("unsaved") }], []);
    expect((await h.renderer.getElements(["unsaved"]))[0]?.id).toBe("unsaved");
    expect(h.renderer.memoryBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
  });

  it("waits through empty pages before exposing a base that contains deleted elements", async () => {
    const pending = deferred<{ generationId: string; revision: number; operations: [{ kind: "delete"; id: string }]; nextCursor: null }>();
    const h = harness({ getChanges: vi.fn(async (document, cursor) => cursor ? pending.promise : {
      generationId: document.generationId, revision: document.revision, operations: [], nextCursor: "scan" }) });
    await h.renderer.mount(h.canvas);
    h.renderer.setCamera(camera);
    const adoption = h.renderer.setDocument(ref); await h.flush();
    expect(h.backend.replaceTile).not.toHaveBeenCalled();
    pending.resolve({ generationId: ref.generationId, revision: 0,
      operations: [{ kind: "delete", id: "element-0" }], nextCursor: null });
    await adoption; await h.flush();
    expect(await h.renderer.pick({ x: 20, y: 20 })).toBeNull();
  });

  it("acknowledges only the saved draft version while preserving same-ID edits made during save", async () => {
    const h = harness({ getChanges: vi.fn(async document => ({ generationId: document.generationId, revision: document.revision,
      operations: document.revision ? [{ kind: "add" as const, element: { ...shape(), transform: { ...shape().transform, x: 100 } } }] : [], nextCursor: null })) });
    await h.start();
    h.renderer.applyChanges([{ kind: "update", element: { ...shape(), transform: { ...shape().transform, x: 100 } } }], [tile(0).bounds]);
    const savedVersion = h.renderer.getDraftVersion();
    h.renderer.applyChanges([{ kind: "update", element: { ...shape(), transform: { ...shape().transform, x: 200 } } }], [tile(0).bounds]);
    await h.renderer.acknowledge({ ...ref, revision: 1 }, savedVersion); await h.flush();
    expect((await h.renderer.getElements([shape().id]))[0]?.transform.x).toBe(200);
    h.renderer.setDraftChanges([], []); await h.flush();
    expect((await h.renderer.getElements([shape().id]))[0]?.transform.x).toBe(100);
    expect(h.backend.mount).toHaveBeenCalledTimes(1);
    expect(h.backend.destroy).not.toHaveBeenCalled();
  });

  it("retires absent base layers and masks only actual promoted elements", async () => {
    const h = harness(); await h.start();
    h.renderer.setPromotedElementIds(["element-0"]); await h.flush();
    expect(await h.renderer.pick({ x: 20, y: 20 })).toBeNull();
    h.renderer.setPromotedElementIds([]); await h.flush();
    expect((await h.renderer.pick({ x: 20, y: 20 }))?.element.id).toBe("element-0");
    expect(() => h.renderer.setPromotedElementIds(Array.from({ length: 65 }, (_, i) => `${i}`))).toThrow("promotion");
    const manifest = await h.source.getManifest(ref, new AbortController().signal);
    vi.mocked(h.source.getManifest).mockResolvedValue({ ...manifest, revision: 1, layers: [] });
    await h.renderer.setDocument({ ...ref, revision: 1 }); await h.flush();
    expect(await h.renderer.pick({ x: 20, y: 20 })).toBeNull();
    expect(vi.mocked(h.backend.replaceTile).mock.calls.at(-1)?.[3]?.has("walls")).toBe(true);
  });

  it("uses only derived display assets for overview and merges camera input before fetching finishes", async () => {
    const pending = deferred<Uint8Array>();
    const h = harness({ loadDisplayTile: vi.fn(() => pending.promise) });
    await h.start();
    for (let i = 0; i < 100; i++) h.renderer.setCamera({ ...camera, centerX: i });
    const before = vi.mocked(h.backend.setCamera).mock.calls.length;
    await h.flush();
    expect(h.backend.setCamera).toHaveBeenCalledTimes(before + 1);
    expect(h.backend.setCamera).toHaveBeenLastCalledWith({ ...camera, centerX: 99 });
    expect(h.source.getElements).not.toHaveBeenCalled();
    expect(h.backend.mount).toHaveBeenCalledTimes(1);
    pending.resolve(new Uint8Array([0])); await h.flush();
  });

  it("reuses immutable display bytes across zoom bands and same-generation revisions", async () => {
    const h = harness(); await h.start();
    expect(h.source.loadDisplayTile).toHaveBeenCalledTimes(2);
    h.renderer.setCamera({ ...camera, zoom: 0.5 }); await h.flush();
    await h.renderer.setDocument({ ...ref, revision: 1 }); await h.flush();
    expect(h.source.loadDisplayTile).toHaveBeenCalledTimes(2);
    expect(h.backend.mount).toHaveBeenCalledTimes(1);
    expect(h.backend.destroy).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("rebuilds only dirty neighbours and masks deleted IDs in late decode results", async () => {
    const h = harness(); await h.start();
    vi.mocked(h.source.decodeDisplayTile!).mockClear();
    h.renderer.applyChanges([{ kind: "delete", id: "element-0" }], [{ minX: 10, minY: 10, maxX: 30, maxY: 30 }]);
    await h.flush();
    expect(h.source.decodeDisplayTile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.source.decodeDisplayTile!).mock.calls[0][2]?.excludedIds).toContain("element-0");
    expect(h.source.loadDisplayTile).toHaveBeenCalledTimes(2);
    expect(await h.renderer.pick({ x: 20, y: 20 })).toBeNull();
  });

  it("does not resurrect deletion when a decode that ignored cancellation resolves late", async () => {
    const h = harness();
    const original = h.source.decodeDisplayTile!;
    const pending = deferred<Awaited<ReturnType<typeof original>>>();
    vi.mocked(h.source.decodeDisplayTile!).mockImplementationOnce(() => pending.promise);
    await h.start();
    h.renderer.applyChanges([{ kind: "delete", id: "element-0" }], [tile(0).bounds]);
    pending.resolve(await original(new Uint8Array([0]), tile(0)));
    await h.flush();
    const renders = vi.mocked(h.backend.replaceTile).mock.calls.filter(([key]) => key.includes("display:0:0"));
    expect(renders.every(([, decoded]) => decoded.batches.length === 0)).toBe(true);
  });

  it("fences old manifests, lookups and generation bytes", async () => {
    const h = harness(); await h.start();
    const lookup = deferred<readonly MapElement[]>();
    vi.mocked(h.source.getElements).mockReturnValueOnce(lookup.promise);
    const picked = h.renderer.pick({ x: 20, y: 20 }); await h.flush();
    await h.renderer.setDocument({ ...ref, generationId: "generation-b" }); await h.flush();
    lookup.resolve([shape()]);
    expect(await picked).toBeNull();
    expect(h.source.loadDisplayTile).toHaveBeenCalledTimes(4);
  });

  it("picks canonical IDs only on demand and releases derived source leases", async () => {
    const h = harness(); await h.start();
    const picked = await h.renderer.pick({ x: 20, y: 20 });
    expect(picked?.element.id).toBe("element-0");
    expect(h.source.getElements).toHaveBeenCalledWith(ref, ["element-0"], expect.any(AbortSignal));
    expect(h.source.loadDisplayTile).toHaveBeenCalledTimes(2);
  });

  it("renders a moved draft with the same backend and survives context loss", async () => {
    const h = harness(); await h.start();
    h.renderer.applyChanges([{ kind: "update", element: { ...shape(), transform: { ...shape().transform, x: 100 } } }], [tile(0).bounds]);
    await h.flush();
    expect((await h.renderer.pick({ x: 120, y: 20 }))?.element.id).toBe("element-0");
    expect(await h.renderer.pick({ x: 20, y: 20 })).toBeNull();
    const before = h.renderer.memoryBytes;
    h.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(h.backend.suspend).toHaveBeenCalledTimes(1);
    expect(h.renderer.memoryBytes).toBeLessThan(before);
    h.canvas.dispatchEvent(new Event("webglcontextrestored")); await h.flush();
    expect(h.backend.mount).toHaveBeenCalledTimes(1);
    expect((await h.renderer.pick({ x: 120, y: 20 }))?.element.id).toBe("element-0");
  });

  it("reports memory pressure instead of silently exceeding the aggregate budget", async () => {
    const h = harness({}, 256); await h.start();
    expect(h.renderer.memoryBytes).toBeLessThanOrEqual(256);
    expect(h.onDegraded.mock.calls.length + h.onError.mock.calls.length).toBeGreaterThan(0);
    h.renderer.dispose(); expect(h.renderer.memoryBytes).toBe(0);
  });

  it("maps explicit display layer names to canonical IDs and rejects missing bindings", async () => {
    const h = harness();
    const getManifest = vi.mocked(h.source.getManifest).getMockImplementation()!;
    vi.mocked(h.source.getManifest).mockImplementation(async (document, signal) => ({
      ...await getManifest(document, signal),
      layers: [{ id: "canonical-wall", name: "Walls", order: 0, visible: true, locked: false }],
      displayLayerBindings: [{ layerName: "walls", layerId: "canonical-wall" }]
    }));
    await h.start();
    expect(vi.mocked(h.backend.replaceTile).mock.calls.some(([, decoded]) => decoded.batches.some(batch => batch.layerName === "canonical-wall"))).toBe(true);
    h.renderer.applyChanges([{ kind: "layer.put", layer: { id: "canonical-wall", name: "Walls", order: 0, visible: false, locked: false } }], []);
    await h.flush();
    expect(vi.mocked(h.backend.replaceTile).mock.calls.at(-1)?.[3]?.has("canonical-wall")).toBe(true);
  });

  it("rejects unbound display layer names instead of guessing canonical IDs", async () => {
    const h = harness();
    vi.mocked(h.source.getManifest).mockResolvedValue({ generationId: ref.generationId, revision: 0,
      canonical: ref.manifest, display, groups: [], layers: [], displayLayerBindings: [] });
    await h.start();
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("binding") }));
  });

  it("rejects oversized multi-selection and overbroad canonical responses", async () => {
    const h = harness(); await h.start();
    await expect(h.renderer.getElements(Array.from({ length: 129 }, (_, i) => `${i}`))).rejects.toThrow("limit");
    expect(h.source.getElements).not.toHaveBeenCalled();
    vi.mocked(h.source.getElements).mockResolvedValueOnce([shape("unrequested")]);
    await expect(h.renderer.getElements(["element-0"])).rejects.toThrow("scope");
  });

  it("limits exact-pick candidate work before loading dense display parts", async () => {
    const h = harness();
    const getManifest = vi.mocked(h.source.getManifest).getMockImplementation()!;
    vi.mocked(h.source.getManifest).mockImplementation(async (document, signal) => ({ ...await getManifest(document, signal),
      display: { ...display, tiles: Array.from({ length: 33 }, (_, part) => ({ ...tile(0), part })) } }));
    await h.start();
    await expect(h.renderer.pick({ x: 20, y: 20 })).rejects.toThrow("selection budget");
    expect(h.source.getElements).not.toHaveBeenCalled();
  });

  it("never adopts an older manifest response and discards responses after disposal", async () => {
    const h = harness(); await h.start();
    const delayed = deferred<Awaited<ReturnType<MapSceneSource["getManifest"]>>>();
    vi.mocked(h.source.getManifest).mockReturnValueOnce(delayed.promise);
    const first = h.renderer.setDocument({ ...ref, revision: 1 });
    await h.renderer.setDocument({ ...ref, revision: 2 });
    const current = await h.source.getManifest({ ...ref, revision: 1 }, new AbortController().signal);
    delayed.resolve({ ...current, display: { ...display, tiles: [] } });
    await first; await h.flush();
    expect((await h.renderer.pick({ x: 20, y: 20 }))?.element.id).toBe("element-0");
    h.renderer.dispose();
    expect(h.renderer.memoryBytes).toBe(0);
    expect(() => h.renderer.setCamera(camera)).toThrow("disposed");
  });

  it("keeps failed over-budget edits atomic", async () => {
    const h = harness(); await h.start();
    const before = h.renderer.memoryBytes;
    expect(() => h.renderer.applyChanges(Array.from({ length: 2001 }, (_, i) => ({ kind: "delete", id: `${i}` })), [])).toThrow("limit");
    expect(h.renderer.memoryBytes).toBe(before);
    expect((await h.renderer.pick({ x: 20, y: 20 }))?.element.id).toBe("element-0");
  });

  it("checks canonical candidates behind polygon holes instead of trusting derived fills", async () => {
    const h = harness();
    vi.mocked(h.source.decodeDisplayTile!).mockImplementation(async (_bytes, descriptor, quality) => ({ descriptor, byteSize: 1,
      ...buildCadGeometryBatches(["back", "front"].map(elementId => ({ type: "rectangle", elementId, groupId: null,
        layerName: "walls", sourceType: "rectangle", bounds: tile(0).bounds, clipBounds: null, style: shape().style,
        geometry: { origin: { x: 0, y: 0 }, width: 100, height: 100, rotation: 0 } })), quality) }));
    vi.mocked(h.source.getElements).mockImplementation(async (_document, ids) => ids.map(id => id === "back" ? shape("back") : {
      ...shape("front"), zIndex: 1, type: "polygon", geometry: {
        outer: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
        holes: [[{ x: 10, y: 10 }, { x: 10, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 10 }]] }
    }));
    await h.start();
    expect((await h.renderer.pick({ x: 20, y: 20 }))?.element.id).toBe("back");
  });

  it("enforces the atlas sub-budget even when the aggregate has room", async () => {
    const h = harness();
    const decode = vi.mocked(h.source.decodeDisplayTile!).getMockImplementation()!;
    vi.mocked(h.source.decodeDisplayTile!).mockImplementation(async (...args) => {
      const result = await decode(...args);
      return { ...result, memory: { cpuBytes: 1, gpuBytes: 1, textAtlasBytes: 65 * 1024 * 1024 } };
    });
    await h.start();
    expect(h.backend.replaceTile).not.toHaveBeenCalled();
    expect(h.onDegraded).toHaveBeenCalled();
  });

  it("ignores a superseded manifest rejection instead of surfacing another floor's error", async () => {
    const h = harness(); await h.start();
    vi.mocked(h.source.getManifest).mockImplementationOnce((_document, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const stale = h.renderer.setDocument({ ...ref, revision: 1 });
    await h.renderer.setDocument({ ...ref, generationId: "generation-b" });
    await expect(stale).resolves.toBeUndefined();
  });

  it("evicts original bytes by LRU without discarding resident display geometry", async () => {
    const h = harness({}, undefined, 1); await h.start();
    expect(h.source.loadDisplayTile).toHaveBeenCalledTimes(2);
    h.renderer.setCamera({ ...camera, centerX: 500 }); await h.flush();
    expect(h.source.loadDisplayTile).toHaveBeenCalledTimes(2);
    h.renderer.setCamera({ ...camera, zoom: 0.5 }); await h.flush();
    expect(h.source.loadDisplayTile).toHaveBeenCalledTimes(3);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("reveals local draft batches when their layer becomes visible again", async () => {
    const h = harness(); await h.start();
    h.renderer.applyChanges([{ kind: "add", element: shape("draft") }], []); await h.flush();
    const layer = { id: "walls", name: "Walls", order: 0, locked: false, visible: false };
    h.renderer.applyChanges([{ kind: "layer.put", layer }], []); await h.flush();
    h.renderer.applyChanges([{ kind: "layer.put", layer: { ...layer, visible: true } }], []); await h.flush();
    const lastDraft = vi.mocked(h.backend.replaceTile).mock.calls.filter(([key]) => key === "transient").at(-1);
    expect(lastDraft?.[3]?.has("walls")).toBe(false);
  });

  it("publishes simultaneous original responses with matching aggregate allocations", async () => {
    const h = harness({}, 100 * 1024, 1024 * 1024);
    const getManifest = vi.mocked(h.source.getManifest).getMockImplementation()!;
    vi.mocked(h.source.getManifest).mockImplementation(async (...args) => ({ ...await getManifest(...args),
      display: { ...display, tiles: display.tiles.map(value => ({ ...value, byteSize: 64 * 1024 })) } }));
    const ready = deferred<void>();
    vi.mocked(h.source.loadDisplayTile).mockImplementation(async () => { await ready.promise; return new Uint8Array(64 * 1024); });
    await h.start();
    ready.resolve(); await h.flush();
    // Inspect retained bytes, not just the reported aggregate that missed the
    // race. The cache is private; no extra production diagnostics API is needed.
    const { originals, budget } = h.renderer as unknown as {
      originals: { totalBytes: number; entries: Map<string, { byteSize: number }> };
      budget: { allocations: Map<string, { owner: string; key: string; bytes: number }> };
    };
    expect(originals.totalBytes).toBe(64 * 1024);
    const allocations = new Map([...budget.allocations.values()].filter(value => value.owner === "map-source")
      .map(value => [value.key, value.bytes]));
    expect(allocations.size).toBe(originals.entries.size);
    for (const [key, entry] of originals.entries) expect(allocations.get(key)).toBe(entry.byteSize);
    expect(originals.totalBytes).toBeLessThanOrEqual(h.renderer.memoryBytes);
    expect(h.renderer.memoryBytes).toBeLessThanOrEqual(100 * 1024);
    expect(h.onError).not.toHaveBeenCalled();
    h.renderer.dispose();
    expect(originals.totalBytes).toBe(0);
    expect(h.renderer.memoryBytes).toBe(0);
  });

  it("does not hide a same-named group when deleting an element", async () => {
    const h = collisionHarness(); await h.start();
    expect((await h.renderer.pick({ x: 120, y: 20 }))?.element.id).toBe("member");
    h.renderer.applyChanges([{ kind: "delete", id: "shared" }], [{ minX: 10, minY: 10, maxX: 30, maxY: 30 }]);
    await h.flush();
    expect(vi.mocked(h.backend.replaceTile).mock.calls.at(-1)?.[1].batches).toHaveLength(1);
    expect((await h.renderer.pick({ x: 120, y: 20 }))?.element.id).toBe("member");
    expect(await h.renderer.pick({ x: 20, y: 20 })).toBeNull();
  });

  it("does not hide a same-named ungrouped element when hiding a group", async () => {
    const h = collisionHarness(); await h.start();
    h.renderer.applyChanges([{ kind: "group.put", group: { ...h.group, visible: false } }], []);
    await h.flush();
    expect(vi.mocked(h.backend.replaceTile).mock.calls.at(-1)?.[1].batches).toHaveLength(1);
    expect((await h.renderer.pick({ x: 20, y: 20 }))?.element.id).toBe("shared");
    expect(await h.renderer.pick({ x: 120, y: 20 })).toBeNull();
    h.renderer.applyChanges([{ kind: "group.put", group: h.group }], []); await h.flush();
    expect((await h.renderer.pick({ x: 120, y: 20 }))?.element.id).toBe("member");
  });

  it.each([1, 2])("uses the last rendered camera for a pick before the queued zoom %s frame", async zoom => {
    const h = collisionHarness(); await h.start();
    expect((await h.renderer.pick({ x: 20, y: 20 }))?.element.id).toBe("shared");
    const next = { ...camera, zoom, centerX: 120 + 492 / zoom, centerY: 20 + 236 / zoom };
    h.renderer.setCamera(next);
    expect((await h.renderer.pick({ x: 20, y: 20 }))?.element.id).toBe("shared");
    expect(h.backend.setCamera).toHaveBeenLastCalledWith(camera);
    await h.flush();
    expect((await h.renderer.pick({ x: 20, y: 20 }))?.element.id).toBe("member");
    expect(h.backend.setCamera).toHaveBeenLastCalledWith(next);
    expect(h.source.loadDisplayTile).toHaveBeenCalledTimes(1);
  });
});
