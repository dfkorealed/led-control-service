import type { EditorTool, FloorMapObjectDraft } from "./editor-types";

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  width: number;
  height: number;
}

export interface MapRect extends Point, Bounds {}

export interface AlignmentGuide {
  orientation: "vertical" | "horizontal";
  position: number;
}

interface Delta {
  dx: number;
  dy: number;
}

export function screenToWorld(point: Point, pan: Point, zoom: number): Point {
  const safeZoom = zoom || 1;
  return {
    x: (point.x - pan.x) / safeZoom,
    y: (point.y - pan.y) / safeZoom
  };
}

export function clampPoint(point: Point, bounds: Bounds): Point {
  return {
    x: Math.min(Math.max(point.x, 0), bounds.width),
    y: Math.min(Math.max(point.y, 0), bounds.height)
  };
}

export function snapValueToGrid(value: number, gridSize: number) {
  return Math.round(value / gridSize) * gridSize;
}

export function snapPointToGrid(point: Point, gridSize: number): Point {
  return {
    x: snapValueToGrid(point.x, gridSize),
    y: snapValueToGrid(point.y, gridSize)
  };
}

export function snapRectToGrid(rect: MapRect, gridSize: number): MapRect {
  const start = snapPointToGrid(rect, gridSize);
  const end = snapPointToGrid({ x: rect.x + rect.width, y: rect.y + rect.height }, gridSize);
  return {
    ...start,
    width: Math.max(gridSize, end.x - start.x),
    height: Math.max(gridSize, end.y - start.y)
  };
}

export function alignRectToGuides(
  moving: MapRect,
  candidates: MapRect[],
  bounds: Bounds,
  threshold: number
): { point: Point; guides: AlignmentGuide[] } {
  const verticalTargets = [0, bounds.width / 2, bounds.width];
  const horizontalTargets = [0, bounds.height / 2, bounds.height];
  for (const candidate of candidates) {
    verticalTargets.push(candidate.x, candidate.x + candidate.width / 2, candidate.x + candidate.width);
    horizontalTargets.push(candidate.y, candidate.y + candidate.height / 2, candidate.y + candidate.height);
  }

  const vertical = nearestAlignment(
    [moving.x, moving.x + moving.width / 2, moving.x + moving.width],
    verticalTargets,
    threshold
  );
  const horizontal = nearestAlignment(
    [moving.y, moving.y + moving.height / 2, moving.y + moving.height],
    horizontalTargets,
    threshold
  );

  return {
    point: {
      x: moving.x + (vertical?.offset ?? 0),
      y: moving.y + (horizontal?.offset ?? 0)
    },
    guides: [
      ...(vertical ? [{ orientation: "vertical" as const, position: vertical.position }] : []),
      ...(horizontal ? [{ orientation: "horizontal" as const, position: horizontal.position }] : [])
    ]
  };
}

function nearestAlignment(anchors: number[], targets: number[], threshold: number) {
  let nearest: { offset: number; position: number; distance: number } | undefined;
  for (const anchor of anchors) {
    for (const target of targets) {
      const offset = target - anchor;
      const distance = Math.abs(offset);
      if (distance <= threshold && (!nearest || distance < nearest.distance)) {
        nearest = { offset, position: target, distance };
      }
    }
  }
  return nearest;
}

export function clampObjectToMap(rect: MapRect, bounds: Bounds): MapRect {
  const width = Math.min(Math.max(rect.width, 0), bounds.width);
  const height = Math.min(Math.max(rect.height, 0), bounds.height);
  return {
    x: Math.min(Math.max(rect.x, 0), Math.max(0, bounds.width - width)),
    y: Math.min(Math.max(rect.y, 0), Math.max(0, bounds.height - height)),
    width,
    height
  };
}

export function trianglePointsForSize(width: number, height: number) {
  return [
    { x: width / 2, y: 0 },
    { x: width, y: height },
    { x: 0, y: height }
  ];
}

export function moveByDelta(point: Point, delta: Delta, bounds: Bounds): Point {
  return clampPoint({ x: point.x + delta.dx, y: point.y + delta.dy }, bounds);
}

export function createDefaultObject(tool: EditorTool, point: Point): FloorMapObjectDraft {
  const base = {
    x: point.x,
    y: point.y,
    rotation: 0,
    strokeColor: "#2563eb",
    fillColor: "#dbeafe",
    strokeWidth: 2,
    text: "",
    fontSize: 16,
    locked: false,
    visible: true
  };

  if (tool === "triangle") {
    return {
      ...base,
      type: "triangle",
      width: 120,
      height: 104,
      points: trianglePointsForSize(120, 104)
    };
  }

  if (tool === "line") {
    return { ...base, type: "line", width: 180, height: 0, fillColor: "transparent" };
  }

  if (tool === "text") {
    return { ...base, type: "text", width: 120, height: 40, fillColor: "transparent", text: "텍스트" };
  }

  return { ...base, type: "rectangle", width: 160, height: 96 };
}

export function createObjectFromDrag(tool: EditorTool, start: Point, end: Point): FloorMapObjectDraft {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.max(Math.abs(end.x - start.x), 24);
  const height = Math.max(Math.abs(end.y - start.y), tool === "text" ? 32 : 24);
  const object = createDefaultObject(tool, { x, y });

  if (tool === "triangle") {
    return {
      ...object,
      width,
      height,
      points: trianglePointsForSize(width, height)
    };
  }

  if (tool === "line") {
    return { ...object, width, height: 0 };
  }

  return { ...object, width, height };
}
