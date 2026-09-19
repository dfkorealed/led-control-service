import {
  mapElementSchema, mapTransformSchema,
  type Bounds as ElementBounds, type MapElement, type MapOp, type Point
} from "@led-control/shared/map-document-contracts";
import { getMapElementBounds, transformMapPoint } from "@led-control/shared/map-document-geometry";
import { alignRectToGuides, snapPointToGrid, type AlignmentGuide, type Bounds, type MapRect } from "./geometry";

export type MapElementTransform = MapElement["transform"];
export const MAP_ELEMENT_IDENTITY: MapElementTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

export interface MapElementAlignmentOptions {
  mapBounds: Bounds;
  /** Undefined disables snapping; applied only when a gesture finishes. */
  gridSize?: number;
  /** World-space rectangles, excluding every selected element. */
  guideTargets?: MapRect[];
  /** World units. The overlay defaults to six screen pixels divided by zoom. */
  guideThreshold?: number;
}

export function uniqueMapSelection(selection: readonly MapElement[]): MapElement[] {
  return [...new Map(selection.map(element => [element.id, element])).values()];
}

export function getMapSelectionBounds(selection: readonly MapElement[]): ElementBounds | null {
  if (!selection.length) return null;
  return selection.map(getMapElementBounds).reduce((a, b) => ({
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY)
  }));
}

export function getMapElementSize(element: MapElement): Bounds {
  const box = getMapElementBounds({ ...element, transform: MAP_ELEMENT_IDENTITY });
  return { width: (box.maxX - box.minX) * element.transform.scaleX,
    height: (box.maxY - box.minY) * element.transform.scaleY };
}

/** Sizes refer to the unrotated local frame, not the rotation-dependent world AABB. */
export function resizeMapElement(element: MapElement, size: Partial<Bounds>): MapElement {
  const current = getMapElementSize(element);
  const transform = { ...element.transform };
  for (const axis of ["width", "height"] as const) {
    const value = size[axis];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0 || current[axis] <= 0) {
      throw new RangeError("크기는 0보다 커야 하며 길이가 없는 축은 확대할 수 없습니다.");
    }
    const scale = axis === "width" ? "scaleX" : "scaleY";
    transform[scale] *= value / current[axis];
  }
  return mapElementSchema.parse({ ...element, transform });
}

function validateMapBounds(bounds: Bounds) {
  if (![bounds.width, bounds.height].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError("맵 크기가 올바르지 않습니다.");
  }
}

/** Validates the entire batch before the caller can enqueue anything. Never performs IO. */
export function createMapElementUpdateOps(
  selection: readonly MapElement[], update: (element: MapElement) => MapElement, mapBounds?: Bounds
): MapOp[] {
  if (mapBounds) validateMapBounds(mapBounds);
  const originals = uniqueMapSelection(selection);
  if (originals.some(element => element.locked)) throw new Error("잠금 상태의 요소는 수정할 수 없습니다.");
  return originals.flatMap(original => {
    const candidate = mapElementSchema.parse(update(structuredClone(original)));
    if (candidate.id !== original.id || candidate.type !== original.type) {
      throw new Error("편집 중 요소의 식별자와 종류를 변경할 수 없습니다.");
    }
    const box = getMapElementBounds(candidate);
    // A tiny tolerance absorbs trigonometric roundoff at an exact map edge, not user-visible overflow.
    const tolerance = 1e-7;
    if (mapBounds && (box.minX < -tolerance || box.minY < -tolerance ||
      box.maxX > mapBounds.width + tolerance || box.maxY > mapBounds.height + tolerance)) {
      throw new RangeError("도형이 맵 범위를 벗어납니다.");
    }
    return JSON.stringify(candidate) === JSON.stringify(original) ? [] : [{ kind: "update" as const, element: candidate }];
  });
}

/** Compose one world-space gesture with each original local transform, never with its preview. */
export function transformMapSelection(
  selection: readonly MapElement[], delta: MapElementTransform, mapBounds: Bounds
): MapOp[] {
  mapTransformSchema.parse(delta);
  return createMapElementUpdateOps(selection, element => {
    if (delta.scaleX === 1 && delta.scaleY === 1 && delta.rotation === 0) {
      return { ...element, transform: { ...element.transform,
        x: element.transform.x + delta.x, y: element.transform.y + delta.y } };
    }
    const origin = transformMapPoint({ x: 0, y: 0 }, element.transform);
    const position = transformMapPoint(origin, delta);
    // Transform directions without translation to avoid cancellation for large world coordinates.
    const localLinear = { ...element.transform, x: 0, y: 0 };
    const deltaLinear = { ...delta, x: 0, y: 0 };
    const x = transformMapPoint(transformMapPoint({ x: 1, y: 0 }, localLinear), deltaLinear);
    const y = transformMapPoint(transformMapPoint({ x: 0, y: 1 }, localLinear), deltaLinear);
    const scaleX = Math.hypot(x.x, x.y), scaleY = Math.hypot(y.x, y.y);
    // U2 cannot store shear. Silently dropping it would corrupt rotated groups and text.
    if (Math.abs(x.x * y.x + x.y * y.y) > 1e-8 * scaleX * scaleY) {
      throw new RangeError("기울임 변환은 지원하지 않습니다. 회전된 선택은 비율을 유지해 크기를 변경하세요.");
    }
    return { ...element, transform: { ...position, scaleX, scaleY,
      rotation: Math.atan2(x.y, x.x) * 180 / Math.PI } };
  }, mapBounds);
}

export function moveMapSelection(
  selection: readonly MapElement[], offset: Point, options: MapElementAlignmentOptions, final: boolean
): { offset: Point; guides: AlignmentGuide[] } {
  validateMapBounds(options.mapBounds);
  if (![offset.x, offset.y].every(Number.isFinite)) throw new RangeError("이동 좌표가 올바르지 않습니다.");
  if (options.gridSize !== undefined && (!Number.isFinite(options.gridSize) || options.gridSize <= 0)) {
    throw new RangeError("격자 간격이 올바르지 않습니다.");
  }
  const box = getMapSelectionBounds(selection);
  if (!box) return { offset: { ...offset }, guides: [] };
  const moving = { x: box.minX + offset.x, y: box.minY + offset.y,
    width: box.maxX - box.minX, height: box.maxY - box.minY };
  const aligned = options.guideTargets ? alignRectToGuides(moving, options.guideTargets,
    options.mapBounds, options.guideThreshold ?? 6) : { point: moving, guides: [] };
  // Grid wins at commit; retaining a preview guide after snapping would advertise a false alignment.
  const point = final && options.gridSize !== undefined ? snapPointToGrid(aligned.point, options.gridSize) : aligned.point;
  return { offset: { x: point.x - box.minX, y: point.y - box.minY },
    guides: final && options.gridSize !== undefined ? [] : aligned.guides };
}
