import type { MapPoint, MapRect } from "./map-gestures";

export interface MarkerHitBounds extends MapRect {
  id: string;
}

/** Resolve the current on-screen button rectangles, independently of paint order.
 * Disabled markers participate: their actual center must never fall through to
 * an eligible neighbour. Coincident centers have a stable ID tie-break because
 * geometry alone cannot distinguish fixtures placed at exactly the same point.
 */
export function resolveMarkerHit(point: MapPoint, bounds: readonly MarkerHitBounds[]): string | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  let winner: { id: string; distance: number } | null = null;
  for (const marker of bounds) {
    if (![marker.left, marker.top, marker.width, marker.height].every(Number.isFinite) ||
        marker.width <= 0 || marker.height <= 0 ||
        point.x < marker.left || point.x > marker.left + marker.width ||
        point.y < marker.top || point.y > marker.top + marker.height) continue;
    const distance = (point.x - marker.left - marker.width / 2) ** 2 +
      (point.y - marker.top - marker.height / 2) ** 2;
    if (!winner || distance < winner.distance || (distance === winner.distance && marker.id < winner.id)) {
      winner = { id: marker.id, distance };
    }
  }
  return winner?.id ?? null;
}
