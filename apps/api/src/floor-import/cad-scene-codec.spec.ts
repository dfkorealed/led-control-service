import { createHash } from "node:crypto";
import {
  CAD_SCENE_MAX_TILE_BYTE_SIZE,
  cadScenePrimitiveSchema,
  mapDisplayOrderingSchema,
  type CadScenePrimitive
} from "@led-control/shared";
import {
  decodeCadSceneTile,
  encodeCadSceneTile,
  getCadSceneTileIntegrity
} from "./cad-scene-codec";
import * as codec from "./cad-scene-codec";

const style = {
  strokeColor: "#112233",
  fillColor: null,
  strokeWidth: 1.5,
  opacity: 0.75
};

function base(elementId: string, sourceType: string, bounds: CadScenePrimitive["bounds"]) {
  return {
    elementId,
    groupId: "cad-group-shared",
    layerName: "WALLS",
    sourceType,
    bounds,
    clipBounds: null,
    style
  };
}

const primitives: CadScenePrimitive[] = [
  {
    ...base("line-1", "LINE", { minX: 0, minY: 0, maxX: 10, maxY: 5 }),
    type: "line",
    geometry: { start: { x: 0, y: 0 }, end: { x: 10, y: 5 } }
  },
  {
    ...base("polyline-1", "LWPOLYLINE", { minX: 1, minY: 1, maxX: 9, maxY: 8 }),
    type: "polyline",
    geometry: {
      points: [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 8 }],
      closed: false
    }
  },
  {
    ...base("rectangle-1", "LWPOLYLINE", { minX: 10, minY: 10, maxX: 30, maxY: 20 }),
    type: "rectangle",
    geometry: { origin: { x: 10, y: 10 }, width: 20, height: 10, rotation: 0 }
  },
  {
    ...base("triangle-1", "POLYLINE", { minX: 40, minY: 10, maxX: 50, maxY: 20 }),
    type: "triangle",
    geometry: { points: [{ x: 40, y: 20 }, { x: 45, y: 10 }, { x: 50, y: 20 }] }
  },
  {
    ...base("ellipse-1", "CIRCLE", { minX: 60, minY: 10, maxX: 80, maxY: 30 }),
    type: "ellipse",
    geometry: { center: { x: 70, y: 20 }, radiusX: 10, radiusY: 10, rotation: 0 }
  },
  {
    ...base("arc-1", "ARC", { minX: 90, minY: 10, maxX: 110, maxY: 30 }),
    type: "arc",
    geometry: {
      center: { x: 100, y: 20 },
      radius: 10,
      startAngle: 15,
      endAngle: 120,
      counterClockwise: true
    }
  },
  {
    ...base("text-1", "MTEXT", { minX: 120, minY: 10, maxX: 180, maxY: 30 }),
    type: "text",
    geometry: {
      position: { x: 120, y: 25 },
      text: "B1 주차장",
      width: 60,
      height: 20,
      rotation: 7.5,
      fontSize: 12
    }
  }
];

describe("common display v2 codec", () => {
  const api = codec;
  const ordered = primitives.map((primitive, index) => ({ ...primitive,
    zIndex: index === 0 ? -2147483648 : 2147483647, fragmentOrder: 0xffffffff - index }));

  it("sizes trusted ordering without allocating a schema parse result per fragment", () => {
    const parse = jest.spyOn(mapDisplayOrderingSchema, "parse");
    try {
      const tracker = new api.MapDisplayTileSizeTracker();
      for (const p of ordered) expect(tracker.tryAdd(p)).toBe(true);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });

  it.each([-2147483649, -2147483648, -1, -0, 0, 0.5, 2147483647, 2147483648,
    0xffffffff, 0x100000000, NaN, Infinity, -Infinity, undefined, null, "0", "1", true])(
    "matches strict ordering schema boundaries for %s without coercion", value => {
      for (const field of ["zIndex", "fragmentOrder"] as const) {
        const p = { ...ordered[0], [field]: value };
        const valid = mapDisplayOrderingSchema.safeParse(p).success;
        const tracker = new api.MapDisplayTileSizeTracker();
        const append = () => tracker.tryAdd(p as typeof ordered[0]);
        if (valid) expect(append()).toBe(true);
        else {
          expect(append).toThrow();
          expect(tracker.primitiveCount).toBe(0);
          expect(tracker.byteSize).toBe(52);
        }
      }
    });

  it("round-trips all shapes with exact int32/uint32 ordering and +8 bytes per occurrence", () => {
    expect(typeof api.encodeMapDisplayTile).toBe("function");
    const payload = api.encodeMapDisplayTile(ordered);
    expect(payload.readUInt16LE(4)).toBe(2);
    expect(payload.byteLength).toBe(encodeCadSceneTile(primitives).byteLength + 8 * primitives.length);
    expect(api.estimateMapDisplayTileByteSize(ordered)).toBe(payload.byteLength);
    expect(api.decodeMapDisplayTile(payload, { version: 2, ...getCadSceneTileIntegrity(payload) })).toEqual(ordered);
    const offset = primitiveOffsetOf(payload);
    expect(payload.readInt32LE(offset + 17)).toBe(-2147483648);
    expect(payload.readUInt32LE(offset + 21)).toBe(0xffffffff);
    expect(payload.readDoubleLE(offset + 25)).toBe(primitives[0].bounds.minX);
  });

  it("rejects v1/v2 header and descriptor mismatches", () => {
    expect(typeof api.decodeMapDisplayTile).toBe("function");
    const payload = api.encodeMapDisplayTile(ordered);
    expect(() => decodeCadSceneTile(payload)).toThrow(/version/i);
    expect(() => api.decodeMapDisplayTile(encodeCadSceneTile(primitives))).toThrow(/version/i);
    expect(() => api.decodeMapDisplayTile(payload, { version: 1 })).toThrow(/version/i);
  });

  it.each([{ zIndex: 2147483648 }, { zIndex: -2147483649 }, { zIndex: 0.5 },
    { fragmentOrder: -1 }, { fragmentOrder: 0x100000000 }, { fragmentOrder: 0.5 },
    { zIndex: undefined }, { fragmentOrder: undefined }])("rejects invalid ordering %j", patch => {
    expect(typeof api.encodeMapDisplayTile).toBe("function");
    expect(() => api.encodeMapDisplayTile([{ ...ordered[0], ...patch } as Parameters<typeof api.encodeMapDisplayTile>[0][number]])).toThrow();
  });

  it("rejects conflicting canonical z/layer/group identity but retains repeated fragments", () => {
    expect(typeof api.encodeMapDisplayTile).toBe("function");
    for (const patch of [{ zIndex: 1 }, { layerName: "other" }, { groupId: "other" }]) {
      expect(() => api.encodeMapDisplayTile([ordered[0], { ...ordered[0], ...patch }])).toThrow(/identity|ordering/i);
    }
    expect(api.decodeMapDisplayTile(api.encodeMapDisplayTile([ordered[0], ordered[0]]))).toEqual([ordered[0], ordered[0]]);
  });

  it("matches an independently specified little-endian golden body and leaves v1 bytes unchanged", () => {
    const value = { ...primitives[0], elementId: "e", groupId: null, layerName: "l", sourceType: "S",
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      style: { strokeColor: null, fillColor: null, strokeWidth: 1, opacity: 1 },
      type: "line" as const, geometry: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } };
    const strings = "030000000100000065010000006c0100000053";
    const identity = "0100000000ffffffff0100000002000000";
    const geometryAndStyle = "00000000000000000000000000000000000000000000f03f000000000000f03f"
      + "00ffffffffffffffff000000000000f03f000000000000f03f"
      + "00000000000000000000000000000000000000000000f03f000000000000f03f";
    for (const version of [1, 2] as const) {
      const body = Buffer.from(strings + identity + (version === 2 ? "feffffff07000000" : "") + geometryAndStyle, "hex");
      const header = Buffer.alloc(48);
      header.write("CDTL"); header.writeUInt16LE(version, 4);
      header.writeUInt32LE(body.length, 8); header.writeUInt32LE(1, 12);
      createHash("sha256").update(body).digest().copy(header, 16);
      const golden = Buffer.concat([header, body]);
      const orderedValue = { ...value, zIndex: -2, fragmentOrder: 7 };
      expect(version === 1 ? encodeCadSceneTile([value]) : api.encodeMapDisplayTile([orderedValue])).toEqual(golden);
      expect(version === 1 ? decodeCadSceneTile(golden) : api.decodeMapDisplayTile(golden)).toEqual([version === 1 ? value : orderedValue]);
    }
  });
});

function rewriteBodyHash(payload: Buffer): Buffer {
  payload.writeUInt32LE(payload.length - 48, 8);
  createHash("sha256").update(payload.subarray(48)).digest().copy(payload, 16);
  return payload;
}

function primitiveOffsetOf(payload: Buffer): number {
  let offset = 52;
  const stringCount = payload.readUInt32LE(48);
  for (let index = 0; index < stringCount; index++) {
    const length = payload.readUInt32LE(offset);
    offset += 4 + length;
  }
  return offset;
}

describe("CAD scene tile codec", () => {
  it("round-trips every native primitive through a versioned binary payload", () => {
    const payload = encodeCadSceneTile(primitives);
    const integrity = getCadSceneTileIntegrity(payload);

    expect(decodeCadSceneTile(payload, integrity)).toEqual(primitives);
    expect(integrity).toEqual({
      byteSize: payload.byteLength,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("uses shared string tables instead of repeating primitive metadata", () => {
    const repeated: CadScenePrimitive[] = Array.from({ length: 100 }, (_, index) => ({
      ...base(`line-${index}`, "LINE", { minX: index, minY: 0, maxX: index + 1, maxY: 1 }),
      groupId: null,
      type: "line" as const,
      geometry: { start: { x: index, y: 0 }, end: { x: index + 1, y: 1 } }
    }));

    expect(encodeCadSceneTile(repeated).byteLength)
      .toBeLessThan(Buffer.byteLength(JSON.stringify(repeated), "utf8"));
  });

  it("validates each primitive exactly once", () => {
    const parse = jest.spyOn(cadScenePrimitiveSchema, "parse");
    try {
      encodeCadSceneTile(primitives);
      expect(parse).toHaveBeenCalledTimes(primitives.length);
    } finally {
      parse.mockRestore();
    }
  });

  it("rejects truncated, tampered, and externally mismatched payloads", () => {
    const payload = encodeCadSceneTile(primitives);
    const integrity = getCadSceneTileIntegrity(payload);
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 1] ^= 0xff;

    expect(() => decodeCadSceneTile(payload.subarray(0, payload.length - 1)))
      .toThrow(/length|truncated/i);
    expect(() => decodeCadSceneTile(tampered)).toThrow(/integrity/i);
    expect(() => decodeCadSceneTile(payload, { ...integrity, byteSize: integrity.byteSize + 1 }))
      .toThrow(/byte size/i);
    expect(() => decodeCadSceneTile(payload, { ...integrity, sha256: "0".repeat(64) }))
      .toThrow(/sha-256/i);
  });

  it("round-trips schema-sized multilingual and emoji text as UTF-8", () => {
    const unicode = "한글🙂".repeat(16_000);
    const value: CadScenePrimitive = {
      ...base("unicode", "MTEXT", { minX: 0, minY: 0, maxX: 100, maxY: 20 }),
      type: "text",
      geometry: {
        position: { x: 0, y: 10 }, text: unicode, width: 100, height: 20, rotation: 0, fontSize: 12
      }
    };
    expect(decodeCadSceneTile(encodeCadSceneTile([value]))).toEqual([value]);
  });

  it("rejects lone UTF-16 surrogates before UTF-8 encoding", () => {
    const value = {
      ...primitives[6],
      geometry: { ...primitives[6].geometry, text: `bad-${String.fromCharCode(0xd800)}` }
    } as CadScenePrimitive;
    expect(() => encodeCadSceneTile([value])).toThrow(/unicode|utf-16|surrogate/i);
  });

  it("round-trips non-null clip bounds and validates tile-cell containment", () => {
    const clipped: CadScenePrimitive = {
      ...primitives[0],
      clipBounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }
    };
    const payload = encodeCadSceneTile([clipped]);
    const nullClipPayload = encodeCadSceneTile([primitives[0]]);
    const context = {
      ...getCadSceneTileIntegrity(payload),
      bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }
    };

    expect(payload.byteLength - nullClipPayload.byteLength).toBe(32);
    expect(decodeCadSceneTile(payload, context)).toEqual([clipped]);
    expect(() => decodeCadSceneTile(payload, {
      ...context,
      bounds: { minX: 0, minY: 0, maxX: 256, maxY: 512 }
    } as typeof context)).toThrow("CAD scene primitive clip bounds must match tile bounds");
  });

  it("rejects malformed non-null clip metadata", () => {
    const clipped: CadScenePrimitive = {
      ...primitives[0],
      clipBounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }
    };
    const invalidFlag = Buffer.from(encodeCadSceneTile([clipped]));
    const primitiveOffset = primitiveOffsetOf(invalidFlag);
    invalidFlag[primitiveOffset + 49] = 2;
    expect(() => decodeCadSceneTile(rewriteBodyHash(invalidFlag))).toThrow(/boolean/i);

    const nonfiniteClip = Buffer.from(encodeCadSceneTile([clipped]));
    nonfiniteClip.writeDoubleLE(Number.NaN, primitiveOffsetOf(nonfiniteClip) + 50);
    expect(() => decodeCadSceneTile(rewriteBodyHash(nonfiniteClip))).toThrow(/finite|number/i);
  });

  it("rejects oversized input before parsing and oversized output before allocation growth", () => {
    expect(() => decodeCadSceneTile(Buffer.alloc(CAD_SCENE_MAX_TILE_BYTE_SIZE + 1)))
      .toThrow(/tile byte size/i);

    const text = "한".repeat(65_530);
    const many = Array.from({ length: 90 }, (_, index): CadScenePrimitive => ({
      ...base(`large-${index}`, "MTEXT", { minX: index, minY: 0, maxX: index + 1, maxY: 1 }),
      type: "text",
      geometry: { position: { x: index, y: 0 }, text: `${text}-${index}`, width: 1, height: 1, rotation: 0, fontSize: 1 }
    }));
    expect(() => encodeCadSceneTile(many)).toThrow(/tile byte size/i);
    const invalidAfterLimit: CadScenePrimitive = {
      ...(primitives[0] as Extract<CadScenePrimitive, { type: "line" }>),
      type: "line",
      geometry: { start: { x: Number.NaN, y: 0 }, end: { x: 1, y: 1 } }
    };
    expect(() => encodeCadSceneTile([
      ...many,
      invalidAfterLimit
    ])).toThrow(/tile byte size/i);
  });

  it("reserves minimum primitive bytes before decoding the string table", () => {
    const payload = Buffer.from(encodeCadSceneTile([primitives[0]]));
    payload.writeUInt32LE(100, 12);
    payload[56] = 0xff;
    expect(() => decodeCadSceneTile(rewriteBodyHash(payload))).toThrow(/primitive count.*capacity/i);
  });

  it("rejects corrupt counts, references, UTF-8, non-finite values, and trailing data", () => {
    const source = encodeCadSceneTile([primitives[0]]);

    const excessiveStrings = Buffer.from(source);
    excessiveStrings.writeUInt32LE(100, 48);
    expect(() => decodeCadSceneTile(rewriteBodyHash(excessiveStrings))).toThrow(/string table/i);

    const badReference = Buffer.from(source);
    const primitiveOffset = primitiveOffsetOf(badReference);
    badReference.writeUInt32LE(0xffff_fffe, primitiveOffset + 1);
    expect(() => decodeCadSceneTile(rewriteBodyHash(badReference))).toThrow(/string reference/i);

    const invalidUtf8 = Buffer.from(source);
    invalidUtf8[56] = 0xff;
    expect(() => decodeCadSceneTile(rewriteBodyHash(invalidUtf8))).toThrow(/utf-8|encoded data/i);

    const nonfinite = Buffer.from(source);
    nonfinite.writeDoubleLE(Number.NaN, primitiveOffset + 17);
    expect(() => decodeCadSceneTile(rewriteBodyHash(nonfinite))).toThrow(/finite|number/i);

    const trailing = Buffer.concat([source, Buffer.from([0])]);
    expect(() => decodeCadSceneTile(rewriteBodyHash(trailing))).toThrow(/trailing/i);

    const excessivePrimitives = Buffer.from(source);
    excessivePrimitives.writeUInt32LE(500_001, 12);
    expect(() => decodeCadSceneTile(excessivePrimitives)).toThrow(/primitive limit/i);
  });
});
