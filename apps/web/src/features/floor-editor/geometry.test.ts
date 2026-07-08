import { describe, expect, it } from "vitest";
import { clampPoint, createDefaultObject, createObjectFromDrag, moveByDelta, screenToWorld } from "./geometry";

describe("floor editor geometry", () => {
  it("converts screen coordinates into world coordinates using pan and zoom", () => {
    expect(screenToWorld({ x: 260, y: 140 }, { x: 20, y: 40 }, 2)).toEqual({ x: 120, y: 50 });
  });

  it("clamps points inside the floor plan bounds", () => {
    expect(clampPoint({ x: -8, y: 920 }, { width: 1200, height: 800 })).toEqual({ x: 0, y: 800 });
    expect(clampPoint({ x: 560, y: 240 }, { width: 1200, height: 800 })).toEqual({ x: 560, y: 240 });
  });

  it("moves a point by delta and keeps it inside bounds", () => {
    expect(moveByDelta({ x: 1180, y: 20 }, { dx: 80, dy: -40 }, { width: 1200, height: 800 })).toEqual({ x: 1200, y: 0 });
  });

  it("creates default map objects for the active drawing tool", () => {
    expect(createDefaultObject("rectangle", { x: 100, y: 160 })).toMatchObject({
      type: "rectangle",
      x: 100,
      y: 160,
      width: 160,
      height: 96,
      strokeColor: "#2563eb",
      fillColor: "#dbeafe",
      strokeWidth: 2
    });

    expect(createDefaultObject("triangle", { x: 24, y: 32 })).toMatchObject({
      type: "triangle",
      x: 24,
      y: 32,
      points: [
        { x: 60, y: 0 },
        { x: 120, y: 104 },
        { x: 0, y: 104 }
      ],
      locked: false,
      visible: true
    });

    expect(createDefaultObject("text", { x: 24, y: 32 })).toMatchObject({
      type: "text",
      x: 24,
      y: 32,
      text: "텍스트",
      fontSize: 16
    });
  });

  it("creates map objects from drag coordinates with normalized bounds", () => {
    expect(createObjectFromDrag("rectangle", { x: 320, y: 240 }, { x: 200, y: 160 })).toMatchObject({
      type: "rectangle",
      x: 200,
      y: 160,
      width: 120,
      height: 80
    });

    expect(createObjectFromDrag("triangle", { x: 10, y: 20 }, { x: 12, y: 22 })).toMatchObject({
      type: "triangle",
      width: 24,
      height: 24,
      points: [
        { x: 12, y: 0 },
        { x: 24, y: 24 },
        { x: 0, y: 24 }
      ]
    });
  });
});
