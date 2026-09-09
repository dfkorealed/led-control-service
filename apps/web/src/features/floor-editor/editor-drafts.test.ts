import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { clearTenantCache } from "../../api/principal-cache";
import { clearEditorDrafts, editorDraftGeneration, editorDraftKey, loadEditorDraft, saveEditorDraft } from "./editor-drafts";
import { useFloorEditorStore } from "./editor-store";
import type { FloorEditorState } from "./editor-types";
const state: FloorEditorState = { floor: { id: "floor", siteId: "site", name: "B1", mapRevision: 3, level: 1, floorPlan: null }, fixtures: [{ id: "f1", name: "L1", x: 10, y: 20, size: 20, ratedWatt: 40, brightness: 70, status: "online", placementStatus: "unplaced", positionVerifiedAt: null }], objects: [] };
describe("scoped draft recovery", () => {
  afterEach(() => { clearEditorDrafts(); useFloorEditorStore.getState().reset(); });
  it("restores only the matching user/site/floor/revision and preserves current telemetry", () => {
    const draft = { ...state, fixtures: [{ ...state.fixtures[0], x: 45, placementStatus: "placed" as const }] };
    expect(saveEditorDraft("user1", state, draft)).toBe(true);
    expect(loadEditorDraft("user2", state)).toBeNull();
    expect(loadEditorDraft("user1", { ...state, floor: { ...state.floor, mapRevision: 4 } })).toBeNull();
    expect(loadEditorDraft("user1", { ...state, floor: { ...state.floor, siteId: "other" } })).toBeNull();
    expect(loadEditorDraft("user1", { ...state, fixtures: [{ ...state.fixtures[0], brightness: 90 }] })?.fixtures[0]).toMatchObject({ x: 45, placementStatus: "placed", brightness: 90 });
  });
  it("rejects malformed and foreign fixture edits", () => {
    localStorage.setItem(editorDraftKey("user", state), JSON.stringify({ version: 1, savedAt: Date.now(), changes: { expectedRevision: 3, fixtureUpdates: [{ id: "foreign", x: 20 }], objectCreates: [], objectUpdates: [], objectDeletes: [] } }));
    expect(loadEditorDraft("user", state)).toBeNull();
  });
  it("purges the singleton draft/history and advances generation on auth cleanup", () => {
    const store = useFloorEditorStore.getState;
    store().initialize(state); store().placeFixtures([{ id: "f1", x: 100, y: 200 }]);
    saveEditorDraft("user", state, store().state!);
    const generation = editorDraftGeneration();
    clearTenantCache(new QueryClient());
    expect(store()).toMatchObject({ state: null, initialState: null, isDirty: false, past: [], future: [], selectedFixtureIds: [] });
    expect(editorDraftGeneration()).toBeGreaterThan(generation);
    expect(loadEditorDraft("user", state)).toBeNull();
  });
});
