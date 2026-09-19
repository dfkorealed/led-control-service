import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFloorEditorStore } from "./editor-store";
import type { FloorEditorState } from "./editor-types";
import type { EDITOR_MAX_NAME_LENGTH } from "@led-control/shared";
import { buildEditorChanges } from "./editor-diff";

const maxNameLength: typeof EDITOR_MAX_NAME_LENGTH = 200;

const initialState: FloorEditorState = {
  floor: { id: "floor-1", siteId: "site-1", name: "B1", level: -1, mapRevision: 3, floorPlan: null },
  fixtures: [{
    id: "fixture-1", name: "L1", x: 10, y: 20, size: 20, ratedWatt: 40,
    brightness: 70, status: "online"
  }],
  lightSlots: [],
  objects: []
};

describe("floor editor store baseline", () => {
  beforeEach(() => {
    useFloorEditorStore.getState().initialize(initialState);
  });

  it("fits the largest native CAD map on a narrow viewport below ten percent zoom", () => {
    const store = useFloorEditorStore.getState();
    store.setViewport({ width: 320, height: 420 });
    store.fit(false, { width: 32_768, height: 16_384 });
    const fitted = useFloorEditorStore.getState();
    expect(fitted.zoom * 32_768).toBeLessThanOrEqual(272);
    expect(fitted.pan.x).toBeGreaterThanOrEqual(24);
    store.setZoom(fitted.zoom / 1.1);
    expect(useFloorEditorStore.getState().zoom).toBeLessThan(fitted.zoom);
  });

  it("enables grid snapping whenever an editor state is initialized", () => {
    expect(useFloorEditorStore.getState().snap).toBe(true);

    useFloorEditorStore.getState().setSnap(false);
    useFloorEditorStore.getState().initialize(initialState);

    expect(useFloorEditorStore.getState().snap).toBe(true);
  });

  it("keeps CAD and manual selections mutually exclusive", () => {
    const cadGroup = {
      mode: "group" as const,
      targetId: "group-1",
      elementId: "cad-element-00000000000000000000000000000001",
      groupId: "group-1",
      layerName: "WALL"
    };

    useFloorEditorStore.getState().selectCad(cadGroup);
    expect(useFloorEditorStore.getState()).toMatchObject({
      cadSelection: cadGroup,
      selection: null,
      selectedFixtureIds: []
    });

    useFloorEditorStore.getState().selectFixture("fixture-1");
    expect(useFloorEditorStore.getState()).toMatchObject({
      cadSelection: null,
      selection: { kind: "fixture", id: "fixture-1" }
    });
  });

  it("fits an explicit CAD preview viewport instead of the stored floor-plan ratio", () => {
    useFloorEditorStore.getState().initialize({
      ...initialState,
      floor: {
        ...initialState.floor,
        floorPlan: {
          sourceType: "image", imageUrl: "/old.svg", originalFileUrl: "/old.svg",
          renderedImageUrl: "/old.svg", width: 1200, height: 800, gridSize: 10, version: 1
        }
      }
    });
    useFloorEditorStore.getState().setViewport({ width: 800, height: 600 });

    useFloorEditorStore.getState().fit(false, { width: 640, height: 360 });

    expect(useFloorEditorStore.getState().zoom).toBeCloseTo(1.175);
    expect(useFloorEditorStore.getState().pan).toEqual({ x: 24, y: 88.5 });
  });

  it("becomes dirty only when an editable value actually changes", () => {
    useFloorEditorStore.getState().setSnap(false);
    useFloorEditorStore.getState().updateFixture("fixture-1", { x: 10 });
    expect(useFloorEditorStore.getState().isDirty).toBe(false);

    useFloorEditorStore.getState().updateFixture("fixture-1", { x: 11 });
    expect(useFloorEditorStore.getState().isDirty).toBe(true);
  });

  it("snaps fixture movement to absolute grid coordinates", () => {
    useFloorEditorStore.getState().setSnap(true);
    useFloorEditorStore.getState().moveFixtures(["fixture-1"], { x: 7, y: 7 });

    expect(useFloorEditorStore.getState().state!.fixtures[0]).toMatchObject({ x: 20, y: 30 });
  });

  it("snaps only object position after movement without changing its size", () => {
    useFloorEditorStore.getState().initialize({
      ...initialState,
      floor: {
        ...initialState.floor,
        floorPlan: { sourceType: "none", imageUrl: "", originalFileUrl: null, renderedImageUrl: null, width: 1200, height: 800, gridSize: 20, version: 1 }
      },
      objects: [{
        id: "object-1", floorId: "floor-1", type: "rectangle", x: 100, y: 100, width: 96, height: 64, points: null,
        rotation: 0, strokeColor: "#000000", fillColor: "#ffffff", strokeWidth: 1,
        text: "", fontSize: null, zIndex: 1, locked: false, visible: true
      }]
    });
    useFloorEditorStore.getState().setSnap(true);

    useFloorEditorStore.getState().updateObject("object-1", { x: 213, y: 177 });

    expect(useFloorEditorStore.getState().state!.objects[0]).toMatchObject({ x: 220, y: 180, width: 96, height: 64 });
  });

  it("snaps an object to the nearest map edge when the map size is not a grid multiple", () => {
    useFloorEditorStore.getState().initialize({
      ...initialState,
      floor: {
        ...initialState.floor,
        floorPlan: { sourceType: "none", imageUrl: "", originalFileUrl: null, renderedImageUrl: null, width: 95, height: 95, gridSize: 20, version: 1 }
      },
      objects: [{
        id: "object-edge", floorId: "floor-1", type: "rectangle", x: 40, y: 40, width: 20, height: 20, points: null,
        rotation: 0, strokeColor: "#000000", fillColor: "#ffffff", strokeWidth: 1,
        text: "", fontSize: null, zIndex: 1, locked: false, visible: true
      }]
    });

    useFloorEditorStore.getState().updateObject("object-edge", { x: 69, y: 69 });

    expect(useFloorEditorStore.getState().state!.objects[0]).toMatchObject({ x: 75, y: 75, width: 20, height: 20 });
  });

  it("stores map-only dimensions and rejects shrinking across existing content", () => {
    expect(useFloorEditorStore.getState().updateMapSettings({ width: 1600, height: 900, gridSize: 20 })).toBeNull();
    expect(useFloorEditorStore.getState().state!.floor.floorPlan).toMatchObject({
      sourceType: "none", width: 1600, height: 900, gridSize: 20
    });

    expect(useFloorEditorStore.getState().updateMapSettings({ width: 12, height: 12, gridSize: 10 }))
      .toBe("기존 요소가 포함되도록 맵 크기를 늘려주세요.");
    expect(useFloorEditorStore.getState().state!.floor.floorPlan).toMatchObject({ width: 1600, height: 900 });
  });

  it.each([121, maxNameLength])("moves a fixture with an existing %i-character name", (length) => {
    const fixture = { ...initialState.fixtures[0], name: "L".repeat(length) };
    useFloorEditorStore.getState().initialize({ ...initialState, fixtures: [fixture] });
    useFloorEditorStore.getState().setSnap(false);
    useFloorEditorStore.getState().moveFixtures([fixture.id], { x: 5, y: 10 });
    expect(useFloorEditorStore.getState().state!.fixtures[0]).toMatchObject({ name: fixture.name, x: 15, y: 30 });
    useFloorEditorStore.getState().undo();
    expect(useFloorEditorStore.getState().state!.fixtures[0]).toEqual(fixture);
  });

  it("accepts the shared name limit and rejects only an over-limit name patch", () => {
    useFloorEditorStore.getState().updateFixture("fixture-1", { name: "L".repeat(maxNameLength) });
    const validState = useFloorEditorStore.getState().state;
    expect(validState!.fixtures[0].name).toHaveLength(maxNameLength);
    useFloorEditorStore.getState().updateFixture("fixture-1", { name: "L".repeat(maxNameLength + 1) });
    expect(useFloorEditorStore.getState().state).toBe(validState);
  });

  it("preserves legacy coordinates and verification on a name-only edit", () => {
    const fixture = { ...initialState.fixtures[0], x: 1800, y: -25, positionVerifiedAt: "2026-09-09T01:00:00.000Z" };
    useFloorEditorStore.getState().initialize({ ...initialState, fixtures: [fixture] });
    useFloorEditorStore.getState().updateFixture(fixture.id, { name: "Renamed" });
    expect(useFloorEditorStore.getState().state!.fixtures[0]).toEqual({ ...fixture, name: "Renamed" });
  });

  it("clamps only the patched coordinate and leaves unrelated legacy size and wattage intact", () => {
    const fixture = { ...initialState.fixtures[0], x: 1800, y: -25, size: 2, ratedWatt: 12000 };
    useFloorEditorStore.getState().initialize({ ...initialState, fixtures: [fixture] });
    useFloorEditorStore.getState().updateFixture(fixture.id, { x: 1500 });
    expect(useFloorEditorStore.getState().state!.fixtures[0]).toMatchObject({ x: 1200, y: -25, size: 2, ratedWatt: 12000 });
    const validState = useFloorEditorStore.getState().state;
    useFloorEditorStore.getState().updateFixture(fixture.id, { x: Number.NaN });
    useFloorEditorStore.getState().updateFixture(fixture.id, { size: 2 });
    useFloorEditorStore.getState().updateFixture(fixture.id, { ratedWatt: 12000 });
    expect(useFloorEditorStore.getState().state).toBe(validState);
  });

  it("adopts an atomic save response as the new clean baseline", () => {
    useFloorEditorStore.getState().updateFixture("fixture-1", { x: 11 });
    const saved = {
      ...initialState,
      floor: { ...initialState.floor, mapRevision: 4 },
      fixtures: [{ ...initialState.fixtures[0], x: 11 }]
    };

    useFloorEditorStore.getState().adoptBaseline(saved);

    expect(useFloorEditorStore.getState()).toMatchObject({ initialState: saved, state: saved, isDirty: false });
  });

  it("tracks object deletion as a real change and ignores a missing id", () => {
    useFloorEditorStore.getState().removeObject("missing");
    expect(useFloorEditorStore.getState().isDirty).toBe(false);

    useFloorEditorStore.getState().addObject("floor-1", {
      type: "rectangle", x: 0, y: 0, width: 10, height: 10, points: null,
      rotation: 0, strokeColor: "#000000", fillColor: "#ffffff", strokeWidth: 1,
      text: "", fontSize: null, locked: false, visible: true
    });
    expect(useFloorEditorStore.getState().isDirty).toBe(true);
    const id = useFloorEditorStore.getState().state!.objects[0].id;
    useFloorEditorStore.getState().removeObject(id);
    expect(useFloorEditorStore.getState().state!.objects).toEqual([]);
  });

  it("keeps draft ids unique after add delete and re-add", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const draft = {
      type: "rectangle" as const, x: 0, y: 0, width: 10, height: 10, points: null,
      rotation: 0, strokeColor: "#000000", fillColor: "#ffffff", strokeWidth: 1,
      text: "", fontSize: null, locked: false, visible: true
    };

    useFloorEditorStore.getState().addObject("floor-1", draft);
    const firstId = useFloorEditorStore.getState().state!.objects[0].id;
    useFloorEditorStore.getState().removeObject(firstId);
    useFloorEditorStore.getState().addObject("floor-1", draft);
    const secondId = useFloorEditorStore.getState().state!.objects[0].id;

    expect(firstId).not.toBe(secondId);
  });

  it("discards the current draft back to the baseline", () => {
    useFloorEditorStore.getState().updateFixture("fixture-1", { x: 99 });

    useFloorEditorStore.getState().discardChanges();

    expect(useFloorEditorStore.getState()).toMatchObject({
      state: initialState,
      initialState,
      isDirty: false,
      selection: null,
      activeTool: "select"
    });
  });

  it("assigns an unplaced fixture to the exact coordinates of an available CAD slot", () => {
    const slot = { id: "slot-1", x: 123.5, y: 247.25, rotation: 37, assignedFixtureId: null };
    useFloorEditorStore.getState().initialize({
      ...initialState,
      fixtures: [{
        ...initialState.fixtures[0],
        x: 0,
        y: 0,
        placementStatus: "unplaced",
        positionVerifiedAt: "2026-09-18T01:00:00.000Z",
        positionVerified: true
      }],
      lightSlots: [slot]
    });

    useFloorEditorStore.getState().assignFixtureToSlot("fixture-1", "slot-1");

    expect(useFloorEditorStore.getState().state!.fixtures[0]).toMatchObject({
      placementStatus: "placed",
      positionVerifiedAt: null,
      positionVerified: false,
      x: 123.5,
      y: 247.25
    });
    expect(useFloorEditorStore.getState().state!.lightSlots[0]).toEqual({
      ...slot,
      assignedFixtureId: "fixture-1"
    });
    expect(useFloorEditorStore.getState()).toMatchObject({ isDirty: true, past: [{ state: expect.anything() }] });
  });

  it("rejects an occupied CAD slot without moving another fixture", () => {
    const state: FloorEditorState = {
      ...initialState,
      fixtures: [
        { ...initialState.fixtures[0], id: "fixture-1", placementStatus: "placed", x: 100, y: 120 },
        { ...initialState.fixtures[0], id: "fixture-2", placementStatus: "unplaced", x: 0, y: 0 }
      ],
      lightSlots: [{ id: "slot-1", x: 100, y: 120, rotation: 0, assignedFixtureId: "fixture-1" }]
    };
    useFloorEditorStore.getState().initialize(state);

    useFloorEditorStore.getState().assignFixtureToSlot("fixture-2", "slot-1");

    expect(useFloorEditorStore.getState().state).toBe(state);
    expect(useFloorEditorStore.getState()).toMatchObject({ isDirty: false, past: [] });
  });

  it("unassigns a fixture, reopens its slot, and restores both through undo and redo", () => {
    const fixture = {
      ...initialState.fixtures[0],
      placementStatus: "placed" as const,
      positionVerifiedAt: "2026-09-18T01:00:00.000Z",
      serialNumber: "SN-100",
      meshAddress: 77,
      x: 123.5,
      y: 247.25
    };
    const slot = { id: "slot-1", x: 123.5, y: 247.25, rotation: 37, assignedFixtureId: fixture.id };
    useFloorEditorStore.getState().initialize({ ...initialState, fixtures: [fixture], lightSlots: [slot] });

    useFloorEditorStore.getState().unassignFixture(fixture.id);

    expect(useFloorEditorStore.getState().state!.fixtures[0]).toEqual({
      ...fixture,
      x: 0,
      y: 0,
      placementStatus: "unplaced",
      positionVerifiedAt: null,
      positionVerified: false
    });
    expect(useFloorEditorStore.getState().state!.lightSlots[0]).toEqual({ ...slot, assignedFixtureId: null });

    useFloorEditorStore.getState().undo();
    expect(useFloorEditorStore.getState().state).toMatchObject({ fixtures: [fixture], lightSlots: [slot] });
    expect(useFloorEditorStore.getState().isDirty).toBe(false);

    useFloorEditorStore.getState().redo();
    expect(useFloorEditorStore.getState().state).toMatchObject({
      fixtures: [expect.objectContaining({ id: fixture.id, x: 0, y: 0, placementStatus: "unplaced" })],
      lightSlots: [expect.objectContaining({ id: slot.id, assignedFixtureId: null })]
    });
    expect(useFloorEditorStore.getState().isDirty).toBe(true);
  });

  it("reopens an assigned slot when its fixture is moved into free placement", () => {
    useFloorEditorStore.getState().initialize({
      ...initialState,
      fixtures: [{ ...initialState.fixtures[0], placementStatus: "placed", x: 10, y: 20 }],
      lightSlots: [{ id: "slot-1", x: 10, y: 20, rotation: 0, assignedFixtureId: "fixture-1" }]
    });
    useFloorEditorStore.getState().setSnap(false);

    useFloorEditorStore.getState().moveFixtures(["fixture-1"], { x: 5, y: 7 });

    expect(useFloorEditorStore.getState().state).toMatchObject({
      fixtures: [expect.objectContaining({ id: "fixture-1", placementStatus: "placed", x: 15, y: 27 })],
      lightSlots: [expect.objectContaining({ id: "slot-1", assignedFixtureId: null })]
    });
  });

  it("keeps a slot-only assignment change dirty after returning the fixture to its baseline coordinates", () => {
    const assignedState: FloorEditorState = {
      ...initialState,
      fixtures: [{ ...initialState.fixtures[0], placementStatus: "placed", x: 10, y: 20 }],
      lightSlots: [{ id: "slot-1", x: 10, y: 20, rotation: 0, assignedFixtureId: "fixture-1" }]
    };
    useFloorEditorStore.getState().initialize(assignedState);
    useFloorEditorStore.getState().setSnap(false);

    useFloorEditorStore.getState().moveFixtures(["fixture-1"], { x: 5, y: 7 });
    useFloorEditorStore.getState().moveFixtures(["fixture-1"], { x: -5, y: -7 });

    const current = useFloorEditorStore.getState().state!;
    expect(current.fixtures[0]).toMatchObject({ x: 10, y: 20 });
    expect(current.lightSlots[0].assignedFixtureId).toBeNull();
    expect(buildEditorChanges(assignedState, current).slotAssignments).toEqual([
      { slotId: "slot-1", assignedFixtureId: null }
    ]);
    expect(useFloorEditorStore.getState().isDirty).toBe(true);
  });

  it("round-trips assignment and free-move slot state through undo and redo", () => {
    const state: FloorEditorState = {
      ...initialState,
      fixtures: [{ ...initialState.fixtures[0], placementStatus: "unplaced", x: 0, y: 0 }],
      lightSlots: [{ id: "slot-1", x: 10, y: 20, rotation: 15, assignedFixtureId: null }]
    };
    useFloorEditorStore.getState().initialize(state);
    useFloorEditorStore.getState().assignFixtureToSlot("fixture-1", "slot-1");
    expect(useFloorEditorStore.getState().state!.lightSlots[0].assignedFixtureId).toBe("fixture-1");

    useFloorEditorStore.getState().undo();
    expect(useFloorEditorStore.getState().state).toEqual(state);
    useFloorEditorStore.getState().redo();
    expect(useFloorEditorStore.getState().state!.lightSlots[0].assignedFixtureId).toBe("fixture-1");

    useFloorEditorStore.getState().setSnap(false);
    useFloorEditorStore.getState().moveFixtures(["fixture-1"], { x: 8, y: 9 });
    expect(useFloorEditorStore.getState().state!.lightSlots[0].assignedFixtureId).toBeNull();
    useFloorEditorStore.getState().undo();
    expect(useFloorEditorStore.getState().state!.lightSlots[0].assignedFixtureId).toBe("fixture-1");
    useFloorEditorStore.getState().redo();
    expect(useFloorEditorStore.getState().state!.lightSlots[0].assignedFixtureId).toBeNull();
  });
});
