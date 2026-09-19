import { mapTransformSchema, type Bounds, type MapElement } from "@led-control/shared/map-document-contracts";
import { transformMapPoint } from "@led-control/shared/map-document-geometry";
import { clampEditorZoom } from "./geometry";
import { unionMapBounds } from "./map-editor-selection-stream";

type Transform = MapElement["transform"];
type Size = { width: number; height: number };
type FixturePosition = { id: string; x: number; y: number; size?: number };

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
