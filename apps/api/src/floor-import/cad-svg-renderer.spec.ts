import type { NormalizedCadDocument } from "./cad-types";
import { renderCadDocumentSvg, renderCadDocumentSvgFile } from "./cad-svg-renderer";
import sharp from "sharp";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { parseAsciiDxf } from "./dxf-document-parser";
import { projectCadPointToViewport } from "./cad-viewport";

const document: NormalizedCadDocument = {
  version: 1,
  bounds: { minX: 0, minY: 0, maxX: 12, maxY: 8 },
  blocks: [{
    name: "LED<&>", basePoint: { x: 0, y: 0, z: 0 },
    entities: [{ type: "circle", sourceEntityId: "block-circle", layer: "SYMBOL", center: { x: 0, y: 0, z: 0 }, radius: 1 }]
  }],
  entities: [
    { type: "line", sourceEntityId: "line-1", layer: "WALL", start: { x: 0, y: 0, z: 0 }, end: { x: 12, y: 8, z: 0 } },
    { type: "text", sourceEntityId: "text-1", layer: "NOTE", position: { x: 2, y: 3, z: 0 }, rotation: 0, height: 1, text: "<script>alert('x') & \"y\"</script>" },
    { type: "insert", sourceEntityId: "insert-1", layer: "LIGHT<&>", blockName: "LED<&>", position: { x: 10, y: 5, z: 0 }, rotation: 30, scale: { x: 2, y: 2, z: 1 }, attributes: [] }
  ]
};

describe("CAD SVG renderer", () => {
  it("streams repeated blocks and escaped Hangul text into a storage-sized hierarchical SVG", async () => {
    const repeated: NormalizedCadDocument = {
      version: 1, bounds: { minX: 0, minY: 0, maxX: 4_000, maxY: 10 },
      blocks: [{
        name: "몰드바등<&>", basePoint: { x: 1, y: 1, z: 0 },
        entities: [
          { type: "circle", sourceEntityId: "lamp", layer: "조명", center: { x: 1, y: 1, z: 0 }, radius: 1 },
          { type: "text", sourceEntityId: "label", layer: "문자", position: { x: 0, y: 0, z: 0 }, rotation: 0, height: 1, text: "한글<&>" }
        ]
      }],
      entities: Array.from({ length: 2_000 }, (_, index) => ({
        type: "insert" as const, sourceEntityId: `i-${index}`, layer: "LIGHT", blockName: "몰드바등<&>",
        position: { x: index * 2, y: 2, z: 0 }, rotation: 0, scale: { x: 1, y: 1, z: 1 }, attributes: []
      }))
    };
    const root = await mkdtemp(join(tmpdir(), "cad-svg-stream-"));
    const outputPath = join(root, "floor.svg");
    const repeatedPath = join(root, "floor-repeat.svg");
    try {
      const result = await renderCadDocumentSvgFile(repeated, outputPath);
      const repeatedResult = await renderCadDocumentSvgFile(repeated, repeatedPath);
      const svg = gunzipSync(await readFile(outputPath)).toString("utf8");
      expect(result.sizeBytes).toBeLessThan(8 * 1024 * 1024);
      expect(svg.match(/<symbol\b/g)).toHaveLength(1);
      expect(svg.match(/<use\b/g)).toHaveLength(2_000);
      expect(svg).toContain("<text");
      expect(svg).toContain("한글&lt;&amp;&gt;");
      expect(svg).not.toMatch(/(?:href|src)=["'](?:https?:|data:)|<image|<foreignObject|@import/i);
      const raster = sharp(Buffer.from(svg)).ensureAlpha();
      const metadata = await raster.metadata();
      const stats = await raster.stats();
      expect(metadata.width).toBeGreaterThan(3_900);
      expect(stats.channels[3]?.max).toBe(255);
      expect(repeatedResult).toEqual(result);
      expect(await readFile(repeatedPath)).toEqual(await readFile(outputPath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("renders one self-contained SVG with a normalized viewport and expanded blocks", () => {
    const svg = renderCadDocumentSvg(document);

    expect(svg.match(/<svg\b/g)).toHaveLength(1);
    expect(svg.match(/<\/svg>/g)).toHaveLength(1);
    expect(svg).toMatch(/^<svg[^>]+viewBox="0 0 [\d.]+ [\d.]+"/);
    expect(svg).toContain('data-source-entity-id="8:insert-112:block-circle"');
    expect(svg).not.toMatch(/NaN|Infinity/);
    expect(svg).not.toMatch(/(?:href|src)=|<image|<foreignObject|@import/i);
  });

  it("XML-escapes every user-controlled layer, block and text value", () => {
    const svg = renderCadDocumentSvg(document);
    expect(svg).toContain("&lt;script&gt;alert(&apos;x&apos;) &amp; &quot;y&quot;&lt;/script&gt;");
    expect(svg).toContain("LIGHT&lt;&amp;&gt;");
    expect(svg).toContain("LED&lt;&amp;&gt;");
    expect(svg).not.toContain("<script>");
  });

  it("replaces XML-forbidden controls and isolated surrogate code units", () => {
    const hostile = structuredClone(document);
    const text = hostile.entities[1];
    if (text.type !== "text") throw new Error("Expected text fixture");
    text.text = "safe\u0000\uD800tail";

    const svg = renderCadDocumentSvg(hostile);
    expect(svg).toContain("safe\uFFFD\uFFFDtail");
    expect(svg).not.toContain("\u0000");
    expect(svg).not.toContain("\uD800");
  });

  it("fails closed when expansion or output exceeds configured limits", () => {
    expect(() => renderCadDocumentSvg(document, { maxRenderedEntities: 2 })).toThrow(/rendered entity.*limit/i);
    expect(() => renderCadDocumentSvg(document, { maxOutputBytes: 64 })).toThrow(/output.*limit/i);
  });

  it("enforces independent SVG wall and CPU budgets", () => {
    let wall = 0;
    expect(() => renderCadDocumentSvg(document, { maxDurationMs: 1, now: () => wall++ }))
      .toThrow(/wall time.*limit/i);
    let cpu = 0;
    expect(() => renderCadDocumentSvg(document, { maxCpuMs: 1, cpuNow: () => cpu++ }))
      .toThrow(/CPU time.*limit/i);
  });

  it("renders LWPOLYLINE bulges as sampled arcs instead of straight chords", () => {
    const curved: NormalizedCadDocument = {
      version: 1, bounds: { minX: 0, minY: -1, maxX: 2, maxY: 0 }, blocks: [],
      entities: [{
        type: "lwpolyline", sourceEntityId: "curve", layer: "WALL", closed: false,
        vertices: [{ x: 0, y: 0, z: 0, bulge: 1 }, { x: 2, y: 0, z: 0, bulge: 0 }]
      }]
    };

    const points = renderCadDocumentSvg(curved).match(/data-source-entity-id="curve"[^>]+points="([^"]+)"/)?.[1].split(" ") ?? [];
    expect(points.length).toBeGreaterThan(2);
    expect(new Set(points.map(point => point.split(",")[1])).size).toBeGreaterThan(1);
  });

  it("applies the complete nested INSERT affine matrix to text glyphs", () => {
    const affine: NormalizedCadDocument = {
      version: 1, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      blocks: [
        { name: "LABEL", basePoint: { x: 0, y: 0, z: 0 }, entities: [{ type: "text", sourceEntityId: "T", layer: "0", position: { x: 0, y: 0, z: 0 }, rotation: 15, height: 1, text: "Affine" }] },
        { name: "WRAPPER", basePoint: { x: 0, y: 0, z: 0 }, entities: [{ type: "insert", sourceEntityId: "INNER", layer: "0", blockName: "LABEL", position: { x: 1, y: 2, z: 0 }, rotation: 30, scale: { x: 2, y: 1, z: 1 }, attributes: [] }] }
      ],
      entities: [{ type: "insert", sourceEntityId: "OUTER", layer: "LIGHTING", blockName: "WRAPPER", position: { x: 3, y: 4, z: 0 }, rotation: 45, scale: { x: 1, y: 3, z: 1 }, attributes: [] }]
    };

    const svg = renderCadDocumentSvg(affine);
    const matrix = svg.match(/data-cad-text="true"[^>]+transform="matrix\(([^)]+)\)"/)?.[1].split(" ").map(Number);
    expect(matrix).toHaveLength(6);
    expect(matrix?.every(Number.isFinite)).toBe(true);
    expect(Math.abs(matrix?.[1] ?? 0)).toBeGreaterThan(0.1);
    expect(Math.abs(matrix?.[2] ?? 0)).toBeGreaterThan(0.1);
    expect(Math.hypot(matrix?.[0] ?? 0, matrix?.[1] ?? 0)).not.toBeCloseTo(Math.hypot(matrix?.[2] ?? 0, matrix?.[3] ?? 0));
  });

  it("converts text to deterministic bundled-font paths whose pixel bounds fit the viewport", async () => {
    const textOnly: NormalizedCadDocument = {
      version: 1, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, blocks: [],
      entities: [{ type: "text", sourceEntityId: "wide", layer: "NOTE", position: { x: 0, y: 0, z: 0 }, rotation: 0, height: 12, text: "WWWWWWWW 긴 한글 조명" }]
    };
    const svg = renderCadDocumentSvg(textOnly, { padding: 2 });
    expect(svg).toContain('data-cad-text="true"');
    expect(svg).toContain("<path ");
    expect(svg).not.toContain("<text");
    expect(svg).toContain('aria-label="WWWWWWWW 긴 한글 조명"');

    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const darkPixels: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset] < 245 || data[offset + 1] < 245 || data[offset + 2] < 245) darkPixels.push({ x, y });
    }
    expect(darkPixels.length).toBeGreaterThan(100);
    expect(Math.min(...darkPixels.map(pixel => pixel.x))).toBeGreaterThan(0);
    expect(Math.max(...darkPixels.map(pixel => pixel.x))).toBeLessThan(info.width - 1);
    expect(Math.min(...darkPixels.map(pixel => pixel.y))).toBeGreaterThan(0);
    expect(Math.max(...darkPixels.map(pixel => pixel.y))).toBeLessThan(info.height - 1);
  });

  it("fails a maximum-size text against a tiny output budget before materializing all glyph paths", () => {
    const oversizedText: NormalizedCadDocument = {
      version: 1, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, blocks: [],
      entities: [{
        type: "text", sourceEntityId: "large-text", layer: "NOTE", position: { x: 0, y: 0, z: 0 },
        rotation: 0, height: 1, text: "한".repeat(20_000)
      }]
    };
    const rssBefore = process.memoryUsage().rss;

    expect(() => renderCadDocumentSvg(oversizedText, { maxOutputBytes: 1024 })).toThrow(/output.*limit/i);

    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(64 * 1024 * 1024);
  });

  it("keeps the small-span pixel transform aligned while omitting hidden and unsupported DXF entities", async () => {
    const dxf = [
      "0","SECTION","2","TABLES","0","TABLE","2","LAYER",
      "0","LAYER","2","VISIBLE","70","0","62","7",
      "0","LAYER","2","OFF","70","0","62","-7","0","ENDTAB","0","ENDSEC",
      "0","SECTION","2","ENTITIES",
      "0","LINE","5","VISIBLE-LINE","8","VISIBLE","10","0","20","0","11","0.9","21","0.9",
      "0","LINE","5","HIDDEN-LAYER","8","OFF","10","0","20","0","11","100","21","100",
      "0","LINE","5","HIDDEN-ENTITY","8","VISIBLE","60","1","10","0","20","0","11","100","21","100",
      "0","WIPEOUT","5","UNSUPPORTED-WIPEOUT","8","VISIBLE","10","0","20","0",
      "0","SPLINE","5","UNSUPPORTED-SPLINE","8","VISIBLE","10","0","20","0",
      "0","ENDSEC","0","EOF"
    ].join("\n") + "\n";
    const parsed = parseAsciiDxf(dxf);
    const root = await mkdtemp(join(tmpdir(), "cad-pixel-oracle-"));
    try {
      const path = join(root, "small.svg");
      await renderCadDocumentSvgFile(parsed, path);
      const svg = gunzipSync(await readFile(path)).toString("utf8");
      expect(parsed.bounds).toEqual({ minX: 0, minY: 0, maxX: 0.9, maxY: 0.9 });
      expect(parsed.entities.map(entity => entity.sourceEntityId)).toEqual(["VISIBLE-LINE"]);
      expect(svg).toContain('<path d="M0 0L0.9 0.9"/>');
      expect(projectCadPointToViewport({ x: 0.45, y: 0.45, z: 0 }, parsed.bounds)).toEqual({ x: 1.45, y: 1.45 });
      const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect({ width: info.width, height: info.height }).toEqual({ width: 3, height: 3 });
      expect([...data].some((value, index) => index % info.channels < 3 && value < 245)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
