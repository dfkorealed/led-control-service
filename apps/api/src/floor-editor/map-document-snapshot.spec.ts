import { MapDocumentRef } from "@led-control/shared";
import { buildMapDocumentSnapshot, parseMapDocumentSnapshot, parseStoredFloorEditorSnapshot, hashFloorEditorSnapshot } from "./floor-editor-snapshot";

describe("common document snapshot", () => {
  const document: MapDocumentRef = { formatVersion: 1, generationId: "generation", revision: 2,
    width: 16384, height: 8192, gridSize: 40, elementCount: 500000,
    manifest: { assetId: "asset", sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 500 } };
  it("stores a reference, fixtures and slots, never the whole canonical scene", () => {
    const snapshot = buildMapDocumentSnapshot({ document, fixtures: [], lightSlots: [] });
    expect(snapshot).toEqual({ version: 3, document, fixtures: [], lightSlots: [] });
    expect(parseMapDocumentSnapshot(snapshot)).toEqual(snapshot);
    expect(parseStoredFloorEditorSnapshot(snapshot)).toEqual(snapshot);
    expect(JSON.stringify(snapshot).length).toBeLessThan(600);
    expect(hashFloorEditorSnapshot(snapshot)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("retains the old decoder without adapting old CAD into new geometry", () => {
    const old = { version: 2, floorPlan: null, fixtures: [], objects: [] };
    expect(parseStoredFloorEditorSnapshot(old)).toEqual(old);
    expect(() => parseMapDocumentSnapshot(old)).toThrow();
    expect(() => parseMapDocumentSnapshot({ version: 3, document, fixtures: [], lightSlots: [], objects: [] })).toThrow();
  });
});
