import type { MapDisplayTile } from "@led-control/shared/map-display-contracts";
import { mapDisplayManifestSchema } from "@led-control/shared/map-display-contracts";
import { mapAssetRefSchema, mapBoundsSchema, mapDocumentRefSchema, mapElementOpSchema, mapElementSchema,
  mapGroupSchema, mapLayerSchema, type Bounds, type MapDocumentRef } from "@led-control/shared/map-document-contracts";
import type { MapChangesPage, MapSceneManifest, MapSceneSource } from "../features/map-scene/map-scene-source";
import { ApiError } from "./client";

const JSON_BYTES = 8 * 1024 * 1024;
const TILE_BYTES = 16 * 1024 * 1024;
export interface MapSelectionInput { groupId?: string; layerId?: string; bounds?: Bounds; cursor?: string; limit?: number }
export interface MapSelectionPage { generationId: string; revision: number; ids: string[]; nextCursor: string | null }
export interface MapDocumentSource extends MapSceneSource {
  getDocument(signal: AbortSignal): Promise<MapDocumentRef | null>;
  getSelection(ref: MapDocumentRef, input: MapSelectionInput, signal: AbortSignal): Promise<MapSelectionPage>;
}

/** Create once per authenticated floor/review scope; authScope must change on
 * principal/session/permission changes. No server authority is cached here. */
export function createMapDocumentSource(options: { floorId: string; authScope: string; jobId?: string; stageId?: string }): MapDocumentSource {
  const { floorId, authScope, jobId, stageId } = options;
  if (!floorId || !authScope || jobId === "" || stageId === "" || jobId !== undefined && stageId !== undefined) throw new Error("Map document requires one authenticated scope");
  if (stageId !== undefined) validId(stageId);
  const scopePath = stageId !== undefined ? `/editor-stages/${encodeURIComponent(stageId)}`
    : jobId !== undefined ? `/import-jobs/${encodeURIComponent(jobId)}` : "";
  const prefix = `/api/floors/${encodeURIComponent(floorId)}${scopePath}/map-document`;
  let manifestEpoch = 0;
  let pinned: { ref: MapDocumentRef; tiles: Map<string, MapDisplayTile> } | null = null;
  const route = (ref: MapDocumentRef, suffix: string, cursor?: string) => {
    mapDocumentRefSchema.parse(ref);
    if (ref.generationId.length > 128) throw new Error("Invalid map generation ID");
    const query = new URLSearchParams({ generationId: ref.generationId, revision: String(ref.revision) });
    if (cursor !== undefined) query.set("cursor", cursorValue(cursor));
    return `${prefix}/${suffix}?${query}`;
  };
  const request = async (url: string, signal: AbortSignal, body?: unknown, maximum = JSON_BYTES): Promise<Uint8Array> => {
    signal.throwIfAborted();
    const response = await fetch(url, { signal, credentials: "include", redirect: "error", cache: "no-store",
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
    if (response.redirected) { await response.body?.cancel(); throw new Error("Map document redirects are forbidden"); }
    if (!response.ok) {
      let errorBody: unknown = null;
      try { errorBody = parseJson(await readBounded(response, 64 * 1024, signal)); }
      catch { signal.throwIfAborted(); }
      throw new ApiError(`Map document request failed with ${response.status}`, response.status, errorBody);
    }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error("Unexpected map document response status"); }
    return readBounded(response, maximum, signal);
  };
  const jsonRequest = async (url: string, signal: AbortSignal, body?: unknown) => parseJson(await request(url, signal, body));

  return Object.freeze({
    scopeKey: JSON.stringify([authScope, floorId, jobId ?? null, ...(stageId === undefined ? [] : ["stage", stageId])]),
    async getDocument(signal: AbortSignal) {
      const result = await jsonRequest(prefix, signal);
      return result === null ? null : mapDocumentRefSchema.parse(result);
    },
    async getManifest(ref: MapDocumentRef, signal: AbortSignal): Promise<MapSceneManifest> {
      const epoch = ++manifestEpoch;
      const value = record(await jsonRequest(route(ref, "manifest"), signal),
        ["generationId", "revision", "canonical", "display", "displayLayerBindings", "groups", "layers"]);
      assertReference(value, ref);
      const canonical = mapAssetRefSchema.parse(value.canonical);
      if (canonical.assetId !== ref.manifest.assetId || canonical.sha256 !== ref.manifest.sha256 ||
          canonical.byteSize !== ref.manifest.byteSize || canonical.decodedByteSize !== ref.manifest.decodedByteSize) {
        throw new Error("Map canonical manifest identity mismatch");
      }
      const display = mapDisplayManifestSchema.parse(value.display);
      if (display.width !== ref.width || display.height !== ref.height || display.gridSize !== ref.gridSize) {
        throw new Error("Map display dimensions do not match its reference");
      }
      const groups = array(value.groups).map(group => mapGroupSchema.parse(group));
      const layers = array(value.layers).map(layer => mapLayerSchema.parse(layer));
      if (new Set(groups.map(group => group.id)).size !== groups.length || new Set(layers.map(layer => layer.id)).size !== layers.length) {
        throw new Error("Duplicate map structure IDs");
      }
      const displayLayerBindings = array(value.displayLayerBindings).map(input => {
        const binding = record(input, ["layerName", "layerId"]);
        return { layerName: validId(binding.layerName), layerId: validId(binding.layerId) };
      });
      if (new Set(displayLayerBindings.map(binding => binding.layerName)).size !== displayLayerBindings.length) {
        throw new Error("Duplicate map display layer binding");
      }
      signal.throwIfAborted();
      if (epoch !== manifestEpoch) throw new DOMException("Superseded map manifest", "AbortError");
      pinned = { ref: structuredClone(ref), tiles: new Map(display.tiles.map(tile => [tile.assetId, tile])) };
      return { generationId: ref.generationId, revision: ref.revision, canonical, display, displayLayerBindings, groups, layers };
    },
    async loadDisplayTile(tile: MapDisplayTile, signal: AbortSignal) {
      const pin = pinned;
      const descriptor = pin?.tiles.get(tile.assetId);
      if (!pin || !descriptor || !sameTile(descriptor, tile)) throw new Error("Map tile is not pinned by the current manifest");
      const bytes = await request(route(pin.ref, `tiles/${encodeURIComponent(tile.assetId)}`), signal, undefined, Math.min(tile.byteSize, TILE_BYTES));
      if (bytes.byteLength !== tile.byteSize) throw new Error("Map tile integrity size mismatch");
      const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
      signal.throwIfAborted();
      const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      if (hash !== tile.sha256) throw new Error("Map tile integrity hash mismatch");
      return bytes;
    },
    async getElements(ref: MapDocumentRef, ids: readonly string[], signal: AbortSignal) {
      if (ids.length > 128 || new Set(ids).size !== ids.length) throw new RangeError("Map element ID limit exceeded");
      ids.forEach(validId);
      const values = array(await jsonRequest(route(ref, "elements"), signal, { ids }));
      if (values.length > ids.length) throw new Error("Map element response exceeds requested IDs");
      const elements = values.map(value => mapElementSchema.parse(value));
      if (new Set(elements.map(element => element.id)).size !== elements.length || elements.some(element => !ids.includes(element.id))) {
        throw new Error("Map element response exceeds requested IDs");
      }
      // Omitted IDs are explicitly allowed for deleted/stale selections.
      return elements;
    },
    async getChanges(ref: MapDocumentRef, cursor: string | undefined, signal: AbortSignal): Promise<MapChangesPage> {
      const page = record(await jsonRequest(route(ref, "changes", cursor), signal), ["generationId", "revision", "operations", "nextCursor"]);
      assertReference(page, ref);
      const operations = array(page.operations, 128).map(value => mapElementOpSchema.parse(value));
      return { generationId: ref.generationId, revision: ref.revision, operations, nextCursor: nextCursor(page.nextCursor) };
    },
    async getSelection(ref: MapDocumentRef, input: MapSelectionInput, signal: AbortSignal): Promise<MapSelectionPage> {
      record(input, ["groupId", "layerId", "bounds", "cursor", "limit"], false);
      if (input.groupId !== undefined) validId(input.groupId);
      if (input.layerId !== undefined) validId(input.layerId);
      if (input.bounds !== undefined) mapBoundsSchema.parse(input.bounds);
      if (input.cursor !== undefined) cursorValue(input.cursor);
      const limit = input.limit ?? 128;
      if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new RangeError("Map selection ID limit exceeded");
      const page = record(await jsonRequest(route(ref, "selection"), signal, input), ["generationId", "revision", "ids", "nextCursor"]);
      assertReference(page, ref);
      const ids = array(page.ids, limit).map(validId);
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate map selection IDs");
      return { generationId: ref.generationId, revision: ref.revision, ids, nextCursor: nextCursor(page.nextCursor) };
    }
  });
}

async function readBounded(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) {
    await response.body?.cancel();
    throw new RangeError("Map response byte limit exceeded");
  }
  if (!response.body) throw new Error("Map response body is missing");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new RangeError("Map response byte limit exceeded");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

function parseJson(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
function record(input: unknown, keys: string[], required = true): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)) ||
      (required && keys.some(key => !(key in input)))) throw new Error("Invalid map response shape");
  return input as Record<string, unknown>;
}
function array(input: unknown, limit = 1_000_000): unknown[] {
  if (!Array.isArray(input) || input.length > limit) throw new Error("Map response array limit exceeded");
  return input;
}
function validId(input: unknown): string {
  if (typeof input !== "string" || !input.trim() || input !== input.trim() || input.length > 512) throw new Error("Invalid map ID");
  // encodeURIComponent also rejects malformed UTF-16 instead of repairing IDs.
  encodeURIComponent(input);
  return input;
}
function cursorValue(input: unknown): string {
  if (typeof input !== "string" || !input || input.length > 8192) throw new Error("Invalid map cursor");
  return input;
}
function nextCursor(input: unknown): string | null { return input === null ? null : cursorValue(input); }
function assertReference(value: Record<string, unknown>, ref: MapDocumentRef): void {
  if (value.generationId !== ref.generationId || value.revision !== ref.revision) throw new Error("Map response reference mismatch");
}
function sameTile(a: MapDisplayTile, b: MapDisplayTile): boolean {
  return a.assetId === b.assetId && a.sha256 === b.sha256 && a.byteSize === b.byteSize && a.version === b.version &&
    a.sceneId === b.sceneId && a.lod === b.lod && a.part === b.part && a.tileX === b.tileX && a.tileY === b.tileY &&
    a.primitiveCount === b.primitiveCount && a.bounds.minX === b.bounds.minX && a.bounds.minY === b.bounds.minY &&
    a.bounds.maxX === b.bounds.maxX && a.bounds.maxY === b.bounds.maxY;
}
