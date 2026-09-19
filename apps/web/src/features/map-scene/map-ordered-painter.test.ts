import { describe, expect, it, vi } from "vitest";
import type { OrderedMapDisplayPrimitive } from "@led-control/shared/map-display-contracts";
import { MapOrderedPainter } from "./map-ordered-painter";

const triangle = (fragmentOrder: number): OrderedMapDisplayPrimitive => ({ type: "triangle", elementId: "polygon", zIndex: 1,
  fragmentOrder, layerName: "layer", groupId: null, sourceType: "polygon", clipBounds: null,
  bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  style: { fillColor: "#ff0000", strokeColor: null, strokeWidth: 0, opacity: 0.5 },
  geometry: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] } });
function context() {
  return { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
    fill: vi.fn(), stroke: vi.fn(), globalAlpha: 1, fillStyle: "" };
}
const group = { id: "polygon-fill", elementId: "polygon", phase: "fill" as const, sequence: 0, final: false, pointCount: 3,
  style: { fillColor: "#ff0000", opacity: 0.5 } };

describe("bounded semantic fill continuation", () => {
  it("fills once across page boundaries, without merging independent same-style primitives", () => {
    const ctx = context(), reserve = vi.fn();
    const painter = new MapOrderedPainter(ctx as unknown as CanvasRenderingContext2D, 1, reserve);
    painter.paint({ primitive: triangle(0), paintGroup: group });
    painter.paint({ primitive: triangle(1), paintGroup: { ...group, sequence: 1, final: true } });
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenLastCalledWith(6 * 64);
    painter.paint({ primitive: { ...triangle(2), elementId: "independent" } });
    expect(ctx.fill).toHaveBeenCalledTimes(2);
    painter.finish(); expect(ctx.fill).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenLastCalledWith(0);
  });

  it("rejects path growth before appending instead of flushing alpha at a budget boundary", () => {
    const ctx = context();
    const painter = new MapOrderedPainter(ctx as unknown as CanvasRenderingContext2D, 1,
      bytes => { if (bytes > 3 * 64) throw new Error("path budget"); });
    painter.paint({ primitive: triangle(0), paintGroup: group });
    expect(() => painter.paint({ primitive: triangle(1), paintGroup: group })).toThrow("path budget");
    expect(ctx.moveTo).toHaveBeenCalledTimes(1);
    expect(ctx.fill).not.toHaveBeenCalled();
    painter.cancel(); expect(ctx.fill).not.toHaveBeenCalled(); expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  it("rejects continuation style/identity changes", () => {
    const ctx = context();
    const painter = new MapOrderedPainter(ctx as unknown as CanvasRenderingContext2D, 1, () => undefined);
    painter.paint({ primitive: triangle(0), paintGroup: group });
    expect(() => painter.paint({ primitive: { ...triangle(1), style: { ...triangle(1).style, opacity: 1 } },
      paintGroup: group })).toThrow("fill continuation");
    painter.cancel();
  });

  it("rejects a forged declared style on the first page before starting its path", () => {
    const ctx = context();
    const painter = new MapOrderedPainter(ctx as unknown as CanvasRenderingContext2D, 1, () => undefined);
    expect(() => painter.paint({ primitive: triangle(0), paintGroup: { ...group,
      style: { fillColor: "#0000ff", opacity: 0.5 } } })).toThrow("fill continuation");
    expect(ctx.moveTo).not.toHaveBeenCalled();
  });
});
