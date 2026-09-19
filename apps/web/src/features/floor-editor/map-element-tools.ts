import {
  MAP_ELEMENT_MAX_POINTS, mapElementSchema, mapPointSchema,
  type MapElement, type MapShape, type Point
} from "@led-control/shared/map-document-contracts";

export type MapElementType = MapElement["type"];
export type MapElementOfType<T extends MapElementType> = Extract<MapElement, { type: T }>;
export const DEFAULT_MAP_ELEMENT_LAYER_ID = "map";

export interface MapElementFactoryOptions {
  layerId?: string;
  style?: Partial<MapElement["style"]>;
  /** Omit to retain fractional coordinates; supplying a grid explicitly enables snapping. */
  gridSize?: number;
  keepAspectRatio?: boolean;
  arc?: Partial<Pick<MapElementOfType<"arc">["geometry"], "startAngle" | "endAngle" | "counterClockwise">>;
  text?: string;
  fontSize?: number;
}

function snapPoint(point: Point, gridSize?: number): Point {
  if (gridSize !== undefined && (!Number.isFinite(gridSize) || gridSize <= 0)) {
    throw new RangeError("격자 간격은 0보다 큰 유한값이어야 합니다.");
  }
  return gridSize === undefined ? { ...point }
    : { x: Math.round(point.x / gridSize) * gridSize, y: Math.round(point.y / gridSize) * gridSize };
}

function validateElement<T extends MapElementType>(element: MapElementOfType<T>): MapElementOfType<T> | null {
  const result = mapElementSchema.safeParse(element);
  // Parsing also clones geometry/style, so a saved element never aliases draft input.
  return result.success ? result.data as MapElementOfType<T> : null;
}

function createElement(shape: MapShape, id: string, options: MapElementFactoryOptions): MapElement | null {
  const closed = ["rectangle", "triangle", "ellipse", "polygon"].includes(shape.type);
  return validateElement({
    ...shape, id, groupId: null, layerId: options.layerId ?? DEFAULT_MAP_ELEMENT_LAYER_ID,
    zIndex: 0, visible: true, locked: false, provenance: null,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    style: { strokeColor: "#2563eb", fillColor: closed ? "#dbeafe" : null,
      strokeWidth: 2, opacity: 1, ...options.style }
  });
}

/** Returns null for a cancelled/invalid gesture, never a saveable zero-size element.
 * The caller must ensure the chosen layer exists; this factory does not create document structure.
 */
export function createMapElementFromDrag<T extends MapElementType>(
  type: T, start: Point, end: Point, id: string, options: MapElementFactoryOptions = {}
): MapElementOfType<T> | null {
  const a = snapPoint(start, options.gridSize);
  let b = snapPoint(end, options.gridSize);
  if (!mapPointSchema.safeParse(a).success || !mapPointSchema.safeParse(b).success) return null;
  let width = Math.abs(b.x - a.x);
  let height = Math.abs(b.y - a.y);
  const isLine = type === "line" || type === "polyline";
  if (isLine ? width === 0 && height === 0 : width === 0 || height === 0) return null;
  if (!isLine && options.keepAspectRatio) {
    const size = Math.max(width, height);
    b = { x: a.x + Math.sign(b.x - a.x) * size, y: a.y + Math.sign(b.y - a.y) * size };
    width = size;
    height = size;
  }
  const origin = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
  const center = { x: origin.x + width / 2, y: origin.y + height / 2 };
  let shape: MapShape;
  switch (type) {
    case "line": shape = { type, geometry: { start: a, end: b } }; break;
    case "rectangle": shape = { type, geometry: { origin, width, height } }; break;
    case "triangle": shape = { type, geometry: { points: [
      { x: center.x, y: origin.y }, { x: origin.x + width, y: origin.y + height },
      { x: origin.x, y: origin.y + height }
    ] } }; break;
    case "ellipse": shape = { type, geometry: { center, radiusX: width / 2, radiusY: height / 2 } }; break;
    case "arc": shape = { type, geometry: { center, radius: Math.min(width, height) / 2,
      startAngle: 0, endAngle: 180, counterClockwise: false, ...options.arc } }; break;
    case "polyline": shape = { type, geometry: { points: [a, b] } }; break;
    case "polygon": shape = { type, geometry: { outer: [origin,
      { x: origin.x + width, y: origin.y }, { x: origin.x + width, y: origin.y + height },
      { x: origin.x, y: origin.y + height }], holes: [] } }; break;
    case "text": shape = { type, geometry: { position: origin, width, height,
      text: options.text ?? "텍스트", fontSize: options.fontSize ?? 20 } }; break;
    default: return null;
  }
  return createElement(shape, id, options) as MapElementOfType<T> | null;
}

export interface MapPathDraft {
  readonly type: "polyline" | "polygon";
  readonly points: readonly Readonly<Point>[];
  readonly options: Readonly<MapElementFactoryOptions>;
}

export function createMapPathDraft(type: MapPathDraft["type"], options: MapElementFactoryOptions = {}): MapPathDraft {
  snapPoint({ x: 0, y: 0 }, options.gridSize);
  return { type, points: [], options: { ...options,
    style: options.style ? { ...options.style } : undefined,
    arc: options.arc ? { ...options.arc } : undefined } };
}

export function appendMapPathPoint(draft: MapPathDraft, point: Point): MapPathDraft {
  const next = mapPointSchema.parse(snapPoint(point, draft.options.gridSize));
  const last = draft.points.at(-1);
  // Double-click completion emits another click at the same point; do not add a zero-length edge.
  if (last?.x === next.x && last.y === next.y) return draft;
  if (draft.points.length >= MAP_ELEMENT_MAX_POINTS) throw new RangeError("꼭짓점 수 한도를 초과했습니다.");
  return { ...draft, points: [...draft.points, next] };
}

function openRing(points: readonly Readonly<Point>[]): Point[] {
  const first = points[0];
  const last = points.at(-1);
  const closed = points.length > 1 && first.x === last?.x && first.y === last.y;
  return (closed ? points.slice(0, -1) : points).map((point) => ({ ...point }));
}

/** Enter/double-click callers finish; invalid drafts stay local so the user can repair them. */
export function finishMapPathDraft(draft: MapPathDraft, id: string): MapElementOfType<"polyline" | "polygon"> | null {
  const shape: MapShape = draft.type === "polyline"
    ? { type: "polyline", geometry: { points: draft.points.map((point) => ({ ...point })) } }
    : { type: "polygon", geometry: { outer: openRing(draft.points), holes: [] } };
  return createElement(shape, id, draft.options) as MapElementOfType<"polyline" | "polygon"> | null;
}

/** Assign the returned null on Escape; cancellation has no document/history side effects. */
export function cancelMapPathDraft(_draft: MapPathDraft | null): null {
  return null;
}

export function addMapPolygonHole(
  polygon: MapElementOfType<"polygon">, points: readonly Readonly<Point>[]
): MapElementOfType<"polygon"> | null {
  // Shared validation checks simplicity, containment, touching, overlaps and total point budget.
  // Points are geometry-local, not screen coordinates or transformed world coordinates.
  return validateElement({ ...polygon, geometry: { ...polygon.geometry,
    holes: [...polygon.geometry.holes, openRing(points)] } });
}

export function removeMapPolygonHole(polygon: MapElementOfType<"polygon">, index: number): MapElementOfType<"polygon"> | null {
  if (!Number.isInteger(index) || index < 0 || index >= polygon.geometry.holes.length) return null;
  return validateElement({ ...polygon, geometry: { ...polygon.geometry,
    holes: polygon.geometry.holes.filter((_, i) => i !== index) } });
}

/** Angles use the U2 degree convention and may cross zero or describe a full circle. */
export function updateMapArcAngles(
  arc: MapElementOfType<"arc">, angles: NonNullable<MapElementFactoryOptions["arc"]>
): MapElementOfType<"arc"> | null {
  return validateElement({ ...arc, geometry: { ...arc.geometry, ...angles } });
}
