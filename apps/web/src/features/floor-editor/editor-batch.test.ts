import { describe, expect, it } from "vitest";
import { createPlacementPreview, alignFixtures } from "./editor-placement";
import type { EditorFixture } from "./editor-types";

const fixtures: EditorFixture[] = Array.from({ length: 24 }, (_, i) => ({ id: `f${i}`, name: `L${i}`, x: i * 20, y: i * 10, ratedWatt: 40, size: 20, brightness: 70, status: "online", placementStatus: "unplaced" }));
const options = { mode: "grid" as const, x: 100, y: 100, width: 800, height: 500, columns: 6, rows: 4, gapX: 80, gapY: 70, angle: 0 };
describe("batch placement", () => {
  it.each([
    { angle: 180, expectedX: 240, expectedY: 400 },
    { angle: 270, expectedX: 400, expectedY: 240 },
    { angle: -90, expectedX: 400, expectedY: 240 },
    { angle: -45, expectedX: 400 + Math.SQRT1_2 * 160, expectedY: 400 - Math.SQRT1_2 * 160 }
  ])("allows a $angle degree line within the map and absolute extents", ({ angle, expectedX, expectedY }) => {
    const result = createPlacementPreview(fixtures.slice(0, 3), { ...options, mode: "line", x: 400, y: 400, width: 160, height: 160, angle }, { width: 1200, height: 800 }, []);
    expect(result.error).toBeNull();
    expect(result.points.map((point) => point.id)).toEqual(["f0", "f1", "f2"]);
    expect(result.points[2].x).toBeCloseTo(expectedX);
    expect(result.points[2].y).toBeCloseTo(expectedY);
  });
  it("allows an upward line along the left map edge without trigonometric drift", () => {
    const result = createPlacementPreview(fixtures.slice(0, 3), { ...options, mode: "line", x: 0, y: 160, angle: 270 }, { width: 1200, height: 800 }, []);
    expect(result.error).toBeNull();
    expect(result.points[2]).toEqual({ id: "f2", x: 0, y: 0 });
  });
  it.each([
    { x: 400, y: 400, width: 159, height: 160, angle: 180 },
    { x: 400, y: 400, width: 160, height: 159, angle: 270 },
    { x: 100, y: 400, width: 800, height: 500, angle: 180 },
    { x: 400, y: 100, width: 800, height: 500, angle: -90 }
  ])("rejects a reverse line beyond its extent or map boundary: $angle degrees at $x,$y", (placement) => {
    const result = createPlacementPreview(fixtures.slice(0, 3), { ...options, ...placement, mode: "line" }, { width: 1200, height: 800 }, []);
    expect(result.error).toContain("배치 영역이 부족");
    expect(result.points).toEqual([]);
  });
  it("previews 24 existing IDs without mutating or cloning", () => {
    const result = createPlacementPreview(fixtures, options, { width: 1200, height: 800 }, fixtures);
    expect(result.error).toBeNull();
    expect(result.points).toHaveLength(24);
    expect(result.points[23]).toEqual({ id: "f23", x: 500, y: 310 });
    expect(fixtures[0].placementStatus).toBe("unplaced");
  });
  it("rejects insufficient capacity and overlaps with existing fixtures", () => {
    expect(createPlacementPreview(fixtures, { ...options, rows: 1 }, { width: 1200, height: 800 }, []).error).toBeTruthy();
    expect(createPlacementPreview(fixtures, { ...options, gapX: 1 }, { width: 1200, height: 800 }, []).error).toBeTruthy();
    expect(createPlacementPreview(fixtures, options, { width: 1200, height: 800 }, [{ ...fixtures[0], id: "other", x: 100, y: 100, placementStatus: "placed" }]).error).toBeTruthy();
  });
  it("supports vertical line placement and equal distribution", () => {
    const result = createPlacementPreview(fixtures.slice(0, 3), { ...options, mode: "line", angle: 90 }, { width: 1200, height: 800 }, []);
    expect(result.points[2].x).toBeCloseTo(100);
    expect(result.points[2].y).toBeCloseTo(260);
    const points = alignFixtures([{ ...fixtures[0], x: 10 }, { ...fixtures[1], x: 25 }, { ...fixtures[2], x: 100 }], "distribute-x");
    expect(points[1].x).toBe(55);
  });
});
