import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDisplayTile } from "@led-control/shared/map-display-contracts";
import { encodeMapDisplayTile } from "../../../../api/src/floor-import/cad-scene-codec";
import { cadSceneCodecGolden } from "../cad-scene/cad-scene-codec.golden";
import * as decoder from "../cad-scene/cad-scene-worker";
import { validateMapPaintAssetPages } from "./map-ordered-pages";

const primitives = cadSceneCodecGolden.primitives.map((primitive, index) => ({
  ...primitive, zIndex: index - 3, fragmentOrder: index
}));
function fixture(values = primitives) {
  vi.stubGlobal("crypto", webcrypto);
  const bytes = encodeMapDisplayTile(values);
  const tile: MapDisplayTile = { version: 2, sceneId: "paged", assetId: "page", tileX: 0, tileY: 0,
    part: 0, lod: 0, bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }, primitiveCount: values.length,
    byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  return { bytes, tile };
}
function rehash(bytes: Buffer, tile: MapDisplayTile): MapDisplayTile {
  createHash("sha256").update(bytes.subarray(48)).digest().copy(bytes, 16);
  return { ...tile, sha256: createHash("sha256").update(bytes).digest("hex") };
}
afterEach(() => vi.unstubAllGlobals());

describe("bounded deferred common-v2 asset reader", () => {
  it("exposes an indexed paint reader independently of renderer integration", () => {
    expect(typeof decoder.createMapDisplayPaintAsset).toBe("function");
  });

  it("retains raw bytes and typed offsets, materializing only requested primitives", async () => {
    const { bytes, tile } = fixture();
    const asset = await decoder.createMapDisplayPaintAsset(bytes, tile);
    expect(asset.payload).toBe(bytes);
    expect(asset.primitiveOffsets).toBeInstanceOf(Uint32Array);
    expect(asset.stringOffsets).toBeInstanceOf(Uint32Array);
    expect(asset.memoryBytes).toBe(bytes.length + asset.primitiveOffsets.byteLength + asset.stringOffsets.byteLength);
    expect(asset.estimate(0)).toBeGreaterThan(JSON.stringify(primitives[0]).length);
    expect(asset.primitiveOffsets).toHaveLength(primitives.length);
    expect(primitives.map((_, index) => asset.read(index))).toEqual(primitives);
    expect(asset.key(6)).toEqual({ layerName: primitives[6].layerName, elementId: primitives[6].elementId,
      zIndex: primitives[6].zIndex, fragmentOrder: primitives[6].fragmentOrder });
    const changed = asset.read(0); changed.style.opacity = 0;
    expect(asset.read(0)).toEqual(primitives[0]);
    expect(() => asset.read(-1)).toThrow("index");
    expect(() => asset.key(primitives.length)).toThrow("index");
  });

  it("keeps integrity and common-v2-only gates without invoking legacy fallback", async () => {
    const { bytes, tile } = fixture();
    const damaged = bytes.slice(); damaged[damaged.length - 1] ^= 1;
    await expect(decoder.createMapDisplayPaintAsset(damaged, tile)).rejects.toThrow("SHA-256");
    const legacy = Buffer.from(cadSceneCodecGolden.payloadBase64, "base64");
    await expect(decoder.createMapDisplayPaintAsset(legacy, { ...tile, byteSize: legacy.length,
      sha256: cadSceneCodecGolden.sha256 })).rejects.toThrow("version");
  });

  it("rejects oversized ordered assets before indexing or materialization", async () => {
    const { tile } = fixture();
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    await expect(decoder.createMapDisplayPaintAsset(oversized, { ...tile, byteSize: oversized.length }))
      .rejects.toThrow("ordered asset byte limit");
  });

  it("validates every record and conflicting identity, not just selected paint keys", async () => {
    const { bytes, tile } = fixture([primitives[0], primitives[0]]);
    bytes.writeInt32LE(20, bytes.length - 114 + 17);
    await expect(decoder.createMapDisplayPaintAsset(bytes, rehash(bytes, tile))).rejects.toThrow("ordering identity");
    const valid = fixture();
    await expect(decoder.createMapDisplayPaintAsset(valid.bytes, { ...valid.tile,
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } })).rejects.toThrow("bounds exceed");
  });

  it("checks page claims against bounded actual records using the shared contract", async () => {
    const values = [0, 1, 2].map(index => ({ ...primitives[0], elementId: `line-${index}`, zIndex: index }));
    const { bytes, tile } = fixture(values);
    const asset = await decoder.createMapDisplayPaintAsset(bytes, tile);
    const key = (index: number) => ({ zIndex: index, elementId: `line-${index}`, fragmentOrder: 0 });
    const pages = [{ layerId: "canonical", sequence: 0, primitiveStart: 0, primitiveCount: 2, firstKey: key(0), lastKey: key(1) },
      { layerId: "canonical", sequence: 1, primitiveStart: 2, primitiveCount: 1, firstKey: key(2), lastKey: key(2) }];
    expect(() => validateMapPaintAssetPages(asset, { ...tile, pages }, () => "canonical")).not.toThrow();
    expect(() => validateMapPaintAssetPages(asset, { ...tile, pages }, () => "wrong")).toThrow("layer mismatch");
    expect(() => validateMapPaintAssetPages(asset, { ...tile, pages: [{ ...pages[0], lastKey: key(2) }, pages[1]] }, () => "canonical"))
      .toThrow("endpoint mismatch");
    expect(() => validateMapPaintAssetPages(asset, { ...tile, pages: [pages[0]] }, () => "canonical")).toThrow("coverage mismatch");
  });
});
