import type { NormalizedCadDocument } from "./cad-types";
import { cadViewportSvgTransform, createCadViewport, projectCadPointToViewport, selectPrimaryCadBounds } from "./cad-viewport";

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

  it("deterministically excludes only a remote isolated entity from primary bounds", () => {
    const entities: NormalizedCadDocument["entities"] = [
      { type: "line", sourceEntityId: "top", layer: "0", start: { x: 0, y: 800, z: 0 }, end: { x: 1_200, y: 800, z: 0 } },
      { type: "line", sourceEntityId: "right", layer: "0", start: { x: 1_200, y: 800, z: 0 }, end: { x: 1_200, y: 0, z: 0 } },
      { type: "line", sourceEntityId: "bottom", layer: "0", start: { x: 1_200, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } },
      { type: "line", sourceEntityId: "left", layer: "0", start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 800, z: 0 } },
      { type: "point", sourceEntityId: "remote", layer: "0", position: { x: 1_000_000, y: 1_000_000, z: 0 } }
    ];
    const document: NormalizedCadDocument = {
      version: 1, bounds: { minX: 0, minY: 0, maxX: 1_000_000, maxY: 1_000_000 }, blocks: [], entities
    };

    expect(selectPrimaryCadBounds(document)).toEqual({
      bounds: { minX: 0, minY: 0, maxX: 1_200, maxY: 800 }, excludedEntityCount: 1, totalEntityCount: 5
    });
    expect(selectPrimaryCadBounds({ ...document, entities: [...entities].reverse() })).toEqual({
      bounds: { minX: 0, minY: 0, maxX: 1_200, maxY: 800 }, excludedEntityCount: 1, totalEntityCount: 5
    });
  });

  it("keeps the complete bounds when disconnected drawing clusters tie", () => {
    const document: NormalizedCadDocument = {
      version: 1, bounds: { minX: 0, minY: 0, maxX: 11_000, maxY: 1_000 }, blocks: [],
      entities: [
        { type: "line", sourceEntityId: "a1", layer: "0", start: { x: 0, y: 0, z: 0 }, end: { x: 1_000, y: 0, z: 0 } },
        { type: "line", sourceEntityId: "a2", layer: "0", start: { x: 1_000, y: 0, z: 0 }, end: { x: 1_000, y: 1_000, z: 0 } },
        { type: "line", sourceEntityId: "b1", layer: "0", start: { x: 10_000, y: 0, z: 0 }, end: { x: 11_000, y: 0, z: 0 } },
        { type: "line", sourceEntityId: "b2", layer: "0", start: { x: 11_000, y: 0, z: 0 }, end: { x: 11_000, y: 1_000, z: 0 } }
      ]
    };

    expect(selectPrimaryCadBounds(document)).toEqual({ bounds: document.bounds, excludedEntityCount: 0, totalEntityCount: 4 });
  });
});
