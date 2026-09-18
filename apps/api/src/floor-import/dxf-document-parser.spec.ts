import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DXF_PARSER_LIMITS, parseAsciiDxf, parseAsciiDxfStream } from "./dxf-document-parser";
import { createCadViewport, projectCadPointToViewport } from "./cad-viewport";

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
  const corpus = (name: string) => join(process.cwd(), "../../scripts/fixtures/cad-import", name);

  it("stops structural parsing after the model ENTITIES section and ignores malformed optional OBJECTS metadata", async () => {
    const converted = [
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "LINE"), pair(5, "MODEL-1"), pair(10, 0), pair(20, 0), pair(11, 4), pair(21, 2),
      pair(0, "ENDSEC"),
      pair(0, "SECTION"), pair(2, "OBJECTS"),
      "55537\n0\n"
    ].join("");

    expect(parseAsciiDxf(converted).entities.map(entity => entity.sourceEntityId)).toEqual(["MODEL-1"]);
    await expect(parseAsciiDxfStream([Buffer.from(converted)]))
      .resolves.toMatchObject({ entities: [expect.objectContaining({ sourceEntityId: "MODEL-1" })] });
  });

  it("retains the approved 208 MiB model accounting ceiling inside the isolated child heap", () => {
    expect(DEFAULT_DXF_PARSER_LIMITS.maxRetainedModelBytes).toBe(208 * 1024 * 1024);
  });

  it("drops only orphan INSERT references emitted without a block definition", () => {
    const converted = [
      pair(0, "SECTION"), pair(2, "BLOCKS"),
      pair(0, "BLOCK"), pair(2, "VALID"), pair(0, "LINE"), pair(5, "B1"),
      pair(10, 0), pair(20, 0), pair(11, 1), pair(21, 1), pair(0, "ENDBLK"), pair(0, "ENDSEC"),
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "INSERT"), pair(5, "ORPHAN"), pair(2, "MISSING"), pair(10, 10), pair(20, 10),
      pair(0, "INSERT"), pair(5, "VALID-INSERT"), pair(2, "VALID"), pair(10, 2), pair(20, 3),
      pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");

    const document = parseAsciiDxf(converted);
    expect(document.entities).toEqual([expect.objectContaining({ sourceEntityId: "VALID-INSERT", blockName: "VALID" })]);
    expect(document.bounds).toEqual({ minX: 2, minY: 3, maxX: 3, maxY: 4 });
  });

  it("keeps only model-space entities by DXF groups 67 and 410 in buffered and streaming modes", async () => {
    const path = corpus("valid-mixed-layout.dxf");
    const buffered = parseAsciiDxf(readFileSync(path));
    const streamed = await parseAsciiDxfStream(createReadStream(path));

    for (const document of [buffered, streamed]) {
      expect(document.entities.map(entity => entity.sourceEntityId)).toEqual(["M1", "IM"]);
      expect(document.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 6 });
    }
  });

  it.each([
    "invalid-trailing-eof.dxf",
    "invalid-missing-endsec.dxf",
    "invalid-orphan-endblk.dxf",
    "invalid-unterminated-block.dxf",
    "invalid-orphan-attrib.dxf",
    "invalid-orphan-seqend.dxf"
  ])("shares the strict malformed corpus in buffered and streaming modes: %s", async name => {
    const path = corpus(name);
    expect(() => parseAsciiDxf(readFileSync(path))).toThrow(/malformed|unterminated|orphan|EOF|ATTRIB|SEQEND|ENDBLK/i);
    await expect(parseAsciiDxfStream(createReadStream(path))).rejects.toThrow(/malformed|unterminated|orphan|EOF|ATTRIB|SEQEND|ENDBLK/i);
  });

  it("bounds streaming line bytes and entity body pairs before normalized materialization", async () => {
    const oversizedLine = `0\nSECTION\n2\nENTITIES\n0\nTEXT\n1\n${"x".repeat(65)}\n10\n0\n20\n0\n40\n1\n0\nENDSEC\n0\nEOF\n`;
    await expect(parseAsciiDxfStream([Buffer.from(oversizedLine)], { maxLineBytes: 64 }))
      .rejects.toThrow(/line.*limit/i);

    const body = [pair(0, "SECTION"), pair(2, "ENTITIES"), pair(0, "LINE"),
      pair(10, 0), pair(20, 0), pair(11, 1), pair(21, 1), pair(30, 0),
      pair(0, "ENDSEC"), pair(0, "EOF")].join("");
    await expect(parseAsciiDxfStream([Buffer.from(body)], { maxEntityBodyPairs: 4 }))
      .rejects.toThrow(/entity body.*limit/i);
  });

  it("streams an input larger than the former 16 MiB cap without whole-file materialization", async () => {
    async function* largeDxf() {
      yield Buffer.from("0\nSECTION\n2\nHEADER\n");
      const value = "x".repeat(16 * 1024);
      for (let index = 0; index < 1_100; index++) yield Buffer.from(`999\n${value}\n`);
      yield Buffer.from("0\nENDSEC\n0\nEOF\n");
    }
    const document = await parseAsciiDxfStream(largeDxf(), {
      maxInputBytes: 32 * 1024 * 1024,
      maxLineBytes: 20 * 1024
    });
    expect(document.entities).toEqual([]);
    expect(document.blocks).toEqual([]);
  });

  it("enforces the independent CPU budget", async () => {
    let cpu = 0;
    await expect(parseAsciiDxfStream([Buffer.from("0\nEOF\n")], {
      maxCpuMs: 1,
      cpuNow: () => cpu++
    })).rejects.toThrow(/CPU.*limit/i);
  });
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
      position: { x: 10, y: 20, z: 0 }, rotation: 45, scale: { x: 2, y: 3, z: 1 }, attributes: []
    });
    expect(document.bounds).toEqual({ minX: -2, minY: 0, maxX: 12.54951, maxY: 22.54951 });
  });

  it("fails closed for malformed, oversized, excessive and out-of-range input", () => {
    expect(() => parseAsciiDxf("0\nSECTION\n2\nENTITIES\n0\nLINE\n10\nnope\n0\nENDSEC\n0\nEOF\n")).toThrow(/decimal|number/i);
    expect(() => parseAsciiDxf("0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n1\n20\n1\n11\n2\n21\n2\n")).toThrow(/unterminated|EOF/i);
    expect(() => parseAsciiDxf(syntheticDxf(), { maxInputBytes: 16 })).toThrow(/input.*limit/i);
    expect(() => parseAsciiDxf(syntheticDxf(), { maxEntities: 2 })).toThrow(/entity.*limit/i);
    expect(() => parseAsciiDxf(syntheticDxf(), { maxCoordinateMagnitude: 9 })).toThrow(/coordinate.*limit/i);
    expect(() => parseAsciiDxf(syntheticDxf(), { maxNormalizedOutputBytes: 32 })).toThrow(/output.*limit/i);
    expect(() => parseAsciiDxf(syntheticDxf(), { maxRetainedModelBytes: 128 })).toThrow(/retained model memory.*limit/i);
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

  it("keeps a separately bounded survey elevation without weakening XY limits", () => {
    const elevated = [
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "LINE"), pair(10, 0), pair(20, 0), pair(30, -21_808_821_412), pair(11, 1), pair(21, 1), pair(31, -21_808_821_412),
      pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");
    expect(parseAsciiDxf(elevated).entities[0]).toMatchObject({ start: { z: -21_808_821_412 } });
    expect(() => parseAsciiDxf(elevated, { maxZCoordinateMagnitude: 1_000 })).toThrow(/coordinate.*limit/i);
  });

  it.each([" ", "0x10", "1_000", "Infinity", "NaN"])("rejects non-DXF decimal coordinate syntax %p", value => {
    const malformed = [
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "LINE"), pair(10, value), pair(20, 0), pair(11, 1), pair(21, 1),
      pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");
    expect(() => parseAsciiDxf(malformed)).toThrow(/decimal|number/i);
  });

  it("rejects duplicate explicit handles across the entire document", () => {
    const duplicated = [
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "LINE"), pair(5, "DUP"), pair(10, 0), pair(20, 0), pair(11, 1), pair(21, 1),
      pair(0, "CIRCLE"), pair(5, "DUP"), pair(10, 2), pair(20, 2), pair(40, 1),
      pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");
    expect(() => parseAsciiDxf(duplicated)).toThrow(/duplicate.*handle/i);
  });

  it("treats DXF handle case variants as duplicates", () => {
    const duplicated = [
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "LINE"), pair(5, "aF"), pair(10, 0), pair(20, 0), pair(11, 1), pair(21, 1),
      pair(0, "LINE"), pair(5, "AF"), pair(10, 2), pair(20, 2), pair(11, 3), pair(21, 3),
      pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");
    expect(() => parseAsciiDxf(duplicated)).toThrow(/duplicate.*handle/i);
  });

  it("rejects a generated source ID that collides with an explicit handle", () => {
    const collision = [
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "LINE"), pair(10, 0), pair(20, 0), pair(11, 1), pair(21, 1),
      pair(0, "LINE"), pair(5, "generated-1"), pair(10, 2), pair(20, 2), pair(11, 3), pair(21, 3),
      pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");
    expect(() => parseAsciiDxf(collision)).toThrow(/duplicate.*(?:source|handle)|source.*collision/i);
  });

  it("preserves INSERT ATTRIB values in the normalized model", () => {
    const attributed = [
      pair(0, "SECTION"), pair(2, "BLOCKS"),
      pair(0, "BLOCK"), pair(2, "DEVICE"), pair(0, "LINE"), pair(10, 0), pair(20, 0), pair(11, 1), pair(21, 0), pair(0, "ENDBLK"), pair(0, "ENDSEC"),
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "INSERT"), pair(5, "I1"), pair(8, "LIGHTING"), pair(2, "DEVICE"), pair(10, 4), pair(20, 5), pair(66, 1),
      pair(0, "ATTRIB"), pair(5, "A1"), pair(2, "TYPE"), pair(1, "LED PANEL"), pair(10, 4), pair(20, 5), pair(40, 0.5), pair(50, 30),
      pair(0, "SEQEND"), pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");

    expect(parseAsciiDxf(attributed).entities[0]).toMatchObject({
      type: "insert",
      attributes: [{ sourceEntityId: "A1", tag: "TYPE", value: "LED PANEL", position: { x: 4, y: 5, z: 0 }, height: 0.5, rotation: 30 }]
    });
  });

  it("excludes an entity-invisible ATTRIB from detector evidence", () => {
    const attributed = [
      pair(0, "SECTION"), pair(2, "BLOCKS"),
      pair(0, "BLOCK"), pair(2, "DEVICE"), pair(0, "LINE"), pair(10, 0), pair(20, 0), pair(11, 1), pair(21, 0), pair(0, "ENDBLK"), pair(0, "ENDSEC"),
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "INSERT"), pair(5, "I1"), pair(8, "EQUIPMENT"), pair(2, "DEVICE"), pair(10, 4), pair(20, 5), pair(66, 1),
      pair(0, "ATTRIB"), pair(5, "A1"), pair(60, 1), pair(2, "TYPE"), pair(1, "LED PANEL"), pair(10, 4), pair(20, 5),
      pair(0, "SEQEND"), pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");

    expect(parseAsciiDxf(attributed).entities[0]).toMatchObject({ type: "insert", attributes: [] });
  });

  it.each([
    ["group 66 sequence without ATTRIB", [pair(0, "INSERT"), pair(2, "DEVICE"), pair(10, 0), pair(20, 0), pair(66, 1), pair(0, "SEQEND")]],
    ["group 66 sequence without SEQEND", [pair(0, "INSERT"), pair(2, "DEVICE"), pair(10, 0), pair(20, 0), pair(66, 1), pair(0, "ATTRIB"), pair(2, "TYPE"), pair(1, "LED"), pair(10, 0), pair(20, 0)]],
    ["ATTRIB without group 66", [pair(0, "INSERT"), pair(2, "DEVICE"), pair(10, 0), pair(20, 0), pair(0, "ATTRIB"), pair(2, "TYPE"), pair(1, "LED"), pair(10, 0), pair(20, 0), pair(0, "SEQEND")]],
    ["invalid group 66 flag", [pair(0, "INSERT"), pair(2, "DEVICE"), pair(10, 0), pair(20, 0), pair(66, 2)]],
    ["duplicate group 66 flag", [pair(0, "INSERT"), pair(2, "DEVICE"), pair(10, 0), pair(20, 0), pair(66, 0), pair(66, 1)]]
  ])("rejects malformed INSERT attribute structure: %s", (_label, sequence) => {
    const malformed = [
      pair(0, "SECTION"), pair(2, "BLOCKS"), pair(0, "BLOCK"), pair(2, "DEVICE"),
      pair(0, "LINE"), pair(10, 0), pair(20, 0), pair(11, 1), pair(21, 0), pair(0, "ENDBLK"), pair(0, "ENDSEC"),
      pair(0, "SECTION"), pair(2, "ENTITIES"), ...sequence, pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");
    expect(() => parseAsciiDxf(malformed)).toThrow(/ATTRIB|SEQEND|group 66|attribute sequence/i);
  });

  it("accepts signed nonzero INSERT scale and preserves mirrored bounds", () => {
    const mirrored = [
      pair(0, "SECTION"), pair(2, "BLOCKS"), pair(0, "BLOCK"), pair(2, "DEVICE"),
      pair(0, "LINE"), pair(10, 0), pair(20, 0), pair(11, 2), pair(21, 1), pair(0, "ENDBLK"), pair(0, "ENDSEC"),
      pair(0, "SECTION"), pair(2, "ENTITIES"), pair(0, "INSERT"), pair(5, "M1"), pair(2, "DEVICE"),
      pair(10, 10), pair(20, 20), pair(41, -2), pair(42, 3), pair(43, -1), pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");

    const document = parseAsciiDxf(mirrored);
    expect(document.entities[0]).toMatchObject({ type: "insert", scale: { x: -2, y: 3, z: -1 } });
    expect(document.bounds).toEqual({ minX: 6, minY: 20, maxX: 10, maxY: 23 });
  });

  it("rejects zero INSERT scale", () => {
    const zeroScale = [
      pair(0, "SECTION"), pair(2, "ENTITIES"), pair(0, "INSERT"), pair(2, "DEVICE"), pair(10, 0), pair(20, 0), pair(41, 0),
      pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");
    expect(() => parseAsciiDxf(zeroScale)).toThrow(/insert x scale/i);
  });

  it("preserves LWPOLYLINE bulge and includes its arc in document bounds", () => {
    const curved = [
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "LWPOLYLINE"), pair(5, "P1"), pair(10, 0), pair(20, 0), pair(42, 1), pair(10, 2), pair(20, 0),
      pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");

    const document = parseAsciiDxf(curved);
    expect(document.entities[0]).toMatchObject({
      type: "lwpolyline",
      vertices: [{ x: 0, y: 0, z: 0, bulge: 1 }, { x: 2, y: 0, z: 0, bulge: 0 }]
    });
    expect(document.bounds).toEqual({ minX: 0, minY: -1, maxX: 2, maxY: 0 });
  });

  it("ignores a degenerate bulge on coincident vertices while preserving finite bounds", () => {
    const degenerate = [
      pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "LWPOLYLINE"), pair(10, 1), pair(20, 2), pair(42, 1), pair(10, 1), pair(20, 2),
      pair(0, "ENDSEC"), pair(0, "EOF")
    ].join("");
    expect(parseAsciiDxf(degenerate).bounds).toEqual({ minX: 1, minY: 2, maxX: 1, maxY: 2 });
  });

  it("excludes off, frozen and entity-invisible geometry before bounds, rendering and detection", () => {
    const dxf = [
      "0","SECTION","2","TABLES","0","TABLE","2","LAYER",
      "0","LAYER","2","VISIBLE","70","0","62","7",
      "0","LAYER","2","OFF","70","0","62","-7",
      "0","LAYER","2","FROZEN","70","1","62","7",
      "0","ENDTAB","0","TABLE","2","STYLE","0","STYLE","2","STANDARD","0","ENDTAB","0","ENDSEC",
      "0","SECTION","2","BLOCKS",
      "0","BLOCK","2","LAMP","10","0","20","0",
      "0","LINE","5","B1","8","VISIBLE","10","0","20","0","11","1","21","0",
      "0","LINE","5","B2","8","OFF","10","0","20","0","11","100","21","0",
      "0","ENDBLK","0","ENDSEC",
      "0","SECTION","2","ENTITIES",
      "0","LINE","5","1","8","VISIBLE","10","0","20","0","11","2","21","0",
      "0","LINE","5","2","8","OFF","10","0","20","0","11","200","21","0",
      "0","LINE","5","3","8","FROZEN","10","0","20","0","11","300","21","0",
      "0","LINE","5","4","8","VISIBLE","60","1","10","0","20","0","11","400","21","0",
      "0","INSERT","5","5","8","VISIBLE","2","LAMP","10","4","20","0",
      "0","WIPEOUT","5","6","8","VISIBLE","10","0","20","0",
      "0","SPLINE","5","7","8","VISIBLE","10","0","20","0",
      "0","ENDSEC","0","EOF"
    ].join("\n") + "\n";

    const document = parseAsciiDxf(dxf);
    expect(document.entities.map(entity => entity.sourceEntityId)).toEqual(["1", "5"]);
    expect(document.blocks[0].entities.map(entity => entity.sourceEntityId)).toEqual(["B1"]);
    expect(document.bounds.maxX).toBe(5);
  });

  it("keeps model geometry on a layer whose flag 2 only means frozen in new viewports", () => {
    const dxf = [
      "0","SECTION","2","TABLES","0","TABLE","2","LAYER",
      "0","LAYER","2","NEW_VIEWPORT_FROZEN","70","2","62","7",
      "0","ENDTAB","0","ENDSEC",
      "0","SECTION","2","ENTITIES",
      "0","LINE","5","FLAG2-LINE","8","NEW_VIEWPORT_FROZEN","10","0","20","0","11","8","21","0",
      "0","ENDSEC","0","EOF"
    ].join("\n") + "\n";

    const document = parseAsciiDxf(dxf);
    expect(document.entities.map(entity => entity.sourceEntityId)).toEqual(["FLAG2-LINE"]);
    expect(document.bounds.maxX).toBe(8);
  });

  it("charges the current entity body against retained memory before normalization", async () => {
    async function* denseUnsupportedEntity() {
      yield "0\nSECTION\n2\nENTITIES\n0\nWIPEOUT\n";
      for (let index = 0; index < 2_000; index++) yield `1000\n${"x".repeat(40)}\n`;
      yield "0\nENDSEC\n0\nEOF\n";
    }
    await expect(parseAsciiDxfStream(denseUnsupportedEntity(), {
      maxRetainedModelBytes: 8 * 1024, maxEntityBodyPairs: 3_000
    })).rejects.toThrow(/retained model memory.*limit/i);
  });

  it("normalizes small CAD coordinates without separating candidates from the rendered map", () => {
    const bounds = { minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 };
    expect(createCadViewport(bounds)).toEqual({ width: 800, height: 800 });
    expect(projectCadPointToViewport({ x: 0.05, y: 0.05, z: 0 }, bounds))
      .toEqual({ x: 400, y: 400 });
  });
});
