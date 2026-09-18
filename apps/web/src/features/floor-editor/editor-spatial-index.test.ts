import { describe, expect, it } from "vitest";
import { buildEditorSpatialIndex, queryEditorSpatialIndex } from "./editor-spatial-index";

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
});
