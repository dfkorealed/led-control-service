import { describe, expect, it } from "vitest";
import { transformMapPoint } from "@led-control/shared/map-document-geometry";
import { boundsGestureTransform, finishFixtureResize, finishSelectionResize, fitSelectionCamera, selectionFixtureBounds, transformSelectedFixtures } from "./map-selection-transform";

describe("whole selection transforms", () => {
  it("snaps a fixture's changed edge without snapping its center or losing its fixed corner", () => {
    const result = finishFixtureResize({ id: "f", x: 103, y: 107, size: 20 }, { x: 106.7, y: 110.7, scaleX: 1.37, scaleY: 1.37, rotation: 0 }, "bottom-right", { width: 500, height: 400 }, 10);
    expect(result.x - result.size / 2).toBeCloseTo(93);
    expect(result.y - result.size / 2).toBeCloseTo(97);
    expect(result.x + result.size / 2).toBeCloseTo(120);
    expect(result.size).toBeCloseTo(27);
  });
  it.each([{ minX: 40, minY: 40, maxX: 40, maxY: 120 }, { minX: 40, minY: 40, maxX: 120, maxY: 40 }])("keeps degenerate line axes finite during corner snapping: %s", local => {
    const original = { x: 200, y: 200, scaleX: 1, scaleY: 1, rotation: 31 };
    const fixed = transformMapPoint({ x: local.minX, y: local.minY }, original);
    const linear = { ...original, x: 0, y: 0, scaleX: 1.37, scaleY: 1.37 };
    const p = transformMapPoint({ x: local.minX, y: local.minY }, linear);
    const result = finishSelectionResize(local, { ...linear, x: fixed.x - p.x, y: fixed.y - p.y }, "bottom-right", { width: 800, height: 600 }, 10);
    expect(Object.values(result).every(Number.isFinite)).toBe(true);
    expect(transformMapPoint({ x: local.minX, y: local.minY }, result).x).toBeCloseTo(fixed.x);
    expect(transformMapPoint({ x: local.minX, y: local.minY }, result).y).toBeCloseTo(fixed.y);
    if (local.minX === local.maxX) expect(result.scaleX).toBe(1.37);
    else expect(result.scaleY).toBe(1.37);
  });
  it("snaps a rotated corner in world space and preserves an off-origin fixed anchor", () => {
    const local = { minX: 103, minY: 107, maxX: 183, maxY: 147 };
    const next = { x: 200, y: 180, scaleX: 1.2, scaleY: 1.4, rotation: 31 };
    const fixed = transformMapPoint({ x: local.minX, y: local.minY }, next);
    const result = finishSelectionResize(local, next, "bottom-right", { width: 1200, height: 800 }, 10);
    const a = transformMapPoint({ x: local.minX, y: local.minY }, result), b = transformMapPoint({ x: local.maxX, y: local.maxY }, result);
    expect(a.x).toBeCloseTo(fixed.x); expect(a.y).toBeCloseTo(fixed.y);
    expect(b.x / 10).toBeCloseTo(Math.round(b.x / 10)); expect(b.y / 10).toBeCloseTo(Math.round(b.y / 10));
  });
  it("preserves proportional scales and clamps at map bounds without moving the anchor", () => {
    const local = { minX: 0, minY: 0, maxX: 80, maxY: 40 };
    const result = finishSelectionResize(local, { x: 103, y: 107, scaleX: 8, scaleY: 8, rotation: 0 }, "bottom-right", { width: 500, height: 400 }, 10, true);
    expect(result.x).toBe(103); expect(result.y).toBe(107); expect(result.scaleX).toBeCloseTo(result.scaleY);
    const edge = transformMapPoint({ x: 80, y: 40 }, result);
    expect(edge.x).toBeLessThanOrEqual(500.000001); expect(edge.y).toBeLessThanOrEqual(400.000001);
  });
  it("composes a bbox resize and rotation against the original world origin exactly once", () => {
    const delta = boundsGestureTransform({ minX: 100, minY: 200, maxX: 300, maxY: 400 }, { x: 200, y: 300, scaleX: 2, scaleY: 2, rotation: 90 });
    expect(transformMapPoint({ x: 100, y: 200 }, delta)).toEqual({ x: 200, y: 300 });
    expect(transformMapPoint({ x: 200, y: 200 }, delta).x).toBeCloseTo(200);
    expect(transformMapPoint({ x: 200, y: 200 }, delta).y).toBeCloseTo(500);
    expect(() => boundsGestureTransform({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { x: 0, y: 0, scaleX: -1, scaleY: 1, rotation: 0 })).toThrow();
  });
  it("fits common shapes and mixed fixture bounds including the fixture size", () => {
    const fixtures = [{ id: "f", x: 500, y: 400, size: 20 }];
    const bounds = selectionFixtureBounds({ minX: 100, minY: 100, maxX: 200, maxY: 200 }, fixtures);
    expect(bounds).toEqual({ minX: 100, minY: 100, maxX: 510, maxY: 410 });
    const camera = fitSelectionCamera(bounds!, { width: 800, height: 600 });
    expect(camera.zoom).toBeCloseTo(552 / 310);
    expect(camera.pan.x + 100 * camera.zoom).toBeGreaterThanOrEqual(24);
    expect(camera.pan.y + 410 * camera.zoom).toBeCloseTo(576);
  });
  it("prepares fixture movement atomically and rejects out-of-map or non-translation mixed gestures", () => {
    const delta = { x: 20, y: 30, scaleX: 1, scaleY: 1, rotation: 0 };
    expect(transformSelectedFixtures([{ id: "f", x: 100, y: 100 }], delta, { width: 500, height: 400 })).toEqual([{ id: "f", x: 120, y: 130 }]);
    expect(() => transformSelectedFixtures([{ id: "f", x: 490, y: 100 }], delta, { width: 500, height: 400 })).toThrow();
    expect(() => transformSelectedFixtures([{ id: "f", x: 100, y: 100 }], { ...delta, rotation: 90 }, { width: 500, height: 400 })).toThrow();
    expect(transformSelectedFixtures([], { ...delta, scaleX: 2, scaleY: 2, rotation: 90 }, { width: 500, height: 400 })).toEqual([]);
  });
});
