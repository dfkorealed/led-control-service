import { describe, expect, it } from "vitest";
import {
  buildEditorSpatialIndex,
  mapObjectWorldAabb,
  queryEditorSpatialIndex
} from "./editor-spatial-index";

describe("editor spatial index", () => {
  it("returns viewport and margin items in deterministic source order", () => {
    const index = buildEditorSpatialIndex([
      { id: "outside", x: 900, y: 900 },
      { id: "inside", x: 100, y: 100 },
      { id: "margin", x: 540, y: 150 }
    ], 64);

    const visible = queryEditorSpatialIndex(index, { x: 0, y: 0, width: 500, height: 300 }, 80);

    expect(visible.map((item) => item.id)).toEqual(["inside", "margin"]);
  });

  it("indexes rectangles across cells without returning duplicates", () => {
    const index = buildEditorSpatialIndex([
      { id: "wide", x: 90, y: 20, width: 100, height: 40 },
      { id: "edge", x: 220, y: 60, width: 20, height: 20 },
      { id: "miss", x: 400, y: 400, width: 20, height: 20 }
    ], 64);

    expect(queryEditorSpatialIndex(index, { x: 128, y: 0, width: 100, height: 100 }, 0).map((item) => item.id))
      .toEqual(["wide", "edge"]);
  });

  it("keeps oversized rectangles out of the bucket cross-product", () => {
    const index = buildEditorSpatialIndex([
      { id: "huge", x: -1_000_000, y: -1_000_000, width: 2_000_000, height: 2_000_000 },
      { id: "small", x: 10, y: 10, width: 20, height: 20 }
    ], 128);

    expect(index.buckets.size).toBeLessThanOrEqual(4);
    expect(index.oversized.map(({ item }) => item.id)).toEqual(["huge"]);
    expect(queryEditorSpatialIndex(index, { x: 0, y: 0, width: 100, height: 100 }, 0).map((item) => item.id))
      .toEqual(["huge", "small"]);
  });

  it("rejects invalid item and query bounds before iterating cells", () => {
    const index = buildEditorSpatialIndex([
      { id: "valid", x: 10, y: 10, width: 20, height: 20 },
      { id: "negative", x: 10, y: 10, width: -1, height: 20 }
    ], 128);

    expect(queryEditorSpatialIndex(index, { x: 0, y: 0, width: 100, height: 100 }, 0).map((item) => item.id))
      .toEqual(["valid"]);
    expect(() => queryEditorSpatialIndex(index, { x: Number.NaN, y: 0, width: 100, height: 100 }, 0))
      .toThrow("bounds must be finite and nonnegative");
  });

  it("computes a world AABB from rotated corners and rendered stroke", () => {
    expect(mapObjectWorldAabb({
      x: 1_000,
      y: 200,
      width: 40,
      height: 300,
      rotation: 90,
      strokeWidth: 20,
      type: "rectangle"
    })).toEqual({ x: 690, y: 190, width: 320, height: 60 });

    expect(mapObjectWorldAabb({
      x: 962,
      y: 50,
      width: 20,
      height: 0,
      rotation: 0,
      strokeWidth: 2,
      type: "line"
    })).toEqual({ x: 959, y: 47, width: 26, height: 6 });
  });
});
