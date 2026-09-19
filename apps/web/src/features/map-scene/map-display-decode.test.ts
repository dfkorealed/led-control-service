import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDisplayTile } from "@led-control/shared/map-display-contracts";
import { encodeMapDisplayTile } from "../../../../api/src/floor-import/cad-scene-codec";
import { cadSceneCodecGolden } from "../cad-scene/cad-scene-codec.golden";
import { buildCadGeometryBatches, createCadSceneWorkerClient, decodeCadSceneTilePayload,
  decodeMapDisplayTilePayload } from "../cad-scene/cad-scene-worker";

const primitives = cadSceneCodecGolden.primitives.map((primitive, index) => ({
  ...primitive, zIndex: index === 0 ? -2147483648 : 2147483647, fragmentOrder: 0xffffffff - index
}));
function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  const bytes = encodeMapDisplayTile(primitives);
  const descriptor: MapDisplayTile = { version: 2, sceneId: "scene", assetId: "asset", tileX: 0, tileY: 0,
    part: 0, lod: 0, bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }, primitiveCount: primitives.length,
    byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  return { bytes, descriptor };
}
afterEach(() => vi.unstubAllGlobals());

describe("strict common display v2 consumer", () => {
  it("decodes all approved producer primitive kinds with signed z and unsigned fragment extremes", async () => {
    const { bytes, descriptor } = fixture();
    expect(await decodeMapDisplayTilePayload(bytes, descriptor)).toEqual(primitives);
    const damaged = bytes.slice(); damaged[damaged.length - 1] ^= 1;
    await expect(decodeMapDisplayTilePayload(damaged, descriptor)).rejects.toThrow("SHA-256");
  });

  it("keeps legacy and common versions mutually exclusive", async () => {
    const { bytes, descriptor } = fixture();
    await expect(decodeCadSceneTilePayload(bytes, { ...descriptor, version: 1 })).rejects.toThrow("version");
    const legacy = Buffer.from(cadSceneCodecGolden.payloadBase64, "base64");
    await expect(decodeMapDisplayTilePayload(legacy, { ...descriptor, byteSize: legacy.length,
      sha256: cadSceneCodecGolden.sha256 })).rejects.toThrow("version");
  });

  it("rejects same-ID ordering conflicts despite valid outer and body hashes", async () => {
    const { descriptor } = fixture();
    const primitive = primitives[0];
    const bytes = encodeMapDisplayTile([primitive, primitive]);
    // A line record is 114 bytes; ordering follows its type and four string indices.
    bytes.writeInt32LE(1, bytes.length - 114 + 17);
    createHash("sha256").update(bytes.subarray(48)).digest().copy(bytes, 16);
    await expect(decodeMapDisplayTilePayload(bytes, { ...descriptor, primitiveCount: 2, byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") })).rejects.toThrow("ordering identity");
  });

  it("retains fill/stroke spans, text identities and paint metadata in the display worker path", async () => {
    const { bytes, descriptor } = fixture();
    const worker = createCadSceneWorkerClient<MapDisplayTile>();
    const decoded = await worker.decode(bytes, descriptor, { zoomBand: 1, maxErrorPixels: 0.5, excludedIds: [] });
    const spans = decoded.batches.flatMap(batch => batch.spans);
    expect(spans.filter(span => span.elementId === "polyline-golden").map(span => span.paint)).toEqual([
      { zIndex: 2147483647, fragmentOrder: 0xfffffffe, phase: "fill" },
      { zIndex: 2147483647, fragmentOrder: 0xfffffffe, phase: "stroke" }
    ]);
    expect(spans.find(span => span.elementId === "line-golden")?.paint).toEqual({
      zIndex: -2147483648, fragmentOrder: 0xffffffff, phase: "stroke"
    });
    expect(decoded.textBatches[0].entries[0]).toMatchObject({ elementId: "text-golden", groupId: "golden-group",
      paint: { zIndex: 2147483647, fragmentOrder: 0xfffffff9, phase: "fill" } });
    expect(decoded.pickEntries).toEqual([]);
    const exact = buildCadGeometryBatches(await decodeMapDisplayTilePayload(bytes, descriptor));
    expect(exact.pickEntries[0].paint).toMatchObject({ zIndex: -2147483648, fragmentOrder: 0xffffffff });
    expect(bytes.byteLength).toBe(descriptor.byteSize);
    worker.destroy();
  });
});
