import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFloorEditorStore } from "./editor-store";
import type { FloorEditorState } from "./editor-types";
import type { EDITOR_MAX_NAME_LENGTH } from "@led-control/shared";

const maxNameLength: typeof EDITOR_MAX_NAME_LENGTH = 200;

const initialState: FloorEditorState = {
  floor: { id: "floor-1", siteId: "site-1", name: "B1", level: -1, mapRevision: 3, floorPlan: null },
  fixtures: [{
    id: "fixture-1", name: "L1", x: 10, y: 20, size: 20, ratedWatt: 40,
    brightness: 70, status: "online"
  }],
  objects: []
};

describe("floor editor store baseline", () => {
  beforeEach(() => {
    useFloorEditorStore.getState().initialize(initialState);
  });

  it("becomes dirty only when an editable value actually changes", () => {
    useFloorEditorStore.getState().updateFixture("fixture-1", { x: 10 });
    expect(useFloorEditorStore.getState().isDirty).toBe(false);

    useFloorEditorStore.getState().updateFixture("fixture-1", { x: 11 });
    expect(useFloorEditorStore.getState().isDirty).toBe(true);
  });

  it.each([121, maxNameLength])("moves a fixture with an existing %i-character name", (length) => {
    const fixture = { ...initialState.fixtures[0], name: "L".repeat(length) };
    useFloorEditorStore.getState().initialize({ ...initialState, fixtures: [fixture] });
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
});
