import { describe, expect, it } from "vitest";
import { fixtureLayoutUpdateSchema, parseFloorEditorSnapshot, registerFixtureBatchSchema } from "./schemas";

describe("fixture placement contracts", () => {
  const fixture = { id: "fixture-1", name: "Light", ratedWatt: "40.00", x: 20, y: 30, size: 24 };

  it("upgrades legacy snapshots without moving or verifying existing fixtures", () => {
    expect(parseFloorEditorSnapshot({ floorPlan: null, fixtures: [fixture], objects: [] })).toEqual({
      version: 2, floorPlan: null, objects: [],
      fixtures: [{ ...fixture, placementStatus: "placed", positionVerifiedAt: null }]
    });
  });

  it("accepts explicit placement and human verification but not caller timestamps", () => {
    expect(fixtureLayoutUpdateSchema.parse({ id: fixture.id, placementStatus: "placed", positionVerified: true }))
      .toMatchObject({ placementStatus: "placed", positionVerified: true });
    expect(() => fixtureLayoutUpdateSchema.parse({ id: fixture.id, positionVerifiedAt: new Date().toISOString() })).toThrow();
    expect(() => fixtureLayoutUpdateSchema.parse({ id: fixture.id, placementStatus: "unplaced", positionVerified: true })).toThrow();
  });

  it("round-trips v2 metadata and rejects verified unplaced snapshots", () => {
    const snapshot = { version: 2, floorPlan: null, objects: [], fixtures: [{
      ...fixture, placementStatus: "placed", positionVerifiedAt: "2026-09-09T00:00:00.000Z"
    }] };
    expect(parseFloorEditorSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parseFloorEditorSnapshot({ ...snapshot, version: 3 })).toThrow();
    expect(() => parseFloorEditorSnapshot({ ...snapshot, fixtures: [{ ...snapshot.fixtures[0], placementStatus: "unplaced" }] })).toThrow();
  });

  it("accepts registration without map placement", () => {
    expect(registerFixtureBatchSchema.parse({
      mode: "batch", defaults: { namePrefix: "L", startNumber: 1, digits: 3, ratedWatt: 40, size: 24 },
      nodes: [{ nodeId: "11111111-1111-4111-8111-111111111111" }]
    }).nodes).toHaveLength(1);
  });
});
