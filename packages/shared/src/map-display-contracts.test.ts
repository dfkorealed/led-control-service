import { describe, expect, it } from "vitest";
import { cadSceneManifestSchema } from "./cad-scene-contracts";
import { compareMapDisplayPaintKeys, mapDisplayManifestSchema, mapDisplayPrimitiveSchema } from "./map-display-contracts";

const sceneId = "00000000-0000-4000-8000-000000000001";
const manifestId = "00000000-0000-4000-8000-000000000002";
const tileId = "00000000-0000-4000-8000-000000000003";
const native = {
  version: 2, sceneId, regionId: "manual", manifestAssetId: manifestId,
  width: 1200, height: 800, padding: 0, gridSize: 10, tileSize: 512, lodMode: "additive",
  primitiveCount: 0, tileCount: 0, byteSize: 100, sha256: "a".repeat(64),
  sourceBounds: { minX: 0, minY: 0, maxX: 1200, maxY: 800 },
  transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: []
};
const tile = { version: 2, sceneId, assetId: tileId, tileX: 2, tileY: 1, lod: 0, part: 0,
  primitiveCount: 1, byteSize: 100, sha256: "b".repeat(64), bounds: { minX: 1024, minY: 512, maxX: 1200, maxY: 800 } };
const nonempty = { ...native, primitiveCount: 1, tileCount: 1, tiles: [tile] };

describe("common map display manifests", () => {
  it("uses current layer order and ordinal tie keys, with fill before stroke", () => {
    const key = { layerOrder: 0, layerId: "Z", zIndex: -10, elementId: "Z", fragmentOrder: 0, phase: "fill" as const };
    for (const patch of [{ layerOrder: 1 }, { layerId: "a" }, { zIndex: 0 }, { elementId: "a" },
      { fragmentOrder: 1 }, { phase: "stroke" as const }]) {
      expect(compareMapDisplayPaintKeys(key, { ...key, ...patch })).toBeLessThan(0);
      expect(compareMapDisplayPaintKeys({ ...key, ...patch }, key)).toBeGreaterThan(0);
    }
    expect(compareMapDisplayPaintKeys(key, key)).toBe(0);
  });
  it("requires ordering and preserves strict primitive geometry validation", () => {
    const primitive = { type: "line", elementId: "e", groupId: null, layerName: "l", sourceType: "LINE",
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, clipBounds: null,
      style: { strokeColor: null, fillColor: null, strokeWidth: 1, opacity: 1 },
      geometry: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }, zIndex: -1, fragmentOrder: 0xffffffff };
    expect(mapDisplayPrimitiveSchema.parse(primitive)).toEqual(primitive);
    for (const patch of [{ zIndex: undefined }, { fragmentOrder: undefined }, { extra: 1 },
      { clipBounds: { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 } }]) {
      expect(mapDisplayPrimitiveSchema.safeParse({ ...primitive, ...patch }).success).toBe(false);
    }
  });
  it("accepts an identity manual display without weakening the CAD-only source contract", () => {
    expect(mapDisplayManifestSchema.parse(native)).toEqual(native);
    expect(cadSceneManifestSchema.safeParse(native).success).toBe(false);
  });
  it("supports nonempty manual/checkpoint tiles, including clipped edge cells", () => {
    expect(mapDisplayManifestSchema.parse(nonempty)).toEqual(nonempty);
  });
  it.each([5, 7, 200])("accepts common document grid %i without CAD normalization", gridSize => {
    expect(mapDisplayManifestSchema.safeParse({ ...native, gridSize }).success).toBe(true);
  });
  it.each([512, 32768])("supports native dimension boundary %i", width => {
    expect(mapDisplayManifestSchema.safeParse({ ...native, width, sourceBounds: { ...native.sourceBounds, maxX: width } }).success).toBe(true);
  });
  it("retains imported CAD normalization and source transform", () => {
    const cad = { ...native, width: 16384, height: 16384, padding: 328, gridSize: 80,
      sourceBounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
      transform: { scaleX: 15.728, scaleY: -15.728, translateX: 328, translateY: 16056 } };
    expect(cadSceneManifestSchema.safeParse({ ...cad, version: 1 }).success).toBe(true);
    expect(mapDisplayManifestSchema.parse(cad)).toEqual(cad);
  });
  it("rejects common v1 and mixed descriptor versions rather than inventing paint order", () => {
    expect(mapDisplayManifestSchema.safeParse({ ...native, version: 1 }).success).toBe(false);
    expect(mapDisplayManifestSchema.safeParse({ ...nonempty, tiles: [{ ...tile, version: 1 }] }).success).toBe(false);
  });
  it.each([
    { padding: 1 }, { width: 511 }, { height: 32769 }, { gridSize: 4 }, { gridSize: 201 },
    { transform: { ...native.transform, translateX: 1 } }, { transform: { ...native.transform, scaleY: -1 } },
    { sourceBounds: { ...native.sourceBounds, minX: 1 } }, { sourceBounds: { ...native.sourceBounds, maxY: 801 } },
    { sha256: "bad" }, { byteSize: 8 * 1024 * 1024 + 1 }, { tileCount: 1 }, { primitiveCount: 1 }, { unexpected: true }
  ])("rejects invalid native metadata %j", patch => {
    expect(mapDisplayManifestSchema.safeParse({ ...native, ...patch }).success).toBe(false);
  });
  it.each([
    { sceneId: manifestId }, { assetId: manifestId }, { sha256: "bad" }, { byteSize: 16 * 1024 * 1024 + 1 },
    { tileX: 3 }, { lod: 3 }, { part: 1 }, { primitiveCount: 0 },
    { bounds: { ...tile.bounds, maxX: 1536 } }
  ])("reuses tile integrity/cell/part validation %j", patch => {
    expect(mapDisplayManifestSchema.safeParse({ ...nonempty, tiles: [{ ...tile, ...patch }] }).success).toBe(false);
  });
  it("rejects duplicate assets/LOD parts and incomplete primitive coverage", () => {
    expect(mapDisplayManifestSchema.safeParse({ ...nonempty, tileCount: 2, tiles: [tile, tile] }).success).toBe(false);
    expect(mapDisplayManifestSchema.safeParse({ ...nonempty, primitiveCount: 2 }).success).toBe(false);
    expect(mapDisplayManifestSchema.safeParse({ ...nonempty, tileCount: 2, tiles: [tile, { ...tile, lod: 1 }] }).success).toBe(false);
  });
  it("retains the aggregate 512 MiB tile payload budget", () => {
    const tiles = Array.from({ length: 33 }, (_, i) => ({ ...tile, part: i, byteSize: 16 * 1024 * 1024,
      assetId: `00000000-0000-4000-8000-${(i + 100).toString().padStart(12, "0")}` }));
    expect(mapDisplayManifestSchema.safeParse({ ...nonempty, tileCount: tiles.length, tiles }).success).toBe(false);
  });
});
