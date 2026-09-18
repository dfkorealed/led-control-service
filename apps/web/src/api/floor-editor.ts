import type {
  CadImportSourceFormat,
  FloorImportApplyInput,
  FloorImportAppliedOverlayResponse,
  FloorImportCandidateListResponse,
  RestoreFloorEditorRevisionInput,
  SaveEditorStateInput
} from "@led-control/shared";
import { floorImportApplyResultSchema } from "@led-control/shared";
import type { FixtureIdentifyRequest, FixtureIdentifyResponse } from "@led-control/shared";
import { ApiError, apiGet, apiPost, apiPut, apiRequest } from "./client";
import type {
  FloorAsset,
  FloorEditorState,
  FloorImportJob
} from "../features/floor-editor/editor-types";

export function getFloorEditorState(floorId: string) {
  return apiGet<FloorEditorState>(`/floors/${encodeURIComponent(floorId)}/editor-state`);
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

export function saveFloorEditorState(floorId: string, payload: SaveEditorStateInput) {
  return apiPut<FloorEditorState>(`/floors/${encodeURIComponent(floorId)}/editor-state`, payload);
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
