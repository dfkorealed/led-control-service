import type { EditorTool, FloorMapObjectDraft } from "./editor-types";

interface Point {
  x: number;
  y: number;
}

interface Bounds {
  width: number;
  height: number;
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

export function moveByDelta(point: Point, delta: Delta, bounds: Bounds): Point {
  return clampPoint({ x: point.x + delta.dx, y: point.y + delta.dy }, bounds);
}

export function createDefaultObject(tool: EditorTool, point: Point): FloorMapObjectDraft {
  const base = {
    x: point.x,
    y: point.y,
    rotation: 0,
    strokeColor: "#2563eb",
    fillColor: "rgba(37, 99, 235, 0.12)",
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
      points: [
        { x: 60, y: 0 },
        { x: 120, y: 104 },
        { x: 0, y: 104 }
      ]
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
