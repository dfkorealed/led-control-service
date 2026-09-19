import { describe, expect, it } from "vitest";
import { getMapElementBounds, transformMapPoint } from "./map-document-geometry";
import type { Bounds, MapElement, MapShape } from "./map-document-contracts";

const point = (x: number, y: number) => ({ x, y });
function element(shape: MapShape, transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }): MapElement {
  return { ...shape, id: "e", groupId: null, layerId: "l", zIndex: 0, visible: true, locked: false,
    transform, style: { strokeColor: "#000000", fillColor: null, strokeWidth: 0, opacity: 1 }, provenance: null };
}
function expectBounds(actual: Bounds, expected: Bounds) {
  for (const key of ["minX", "minY", "maxX", "maxY"] as const) expect(actual[key]).toBeCloseTo(expected[key], 9);
}
describe("map element bounds", () => {
  it("scales around the geometry origin then rotates in degrees and translates once", () => {
    const transform = { x: 10, y: 20, scaleX: 2, scaleY: 3, rotation: 90 };
    const transformed = transformMapPoint(point(1, 2), transform);
    expect(transformed.x).toBeCloseTo(4);
    expect(transformed.y).toBeCloseTo(22);
    expectBounds(getMapElementBounds(element({ type: "rectangle", geometry: { origin: point(1, 2), width: 4, height: 2 } }, transform)),
      { minX: -2, minY: 22, maxX: 4, maxY: 30 });
  });
  it.each<[MapShape, Bounds]>([
    [{ type: "line", geometry: { start: point(5, 3), end: point(-2, 3) } }, { minX: -2, minY: 3, maxX: 5, maxY: 3 }],
    [{ type: "triangle", geometry: { points: [point(0, 0), point(4, -1), point(2, 6)] } }, { minX: 0, minY: -1, maxX: 4, maxY: 6 }],
    [{ type: "polyline", geometry: { points: [point(0, 0), point(3, 7), point(-2, 4)] } }, { minX: -2, minY: 0, maxX: 3, maxY: 7 }],
    [{ type: "polygon", geometry: { outer: [point(0, 0), point(8, 0), point(8, 8), point(0, 8)], holes: [[point(2, 2), point(4, 2), point(3, 4)]] } }, { minX: 0, minY: 0, maxX: 8, maxY: 8 }],
    [{ type: "text", geometry: { position: point(3, 5), text: "LED", width: 30, height: 12, fontSize: 12 } }, { minX: 3, minY: 5, maxX: 33, maxY: 17 }],
    [{ type: "text", geometry: { position: point(3, 5), text: "", width: 0, height: 0, fontSize: 12 } }, { minX: 3, minY: 5, maxX: 3, maxY: 5 }]
  ])("computes exact neutral shape bounds %#", (shape, expected) => expectBounds(getMapElementBounds(element(shape)), expected));
  it("uses analytic ellipse extrema after nonuniform scaling and rotation", () => {
    const bounds = getMapElementBounds(element({ type: "ellipse", geometry: { center: point(0, 0), radiusX: 2, radiusY: 1 } },
      { x: 10, y: 20, scaleX: 2, scaleY: 3, rotation: 45 }));
    expectBounds(bounds, { minX: 6.464466094067262, minY: 16.464466094067262, maxX: 13.535533905932738, maxY: 23.535533905932738 });
  });
  it.each([
    [0, 90, true, { minX: 0, minY: 0, maxX: 10, maxY: 10 }],
    [0, 90, false, { minX: -10, minY: -10, maxX: 10, maxY: 10 }],
    [270, 90, true, { minX: 0, minY: -10, maxX: 10, maxY: 10 }],
    [0, 0, true, { minX: -10, minY: -10, maxX: 10, maxY: 10 }],
    [0, 360, false, { minX: -10, minY: -10, maxX: 10, maxY: 10 }]
  ] as const)("bounds arc %s to %s ccw=%s including wrap and full circles", (startAngle, endAngle, counterClockwise, expected) => {
    expectBounds(getMapElementBounds(element({ type: "arc", geometry: { center: point(0, 0), radius: 10, startAngle, endAngle, counterClockwise } })), expected);
  });
  it("includes transformed arc interior extrema, not only endpoints or the full ellipse", () => {
    expectBounds(getMapElementBounds(element({ type: "arc", geometry: { center: point(0, 0), radius: 1, startAngle: 0, endAngle: 90, counterClockwise: true } },
      { x: 0, y: 0, scaleX: 2, scaleY: 1, rotation: 45 })),
    { minX: -0.7071067811865475, minY: 0.7071067811865475, maxX: 1.4142135623730951, maxY: 1.5811388300841898 });
  });
  it("does not trust injected bounds or apply style/visibility as geometry", () => {
    const value = element({ type: "line", geometry: { start: point(0, 0), end: point(10, 0) } });
    expect(getMapElementBounds({ ...value, visible: false, style: { ...value.style, strokeWidth: 100 },
      bounds: { minX: -999, maxX: 999, minY: -999, maxY: 999 } } as MapElement)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 0 });
  });
  it("fails closed on non-finite transformed output", () => {
    expect(() => getMapElementBounds(element({ type: "line", geometry: { start: point(1e308, 0), end: point(1e308, 1) } },
      { x: 0, y: 0, scaleX: 100, scaleY: 1, rotation: 0 }))).toThrow();
  });
});
