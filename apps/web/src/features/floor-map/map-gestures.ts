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

export interface MapSize {
  width: number;
  height: number;
}

export interface MapRect extends MapSize {
  left: number;
  top: number;
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

export function mapPointFromSurface(input: {
  client: MapPoint;
  surface: MapRect;
  mapSize: MapSize;
}): MapPoint {
  return {
    x: (input.client.x - input.surface.left) * input.mapSize.width / input.surface.width,
    y: (input.client.y - input.surface.top) * input.mapSize.height / input.surface.height
  };
}

export function scrollAdjustmentForMapAnchor(input: {
  mapPoint: MapPoint;
  mapSize: MapSize;
  surface: MapRect;
  viewport: Pick<MapRect, "left" | "top">;
  anchor: MapPoint;
}): MapPoint {
  return {
    x: input.surface.left + input.mapPoint.x * input.surface.width / input.mapSize.width - input.viewport.left - input.anchor.x,
    y: input.surface.top + input.mapPoint.y * input.surface.height / input.mapSize.height - input.viewport.top - input.anchor.y
  };
}

export function normalizeSelectionRect(start: MapPoint, end: MapPoint): MapSelectionRect {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y)
  };
}
