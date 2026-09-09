import { beforeEach, describe, expect, it } from "vitest";
import { useFloorEditorStore } from "./editor-store";
import { buildEditorChanges } from "./editor-diff";
import type { FloorEditorState } from "./editor-types";

const baseline: FloorEditorState = {
  floor: { id: "floor-1", siteId: "site-1", name: "B1", level: -1, mapRevision: 3, floorPlan: null },
  fixtures: Array.from({ length: 1000 }, (_, i) => ({
    id: `f-${i}`, name: `L${i}`, x: 20 + i % 40 * 25, y: 20 + Math.floor(i / 40) * 25,
    size: 20, ratedWatt: 40, brightness: 70, status: "online" as const,
    placementStatus: "unplaced" as const, positionVerifiedAt: null
  })), objects: []
};

describe("placement commands", () => {
  beforeEach(() => useFloorEditorStore.getState().initialize(baseline));
  it("never mutates hidden fixtures and clears hidden selection", () => {
    const store = useFloorEditorStore.getState;
    store().selectFixture("f-0");
    store().setLayer("fixtures", { visible: false });
    store().updateFixture("f-0", { name: "hidden mutation" });
    expect(store().selectedFixtureIds).toEqual([]);
    expect(store().isDirty).toBe(false);
  });

  it("places the existing ID once, unplaces locally, and restores coordinates with undo/redo", () => {
    const store = useFloorEditorStore.getState;
    store().placeFixtures([{ id: "f-0", x: 123.5, y: 241 }]);
    expect(store().state!.fixtures).toHaveLength(1000);
    expect(store().state!.fixtures[0]).toMatchObject({ x: 123.5, y: 241, placementStatus: "placed", positionVerifiedAt: null });
    store().unplaceFixture("f-0");
    expect(store().selection).toBeNull();
    expect(buildEditorChanges(baseline, store().state!).fixtureUpdates[0]).toMatchObject({ id: "f-0" });
    store().undo();
    expect(store().state!.fixtures[0]).toMatchObject({ placementStatus: "placed", x: 123.5 });
    store().redo();
    expect(store().state!.fixtures[0].placementStatus).toBe("unplaced");
  });

  it("moves 1000 fixtures with one bounded delta and one undo step", () => {
    const store = useFloorEditorStore.getState;
    store().initialize({ ...baseline, fixtures: baseline.fixtures.map((f) => ({ ...f, placementStatus: "placed" })) });
    const before = store().state!;
    store().moveFixtures(before.fixtures.map((f) => f.id), { x: -1000, y: 5 });
    const after = store().state!;
    expect(after.fixtures[0].x).toBe(0);
    expect(after.fixtures[999].x - before.fixtures[999].x).toBe(-20);
    expect(store().past).toHaveLength(1);
    store().undo();
    expect(store().state).toEqual(before);
  });

  it("invalidates verification only for actual position changes", () => {
    const store = useFloorEditorStore.getState;
    store().initialize({ ...baseline, fixtures: [{ ...baseline.fixtures[0], placementStatus: "placed", positionVerifiedAt: "2026-09-09T00:00:00Z" }] });
    store().updateFixture("f-0", { name: "New", size: 30 });
    expect(store().state!.fixtures[0].positionVerifiedAt).toBeTruthy();
    store().updateFixture("f-0", { x: 20 });
    expect(store().state!.fixtures[0].positionVerifiedAt).toBeTruthy();
    store().updateFixture("f-0", { x: 22 });
    expect(store().state!.fixtures[0].positionVerifiedAt).toBeNull();
    expect(buildEditorChanges(store().initialState!, store().state!).fixtureUpdates[0]).toMatchObject({ positionVerified: false });
  });

  it("isolates floor selection, layer state and history and rejects IDs from another floor", () => {
    const store = useFloorEditorStore.getState;
    store().placeFixtures([{ id: "f-0", x: 12, y: 34 }]);
    store().initialize({ ...baseline, floor: { ...baseline.floor, id: "floor-2" }, fixtures: [] });
    store().placeFixtures([{ id: "f-0", x: 12, y: 34 }]);
    expect(store().state!.fixtures).toEqual([]);
    expect(store().past).toEqual([]);
    expect(store().selectedFixtureIds).toEqual([]);
    expect(store().isDirty).toBe(false);
  });
});
