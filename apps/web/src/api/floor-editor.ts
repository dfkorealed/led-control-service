import type {
  CadSceneDescriptor,
  CadSceneEditInput,
  CadSceneManifest,
  CadSceneState,
  CadImportSourceFormat,
  FloorImportApplyInput,
  FloorImportAppliedOverlayResponse,
  FloorImportCandidateListResponse,
  RestoreFloorEditorRevisionInput,
  SaveEditorStateInput
} from "@led-control/shared";
import { CAD_SCENE_MAX_MANIFEST_BYTES, CAD_SCENE_MAX_TILE_BYTE_SIZE, cadSceneManifestSchema, cadSceneStateSchema } from "@led-control/shared/cad-scene-contracts";
import { floorImportApplyResultSchema } from "@led-control/shared/cad-import-contracts";
import { editorDocumentChangesSchema, mapDocumentRefSchema, MAP_MUTATION_MAX_BYTES } from "@led-control/shared/map-document-contracts";
import type { FixtureIdentifyRequest, FixtureIdentifyResponse } from "@led-control/shared";
import { ApiError, apiGet, apiPost, apiPut, apiRequest } from "./client";
import { readCadSceneBytes, readCadSceneJson } from "./cad-scene-content";
import type {
  FloorAsset,
  FloorEditorState,
  FloorImportJob
} from "../features/floor-editor/editor-types";

export async function getFloorEditorState(floorId: string, options: { signal?: AbortSignal } = {}) {
  return validateEditorDocument(await apiRequest<FloorEditorState>(`/floors/${encodeURIComponent(floorId)}/editor-state`, {
    signal: options.signal
  }));
}

function validateEditorDocument(state: FloorEditorState) {
  // An absent field is legacy compatibility, not a reason to erase malformed
  // converted data. Never catch parse failures and replace a document with null.
  if (state.floor.mapDocument !== undefined && state.floor.mapDocument !== null) {
    const document = mapDocumentRefSchema.parse(state.floor.mapDocument);
    if (document.revision !== state.floor.mapRevision || !Array.isArray(state.objects) || state.objects.length) {
      throw new Error("공통 맵 응답이 올바르지 않습니다.");
    }
  }
  return state;
}

export async function getCadSceneState(siteId: string, floorId: string, options: { signal?: AbortSignal } = {}) {
  return cadSceneStateSchema.parse(await apiRequest<CadSceneState>(cadSceneStatePath(siteId, floorId), {
    signal: options.signal
  }));
}

export async function updateCadScene(
  siteId: string,
  floorId: string,
  payload: CadSceneEditInput,
  options: { signal?: AbortSignal } = {}
) {
  return cadSceneStateSchema.parse(await apiRequest<CadSceneState>(cadSceneStatePath(siteId, floorId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options.signal
  }));
}

export async function getCadSceneManifest(path: CadSceneDescriptor["manifestContentPath"], signal?: AbortSignal) {
  const response = await fetchCadSceneContent(path, signal);
  return cadSceneManifestSchema.parse(await readCadSceneJson(response, CAD_SCENE_MAX_MANIFEST_BYTES)) as CadSceneManifest;
}

export async function getCadSceneTile(path: string, signal?: AbortSignal) {
  const response = await fetchCadSceneContent(path, signal);
  return readCadSceneBytes(response, CAD_SCENE_MAX_TILE_BYTE_SIZE);
}

function cadSceneStatePath(siteId: string, floorId: string) {
  return `/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}/cad-scene`;
}

async function fetchCadSceneContent(path: string, signal?: AbortSignal) {
  const response = await fetch(`/api${path}`, { credentials: "same-origin", signal });
  if (!response.ok) {
    throw new ApiError(`GET ${path} failed with ${response.status}`, response.status, null);
  }
  return response;
}

export function identifyFixture(floorId: string, fixtureId: string, payload: FixtureIdentifyRequest) {
  return apiPost<FixtureIdentifyResponse>(`/floors/${encodeURIComponent(floorId)}/fixtures/${encodeURIComponent(fixtureId)}/identify`, payload);
}

export interface FloorEditorRevision {
  revision: number;
  snapshotSha256: string;
  changeSummary: Record<string, unknown>;
  restoredFromRevision: number | null;
  createdAt: string;
  actor: { displayName: string };
}

export interface FloorEditorRevisionPage {
  items: FloorEditorRevision[];
  nextCursor: number | null;
}

export interface FloorEditorLease {
  editable: boolean;
  token?: string;
  fence?: number;
  holderName?: string;
  acquiredAt?: string;
}

export async function saveFloorEditorState(floorId: string, payload: SaveEditorStateInput) {
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAP_MUTATION_MAX_BYTES) throw new Error("대량 변경은 준비 저장 경로가 필요합니다.");
  if (payload.documentChanges) {
    editorDocumentChangesSchema.parse(payload.documentChanges);
    if (payload.objectCreates.length || payload.objectUpdates.length || payload.objectDeletes.length) throw new Error("공통 맵과 이전 도형 변경을 함께 저장할 수 없습니다.");
  }
  const result = validateEditorDocument(await apiPut<FloorEditorState>(`/floors/${encodeURIComponent(floorId)}/editor-state`, payload));
  if (payload.documentChanges && (result.floor.id !== floorId || result.floor.mapRevision !== payload.expectedRevision + 1
    || !result.floor.mapDocument)) throw new Error("저장된 맵 문서를 확인할 수 없습니다.");
  return result;
}

export function acquireFloorEditorLease(floorId: string, token?: string) {
  return apiPost<FloorEditorLease>(`/floors/${encodeURIComponent(floorId)}/editor-lease`, token ? { token } : {});
}

export function releaseFloorEditorLease(floorId: string, token: string, options: { keepalive?: boolean } = {}) {
  return apiRequest<{ released: boolean }>(`/floors/${encodeURIComponent(floorId)}/editor-lease`, {
    ...options,
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
}

export function listFloorEditorRevisions(floorId: string, query: { cursor?: number; limit?: number } = {}) {
  const search = new URLSearchParams();
  if (query.cursor !== undefined) search.set("cursor", String(query.cursor));
  if (query.limit !== undefined) search.set("limit", String(query.limit));
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return apiGet<FloorEditorRevisionPage>(`/floors/${encodeURIComponent(floorId)}/editor-revisions${suffix}`);
}

export function restoreFloorEditorRevision(floorId: string, revision: number, payload: RestoreFloorEditorRevisionInput) {
  return apiPost<FloorEditorState & { skippedFixtureIds: string[] }>(
    `/floors/${encodeURIComponent(floorId)}/editor-revisions/${revision}/restore`,
    payload
  );
}

export function createFloorImportJob(
  floorId: string,
  payload: { sourceAssetId: string; sourceFormat: CadImportSourceFormat }
) {
  return apiPost<FloorImportJob>(`/floors/${encodeURIComponent(floorId)}/import-jobs`, payload);
}

export function getActiveFloorImportJob(floorId: string) {
  return apiGet<{ job: FloorImportJob | null }>(
    `/floors/${encodeURIComponent(floorId)}/import-jobs/active`
  );
}

export function getAppliedFloorImportOverlay(floorId: string) {
  return apiGet<FloorImportAppliedOverlayResponse>(
    `/floors/${encodeURIComponent(floorId)}/import-jobs/applied-overlay`
  );
}

export function getFloorImportJob(floorId: string, jobId: string) {
  return apiGet<FloorImportJob>(floorImportJobPath(floorId, jobId));
}

export function listFloorImportCandidates(floorId: string, jobId: string) {
  return apiGet<FloorImportCandidateListResponse>(`${floorImportJobPath(floorId, jobId)}/candidates`);
}

export async function applyFloorImportJob(floorId: string, jobId: string, payload: FloorImportApplyInput) {
  return floorImportApplyResultSchema.parse(
    await apiPost<unknown>(`${floorImportJobPath(floorId, jobId)}/apply`, payload)
  );
}

export function cancelFloorImportJob(floorId: string, jobId: string) {
  return apiPost<FloorImportJob>(`${floorImportJobPath(floorId, jobId)}/cancel`, {});
}

function floorImportJobPath(floorId: string, jobId: string) {
  return `/floors/${encodeURIComponent(floorId)}/import-jobs/${encodeURIComponent(jobId)}`;
}

interface FloorAssetUploadIntent {
  assetId: string;
  uploadUrl: string;
  accessPath: string;
  expiresInSeconds: number;
}

export async function uploadFloorAsset(floorId: string, file: File): Promise<FloorAsset> {
  const bytes = await file.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const checksumSha256 = btoa(String.fromCharCode(...digest));
  const encodedFloorId = encodeURIComponent(floorId);
  const intent = await apiPost<FloorAssetUploadIntent>(`/floors/${encodedFloorId}/assets/upload-intent`, {
    kind: "original",
    mimeType: file.type,
    sizeBytes: file.size,
    sha256
  });
  const uploadResponse = await fetch(intent.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type,
      "x-amz-checksum-sha256": checksumSha256
    },
    body: file
  });
  if (!uploadResponse.ok) {
    throw new ApiError(`PUT floor asset failed with ${uploadResponse.status}`, uploadResponse.status, null);
  }
  return apiPost<FloorAsset>(
    `/floors/${encodedFloorId}/assets/${encodeURIComponent(intent.assetId)}/complete`,
    {}
  );
}
