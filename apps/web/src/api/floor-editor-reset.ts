import { mapDocumentRefSchema, type MapDocumentRef } from "@led-control/shared/map-document-contracts";
import type { FloorEditorState } from "../features/floor-editor/editor-types";
import { apiPost } from "./client";

export interface FloorEditorResetInput { requestId: string; baseRevision: number; leaseToken: string; leaseFence: number }

export async function resetFloorEditorDocument(floorId: string, input: FloorEditorResetInput, options: { signal?: AbortSignal } = {}): Promise<MapDocumentRef> {
  return mapDocumentRefSchema.parse(await apiPost<unknown>(`/floors/${encodeURIComponent(floorId)}/editor-reset`, input, options));
}

/** Only an explicit null reference with no previous map state is automatic.
 * Missing references and any legacy content require destructive confirmation. */
export function canInitializeEmptyFloor(state: FloorEditorState): boolean {
  return state.floor.mapDocument === null && state.floor.mapRevision === 0 && !state.floor.cadScene
    && !state.floor.floorPlan && state.objects.length === 0 && state.lightSlots.length === 0
    && state.fixtures.every(fixture => fixture.placementStatus === "unplaced");
}
