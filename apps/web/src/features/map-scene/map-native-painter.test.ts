import { expect, it, vi } from "vitest";
import type { OrderedMapDisplayPrimitive } from "@led-control/shared/map-display-contracts";
import { canJoinDisplayFill, paintDisplayPrimitive } from "./map-native-painter";

it("joins the canonical HATCH triangulation fallback without merging other identities or styles", () => {
  const a: OrderedMapDisplayPrimitive = { type: "triangle", elementId: "hatch", layerName: "layer", groupId: null,
    sourceType: "HATCH", zIndex: 1, fragmentOrder: 0, clipBounds: null,
    bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
    geometry: { points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }] },
    style: { fillColor: "#ff0000", strokeColor: null, strokeWidth: 0, opacity: 0.5 } };
  const b: OrderedMapDisplayPrimitive = { ...a, fragmentOrder: 1,
    geometry: { points: [{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }] } };
  expect(canJoinDisplayFill(a, b)).toBe(true);
  expect(canJoinDisplayFill(a, { ...b, elementId: "other" })).toBe(false);
  expect(canJoinDisplayFill(a, { ...b, style: { ...b.style, opacity: 0.25 } })).toBe(false);
});

it.each([1, 2])("paints %i compound holes without zero-winding connector edges", holes => {
  const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn() };
  const outer = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
  const hole = [{ x: 5, y: 5 }, { x: 5, y: 15 }, { x: 15, y: 15 }, { x: 15, y: 5 }];
  const second = [{ x: 16, y: 16 }, { x: 16, y: 18 }, { x: 18, y: 18 }, { x: 18, y: 16 }];
  const p: OrderedMapDisplayPrimitive = { type: "polyline", elementId: "hatch", layerName: "layer", groupId: null,
    sourceType: "HATCH", zIndex: 0, fragmentOrder: 0, clipBounds: null,
    bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
    geometry: { closed: true, points: [...outer, outer[0], ...hole, hole[0], outer[0],
      ...(holes === 2 ? [...second, second[0], outer[0]] : [])] },
    style: { fillColor: "#ff0000", strokeColor: null, strokeWidth: 0, opacity: 0.5 } };
  paintDisplayPrimitive(context as unknown as CanvasRenderingContext2D, p, 1);
  expect(context.moveTo.mock.calls).toEqual([[0, 0], [5, 5], ...(holes === 2 ? [[16, 16]] : [])]);
  expect(context.closePath).toHaveBeenCalledTimes(holes + 1);
  expect(context.fill).toHaveBeenCalledWith("nonzero");
  expect(context.stroke).not.toHaveBeenCalled();
});

it("uses Canvas's direct fillRect coverage for an unrotated translucent rectangle", () => {
  const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    rect: vi.fn(), fill: vi.fn(), fillRect: vi.fn(), stroke: vi.fn() };
  const rectangle: OrderedMapDisplayPrimitive = { type: "rectangle", elementId: "rectangle", layerName: "layer", groupId: null,
    sourceType: "RECTANGLE", zIndex: 0, fragmentOrder: 0, clipBounds: null,
    bounds: { minX: 0, minY: 0, maxX: 20, maxY: 10 },
    geometry: { origin: { x: 0, y: 0 }, width: 20, height: 10, rotation: 0 },
    style: { fillColor: "#ff0000", strokeColor: null, strokeWidth: 0, opacity: 0.5 } };

  paintDisplayPrimitive(context as unknown as CanvasRenderingContext2D, rectangle, 1);

  expect(context.fillRect).toHaveBeenCalledWith(0, 0, 20, 10);
  expect(context.fill).not.toHaveBeenCalled();
  expect(context.stroke).not.toHaveBeenCalled();
});
