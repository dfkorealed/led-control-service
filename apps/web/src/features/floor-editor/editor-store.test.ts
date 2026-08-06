import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFloorEditorStore } from "./editor-store";
import type { FloorEditorState } from "./editor-types";

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
});
