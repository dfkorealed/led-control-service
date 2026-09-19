import { mapElementSchema, type Point } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import {
  addMapPolygonHole, appendMapPathPoint, cancelMapPathDraft, createMapElementFromDrag,
  createMapPathDraft, finishMapPathDraft, removeMapPolygonHole, updateMapArcAngles
} from "./map-element-tools";

const start = { x: 10, y: 20 };
const end = { x: 50, y: 40 };
const types = ["rectangle", "triangle", "line", "text", "ellipse", "arc", "polyline", "polygon"] as const;
const ring = [{ x: 15, y: 25 }, { x: 20, y: 25 }, { x: 20, y: 30 }, { x: 15, y: 30 }];

describe("createMapElementFromDrag", () => {
  it.each(types)("creates a valid general %s without import provenance", (type) => {
    const element = createMapElementFromDrag(type, start, end, "manual-1");
    expect(element).toMatchObject({ type, id: "manual-1", layerId: "map", groupId: null,
      provenance: null, visible: true, locked: false, zIndex: 0,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } });
    expect(mapElementSchema.safeParse(element).success).toBe(true);
  });

  it.each([
    ["rectangle", { origin: start, width: 40, height: 20 }],
    ["triangle", { points: [{ x: 30, y: 20 }, { x: 50, y: 40 }, { x: 10, y: 40 }] }],
    ["ellipse", { center: { x: 30, y: 30 }, radiusX: 20, radiusY: 10 }],
    ["arc", { center: { x: 30, y: 30 }, radius: 10, startAngle: 0, endAngle: 180, counterClockwise: false }],
    ["polygon", { outer: [start, { x: 50, y: 20 }, end, { x: 10, y: 40 }], holes: [] }],
    ["text", { position: start, width: 40, height: 20, fontSize: 20, text: "텍스트" }]
  ] as const)("normalizes reversed %s drag", (type, geometry) => {
    expect(createMapElementFromDrag(type, end, start, "new")?.geometry).toEqual(geometry);
  });

  it.each(types)("cancels a zero-length %s drag", (type) => {
    expect(createMapElementFromDrag(type, start, start, "new")).toBeNull();
  });

  it.each(["rectangle", "triangle", "ellipse", "arc", "polygon", "text"] as const)("cancels a zero-area %s", (type) => {
    expect(createMapElementFromDrag(type, start, { x: 10, y: 40 }, "new")).toBeNull();
    expect(createMapElementFromDrag(type, start, { x: 50, y: 20 }, "new")).toBeNull();
  });

  it.each(["line", "polyline"] as const)("preserves %s direction, including horizontal and vertical lines", (type) => {
    const horizontal = createMapElementFromDrag(type, end, { x: 10, y: 40 }, "new");
    const vertical = createMapElementFromDrag(type, end, { x: 50, y: 20 }, "new");
    expect(horizontal?.geometry).toEqual(type === "line"
      ? { start: end, end: { x: 10, y: 40 } } : { points: [end, { x: 10, y: 40 }] });
    expect(mapElementSchema.safeParse(vertical).success).toBe(true);
  });

  it("keeps fractional coordinates unless grid snapping is requested", () => {
    expect(createMapElementFromDrag("rectangle", { x: 1.25, y: 2.5 }, { x: 8.75, y: 9.5 }, "new")?.geometry)
      .toEqual({ origin: { x: 1.25, y: 2.5 }, width: 7.5, height: 7 });
    expect(createMapElementFromDrag("rectangle", { x: 11, y: 21 }, { x: 48, y: 42 }, "new", { gridSize: 10 })?.geometry)
      .toEqual({ origin: start, width: 40, height: 20 });
    expect(createMapElementFromDrag("rectangle", { x: 11, y: 21 }, { x: 12, y: 22 }, "new", { gridSize: 10 })).toBeNull();
  });

  it.each([0, -5, NaN, Infinity])("rejects an invalid grid option %s", (gridSize) => {
    expect(() => createMapElementFromDrag("line", start, end, "new", { gridSize })).toThrow(RangeError);
  });

  it("supports explicit layer/style and does not alias caller inputs", () => {
    const point = { ...start };
    const style = { fillColor: null, opacity: 0.4, strokeColor: "#123456" };
    const element = createMapElementFromDrag("line", point, end, "new", { layerId: "custom", style });
    point.x = 999;
    style.opacity = 0.9;
    expect(element).toMatchObject({ layerId: "custom", style: { fillColor: null, opacity: 0.4, strokeColor: "#123456" },
      geometry: { start } });
  });

  it("constrains a reversed ellipse drag to a circle anchored at the starting point", () => {
    expect(createMapElementFromDrag("ellipse", end, start, "new", { keepAspectRatio: true })?.geometry)
      .toEqual({ center: { x: 30, y: 20 }, radiusX: 20, radiusY: 20 });
  });

  it("uses editable text and arc creation values", () => {
    expect(createMapElementFromDrag("text", start, end, "new", { text: "A동", fontSize: 12.5 })?.geometry)
      .toMatchObject({ text: "A동", fontSize: 12.5 });
    expect(createMapElementFromDrag("arc", start, end, "new", {
      arc: { startAngle: 270, endAngle: 450, counterClockwise: true }
    })?.geometry).toMatchObject({ startAngle: 270, endAngle: 450, counterClockwise: true });
  });

  it.each(types)("does not emit invalid %s elements", (type) => {
    expect(createMapElementFromDrag(type, { x: NaN, y: 20 }, end, "new")).toBeNull();
    expect(createMapElementFromDrag(type, start, end, "")).toBeNull();
    expect(createMapElementFromDrag(type, start, end, "new", { style: { opacity: 2 } })).toBeNull();
    expect(createMapElementFromDrag(type, { x: -1e308, y: -1e308 }, { x: 1e308, y: 1e308 }, "new")).toBeNull();
  });
});

function draftFromPoints(type: "polyline" | "polygon", points: Point[]) {
  return points.reduce((draft, point) => appendMapPathPoint(draft, point), createMapPathDraft(type));
}

describe("interactive path drafts", () => {
  it("appends immutably, snaps when requested and ignores consecutive duplicate clicks", () => {
    const options = { gridSize: 10, layerId: "draft-layer", style: { strokeColor: "#123456" } };
    const empty = createMapPathDraft("polyline", options);
    options.style.strokeColor = "#654321";
    const first = appendMapPathPoint(empty, { x: 11, y: 21 });
    const duplicate = appendMapPathPoint(first, { x: 12, y: 22 });
    const complete = appendMapPathPoint(duplicate, end);
    expect(empty.points).toEqual([]);
    expect(first.points).toEqual([start]);
    expect(duplicate.points).toEqual([start]);
    expect(finishMapPathDraft(complete, "new")).toMatchObject({ type: "polyline", layerId: "draft-layer",
      style: { strokeColor: "#123456" }, geometry: { points: [start, end] }, provenance: null });
  });

  it("keeps a polyline open and normalizes an explicitly closed polygon ring", () => {
    const points = [start, { x: 50, y: 20 }, end, { x: 10, y: 40 }];
    expect(finishMapPathDraft(draftFromPoints("polyline", points), "new")?.geometry).toEqual({ points });
    expect(finishMapPathDraft(draftFromPoints("polygon", [...points, start]), "new")?.geometry)
      .toEqual({ outer: points, holes: [] });
  });

  it("does not save incomplete, collinear, or self-intersecting drafts; cancel discards the draft", () => {
    const partial = draftFromPoints("polygon", [start, end]);
    expect(finishMapPathDraft(partial, "new")).toBeNull();
    expect(finishMapPathDraft(draftFromPoints("polyline", [start]), "new")).toBeNull();
    expect(finishMapPathDraft(draftFromPoints("polygon", [start, { x: 30, y: 30 }, end]), "new")).toBeNull();
    expect(finishMapPathDraft(draftFromPoints("polygon", [start, end, { x: 50, y: 20 }, { x: 10, y: 40 }]), "new")).toBeNull();
    expect(cancelMapPathDraft(partial)).toBeNull();
    expect(partial.points).toEqual([start, end]);
    expect(() => appendMapPathPoint(partial, { x: Infinity, y: 0 })).toThrow();
  });
});

describe("polygon holes and arc edits", () => {
  it("adds/removes holes without mutating the polygon and preserves provenance", () => {
    const polygon = createMapElementFromDrag("polygon", start, end, "new")!;
    polygon.provenance = { importJobId: "job", sourceId: "source" };
    const withHole = addMapPolygonHole(polygon, [...ring, ring[0]])!;
    expect(withHole.geometry.holes).toEqual([ring]);
    expect(polygon.geometry.holes).toEqual([]);
    expect(removeMapPolygonHole(withHole, 0)).toEqual(polygon);
    expect(removeMapPolygonHole(withHole, 9)).toBeNull();
    expect(removeMapPolygonHole(withHole, 0.5)).toBeNull();
    expect(mapElementSchema.safeParse(withHole).success).toBe(true);
  });

  it("rejects outside, touching, intersecting, overlapping and nested holes using the shared contract", () => {
    const polygon = createMapElementFromDrag("polygon", start, end, "new")!;
    const withHole = addMapPolygonHole(polygon, ring)!;
    for (const points of [
      ring.map((p) => ({ x: p.x - 20, y: p.y })),
      ring.map((p) => ({ x: p.x - 5, y: p.y })),
      [ring[0], ring[2], ring[1], ring[3]],
      ring,
      [{ x: 16, y: 26 }, { x: 19, y: 26 }, { x: 19, y: 29 }]
    ]) expect(addMapPolygonHole(withHole, points)).toBeNull();
    expect(withHole.geometry.holes).toHaveLength(1);
  });

  it("edits arc angles immutably and refuses non-finite angles", () => {
    const arc = createMapElementFromDrag("arc", start, end, "new")!;
    expect(updateMapArcAngles(arc, { startAngle: -90, endAngle: 270, counterClockwise: true }))
      .toMatchObject({ geometry: { startAngle: -90, endAngle: 270, counterClockwise: true, radius: 10 } });
    expect(arc.geometry.startAngle).toBe(0);
    expect(updateMapArcAngles(arc, { endAngle: Infinity })).toBeNull();
  });
});
