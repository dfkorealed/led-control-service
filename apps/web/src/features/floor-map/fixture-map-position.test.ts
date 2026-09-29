import { describe, expect, it } from "vitest";
import type { FloorMapSnapshot } from "@led-control/shared";
import { resolveFixtureMapPosition } from "./fixture-map-position";
const snapshot: FloorMapSnapshot = { floorId: "f", revision: 1, width: 1000, height: 800, objects: [], floorPlan: null, fixtures: [{ id: "a", name: "a", x: 700, y: 300, size: 20 }] };
describe("fixture placement authority", () => {
  it("uses saved coordinates instead of stale runtime", () => {
    expect(resolveFixtureMapPosition(snapshot, { id: "a", x: 20, y: 10, placementStatus: "unplaced" })).toEqual({ kind: "placed", point: { x: 700, y: 300 } });
  });
  it("allows legacy runtime placements only", () => {
    expect(resolveFixtureMapPosition(snapshot, { id: "b", x: 20, y: 10 })).toEqual({ kind: "placed", point: { x: 20, y: 10 } });
    expect(resolveFixtureMapPosition(snapshot, { id: "b", x: 20, y: 10, placementStatus: "unplaced" })).toEqual({ kind: "unplaced" });
  });
  it("rejects missing or invalid positions", () => {
    expect(resolveFixtureMapPosition(snapshot, null)).toEqual({ kind: "unknown" });
    expect(resolveFixtureMapPosition(snapshot, { id: "b", x: NaN, y: 10 })).toEqual({ kind: "unknown" });
  });
});
