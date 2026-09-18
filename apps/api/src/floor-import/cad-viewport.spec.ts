import { cadViewportSvgTransform, createCadViewport, projectCadPointToViewport } from "./cad-viewport";

describe("CAD viewport normalization", () => {
  it("normalizes a very wide CAD drawing into a bounded editor map", () => {
    const bounds = { minX: 1_000_000, minY: -20_000, maxX: 16_020_849, maxY: 144_134 };

    expect(createCadViewport(bounds)).toEqual({ width: 2_400, height: 800 });

    const topLeft = projectCadPointToViewport({ x: bounds.minX, y: bounds.maxY, z: 0 }, bounds);
    const bottomRight = projectCadPointToViewport({ x: bounds.maxX, y: bounds.minY, z: 0 }, bounds);
    expect(topLeft.x).toBeCloseTo(40);
    expect(bottomRight.x).toBeCloseTo(2_360);
    expect(topLeft.y).toBeGreaterThan(380);
    expect(bottomRight.y).toBeLessThan(420);
  });

  it("uses the same normalized projection for points and the SVG matrix", () => {
    const bounds = { minX: 100, minY: 200, maxX: 1_300, maxY: 1_000 };
    const viewport = createCadViewport(bounds);
    const point = projectCadPointToViewport({ x: 700, y: 600, z: 0 }, bounds);

    expect(viewport.width).toBeLessThanOrEqual(2_400);
    expect(viewport.height).toBeLessThanOrEqual(1_600);
    expect(point.x).toBeCloseTo(viewport.width / 2);
    expect(point.y).toBeCloseTo(viewport.height / 2);
    expect(cadViewportSvgTransform(bounds)).toMatch(/^matrix\([\d.-]+ 0 0 -[\d.-]+ [\d.-]+ [\d.-]+\)$/);
  });
});
