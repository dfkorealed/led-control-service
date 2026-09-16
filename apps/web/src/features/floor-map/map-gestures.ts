export interface MapPoint {
  x: number;
  y: number;
}

export interface MapSelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type MapInteractionMode = "pan" | "select" | "area";

export function pointerDistance(left: MapPoint, right: MapPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

export function pointerMidpoint(left: MapPoint, right: MapPoint): MapPoint {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

export function clampMapZoom(value: number) {
  return Math.round(Math.min(4, Math.max(0.1, value)) * 10) / 10;
}

export function anchoredScrollPosition(input: {
  scroll: number;
  anchor: number;
  fromZoom: number;
  toZoom: number;
}) {
  return ((input.scroll + input.anchor) / input.fromZoom) * input.toZoom - input.anchor;
}

export function normalizeSelectionRect(start: MapPoint, end: MapPoint): MapSelectionRect {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y)
  };
}
