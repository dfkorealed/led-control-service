import { describe, expect, it } from "vitest";
import { transformMapPoint } from "@led-control/shared/map-document-geometry";
import { boundsGestureTransform, fitSelectionCamera, selectionFixtureBounds, transformSelectedFixtures } from "./map-selection-transform";

describe("whole selection transforms", () => {
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
