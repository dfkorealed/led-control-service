import type { RestoreFloorEditorRevisionInput, SaveEditorStateInput } from "@led-control/shared";
import { apiGet, apiPost, apiPut, apiRequest } from "./client";
import type { EditorFixture, FloorEditorState, FloorMapObject, FloorMapObjectDraft } from "../features/floor-editor/editor-types";

interface FloorPlanPayload {
  imageUrl: string;
  sourceType?: "none" | "image" | "pdf";
  originalFileUrl?: string | null;
  renderedImageUrl?: string | null;
  width: number;
  height: number;
}

export function getFloorEditorState(floorId: string) {
  return apiGet<FloorEditorState>(`/floors/${encodeURIComponent(floorId)}/editor-state`);
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

export function saveFloorEditorState(floorId: string, payload: SaveEditorStateInput) {
  return apiPut<FloorEditorState>(`/floors/${encodeURIComponent(floorId)}/editor-state`, payload);
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

export function updateFloorPlan(floorId: string, payload: FloorPlanPayload) {
  return request<FloorEditorState["floor"]["floorPlan"]>(`/floors/${floorId}/floor-plan`, "PATCH", payload);
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

export function updateEditorFixture(fixtureId: string, payload: Partial<Pick<EditorFixture, "name" | "ratedWatt" | "x" | "y" | "size">>) {
  return request<EditorFixture>(`/fixtures/${fixtureId}`, "PATCH", payload);
}

export function createFloorMapObject(floorId: string, payload: FloorMapObjectDraft) {
  return apiPost<FloorMapObject>("/floor-map-objects", { ...payload, floorId });
}

export function updateFloorMapObject(objectId: string, payload: Partial<FloorMapObjectDraft>) {
  return request<FloorMapObject>(`/floor-map-objects/${objectId}`, "PATCH", payload);
}

export function deleteFloorMapObject(objectId: string) {
  return request<{ ok: true }>(`/floor-map-objects/${objectId}`, "DELETE");
}

async function request<T>(path: string, method: "PATCH" | "DELETE", body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
}
