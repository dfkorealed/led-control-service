import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { MapElement, mapElementSchema } from "@led-control/shared";
import { decodeMapChunk, decodeMapPayload, encodeMapChunk, encodeMapPayload, MAP_CHUNK_MAX_BYTES } from "./map-document-codec";

function line(id = "line-1"): Extract<MapElement, { type: "line" }> {
  return { id, type: "line", geometry: { start: { x: 0, y: 1 }, end: { x: 20, y: 30 } },
    layerId: "default", groupId: null, zIndex: 0, visible: true, locked: false,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    style: { strokeColor: "#123456", fillColor: null, strokeWidth: 1, opacity: 1 }, provenance: null };
}

describe("common map chunk codec", () => {
  it("roundtrips empty and full-precision shared elements", () => {
    const element = line();
    element.transform.x = 0.123456789012345;
    expect(decodeMapChunk(encodeMapChunk([]))).toEqual([]);
    expect(decodeMapChunk(encodeMapChunk([element]))).toEqual([element]);
  });
  it("rejects invalid headers, truncated gzip, decoded digest and length corruption", () => {
    expect(() => decodeMapChunk(new Uint8Array([0, 255, 17]))).toThrow();
    const original = Buffer.from(encodeMapChunk([line()]));
    for (const offset of [0, 4, 8, original.length - 1]) {
      const corrupt = Buffer.from(original); corrupt[offset] ^= 1;
      expect(() => decodeMapChunk(corrupt)).toThrow();
    }
    expect(() => decodeMapChunk(original.subarray(0, original.length - 5))).toThrow();
  });
  it("bounds actual inflation even when the header lies", () => {
    const original = Buffer.from(encodeMapChunk([]));
    const bomb = Buffer.alloc(MAP_CHUNK_MAX_BYTES + 1, 32);
    const header = Buffer.from(original.subarray(0, 40));
    createHash("sha256").update(bomb).digest().copy(header, 8);
    expect(() => decodeMapChunk(Buffer.concat([header, gzipSync(bomb)]))).toThrow();
  });
  it("rejects excess encoded and decoded bytes independently", () => {
    expect(() => decodeMapChunk(Buffer.alloc(MAP_CHUNK_MAX_BYTES + 65_537))).toThrow();
    expect(() => encodeMapPayload(Buffer.alloc(MAP_CHUNK_MAX_BYTES + 1))).toThrow();
    const bytes = encodeMapPayload(Buffer.from("test"));
    expect(() => decodeMapPayload(bytes, { byteSize: bytes.length + 1, decodedByteSize: 4, sha256: "0".repeat(64) })).toThrow();
    expect(() => decodeMapPayload(bytes, { byteSize: bytes.length, decodedByteSize: 5,
      sha256: createHash("sha256").update(bytes).digest("hex") })).toThrow();
    expect(() => decodeMapPayload(bytes, { byteSize: bytes.length, decodedByteSize: 4, sha256: "0".repeat(64) })).toThrow();
  });
  it("runs the shared numeric and polygon checks on write and read", () => {
    const invalid = { ...line(), transform: { ...line().transform, x: Infinity } };
    expect(() => encodeMapChunk([invalid])).toThrow();
    const invalidPolygon = { ...line(), type: "polygon", geometry: {
      outer: [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 4, y: 0 }], holes: [] } };
    expect(() => decodeMapChunk(encodeMapPayload(Buffer.from(JSON.stringify([invalidPolygon]))))).toThrow();
    const extreme = { ...line(), style: { ...line().style, strokeWidth: 1e200 },
      geometry: { start: { x: 1e200, y: 0 }, end: { x: 2e200, y: 10 } } };
    expect(mapElementSchema.safeParse(extreme).success).toBe(true);
    expect(decodeMapChunk(encodeMapChunk([extreme]))).toEqual([extreme]);
  });
  it("rejects duplicate canonical IDs and invalid UTF-8", () => {
    expect(() => encodeMapChunk([line("x"), line(" x ")])).toThrow();
    expect(() => decodeMapChunk(encodeMapPayload(Buffer.from([0xff])))).toThrow();
  });
  it("stops validating inputs as soon as a chunk budget is exhausted", () => {
    const inputs: MapElement[] = Array.from({ length: 130 }, (_, index) => ({ ...line(String(index)), type: "text",
      geometry: { position: { x: 0, y: 0 }, text: "x".repeat(65_536), width: 10, height: 10, fontSize: 12 } }));
    Object.defineProperty(inputs, 129, { get() { throw new Error("late input was read"); } });
    expect(() => encodeMapChunk(inputs)).toThrow(/budget/);
  });
});
