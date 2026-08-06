import { describe, expect, it } from "vitest";
import { buildEditorChanges } from "./editor-diff";
import type { EditorFixture, FloorEditorState, FloorMapObject } from "./editor-types";

function fixture(index: number): EditorFixture {
  return {
    id: `fixture-${index}`,
    name: `L-${index}`,
    x: index,
    y: index + 10,
    size: 20,
    ratedWatt: 40,
    brightness: 70,
    status: "online"
  };
}

function object(id: string, patch: Partial<FloorMapObject> = {}): FloorMapObject {
  return {
    id,
    floorId: "floor-1",
    type: "rectangle",
    x: 10,
    y: 20,
    width: 100,
    height: 60,
    points: null,
    rotation: 0,
    strokeColor: "#111827",
    fillColor: "#ffffff",
    strokeWidth: 1,
    text: "",
    fontSize: null,
    zIndex: 1,
    locked: false,
    visible: true,
    ...patch
  };
}

function state(patch: Partial<FloorEditorState> = {}): FloorEditorState {
  return {
    floor: {
      id: "floor-1",
      siteId: "site-1",
      name: "B1",
      level: -1,
      mapRevision: 7,
      floorPlan: {
        id: "plan-1",
        sourceType: "image",
        imageUrl: "/plan.png",
        originalFileUrl: "/plan.png",
        renderedImageUrl: "/plan.png",
        width: 1200,
        height: 800,
        version: 1
      }
    },
    fixtures: [],
    objects: [],
    ...patch
  };
}

describe("buildEditorChanges", () => {
  it("finds one changed fixture in a 1,000 fixture state", () => {
    const fixtures = Array.from({ length: 1_000 }, (_, index) => fixture(index));
    const initial = state({ fixtures });
    const current = state({
      fixtures: fixtures.map((item, index) => index === 500 ? { ...item, x: 420, y: 180 } : item)
    });

    expect(buildEditorChanges(initial, current)).toEqual({
      expectedRevision: 7,
      fixtureUpdates: [{ id: "fixture-500", x: 420, y: 180 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    });
  });

  it("builds disjoint object create update and delete changes", () => {
    const initial = state({ objects: [object("object-update"), object("object-delete", { zIndex: 2 })] });
    const current = state({
      objects: [
        object("object-update", { x: 45, text: "변경" }),
        object("draft-new", { type: "text", width: 120, height: 40, text: "신규", zIndex: 3 })
      ]
    });

    const changes = buildEditorChanges(initial, current);

    expect(changes.objectCreates).toEqual([expect.objectContaining({ type: "text", x: 10, text: "신규" })]);
    expect(changes.objectUpdates).toEqual([{ id: "object-update", patch: { x: 45, text: "변경" } }]);
    expect(changes.objectDeletes).toEqual(["object-delete"]);
    expect(new Set([
      ...changes.objectUpdates.map(({ id }) => id),
      ...changes.objectDeletes
    ]).size).toBe(changes.objectUpdates.length + changes.objectDeletes.length);
  });

  it("includes only a changed floor plan and omits server-managed fields", () => {
    const initial = state();
    const current = state({
      floor: {
        ...initial.floor,
        floorPlan: { ...initial.floor.floorPlan!, width: 1400, version: 2 }
      }
    });

    expect(buildEditorChanges(initial, current).floorPlan).toEqual({
      sourceType: "image",
      imageUrl: "/plan.png",
      originalFileUrl: "/plan.png",
      renderedImageUrl: "/plan.png",
      width: 1400,
      height: 800
    });
  });

  it("uses null when the floor plan is deleted", () => {
    const initial = state();
    const current = state({ floor: { ...initial.floor, floorPlan: null } });

    expect(buildEditorChanges(initial, current).floorPlan).toBeNull();
  });

  it("returns no mutations for an unchanged state", () => {
    const initial = state({ fixtures: [fixture(1)], objects: [object("object-1")] });

    expect(buildEditorChanges(initial, structuredClone(initial))).toEqual({
      expectedRevision: 7,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    });
  });
});
