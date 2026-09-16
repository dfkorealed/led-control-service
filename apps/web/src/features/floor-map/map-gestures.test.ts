import { describe, expect, it } from "vitest";
import {
  anchoredScrollPosition,
  clampMapZoom,
  normalizeSelectionRect,
  pointerDistance,
  pointerMidpoint
} from "./map-gestures";

describe("map gestures", () => {
  it("zooms around the midpoint of two touch pointers", () => {
    const start = [{ x: 100, y: 100 }, { x: 200, y: 100 }] as const;
    const next = [{ x: 50, y: 100 }, { x: 250, y: 100 }] as const;

    expect(pointerDistance(...start)).toBe(100);
    expect(pointerDistance(...next)).toBe(200);
    expect(pointerMidpoint(...next)).toEqual({ x: 150, y: 100 });
    expect(clampMapZoom(1 * 200 / 100)).toBe(2);
  });

  it("keeps the content below the pinch midpoint anchored", () => {
    expect(anchoredScrollPosition({ scroll: 40, anchor: 150, fromZoom: 1, toZoom: 2 }))
      .toBe(230);
  });

  it("orders area selection bounds when dragging back toward the origin", () => {
    expect(normalizeSelectionRect({ x: 300, y: 240 }, { x: 100, y: 80 }))
      .toEqual({ left: 100, top: 80, right: 300, bottom: 240 });
  });
});
