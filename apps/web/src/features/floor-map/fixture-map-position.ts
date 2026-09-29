import type { FloorMapSnapshot } from "@led-control/shared";
import type { MapPoint } from "./map-gestures";

export type FixtureMapPosition = { kind: "placed"; point: MapPoint } | { kind: "unplaced" } | { kind: "unknown" };
type FixturePosition = { id: string; x: number; y: number; placementStatus?: "placed" | "unplaced" };
export function resolveFixtureMapPosition(snapshot: FloorMapSnapshot | null | undefined, fixture: FixturePosition | null | undefined): FixtureMapPosition {
  if (!snapshot || !fixture) return { kind: "unknown" };
  const saved = snapshot.fixtures?.find(pin => pin.id === fixture.id);
  // Common-map placements are authoritative; runtime coordinates may predate an import.
  if (!saved && (snapshot.mapDocument || fixture.placementStatus === "unplaced")) return { kind: "unplaced" };
  const point = saved ?? fixture;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0
    || point.x > snapshot.width || point.y > snapshot.height) return { kind: "unknown" };
  return { kind: "placed", point: { x: point.x, y: point.y } };
}
