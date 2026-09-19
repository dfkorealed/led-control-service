import { MapDocumentRef } from "@led-control/shared";
import { MapDocumentRevisionData } from "./map-document-revision-data";
import { buildMapDocumentSnapshot, hashFloorEditorSnapshot } from "./floor-editor-snapshot";

describe("current generation versus immutable history reference", () => {
  const original: MapDocumentRef = { formatVersion: 1, generationId: "original", revision: 7,
    width: 1200, height: 800, gridSize: 10, elementCount: 3,
    manifest: { assetId: "old-asset", sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 200 } };
  const snapshot = buildMapDocumentSnapshot({ document: original, fixtures: [], lightSlots: [] });
  const fixture = () => {
    const generation = { id: "compact", floorId: "floor", status: "active", formatVersion: 1,
      sourceGenerationId: original.generationId, sourceRevision: 7, baseRevision: 7,
      width: 1200, height: 800, gridSize: 10, elementCount: 3, manifestAssetId: "new-asset", manifestDecodedBytes: 300,
      manifest: { id: "new-asset", floorId: "floor", kind: "map_manifest", status: "ready", cleanupStartedAt: null,
        mimeType: "application/octet-stream", contentEncoding: null, sha256: "b".repeat(64), sizeBytes: 150n } };
    const row = { snapshot, snapshotSha256: hashFloorEditorSnapshot(snapshot) };
    const db = { floorMapDocument: { findUnique: jest.fn().mockResolvedValue({ floorId: "floor", activeGenerationId: "compact", revision: 7 }) },
      floorMapRevision: { findUniqueOrThrow: jest.fn().mockResolvedValue(row) },
      floorMapGeneration: { findFirst: jest.fn().mockResolvedValue(generation) },
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor", mapRevision: 7, floorPlan: { width: 1200, height: 800, gridSize: 10 } }) } };
    return { generation, row, db, reader: new MapDocumentRevisionData(db as never, {} as never, {} as never) };
  };
  it("resolves the active compacted generation without rewriting the historical snapshot", async () => {
    const { reader, row } = fixture();
    expect(await reader.currentRef("floor")).toEqual({ ...original, generationId: "compact",
      manifest: { assetId: "new-asset", sha256: "b".repeat(64), byteSize: 150, decodedByteSize: 300 } });
    expect(row.snapshot.document).toEqual(original);
  });
  it.each([{ floorId: "other" }, { status: "prepared" }, { sourceRevision: 6 }, { baseRevision: 6 },
    { width: 2048 }, { height: 1024 }, { gridSize: 20 }, { elementCount: 2 }, { sourceGenerationId: "unrelated" }])
  ("rejects unproven same-revision head swaps: %j", async patch => {
    const { reader, generation } = fixture(); Object.assign(generation, patch);
    await expect(reader.currentRef("floor")).rejects.toThrow();
  });
  it("rejects corrupted history hashes and unavailable manifest ledgers", async () => {
    const first = fixture(); first.row.snapshotSha256 = "c".repeat(64);
    await expect(first.reader.currentRef("floor")).rejects.toThrow();
    const second = fixture(); second.generation.manifest.floorId = "other";
    await expect(second.reader.currentRef("floor")).rejects.toThrow();
    const third = fixture(); third.generation.manifest.status = "pending";
    await expect(third.reader.currentRef("floor")).rejects.toThrow();
  });
});
