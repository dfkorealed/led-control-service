import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapElement, MapOp } from "@led-control/shared";
import { useFloorEditorStore } from "./editor-store";
import type { FloorEditorState } from "./editor-types";
import { clearEditorDrafts, editorDraftGeneration, loadEditorDraft, saveEditorDraft } from "./editor-drafts";
import { CommonMapStore } from "./common-map-store";

const store = useFloorEditorStore.getState;
const lease = { leaseToken: "lease", leaseFence: 1 };
const element = (id = "shape"): MapElement => ({
  id, type: "rectangle", groupId: null, layerId: "layer", zIndex: 0,
  visible: true, locked: false, provenance: null,
  transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
  style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 },
  geometry: { origin: { x: 10, y: 10 }, width: 20, height: 30 }
});
const baseline = (): FloorEditorState => ({
  floor: { id: "floor", siteId: "site", name: "B1", level: 1, mapRevision: 3, floorPlan: null,
    mapDocument: { formatVersion: 1, generationId: "generation", revision: 3, width: 16384,
      height: 8192, gridSize: 80, elementCount: 1,
      manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } },
  fixtures: [{ id: "fixture", name: "Light", x: 10, y: 20, ratedWatt: 40, brightness: 80, status: "online" }],
  objects: [], lightSlots: []
});
const ack = (revision = 4): FloorEditorState => {
  const state = baseline();
  return { ...state, floor: { ...state.floor, mapRevision: revision,
    mapDocument: { ...state.floor.mapDocument!, revision } } };
};
function operations() {
  const request = store().prepareSave(lease);
  expect(request.kind).toBe("normal");
  return request.payload.documentChanges!.operations;
}

describe("common map store integration", () => {
  beforeEach(() => {
    store().initialize(baseline(), "user");
    store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "layer", name: "Shapes", order: 0, visible: true, locked: false }] });
    store().loadMapElements(store().mapScope!, [element()]);
  });

  it("edits, saves, undoes a saved deletion, resaves and reloads canonical elements", async () => {
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }] });
    expect(store().isDirty).toBe(true);
    expect(store().mapElements.has("shape")).toBe(false);
    const transport = vi.fn().mockResolvedValue(ack());
    expect(await store().saveChanges(lease, transport)).toBe("saved");
    expect(store().isDirty).toBe(false);
    expect(transport.mock.calls[0][1]).toMatchObject({ expectedRevision: 3, ...lease,
      objectCreates: [], objectUpdates: [], objectDeletes: [],
      documentChanges: { generationId: "generation", operations: [{ kind: "delete", id: "shape" }] } });
    store().undo();
    expect(store().mapElements.get("shape")).toEqual(element());
    expect(operations()).toEqual([{ kind: "add", element: element() }]);
    expect(store().isDirty).toBe(true);
    await store().saveChanges(lease, vi.fn().mockResolvedValue(ack(5)));
    store().initialize(ack(5), "user");
    store().loadMapElements(store().mapScope!, [element()]);
    expect(store().mapElements.get("shape")).toEqual(element());
    expect(store().isDirty).toBe(false);
  });

  it("coalesces add/edit/delete and supports multi-delete as one undo", () => {
    store().applyMapTransaction({ operations: [{ kind: "add", element: element("new") }] });
    store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element("new"), zIndex: 2 } }] });
    expect(operations()).toEqual([{ kind: "add", element: { ...element("new"), zIndex: 2 } }]);
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "new" }, { kind: "delete", id: "shape" }] });
    expect(operations()).toEqual([{ kind: "delete", id: "shape" }]);
    store().undo();
    expect(store().mapElements.size).toBe(2);
    store().redo();
    expect(store().mapElements.size).toBe(0);
  });

  it("combines fixture and shape commands in one undo transaction", () => {
    store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), zIndex: 3 } }],
      fixtureUpdates: [{ id: "fixture", name: "Changed" }] });
    expect(store().past).toHaveLength(1);
    expect(store().state!.fixtures[0].name).toBe("Changed");
    store().undo();
    expect(store().state!.fixtures[0].name).toBe("Light");
    expect(store().mapElements.get("shape")!.zIndex).toBe(0);
    expect(store().isDirty).toBe(false);
    store().redo();
    expect(store().mapElements.get("shape")!.zIndex).toBe(3);
    expect(store().state!.fixtures[0].name).toBe("Changed");
  });

  it.each([undefined, true])("keeps transaction snapping opt-in precision=%s and preserves atomic history", preserveFixturePositions => {
    store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), transform: { ...element().transform, x: 80 } } }],
      fixtureUpdates: [{ id: "fixture", x: 90, y: 100 }], preserveFixturePositions });
    expect(store().state!.fixtures[0]).toMatchObject(preserveFixturePositions ? { x: 90, y: 100 } : { x: 80, y: 80 });
    expect(store().past).toHaveLength(1);
    store().undo();
    expect(store().state!.fixtures[0]).toMatchObject({ x: 10, y: 20 });
    expect(store().mapElements.get("shape")!.transform.x).toBe(0);
    store().redo();
    expect(store().state!.fixtures[0]).toMatchObject(preserveFixturePositions ? { x: 90, y: 100 } : { x: 80, y: 80 });
  });

  it("still rejects invalid or locked fixture patches atomically with precision enabled", () => {
    const apply = (x: number) => store().applyMapTransaction({ preserveFixturePositions: true,
      operations: [{ kind: "delete", id: "shape" }], fixtureUpdates: [{ id: "fixture", x }] });
    expect(() => apply(NaN)).toThrow();
    store().toggleFixtureLock(["fixture"]);
    expect(() => apply(90)).toThrow();
    expect(store().mapElements.has("shape")).toBe(true);
    expect(store().state!.fixtures[0].x).toBe(10);
    expect(store().past).toHaveLength(0);
  });

  it("preserves mixed additive selections and undoes one mixed gesture atomically", () => {
    store().selectFixture("fixture");
    store().selectMapElements(["shape"], true);
    store().selectMapGroups(["group"], true);
    expect(store().selectedFixtureIds).toEqual(["fixture"]);
    expect(store().mapSelection).toEqual({ elementIds: ["shape"], groupIds: ["group"] });
    store().selectFixtures(["fixture"], true);
    expect(store().mapSelection.elementIds).toEqual(["shape"]);
    store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), transform: { ...element().transform, x: 80 } } }],
      fixtureUpdates: [{ id: "fixture", x: 90 }] });
    expect(store().past).toHaveLength(1);
    store().undo();
    expect(store().state!.fixtures[0].x).toBe(10); expect(store().mapElements.get("shape")!.transform.x).toBe(0);
    expect(store().selectedFixtureIds).toEqual(["fixture"]); expect(store().mapSelection.groupIds).toEqual(["group"]);
    store().selectFixture("fixture", true); expect(store().selectedFixtureIds).toEqual([]); expect(store().mapSelection.elementIds).toEqual(["shape"]);
    store().selectMapElements(["shape"]); expect(store().selectedFixtureIds).toEqual([]); expect(store().mapSelection.groupIds).toEqual([]);
  });

  it("persists a normal saved-delete inverse with the exact session auth scope, not raw user ID", async () => {
    const authScope = "user:4:admin";
    store().initialize(baseline(), authScope);
    store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "layer", name: "Shapes", order: 0, visible: true, locked: false }] });
    store().loadMapElements(store().mapScope!, [element()]);
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }] });
    expect(saveEditorDraft("user", baseline(), store().state!, store().exportMapDraft())).toBe(false);
    expect(saveEditorDraft(authScope, baseline(), store().state!, store().exportMapDraft())).toBe(true);
    await store().saveChanges(lease, vi.fn().mockResolvedValue(ack()));
    expect(store().exportMapDraft()).toMatchObject({ scope: { authScope, baseRevision: 4 }, operations: [], inverse: [] });
    expect(saveEditorDraft(authScope, store().initialState!, store().state!, store().exportMapDraft())).toBe(true);
    store().undo();
    expect(saveEditorDraft(authScope, store().initialState!, store().state!, store().exportMapDraft())).toBe(true);
    expect(loadEditorDraft(authScope, store().initialState!)?.commonMapDraft?.operations).toEqual([{ kind: "add", element: element() }]);
  });

  it("preserves failed saves and retries the exact request ID until payload changes", async () => {
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }] });
    const transport = vi.fn().mockRejectedValue(new Error("lost response"));
    await expect(store().saveChanges(lease, transport)).rejects.toThrow("lost response");
    await expect(store().saveChanges(lease, transport)).rejects.toThrow("lost response");
    expect(transport.mock.calls[0][1]).toEqual(transport.mock.calls[1][1]);
    expect(store().isDirty).toBe(true);
    store().updateFixture("fixture", { name: "Changed" });
    await expect(store().saveChanges(lease, transport)).rejects.toThrow();
    expect(transport.mock.calls[2][1].documentChanges.requestId).not.toBe(transport.mock.calls[0][1].documentChanges.requestId);
  });

  it("ignores late save and canonical loads after an auth/site/floor transition", async () => {
    const oldScope = store().mapScope!;
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }] });
    let resolve!: (state: FloorEditorState) => void;
    const pending = store().saveChanges(lease, () => new Promise((done) => { resolve = done; }));
    store().initialize({ ...baseline(), floor: { ...baseline().floor, siteId: "another" } }, "other-user");
    expect(store().loadMapElements(oldScope, [element("stale")])).toBe(false);
    resolve(ack());
    expect(await pending).toBe("stale");
    expect(store().state!.floor.siteId).toBe("another");
    expect(store().mapElements.size).toBe(0);
  });

  it("rebases changes made while save is in flight without claiming them saved", async () => {
    store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), zIndex: 2 } }] });
    let resolve!: (state: FloorEditorState) => void;
    const pending = store().saveChanges(lease, () => new Promise((done) => { resolve = done; }));
    store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), zIndex: 3 } }] });
    resolve(ack());
    expect(await pending).toBe("saved");
    expect(store().mapElements.get("shape")!.zIndex).toBe(3);
    expect(store().isDirty).toBe(true);
    expect(store().prepareSave(lease).payload.expectedRevision).toBe(4);
    store().undo();
    expect(store().isDirty).toBe(false);
  });

  it("returns explicit staging-required for 2001 ops without truncation or an HTTP call", async () => {
    const ops: MapOp[] = Array.from({ length: 2001 }, (_, index) => ({ kind: "add", element: element(`new-${index}`) }));
    store().applyMapTransaction({ operations: ops });
    const prepared = store().prepareSave(lease);
    expect(prepared.kind).toBe("staging-required");
    expect(prepared.payload.documentChanges!.operations).toHaveLength(2001);
    const transport = vi.fn();
    const stage = { prepare: vi.fn().mockRejectedValue(new Error("stage unavailable")) };
    await expect(store().saveChanges(lease, transport, stage as never)).rejects.toThrow("stage unavailable");
    expect(stage.prepare).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
    expect(store().isDirty).toBe(true);
  });

  it("retains dirty originals outside the bounded clean cache and does not snapshot a canonical map", () => {
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }] });
    for (let i = 0; i < 600; i++) store().loadMapElements(store().mapScope!, [element(`loaded-${i}`)]);
    expect(store().mapElements.size).toBeLessThanOrEqual(256);
    expect(JSON.stringify(store().past)).not.toContain("loaded-599");
    store().undo();
    expect(store().mapElements.get("shape")).toEqual(element());
  });

  it("preserves the document on malformed or generation-changing normal-save responses", async () => {
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }] });
    for (const response of [baseline(), { ...ack(), floor: { ...ack().floor, mapDocument: null } }]) {
      await expect(store().saveChanges(lease, async () => response)).rejects.toBeDefined();
      expect(store().state!.floor.mapDocument!.generationId).toBe("generation");
      expect(store().isDirty).toBe(true);
    }
  });

  it("saves and restores a sparse authenticated draft with originals and one combined undo", () => {
    clearEditorDrafts();
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }], fixtureUpdates: [{ id: "fixture", name: "Draft" }] });
    expect(saveEditorDraft("user", baseline(), store().state!, store().exportMapDraft())).toBe(true);
    const restored = loadEditorDraft("user", baseline());
    expect(restored).not.toBeNull();
    store().initialize(baseline(), "user");
    store().recoverDraft(restored!);
    expect(operations()).toEqual([{ kind: "delete", id: "shape" }]);
    expect(store().state!.fixtures[0].name).toBe("Draft");
    store().undo();
    expect(store().mapElements.get("shape")).toEqual(element());
    expect(store().state!.fixtures[0].name).toBe("Light");
    expect(store().isDirty).toBe(false);
  });

  it("refuses stale generation/revision/user drafts and delayed writes after auth cleanup", () => {
    clearEditorDrafts();
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }] });
    const draft = store().exportMapDraft()!, generation = editorDraftGeneration();
    expect(saveEditorDraft("user", baseline(), store().state!, draft)).toBe(true);
    expect(loadEditorDraft("other", baseline())).toBeNull();
    const otherGeneration = baseline(); otherGeneration.floor.mapDocument!.generationId = "new-generation";
    expect(loadEditorDraft("user", otherGeneration)).toBeNull();
    expect(loadEditorDraft("user", ack())).toBeNull();
    clearEditorDrafts();
    expect(saveEditorDraft("user", baseline(), store().state!, draft, generation)).toBe(false);
  });

  it("preserves group/layer changes and fixture-only saves in the common timeline", () => {
    const group = { id: "group", parentId: null, name: "Group", visible: true, locked: false };
    store().applyMapTransaction({ operations: [{ kind: "group.put", group },
      { kind: "update", element: { ...element(), groupId: group.id } }] });
    expect(store().mapGroups.get("group")).toEqual(group);
    store().undo();
    expect(store().mapGroups.size).toBe(0);
    expect(store().mapElements.get("shape")!.groupId).toBeNull();
    store().updateFixture("fixture", { name: "Only fixture" });
    expect(operations()).toEqual([]);
    expect(store().prepareSave(lease).payload.fixtureUpdates).toEqual([{ id: "fixture", name: "Only fixture" }]);
  });

  it("can inject affected originals for a selection larger than the clean cache", () => {
    const originals = Array.from({ length: 600 }, (_, index) => element(`large-${index}`));
    store().applyMapTransaction({ scope: store().mapScope!, canonicalElements: originals,
      operations: originals.map((item) => ({ kind: "delete", id: item.id })) });
    expect(operations()).toHaveLength(600);
    store().undo();
    expect(store().mapElements.get("large-0")).toEqual(originals[0]);
    expect(store().mapElements.get("large-599")).toEqual(originals[599]);
    expect(store().isDirty).toBe(false);
  });

  it("keeps private originals and history intact when initialization fails", () => {
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }] });
    const invalid = baseline(); invalid.floor.mapDocument!.revision = 999;
    expect(() => store().initialize(invalid, "user")).toThrow();
    expect(operations()).toEqual([{ kind: "delete", id: "shape" }]);
    store().undo();
    expect(store().mapElements.get("shape")).toEqual(element());
  });

  it("keeps common and fixture selections exclusive and rejects legacy shape edits after conversion", () => {
    store().selectMapGroups(["group"]);
    store().selectFixture("fixture");
    expect(store().mapSelection).toEqual({ elementIds: [], groupIds: [] });
    store().selectMapElements(["shape"]);
    store().clearSelection();
    expect(store().mapSelection.elementIds).toEqual([]);
    expect(() => store().removeObject("legacy")).toThrow();
  });

  it("uses common dimensions for fixtures and drafts a U6b resize checkpoint", () => {
    store().setSnap(false);
    store().placeFixtures([{ id: "fixture", x: 12000, y: 4000 }]);
    expect(store().state!.fixtures[0]).toMatchObject({ x: 12000, y: 4000 });
    expect(store().updateMapSettings({ width: 20000, height: 10000, gridSize: 80 })).toBeNull();
    expect(store().prepareSave(lease).reason).toBe("checkpoint");
    expect(store().state!.floor.mapDocument!.width).toBe(16384);
  });

  it("rejects locked elements, inherited locks and out-of-bounds edits atomically", () => {
    store().loadMapElements(store().mapScope!, [{ ...element(), locked: true }]);
    expect(() => store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }], fixtureUpdates: [{ id: "fixture", name: "Wrong" }] })).toThrow();
    expect(store().state!.fixtures[0].name).toBe("Light");
    expect(store().isDirty).toBe(false);
    store().loadMapElements(store().mapScope!, [element()]);
    store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "layer", name: "Shapes", order: 0, visible: true, locked: true }] });
    expect(() => store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }] })).toThrow();
    store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "layer", name: "Shapes", order: 0, visible: true, locked: false }] });
    expect(() => store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), transform: { ...element().transform, x: 50000 } } }] })).toThrow();
  });

  it("does not evict complete manifest groups/layers while churning clean elements", () => {
    const groups = Array.from({ length: 600 }, (_, index) => ({ id: `group-${index}`, parentId: null, name: `Group ${index}`, locked: false, visible: true }));
    const layers = Array.from({ length: 600 }, (_, index) => ({ id: `layer-${index}`, name: `Layer ${index}`, order: index, locked: false, visible: true }));
    store().loadMapStructures(store().mapScope!, { groups, layers });
    store().loadMapElements(store().mapScope!, Array.from({ length: 600 }, (_, index) => element(`cache-${index}`)));
    const first = { ...element("first"), groupId: "group-0", layerId: "layer-0" };
    const last = { ...element("last"), groupId: "group-599", layerId: "layer-599" };
    store().loadMapElements(store().mapScope!, [first, last]);
    expect(store().mapGroups.size).toBe(600);
    expect(store().mapLayers.size).toBe(601);
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "first" }, { kind: "delete", id: "last" }] });
    expect(operations()).toHaveLength(2);
    store().undo();
    expect(store().mapElements.get("first")).toEqual(first);
  });

  it("rejects a missing delete and invalid fixture update without publishing part of a transaction", () => {
    expect(() => store().applyMapTransaction({ operations: [{ kind: "delete", id: "not-loaded" }] })).toThrow();
    expect(() => store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }],
      fixtureUpdates: [{ id: "fixture", ratedWatt: -1 }] })).toThrow();
    expect(store().mapElements.has("shape")).toBe(true);
    expect(store().past).toHaveLength(0);
  });

  it("persists map grid settings together with shape changes in a recoverable draft", () => {
    clearEditorDrafts();
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }],
      floorPlan: { sourceType: "none", imageUrl: "", originalFileUrl: null, renderedImageUrl: null,
        width: 16384, height: 8192, gridSize: 40, version: 1 } });
    expect(saveEditorDraft("user", baseline(), store().state!, store().exportMapDraft())).toBe(true);
    const draft = loadEditorDraft("user", baseline());
    expect(draft?.floor.floorPlan?.gridSize).toBe(40);
    store().initialize(baseline(), "user");
    store().recoverDraft(draft!);
    store().undo();
    expect(store().state!.floor.floorPlan).toBeNull();
    expect(store().isDirty).toBe(false);
  });

  it("does not restore a foreign source asset or malformed common inverse from storage", () => {
    clearEditorDrafts();
    store().applyMapTransaction({ operations: [{ kind: "delete", id: "shape" }] });
    expect(saveEditorDraft("user", baseline(), { ...store().state!, floor: { ...store().state!.floor,
      floorPlan: { sourceType: "image", imageUrl: "/foreign.png", width: 16384, height: 8192, version: 1 } } }, store().exportMapDraft())).toBe(false);
    const draft = store().exportMapDraft()!;
    expect(() => store().recoverDraft({ ...baseline(), commonMapDraft: { ...draft,
      inverse: [{ kind: "delete", id: "shape" }] } })).toThrow();
    expect(operations()).toEqual([{ kind: "delete", id: "shape" }]);
  });

  it("keeps in-flight fixture movement unverified after adopting a save ACK", async () => {
    store().updateFixture("fixture", { name: "Renamed" });
    let resolve!: (state: FloorEditorState) => void;
    const pending = store().saveChanges(lease, () => new Promise((done) => { resolve = done; }));
    store().placeFixtures([{ id: "fixture", x: 200, y: 200 }]);
    const response = ack(); response.fixtures[0] = { ...response.fixtures[0], name: "Renamed", positionVerifiedAt: "2026-09-19T00:00:00Z" };
    resolve(response);
    await pending;
    expect(store().state!.fixtures[0].positionVerifiedAt).toBeNull();
    expect(store().isDirty).toBe(true);
  });

  it("classifies a grid checkpoint and a sub-2000-op oversized body for staging", () => {
    store().updateMapSettings({ width: 16384, height: 8192, gridSize: 40 });
    expect(store().prepareSave(lease)).toMatchObject({ kind: "staging-required", reason: "checkpoint" });
    store().undo();
    store().applyMapTransaction({ operations: Array.from({ length: 20 }, (_, index) => ({ kind: "add",
      element: { ...element(`text-${index}`), type: "text", geometry: { position: { x: 0, y: 0 },
        width: 100, height: 30, fontSize: 16, text: "x".repeat(60000) } } })) });
    expect(store().prepareSave(lease)).toMatchObject({ kind: "staging-required", reason: "bytes" });
    expect(store().prepareSave(lease).payload.documentChanges!.operations).toHaveLength(20);
  });

  it("combines a fixture placement and slot assignment with shape editing", () => {
    const initial = baseline(); initial.fixtures[0].placementStatus = "unplaced";
    initial.lightSlots = [{ id: "slot", x: 400, y: 400, rotation: 0, assignedFixtureId: null }];
    store().initialize(initial, "user");
    store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "layer", name: "Shapes", order: 0, visible: true, locked: false }] });
    store().applyMapTransaction({ scope: store().mapScope!, canonicalElements: [element()], operations: [{ kind: "delete", id: "shape" }],
      fixtureUpdates: [{ id: "fixture", x: 400, y: 400, placementStatus: "placed" }],
      slotAssignments: [{ slotId: "slot", assignedFixtureId: "fixture" }] });
    expect(store().prepareSave(lease).payload.slotAssignments).toEqual([{ slotId: "slot", assignedFixtureId: "fixture" }]);
    store().undo();
    expect(store().state!.fixtures[0].placementStatus).toBe("unplaced");
    expect(store().state!.lightSlots[0].assignedFixtureId).toBeNull();
    expect(store().mapElements.has("shape")).toBe(true);
    expect(store().isDirty).toBe(false);
  });

  it("fences delayed canonical transaction injection after switching documents", () => {
    const oldScope = store().mapScope!;
    store().initialize(baseline(), "new-user");
    store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "layer", name: "Shapes", order: 0, visible: true, locked: false }] });
    expect(() => store().applyMapTransaction({ scope: oldScope, canonicalElements: [element()],
      operations: [{ kind: "delete", id: "shape" }] })).toThrow();
    expect(store().isDirty).toBe(false);
    expect(store().mapElements.size).toBe(0);
  });

  it.each([false, true])("keeps ACK rebase originals after undo, a new branch and cache churn (evict=%s)", async (evict) => {
    store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), zIndex: 2 } }] });
    let resolve!: (state: FloorEditorState) => void;
    const pending = store().saveChanges(lease, () => new Promise((done) => { resolve = done; }));
    store().undo();
    store().updateFixture("fixture", { name: "New branch" });
    expect(store().future).toHaveLength(0);
    if (evict) store().loadMapElements(store().mapScope!, Array.from({ length: 257 }, (_, i) => element(`other-${i}`)));
    resolve(ack());
    expect(await pending).toBe("saved");
    expect(operations()).toEqual([{ kind: "update", element: element() }]);
    expect(store().mapElements.get("shape")).toEqual(element());
    expect(store().state!.fixtures[0].name).toBe("New branch");
  });

  it.each(["fixture", "slot", "settings"] as const)("recovers %s-only drafts without empty map history frames", (kind) => {
    clearEditorDrafts();
    const initial = baseline();
    initial.lightSlots = [{ id: "slot", x: 10, y: 20, rotation: 0, assignedFixtureId: null }];
    store().initialize(initial, "user");
    if (kind === "fixture") store().updateFixture("fixture", { name: "Draft" });
    if (kind === "slot") store().applyMapTransaction({ operations: [], slotAssignments: [{ slotId: "slot", assignedFixtureId: "fixture" }] });
    if (kind === "settings") store().updateMapSettings({ width: 16384, height: 8192, gridSize: 40 });
    const edited = store().state!;
    expect(store().exportMapDraft()!.operations).toEqual([]);
    expect(saveEditorDraft("user", initial, edited, store().exportMapDraft())).toBe(true);
    const recovered = loadEditorDraft("user", initial)!;
    store().initialize(initial, "user");
    store().recoverDraft(recovered);
    expect(store().past).toHaveLength(1);
    expect(store().past[0].mapCommand).toBeUndefined();
    expect(store().past[0].mapSelection).toEqual({ elementIds: [], groupIds: [] });
    store().undo();
    expect(store().state!.fixtures).toEqual(initial.fixtures);
    expect(store().state!.lightSlots).toEqual(initial.lightSlots);
    expect(store().state!.floor).toEqual(initial.floor);
    expect(store().isDirty).toBe(false);
    expect(store().future[0].mapCommand).toBeUndefined();
    store().redo();
    expect(store().state!.fixtures).toEqual(edited.fixtures);
    expect(store().state!.lightSlots).toEqual(edited.lightSlots);
    expect(store().state!.floor).toEqual(edited.floor);
    expect(store().state!.floor.mapDocument).toEqual(initial.floor.mapDocument);
    expect(store().isDirty).toBe(true);
  });

  it("retains an explicit undone-add tombstone while its successful ACK is pending", async () => {
    store().applyMapTransaction({ operations: [{ kind: "add", element: element("new") }] });
    let resolve!: (state: FloorEditorState) => void;
    const pending = store().saveChanges(lease, () => new Promise((done) => { resolve = done; }));
    store().undo(); store().updateFixture("fixture", { name: "New branch" });
    store().loadMapElements(store().mapScope!, Array.from({ length: 257 }, (_, i) => element(`other-${i}`)));
    resolve(ack()); await pending;
    expect(operations()).toEqual([{ kind: "delete", id: "new" }]);
    expect(store().mapElements.has("new")).toBe(false);
  });

  it("releases clean pending pins after a failed save without leaking them into a new scope", async () => {
    store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), zIndex: 2 } }] });
    let reject!: (error: Error) => void;
    const pending = store().saveChanges(lease, () => new Promise((_done, fail) => { reject = fail; }));
    const outcome = expect(pending).rejects.toThrow("failed");
    store().undo(); store().updateFixture("fixture", { name: "New branch" });
    reject(new Error("failed")); await outcome;
    store().loadMapElements(store().mapScope!, Array.from({ length: 257 }, (_, i) => element(`other-${i}`)));
    expect(store().mapElements.has("shape")).toBe(false);
    expect(store().mapElements.size).toBeLessThanOrEqual(256);
    expect(operations()).toEqual([]);
    store().initialize(baseline(), "other-user");
    expect(store().mapElements.size).toBe(0);
    expect(store().isSaving).toBe(false);
  });

  it("does not let a stale ACK release the new scope's pending originals", async () => {
    store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), zIndex: 2 } }] });
    let resolveOld!: (state: FloorEditorState) => void;
    const oldSave = store().saveChanges(lease, () => new Promise((done) => { resolveOld = done; }));
    store().initialize(baseline(), "new-user");
    store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "layer", name: "Shapes", order: 0, visible: true, locked: false }] });
    store().loadMapElements(store().mapScope!, [element()]);
    store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), zIndex: 3 } }] });
    let resolveNew!: (state: FloorEditorState) => void;
    const newSave = store().saveChanges(lease, () => new Promise((done) => { resolveNew = done; }));
    resolveOld(ack());
    expect(await oldSave).toBe("stale");
    expect(store().isSaving).toBe(true);
    store().undo(); store().updateFixture("fixture", { name: "New scope branch" });
    store().loadMapElements(store().mapScope!, Array.from({ length: 257 }, (_, i) => element(`other-${i}`)));
    resolveNew(ack());
    expect(await newSave).toBe("saved");
    expect(operations()).toEqual([{ kind: "update", element: element() }]);
    expect(store().mapScope!.authScope).toBe("new-user");
  });

  it("rejects unloaded ACK targets before changing any baseline rather than inventing tombstones", () => {
    const adapter = new CommonMapStore();
    adapter.loadElements([element()]);
    expect(() => adapter.acknowledge([
      { kind: "update", element: { ...element(), zIndex: 9 } },
      { kind: "delete", id: "not-loaded" }
    ])).toThrow(expect.objectContaining({ code: "MAP_ACK_TARGET_UNLOADED" }));
    expect(adapter.isDirty).toBe(false);
    adapter.applyPrepared(adapter.prepare([{ kind: "update", element: { ...element(), zIndex: 2 } }]));
    expect(adapter.draft(store().mapScope!).inverse).toEqual([{ kind: "update", element: element() }]);
  });
});
