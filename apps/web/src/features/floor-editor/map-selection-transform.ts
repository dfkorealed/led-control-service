import { mapTransformSchema, type Bounds, type MapElement } from "@led-control/shared/map-document-contracts";
import { transformMapPoint } from "@led-control/shared/map-document-geometry";
import { clampEditorZoom, snapPointToGrid } from "./geometry";
import { unionMapBounds } from "./map-editor-selection-stream";

type Transform = MapElement["transform"];
type Size = { width: number; height: number };
type FixturePosition = { id: string; x: number; y: number; size?: number };

/** One common delta preserves spacing, even when original positions are off-grid. */
export function finishSelectionMove(bounds: Bounds, delta: { x: number; y: number }, map: Size, gridSize?: number, axes = { x: true, y: true }) {
  const point = { x: bounds.minX + delta.x, y: bounds.minY + delta.y };
  const snapped = gridSize === undefined ? point : snapPointToGrid(point, gridSize);
  // Pointer gestures use both axes. Numeric forms must leave an untouched axis
  // unchanged, including its off-grid position and pre-existing boundary state.
  return { x: axes.x ? Math.max(-bounds.minX, Math.min(snapped.x - bounds.minX, map.width - bounds.maxX)) : 0,
    y: axes.y ? Math.max(-bounds.minY, Math.min(snapped.y - bounds.minY, map.height - bounds.maxY)) : 0 };
}

/** Resize in the original local frame. Never round transform.x/y: that moves the fixed anchor.
 * A rotated edge (one degree of freedom), or proportional resize, snaps its dominant world
 * component; independent corner resizing snaps both. Map edges take priority over the grid.
 */
export function finishSelectionResize(local: Bounds, next: Transform, anchor: string | null, map: Size, gridSize?: number, proportional = false,
  boundsForTransform?: (transform: Transform) => Bounds, original?: Transform): Transform {
  mapTransformSchema.parse(next);
  if (!anchor || anchor === "rotater") return next;
  const left = anchor.includes("left"), right = anchor.includes("right"), top = anchor.includes("top"), bottom = anchor.includes("bottom");
  // A zero-length axis has no resize degree of freedom, even though Konva supplies
  // a widened hit frame. Preserve that scale and project the other axis only.
  const changeX = (left || right) && local.maxX > local.minX, changeY = (top || bottom) && local.maxY > local.minY;
  if (!changeX && !changeY) return next;
  const fixed = { x: left ? local.maxX : right ? local.minX : (local.minX + local.maxX) / 2,
    y: top ? local.maxY : bottom ? local.minY : (local.minY + local.maxY) / 2 };
  const moving = { x: left ? local.minX : right ? local.maxX : fixed.x,
    y: top ? local.minY : bottom ? local.maxY : fixed.y };
  const pivot = transformMapPoint(fixed, next), edge = transformMapPoint(moving, next);
  const angle = next.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  let sx = next.scaleX, sy = next.scaleY;
  if (gridSize !== undefined) {
    const snapped = snapPointToGrid(edge, gridSize);
    const dx = snapped.x - pivot.x, dy = snapped.y - pivot.y;
    if (changeX && changeY && !proportional) {
      sx = (dx * cos + dy * sin) / (moving.x - fixed.x);
      sy = (-dx * sin + dy * cos) / (moving.y - fixed.y);
    } else {
      const vector = { x: edge.x - pivot.x, y: edge.y - pivot.y };
      const axis = Math.abs(vector.x) >= Math.abs(vector.y) ? "x" : "y";
      const ratio = (snapped[axis] - pivot[axis]) / vector[axis];
      if (Number.isFinite(ratio) && ratio > 0) { if (changeX) sx *= ratio; if (changeY) sy *= ratio; }
    }
  }
  sx = Math.max(0.000001, sx); sy = Math.max(0.000001, sy);
  const corners = [local.minX, local.maxX].flatMap(x => [local.minY, local.maxY].map(y => ({ x, y })));
  const at = (scaleX: number, scaleY: number): Transform => {
    const offset = transformMapPoint(fixed, { ...next, x: 0, y: 0, scaleX, scaleY });
    return { ...next, x: pivot.x - offset.x, y: pivot.y - offset.y, scaleX, scaleY };
  };
  const fits = (t: Transform) => {
    if (boundsForTransform) {
      const b = boundsForTransform(t);
      return b.minX >= 0 && b.minY >= 0 && b.maxX <= map.width && b.maxY <= map.height;
    }
    return corners.every(corner => {
    const p = transformMapPoint(corner, t);
    return p.x >= 0 && p.y >= 0 && p.x <= map.width && p.y <= map.height;
    });
  };
  let result = at(sx, sy);
  if (!fits(result)) {
    // Curves may have a virtual bbox anchor outside the map. Clamp from the valid
    // original shape, not a collapsed bbox that is not guaranteed to fit.
    const baseX = changeX ? original?.scaleX ?? 0.000001 : sx;
    const baseY = changeY ? original?.scaleY ?? 0.000001 : sy;
    if (!fits(at(baseX, baseY))) throw new RangeError("도형이 맵 범위를 벗어납니다.");
    const candidateAt = (ratio: number) => at(baseX + (sx - baseX) * ratio, baseY + (sy - baseY) * ratio);
    let low = 0, high = 1;
    for (let i = 0; i < 48; i++) {
      const ratio = (low + high) / 2;
      const candidate = candidateAt(ratio);
      if (fits(candidate)) low = ratio; else high = ratio;
    }
    result = candidateAt(low);
  }
  return mapTransformSchema.parse(result);
}

/** Fixture symbols resize proportionally. Independently rounding their center would
 * move the fixed corner. Fixture size limits take priority over grid alignment. */
export function finishFixtureResize(fixture: FixturePosition, next: Transform, anchor: string | null, map: Size, gridSize?: number) {
  const radius = (fixture.size ?? 20) / 2;
  const local = { minX: -radius, minY: -radius, maxX: radius, maxY: radius };
  const fixed = { x: anchor?.includes("left") ? radius : anchor?.includes("right") ? -radius : 0,
    y: anchor?.includes("top") ? radius : anchor?.includes("bottom") ? -radius : 0 };
  const limit = (t: Transform) => {
    const scale = Math.max(4, Math.min(200, radius * 2 * Math.max(t.scaleX, t.scaleY))) / (radius * 2);
    const pivot = transformMapPoint(fixed, t);
    return { ...t, x: pivot.x - fixed.x * scale, y: pivot.y - fixed.y * scale, scaleX: scale, scaleY: scale, rotation: 0 };
  };
  const result = limit(finishSelectionResize(local, limit(next), anchor, map, gridSize, true));
  const size = radius * 2 * result.scaleX;
  if (result.x - size / 2 < 0 || result.y - size / 2 < 0 || result.x + size / 2 > map.width || result.y + size / 2 > map.height) {
    throw new RangeError("조명이 맵 범위를 벗어납니다.");
  }
  return { id: fixture.id, x: result.x, y: result.y, size };
}

/** Konva positions a bounds handle at its corner; the canonical delta acts on world coordinates. */
export function boundsGestureTransform(bounds: Bounds, node: Transform): Transform {
  mapTransformSchema.parse(node);
  const origin = transformMapPoint({ x: bounds.minX, y: bounds.minY }, { ...node, x: 0, y: 0 });
  return mapTransformSchema.parse({ ...node, x: node.x - origin.x, y: node.y - origin.y });
}

export function selectionFixtureBounds(shapes: Bounds | null, fixtures: readonly FixturePosition[]): Bounds | null {
  return fixtures.reduce<Bounds | null>((bounds, fixture) => {
    const radius = (fixture.size ?? 20) / 2;
    return unionMapBounds(bounds, { minX: fixture.x - radius, minY: fixture.y - radius,
      maxX: fixture.x + radius, maxY: fixture.y + radius });
  }, shapes);
}

export function fitSelectionCamera(bounds: Bounds, viewport: Size) {
  const width = Math.max(1, bounds.maxX - bounds.minX), height = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = Math.min(2, clampEditorZoom(Math.min((viewport.width - 48) / width, (viewport.height - 48) / height)));
  return { zoom, pan: { x: (viewport.width - width * zoom) / 2 - bounds.minX * zoom,
    y: (viewport.height - height * zoom) / 2 - bounds.minY * zoom } };
}

/** Fixtures support translation in mixed gestures; validate all patches before the atomic store command. */
export function transformSelectedFixtures(fixtures: readonly FixturePosition[], delta: Transform, map: Size) {
  mapTransformSchema.parse(delta);
  if (fixtures.length && (delta.scaleX !== 1 || delta.scaleY !== 1 || delta.rotation !== 0)) throw new RangeError("Mixed fixture transforms must be translations");
  return fixtures.map(fixture => {
    const x = fixture.x + delta.x, y = fixture.y + delta.y;
    if (![x, y, map.width, map.height].every(Number.isFinite) || x < 0 || y < 0 || x > map.width || y > map.height) {
      throw new RangeError("Fixture movement exceeds map bounds");
    }
    return { id: fixture.id, x, y };
  });
}
