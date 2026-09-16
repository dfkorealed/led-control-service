import { parseAsciiDxf } from "./dxf-document-parser";

const pair = (code: number, value: string | number) => `${code}\n${value}\n`;

function syntheticDxf(): string {
  return [
    pair(0, "SECTION"), pair(2, "BLOCKS"),
    pair(0, "BLOCK"), pair(2, "LED_FIXTURE"), pair(10, 0), pair(20, 0),
    pair(0, "CIRCLE"), pair(5, "B1"), pair(8, "SYMBOL"), pair(10, 0), pair(20, 0), pair(40, 1),
    pair(0, "ENDBLK"), pair(0, "ENDSEC"),
    pair(0, "SECTION"), pair(2, "ENTITIES"),
    pair(0, "LINE"), pair(5, "10"), pair(8, "WALL"), pair(10, -2), pair(20, 1), pair(11, 5), pair(21, 4),
    pair(0, "LWPOLYLINE"), pair(5, "11"), pair(8, "WALL"), pair(70, 1), pair(10, 0), pair(20, 0), pair(10, 4), pair(20, 0), pair(10, 4), pair(20, 3),
    pair(0, "POLYLINE"), pair(5, "12"), pair(8, "WALL"), pair(70, 1),
    pair(0, "VERTEX"), pair(10, 1), pair(20, 1), pair(0, "VERTEX"), pair(10, 2), pair(20, 2), pair(0, "SEQEND"),
    pair(0, "CIRCLE"), pair(5, "13"), pair(8, "DETAIL"), pair(10, 8), pair(20, 8), pair(40, 2),
    pair(0, "ARC"), pair(5, "14"), pair(8, "DETAIL"), pair(10, 2), pair(20, 8), pair(40, 2), pair(50, 0), pair(51, 90),
    pair(0, "TEXT"), pair(5, "15"), pair(8, "NOTE"), pair(10, 1), pair(20, 5), pair(40, 0.5), pair(50, 15), pair(1, "fixture <A>"),
    pair(0, "MTEXT"), pair(5, "16"), pair(8, "NOTE"), pair(10, 3), pair(20, 5), pair(40, 0.75), pair(3, "line "), pair(1, "two & more"),
    pair(0, "INSERT"), pair(5, "17"), pair(8, "LIGHTING"), pair(2, "LED_FIXTURE"), pair(10, 10), pair(20, 20), pair(41, 2), pair(42, 3), pair(50, 45),
    pair(0, "ENDSEC"), pair(0, "EOF")
  ].join("");
}

describe("ASCII DXF document parser", () => {
  it("normalizes supported geometry, text, blocks and INSERT transforms", () => {
    const document = parseAsciiDxf(syntheticDxf());

    expect(document.entities.map(entity => entity.type)).toEqual([
      "line", "lwpolyline", "polyline", "circle", "arc", "text", "mtext", "insert"
    ]);
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0]).toMatchObject({ name: "LED_FIXTURE", basePoint: { x: 0, y: 0, z: 0 } });
    expect(document.blocks[0].entities[0]).toMatchObject({ type: "circle", sourceEntityId: "B1", layer: "SYMBOL", radius: 1 });
    expect(document.entities[1]).toMatchObject({ type: "lwpolyline", closed: true, vertices: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 4, y: 3, z: 0 }] });
    expect(document.entities[2]).toMatchObject({ type: "polyline", closed: true, vertices: [{ x: 1, y: 1, z: 0 }, { x: 2, y: 2, z: 0 }] });
    expect(document.entities[5]).toMatchObject({ type: "text", text: "fixture <A>", position: { x: 1, y: 5, z: 0 }, rotation: 15, height: 0.5 });
    expect(document.entities[6]).toMatchObject({ type: "mtext", text: "line two & more", position: { x: 3, y: 5, z: 0 }, rotation: 0, height: 0.75 });
    expect(document.entities[7]).toEqual({
      type: "insert", sourceEntityId: "17", layer: "LIGHTING", blockName: "LED_FIXTURE",
      position: { x: 10, y: 20, z: 0 }, rotation: 45, scale: { x: 2, y: 3, z: 1 }
    });
    expect(document.bounds).toEqual({ minX: -2, minY: 0, maxX: 12.54951, maxY: 22.54951 });
  });

  it("fails closed for malformed, oversized, excessive and out-of-range input", () => {
    expect(() => parseAsciiDxf("0\nSECTION\n2\nENTITIES\n0\nLINE\n10\nnope\n0\nENDSEC\n0\nEOF\n")).toThrow(/number/i);
    expect(() => parseAsciiDxf("0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n1\n20\n1\n11\n2\n21\n2\n")).toThrow(/unterminated|EOF/i);
    expect(() => parseAsciiDxf(syntheticDxf(), { maxInputBytes: 16 })).toThrow(/input.*limit/i);
    expect(() => parseAsciiDxf(syntheticDxf(), { maxEntities: 2 })).toThrow(/entity.*limit/i);
    expect(() => parseAsciiDxf(syntheticDxf(), { maxCoordinateMagnitude: 9 })).toThrow(/coordinate.*limit/i);
    expect(() => parseAsciiDxf(syntheticDxf(), { maxNormalizedOutputBytes: 32 })).toThrow(/output.*limit/i);
  });

  it("enforces the parsing time budget with an injectable monotonic clock", () => {
    let tick = 0;
    expect(() => parseAsciiDxf(syntheticDxf(), { maxDurationMs: 1, now: () => tick++ })).toThrow(/time.*limit/i);
  });

  it("rejects an INSERT whose transform amplifies otherwise valid coordinates past the limit", () => {
    const amplified = [
      pair(0, "SECTION"), pair(2, "BLOCKS"),
      pair(0, "BLOCK"), pair(2, "B"),
      pair(0, "LINE"), pair(10, 0), pair(20, 0), pair(11, 9), pair(21, 0),
      pair(0, "ENDBLK"), pair(0, "ENDSEC"),
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "INSERT"), pair(2, "B"), pair(10, 9), pair(20, 0), pair(41, 2), pair(42, 1),
      pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");

    expect(() => parseAsciiDxf(amplified, { maxCoordinateMagnitude: 10 })).toThrow(/coordinate.*limit/i);
  });
});
