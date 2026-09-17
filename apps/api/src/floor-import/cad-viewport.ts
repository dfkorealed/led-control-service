import type { CadBounds, CadPoint } from "./cad-types";

export function createCadViewport(bounds: CadBounds): { width: number; height: number } {
  return {
    width: Math.ceil(Math.max(1, bounds.maxX - bounds.minX + 2)),
    height: Math.ceil(Math.max(1, bounds.maxY - bounds.minY + 2))
  };
}

export function projectCadPointToViewport(point: CadPoint, bounds: CadBounds): { x: number; y: number } {
  return { x: point.x - bounds.minX + 1, y: bounds.maxY - point.y + 1 };
}

export function cadViewportSvgTransform(bounds: CadBounds): string {
  return `matrix(1 0 0 -1 ${format(-bounds.minX + 1)} ${format(bounds.maxY + 1)})`;
}

function format(value: number): string {
  return Number(value.toFixed(6)).toString();
}
