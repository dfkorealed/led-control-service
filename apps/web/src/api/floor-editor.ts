import { apiGet, apiPost } from "./client";
import type { EditorFixture, FloorEditorState, FloorMapObject, FloorMapObjectDraft } from "../features/floor-editor/editor-types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

interface FloorPlanPayload {
  imageUrl: string;
  sourceType?: "none" | "image" | "pdf";
  originalFileUrl?: string | null;
  renderedImageUrl?: string | null;
  width: number;
  height: number;
}

export function getFloorEditorState(floorId: string) {
  return apiGet<FloorEditorState>(`/floors/${floorId}/editor-state`);
}

export function updateFloorPlan(floorId: string, payload: FloorPlanPayload) {
  return request<FloorEditorState["floor"]["floorPlan"]>(`/floors/${floorId}/floor-plan`, "PATCH", payload);
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
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`);
  if (response.status === 204) return { ok: true } as T;
  return response.json() as Promise<T>;
}
