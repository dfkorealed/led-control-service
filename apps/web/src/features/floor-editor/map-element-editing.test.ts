import { getMapElementBounds, transformMapPoint, type MapElement } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import { createMapElementFromDrag } from "./map-element-tools";
import {
  createMapElementUpdateOps, getMapElementSize, getMapSelectionBounds,
  moveMapSelection, resizeMapElement, transformMapSelection
} from "./map-element-editing";

const bounds = { width: 2000, height: 2000 };
const types: MapElement["type"][] = ["line", "rectangle", "triangle", "ellipse", "arc", "polyline", "polygon", "text"];
const delta = { x: 70, y: 90, scaleX: 1.5, scaleY: 1.5, rotation: 23 };
function make(type: MapElement["type"]): MapElement {
  const element = createMapElementFromDrag(type, { x: 10, y: 20 }, { x: 70, y: 40 }, type)!;
  const reflect = (point: { x: number; y: number }) => ({ x: -point.x, y: point.y });
  // Imported reflections are normalized into local geometry, not forbidden negative scales.
  switch (element.type) {
    case "line": element.geometry = { start: reflect(element.geometry.start), end: reflect(element.geometry.end) }; break;
    case "rectangle": element.geometry.origin.x = -element.geometry.origin.x - element.geometry.width; break;
    case "triangle": element.geometry.points = element.geometry.points.map(reflect) as [typeof element.geometry.points[0], typeof element.geometry.points[0], typeof element.geometry.points[0]]; break;
    case "polyline": element.geometry.points = element.geometry.points.map(reflect); break;
    case "polygon": element.geometry.outer = element.geometry.outer.map(reflect); break;
    case "ellipse": element.geometry.center = reflect(element.geometry.center); break;
    case "arc": element.geometry = { ...element.geometry, center: reflect(element.geometry.center),
      startAngle: 180 - element.geometry.startAngle, endAngle: 180 - element.geometry.endAngle,
      counterClockwise: !element.geometry.counterClockwise }; break;
    // U2 text has normalized readable glyphs; only its canonical layout position is reflected.
    case "text": element.geometry.position.x = -element.geometry.position.x - element.geometry.width; break;
  }
  return { ...element, transform: { x: 400, y: 300, scaleX: 1.2, scaleY: 0.7, rotation: -37 } };
}
const updated = (ops: ReturnType<typeof transformMapSelection>) => ops.map(op => {
  if (op.kind !== "update") throw new Error("Expected update");
  return op.element;
});

describe("common map element editing", () => {
  it.each(types)("composes %s with negative local coordinates and positive scales exactly once", type => {
    const element = make(type);
    const before = structuredClone(element);
    const [next] = updated(transformMapSelection([element], delta, bounds));
    expect(next.geometry).toEqual(before.geometry);
    expect(element).toEqual(before);
    for (const point of [{ x: -31, y: -12 }, { x: 10, y: 20 }]) {
      const expected = transformMapPoint(transformMapPoint(point, element.transform), delta);
      const actual = transformMapPoint(point, next.transform);
      expect(actual.x).toBeCloseTo(expected.x, 8);
      expect(actual.y).toBeCloseTo(expected.y, 8);
    }
    expect(next.transform.scaleX).toBeGreaterThan(0);
    expect(next.transform.scaleY).toBeGreaterThan(0);
  });

  it.each(types)("resizes the local %s frame without changing rotation or geometry", type => {
    const element = make(type);
    const size = getMapElementSize(element);
    const next = resizeMapElement(element, { width: size.width * 2, height: size.height * 3 });
    expect(getMapElementSize(next).width).toBeCloseTo(size.width * 2, 10);
    expect(getMapElementSize(next).height).toBeCloseTo(size.height * 3, 10);
    expect(next.geometry).toEqual(element.geometry);
    expect(next.transform.rotation).toBe(element.transform.rotation);
  });

  it("applies a group delta once per original ID and keeps provenance and group membership", () => {
    const first = { ...make("rectangle"), groupId: "chosen-group" };
    const second = { ...make("text"), provenance: { importJobId: "job", sourceId: "source" } };
    const result = updated(transformMapSelection([first, second, first], delta, bounds));
    expect(result).toHaveLength(2);
    expect(result[0].groupId).toBe("chosen-group");
    expect(result[1].provenance).toEqual(second.provenance);
  });

  it("preserves drag offset and dimensions, snapping the selection origin only at the end", () => {
    const element = createMapElementFromDrag("rectangle", { x: 13, y: 17 }, { x: 48, y: 41 }, "a")!;
    const preview = moveMapSelection([element], { x: 14, y: 9 }, { mapBounds: bounds, gridSize: 10 }, false);
    const final = moveMapSelection([element], { x: 14, y: 9 }, { mapBounds: bounds, gridSize: 10 }, true);
    expect(preview.offset).toEqual({ x: 14, y: 9 });
    expect(final.offset).toEqual({ x: 17, y: 13 });
    const [next] = updated(transformMapSelection([element], { ...delta, ...final.offset, scaleX: 1, scaleY: 1, rotation: 0 }, bounds));
    expect(getMapElementBounds(next)).toEqual({ minX: 30, minY: 30, maxX: 65, maxY: 54 });
  });

  it("reuses world-space guide alignment without quantizing movement", () => {
    const element = createMapElementFromDrag("rectangle", { x: 10, y: 10 }, { x: 30, y: 30 }, "a")!;
    const result = moveMapSelection([element], { x: 37, y: 7 }, {
      mapBounds: bounds, guideTargets: [{ x: 50, y: 100, width: 20, height: 20 }], guideThreshold: 4
    }, false);
    expect(result.offset).toEqual({ x: 40, y: 7 });
    expect(result.guides).toContainEqual({ orientation: "vertical", position: 50 });
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid scale %s", scaleX => {
    expect(() => transformMapSelection([make("line")], { ...delta, scaleX }, bounds)).toThrow();
  });

  it("rejects shear, out-of-map, zero geometry and locked batches atomically", () => {
    expect(() => transformMapSelection([make("text")], { ...delta, scaleX: 2 }, bounds)).toThrow(/기울임/);
    expect(() => transformMapSelection([make("line")], { ...delta, x: 5000 }, bounds)).toThrow(/범위/);
    expect(() => resizeMapElement(make("rectangle"), { width: 0 })).toThrow();
    expect(() => createMapElementUpdateOps([make("line"), { ...make("text"), locked: true }], e => e, bounds)).toThrow(/잠금/);
    expect(() => createMapElementUpdateOps([make("line")], e => ({ ...e, transform: { ...e.transform, x: Infinity } }), bounds)).toThrow();
  });

  it("validates changed shape geometry and keeps the previous element immutable", () => {
    const element = make("line");
    expect(() => createMapElementUpdateOps([element], e => ({ ...e, type: "line", geometry: {
      start: { x: 0, y: 0 }, end: { x: 0, y: 0 }
    } }), bounds)).toThrow();
    expect(getMapSelectionBounds([])).toBeNull();
    expect(getMapSelectionBounds([element])).toEqual(getMapElementBounds(element));
  });

  it("does not create a command or change existing floating point scales for a stationary drag", () => {
    const element = { ...make("line"), transform: { x: 400, y: 300, scaleX: 1.23, scaleY: 0.73, rotation: 17.2 } };
    expect(transformMapSelection([element], { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, bounds)).toEqual([]);
  });
});
