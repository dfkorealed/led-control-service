import { describe, expect, it } from "vitest";
import { floorMapSnapshotSchema, saveEditorStateSchema } from "./schemas";

const base = { expectedRevision: 1, leaseToken: "lease", leaseFence: 1,
  fixtureUpdates: [], objectCreates: [], objectUpdates: [], objectDeletes: [] };
const changes = { requestId: "request", generationId: "generation", operations: [] };

describe("atomic editor document save", () => {
  it("exposes a minimal common document reference in the monitoring snapshot", () => {
    const document = { formatVersion: 1, generationId: "g", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: 5,
      manifest: { assetId: "asset", byteSize: 10, decodedByteSize: 20, sha256: "a".repeat(64) } };
    const snapshot = { floorId: "00000000-0000-4000-8000-000000000001", revision: 1, width: 1200, height: 800,
      floorPlan: null, cadScene: null, mapDocument: document, objects: [] };
    expect(floorMapSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(floorMapSnapshotSchema.safeParse({ ...snapshot, revision: 2 }).success).toBe(false);
    const cad = { ...snapshot, floorPlan: { sourceType: "cad", imageUrl: "", originalFileUrl: null,
      renderedImageUrl: null, width: 1200, height: 800, gridSize: 10 } };
    expect(floorMapSnapshotSchema.parse(cad)).toEqual(cad);
    expect(floorMapSnapshotSchema.safeParse({ ...cad, floorPlan: { ...cad.floorPlan, width: 2000 } }).success).toBe(false);
    expect(floorMapSnapshotSchema.safeParse({ ...cad, floorPlan: { ...cad.floorPlan, gridSize: 20 } }).success).toBe(false);
  });
  it("keeps the legacy payload valid", () => {
    expect(saveEditorStateSchema.parse(base).expectedRevision).toBe(1);
  });
  it("allows fixture-only document saves without duplicating lease or revision", () => {
    expect(saveEditorStateSchema.parse({ ...base, documentChanges: changes })).toMatchObject({ documentChanges: changes });
    expect(saveEditorStateSchema.safeParse({ ...base, documentChanges: { ...changes, baseRevision: 1 } }).success).toBe(false);
  });
  it("accepts 2000 unique operations but rejects overflow and duplicates", () => {
    const operations = Array.from({ length: 2000 }, (_, id) => ({ kind: "delete", id: String(id) }));
    expect(saveEditorStateSchema.safeParse({ ...base, documentChanges: { ...changes, operations } }).success).toBe(true);
    expect(saveEditorStateSchema.safeParse({ ...base, documentChanges: { ...changes, operations: [...operations, { kind: "delete", id: "more" }] } }).success).toBe(false);
    expect(saveEditorStateSchema.safeParse({ ...base, documentChanges: { ...changes, operations: [operations[0], operations[0]] } }).success).toBe(false);
  });
  it("rejects mixed legacy object mutations", () => {
    expect(saveEditorStateSchema.safeParse({ ...base, documentChanges: changes, objectDeletes: ["old-object"] }).success).toBe(false);
  });
  it("bounds the complete envelope, not only document operations", () => {
    const fixtureUpdates = Array.from({ length: 1000 }, (_, index) => ({ id: String(index), name: "x".repeat(200) }));
    const operations = Array.from({ length: 1800 }, (_, index) => ({ kind: "delete", id: `${index}${"x".repeat(508)}` }));
    expect(saveEditorStateSchema.safeParse({ ...base, fixtureUpdates, documentChanges: { ...changes, operations } }).success).toBe(false);
  });
});
