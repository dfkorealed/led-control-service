import type { MapDocumentRef, MapOp, SaveEditorStateInput } from "@led-control/shared";
import { mapDocumentRefSchema, mapOpSchema } from "@led-control/shared/map-document-contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { apiRequest, isTransientApiError } from "./client";
import type { FloorEditorState } from "../features/floor-editor/editor-types";

export const MAP_STAGE_PART_BYTES = 512 * 1024;
export const MAP_STAGE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_OPERATION_BYTES = 8 * 1024 * 1024;
export type StageLease = Pick<SaveEditorStateInput, "leaseToken" | "leaseFence">;
export type StageDigest = { partCount: number; decodedBytes: number; sha256: string };
export type StageIntent = StageLease & Partial<StageDigest>;
export type MapStageStatus = "preparing" | "queued" | "processing" | "ready" | "committed" | "failed" | "cancelled" | "expired";
export type MapStageReceipt = FloorEditorState & { history: { undo: { revision: number }; redo: { revision: number } } };
export interface MapStage {
  id: string; status: MapStageStatus; generationId: string; baseRevision: number;
  partCount: number; decodedBytes: number; expiresAt: string; errorCode: string | null;
  result: MapStageReceipt | null; preview?: MapDocumentRef;
}
export interface PreparedMapStage extends MapStage { intent: StageIntent }
export interface MapStageProgress { stageId: string; phase: MapStageStatus | "uploading"; partCount: number; decodedBytes: number }
export interface MapStageOptions { signal?: AbortSignal; onProgress?: (progress: MapStageProgress) => void }
type Request = (path: string, init?: RequestInit) => Promise<unknown>;
type Part = { bytes: Uint8Array; sha256: string; streamSha256?: string };

/** One operation (bounded by the canonical reader) and one part are resident.
 * Yielding each part before pulling the source again provides upload backpressure. */
export async function* streamMapParts(source: AsyncIterable<MapOp> | Iterable<MapOp>, signal?: AbortSignal): AsyncGenerator<Part> {
  const whole = sha256.create(), encoder = new TextEncoder();
  let buffer = new Uint8Array(MAP_STAGE_PART_BYTES), used = 0, total = 0;
  async function* tokens() {
    yield "["; let first = true;
    for await (const operation of source) {
      signal?.throwIfAborted();
      const json = JSON.stringify(mapOpSchema.parse(operation));
      if (json.length > MAX_OPERATION_BYTES) throw new Error("MAP_STAGE_OPERATION_TOO_LARGE");
      yield (first ? "" : ",") + json; first = false;
    }
    yield "]";
  }
  try {
    for await (const token of tokens()) {
      signal?.throwIfAborted();
      const bytes = encoder.encode(token);
      if (bytes.length > MAX_OPERATION_BYTES + 1) throw new Error("MAP_STAGE_OPERATION_TOO_LARGE");
      for (let offset = 0; offset < bytes.length;) {
        const length = Math.min(bytes.length - offset, buffer.length - used);
        if (total + length > MAP_STAGE_TOTAL_BYTES) throw new Error("MAP_STAGE_TOO_LARGE");
        buffer.set(bytes.subarray(offset, offset + length), used);
        used += length; offset += length; total += length;
        if (used === buffer.length) {
          whole.update(buffer);
          yield { bytes: buffer, sha256: bytesToHex(sha256(buffer)) };
          buffer = new Uint8Array(MAP_STAGE_PART_BYTES); used = 0;
        }
      }
    }
    // A stream exactly divisible by the part size needs no empty final part.
    if (used) {
      const bytes = buffer.subarray(0, used); whole.update(bytes);
      yield { bytes, sha256: bytesToHex(sha256(bytes)), streamSha256: bytesToHex(whole.digest()) };
    } else yield { bytes: new Uint8Array(), sha256: "", streamSha256: bytesToHex(whole.digest()) };
  } finally { whole.destroy(); }
}

function base64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(pieces.join(""));
}
function parseStage(raw: unknown): MapStage {
  const value = raw as MapStage;
  if (!value || typeof value.id !== "string" || !value.id || typeof value.generationId !== "string"
    || !Number.isInteger(value.baseRevision) || value.baseRevision < 1
    || !["preparing", "queued", "processing", "ready", "committed", "failed", "cancelled", "expired"].includes(value.status)
    || !Number.isInteger(value.partCount) || value.partCount < 0 || value.partCount > 1024
    || !Number.isInteger(value.decodedBytes) || value.decodedBytes < 0 || value.decodedBytes > MAP_STAGE_TOTAL_BYTES
    || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error("MAP_STAGE_RESPONSE_INVALID");
  if (value.preview) mapDocumentRefSchema.parse(value.preview);
  return value;
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function createMapStageClient({ request = apiRequest, pollMs = 500 }: { request?: Request; pollMs?: number } = {}) {
  const root = (floorId: string) => `/floors/${encodeURIComponent(floorId)}/editor-stages`;
  const path = (floorId: string, id: string) => `${root(floorId)}/${encodeURIComponent(id)}`;
  async function call(url: string, method?: string, body?: unknown, signal?: AbortSignal) {
    const init = { ...(method ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal };
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try { return parseStage(await request(url, init)); }
      catch (error) {
        if (signal?.aborted || !isTransientApiError(error) || attempt === 2) throw error;
        await pause(pollMs * (attempt + 1), signal);
      }
    }
  }
  function progress(stage: MapStage, options: MapStageOptions, phase = stage.status as MapStageProgress["phase"]) {
    options.onProgress?.({ stageId: stage.id, phase, partCount: stage.partCount, decodedBytes: stage.decodedBytes });
  }
  async function settle(floorId: string, stageId: string, options: MapStageOptions = {}) {
    const deadline = Date.now() + 15 * 60_000;
    while (true) {
      const stage = await call(path(floorId, stageId), undefined, undefined, options.signal); progress(stage, options);
      if (["ready", "committed"].includes(stage.status)) return stage;
      if (["failed", "cancelled", "expired"].includes(stage.status)) throw new Error(stage.errorCode ?? `MAP_STAGE_${stage.status.toUpperCase()}`);
      if (Date.now() >= Math.min(deadline, Date.parse(stage.expiresAt))) throw new Error("MAP_STAGE_TIMEOUT");
      await pause(pollMs, options.signal);
    }
  }
  async function create(floorId: string, payload: SaveEditorStateInput, options: MapStageOptions, revision?: number) {
    if (!payload.documentChanges || payload.documentChanges.operations.length || payload.objectCreates.length || payload.objectUpdates.length || payload.objectDeletes.length) throw new Error("MAP_STAGE_ENVELOPE_INVALID");
    const stage = await call(root(floorId), "POST", { ...payload, ...(revision === undefined ? {} : { historySource: { revision } }) }, options.signal);
    if (stage.generationId !== payload.documentChanges.generationId || stage.baseRevision !== payload.expectedRevision) throw new Error("MAP_STAGE_SCOPE_INVALID");
    progress(stage, options); return stage;
  }
  return {
    status: (floorId: string, stageId: string, signal?: AbortSignal) => call(path(floorId, stageId), undefined, undefined, signal),
    settle,
    async prepare(floorId: string, payload: SaveEditorStateInput, source: AsyncIterable<MapOp> | Iterable<MapOp>, options: MapStageOptions = {}): Promise<PreparedMapStage> {
      const stage = await create(floorId, payload, options);
      const lease = { leaseToken: payload.leaseToken, leaseFence: payload.leaseFence };
      let partCount = 0, decodedBytes = 0, sha256 = "";
      for await (const part of streamMapParts(source, options.signal)) {
        if (part.bytes.length) {
          await call(`${path(floorId, stage.id)}/parts/${partCount}`, "PUT", { ...lease, data: base64(part.bytes), sha256: part.sha256 }, options.signal);
          partCount++; decodedBytes += part.bytes.length;
          progress({ ...stage, partCount, decodedBytes }, options, "uploading");
        }
        if (part.streamSha256) sha256 = part.streamSha256;
      }
      const intent = { ...lease, partCount, decodedBytes, sha256 };
      await call(`${path(floorId, stage.id)}/prepare`, "POST", intent, options.signal);
      const ready = await settle(floorId, stage.id, options);
      if (ready.status === "ready" && !ready.preview) throw new Error("MAP_STAGE_PREVIEW_MISSING");
      return { ...ready, intent };
    },
    async prepareHistory(floorId: string, payload: SaveEditorStateInput, revision: number, options: MapStageOptions = {}): Promise<PreparedMapStage> {
      const stage = await create(floorId, payload, options, revision);
      const intent = { leaseToken: payload.leaseToken, leaseFence: payload.leaseFence };
      await call(`${path(floorId, stage.id)}/prepare`, "POST", intent, options.signal);
      const ready = await settle(floorId, stage.id, options);
      if (ready.status === "ready" && !ready.preview) throw new Error("MAP_STAGE_PREVIEW_MISSING");
      return { ...ready, intent };
    },
    async commit(floorId: string, stage: Pick<PreparedMapStage, "id" | "intent">, options: MapStageOptions = {}) {
      const queued = await call(`${path(floorId, stage.id)}/commit`, "POST", stage.intent, options.signal);
      progress(queued, options);
      return queued.status === "committed" ? queued : settle(floorId, stage.id, options);
    },
    async cancel(floorId: string, stageId: string, lease: StageLease, options: MapStageOptions = {}) {
      try { return await call(path(floorId, stageId), "DELETE", lease, options.signal); }
      catch (error) {
        // DELETE can race an atomic commit or lose its response. Only a fresh
        // server status can report which outcome won; a failed GET stays failed.
        if (options.signal?.aborted) throw error;
        return call(path(floorId, stageId), undefined, undefined, options.signal);
      }
    }
  };
}
export type MapStageClient = ReturnType<typeof createMapStageClient>;
export const mapStageClient = createMapStageClient();
