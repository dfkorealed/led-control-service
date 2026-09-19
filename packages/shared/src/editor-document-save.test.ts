import { describe, expect, it } from "vitest";
import { saveEditorStateSchema } from "./schemas";

const base = { expectedRevision: 1, leaseToken: "lease", leaseFence: 1,
  fixtureUpdates: [], objectCreates: [], objectUpdates: [], objectDeletes: [] };
const changes = { requestId: "request", generationId: "generation", operations: [] };

describe("atomic editor document save", () => {
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
