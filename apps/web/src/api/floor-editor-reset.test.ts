import { afterEach, describe, expect, it, vi } from "vitest";
import { resetFloorEditorDocument, canInitializeEmptyFloor } from "./floor-editor-reset";
import type { FloorEditorState } from "../features/floor-editor/editor-types";

afterEach(() => vi.unstubAllGlobals());
const state: FloorEditorState = { floor: { id: "f", siteId: "s", name: "F", level: 1, mapRevision: 0, mapDocument: null, floorPlan: null }, fixtures: [], lightSlots: [], objects: [] };
describe("explicit editor reset boundary", () => {
  it("only auto-initializes a clearly empty null-reference revision-zero floor", () => {
    expect(canInitializeEmptyFloor(state)).toBe(true);
    expect(canInitializeEmptyFloor({ ...state, floor: { ...state.floor, mapRevision: 1 } })).toBe(false);
    expect(canInitializeEmptyFloor({ ...state, floor: { ...state.floor, mapDocument: undefined } })).toBe(false);
    expect(canInitializeEmptyFloor({ ...state, lightSlots: [{ id: "slot", x: 0, y: 0, rotation: 0, assignedFixtureId: null }] })).toBe(false);
  });
  it("uses the authenticated POST client and validates the strict document response", async () => {
    const ref = { formatVersion: 1, generationId: "gen", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: 0,
      manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(ref), { status: 200 })); vi.stubGlobal("fetch", fetch);
    const body = { requestId: "request", baseRevision: 0, leaseToken: "lease", leaseFence: 1 };
    expect(await resetFloorEditorDocument("floor /1", body)).toEqual(ref);
    expect(fetch).toHaveBeenCalledWith("/api/floors/floor%20%2F1/editor-reset", expect.objectContaining({ method: "POST", credentials: "include", body: JSON.stringify(body) }));
    fetch.mockResolvedValue(new Response(JSON.stringify({ ...ref, unexpected: true }), { status: 200 }));
    await expect(resetFloorEditorDocument("floor", body)).rejects.toThrow();
  });
});
