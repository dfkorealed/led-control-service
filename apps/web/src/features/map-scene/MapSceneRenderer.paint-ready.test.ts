import { afterEach, expect, it, vi } from "vitest";
import type { MapDisplayManifest } from "@led-control/shared/map-display-contracts";
import type { MapDocumentRef } from "@led-control/shared/map-document-contracts";
import type { MapSceneSource } from "./map-scene-source";
import { MapSceneRenderer } from "./MapSceneRenderer";

const callbacks = vi.hoisted(() => [] as Array<(ready: boolean, manifest: MapDisplayManifest) => void>);
vi.mock("./map-raster-backend", () => ({ MapRasterBackend: class {
  constructor(_budget: unknown, _layers: unknown, callback: typeof callbacks[number]) { callbacks.push(callback); }
  async mount() {}
  async renderDisplay() {}
  resize() {}
  setCamera() {}
  render() {}
  suspend() {}
  destroy() {}
  removeTile() {}
  setLayerStates() {}
  invalidateDisplay() {}
} }));

afterEach(() => { callbacks.length = 0; vi.unstubAllGlobals(); });

it("fences incoming document metadata and an old frame before the latest camera is applied", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const flush = async () => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0));
    await Promise.resolve();
  };
  const ref: MapDocumentRef = { formatVersion: 1, generationId: "first", revision: 0, width: 1024, height: 1024,
    gridSize: 50, elementCount: 0, manifest: { assetId: "canonical", byteSize: 100, decodedByteSize: 100, sha256: "a".repeat(64) } };
  const display: MapDisplayManifest = { version: 2, sceneId: "first", regionId: "region", manifestAssetId: "display",
    width: 1024, height: 1024, padding: 0, gridSize: 50, tileSize: 512, lodMode: "additive", primitiveCount: 0,
    tileCount: 0, byteSize: 100, sha256: "a".repeat(64), sourceBounds: { minX: 0, minY: 0, maxX: 1024, maxY: 1024 },
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [] };
  const nextDisplay = { ...display, sceneId: "second" };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const source: MapSceneSource = { scopeKey: "fixture", getElements: async () => [], loadDisplayTile: async () => new Uint8Array(),
    getChanges: async document => ({ generationId: document.generationId, revision: document.revision, operations: [], nextCursor: null }),
    getManifest: async document => {
      if (document.generationId === "second") await blocked;
      return { generationId: document.generationId, revision: document.revision, canonical: document.manifest,
        groups: [], layers: [], displayLayerBindings: [], display: document.generationId === "first" ? display : nextDisplay };
    } };
  const ready = vi.fn(), renderer = new MapSceneRenderer({ source, onPaintReady: ready });
  const camera = { centerX: 512, centerY: 512, viewportWidth: 320, viewportHeight: 480, zoom: 1 };
  try {
    await renderer.mount(document.createElement("canvas"));
    renderer.setCamera(camera); await renderer.setDocument(ref); await flush();
    expect(ready).not.toHaveBeenCalledWith(true);
    callbacks[0](true, display);
    expect(ready).toHaveBeenLastCalledWith(true);
    renderer.setCamera({ ...camera, centerX: 512.25 });
    callbacks[0](true, display);
    expect(ready).toHaveBeenLastCalledWith(false);
    await flush(); callbacks[0](true, display);
    expect(ready).toHaveBeenLastCalledWith(true);
    const adoption = renderer.setDocument({ ...ref, generationId: "second" });
    callbacks[0](true, display);
    expect(ready).toHaveBeenLastCalledWith(false);
    release(); await adoption; await flush();
    callbacks[0](true, display);
    expect(ready).toHaveBeenLastCalledWith(false);
    callbacks[0](true, nextDisplay);
    expect(ready).toHaveBeenLastCalledWith(true);
    renderer.dispose(); ready.mockClear(); callbacks[0](true, nextDisplay);
    expect(ready).not.toHaveBeenCalled();
  } finally { release(); renderer.dispose(); }
});
