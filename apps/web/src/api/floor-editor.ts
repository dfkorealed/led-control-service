import type { RestoreFloorEditorRevisionInput, SaveEditorStateInput } from "@led-control/shared";
import type { FixtureIdentifyRequest, FixtureIdentifyResponse } from "@led-control/shared";
import { apiGet, apiPost, apiPut, apiRequest } from "./client";
import type { FloorEditorState } from "../features/floor-editor/editor-types";

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

export async function uploadFloorAsset(floorId: string, file: Blob, kind: "original" | "rendered") {
  const mimeType = file.type;
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const checksumBase64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const intent = await apiPost<{ assetId: string; uploadUrl: string; publicUrl: string }>(
    `/floors/${floorId}/assets/upload-intent`,
    { kind, mimeType, sizeBytes: file.size, sha256 }
  );
  const response = await fetch(intent.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType, "x-amz-checksum-sha256": checksumBase64 },
    body: file
  });
  if (!response.ok) throw new Error(`floor asset upload failed with ${response.status}`);
  return apiPost<{ id: string; status: "ready"; publicUrl: string }>(
    `/floors/${floorId}/assets/${intent.assetId}/complete`,
    {}
  );
}
