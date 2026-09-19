import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import sharp from "sharp";
import { renderCadDocumentSvgFile } from "./cad-svg-renderer";
import { cadViewportScale, cadViewportSvgTransform } from "./cad-viewport";
import * as geometry from "./cad-geometry";
import * as renderer from "./cad-region-preview-renderer";
import type { NormalizedCadDocument } from "./cad-types";

describe("bounded CAD region previews", () => {
  const drawing: NormalizedCadDocument = {
    version: 1, bounds: { minX: 0, minY: 0, maxX: 1010, maxY: 10 }, blocks: [],
    entities: [
      { type: "line", sourceEntityId: "near", layer: "0", start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 10, z: 0 } },
      { type: "line", sourceEntityId: "far", layer: "0", start: { x: 1000, y: 0, z: 0 }, end: { x: 1010, y: 10, z: 0 } }
    ]
  };
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cad-preview-batch-")); });
  afterEach(async () => { jest.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  it("expands once, routes overlapping regions, and bounds open files and buffers", async () => {
    const expansion = jest.spyOn(geometry, "iterateCadDocumentExpansion");
    const regions = [
      { regionId: "near", bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, outputPath: join(root, "near.svg") },
      { regionId: "far", bounds: { minX: 1000, minY: 0, maxX: 1010, maxY: 10 }, outputPath: join(root, "far.svg") },
      { regionId: "both", bounds: drawing.bounds, outputPath: join(root, "both.svg") }
    ];
    const result = await renderer.renderCadRegionPreviewFiles(drawing, regions, { maxOpenFiles: 1, maxBufferedBytes: 256 });
    expect(expansion).toHaveBeenCalledTimes(1);
    expect(result.expandedOccurrences).toBe(2);
    expect(result.routedOccurrences).toBe(4);
    expect(result.peakOpenFiles).toBeLessThanOrEqual(1);
    expect(result.peakBufferedBytes).toBeLessThanOrEqual(256);
    expect(result.previews).toHaveLength(3);
    for (const [index, count] of [1, 1, 2].entries()) {
      const svg = gunzipSync(await readFile(regions[index].outputPath)).toString("utf8");
      expect(svg.match(/<path /g)).toHaveLength(count);
      expect(svg).not.toMatch(/NaN|Infinity|<image|href="https?:/);
    }
  });

  it.each([
    { maxTotalRawBytes: 16 }, { maxTotalOutputBytes: 16 }, { maxRoutingSteps: 1 }
  ])("fails explicitly and removes partial artifacts at an aggregate limit %j", async limits => {
    await expect(renderer.renderCadRegionPreviewFiles(drawing, [
      { regionId: "all", bounds: drawing.bounds, outputPath: join(root, "all.svg") }
    ], limits)).rejects.toThrow(/limit|budget/i);
    expect(await readdir(root)).toEqual([]);
  });

  it("matches the existing renderer for nested reflected blocks even when the definition cache fills", async () => {
    const transformed: NormalizedCadDocument = {
      version: 1, bounds: { minX: -10, minY: -10, maxX: 30, maxY: 30 },
      blocks: [{ name: "SYMBOL", basePoint: { x: 0, y: 0, z: 0 }, entities: [
        { type: "circle", sourceEntityId: "circle", layer: "0", center: { x: 0, y: 0, z: 0 }, radius: 3 },
        { type: "line", sourceEntityId: "line", layer: "0", start: { x: -4, y: -4, z: 0 }, end: { x: 4, y: 4, z: 0 } }
      ] }],
      entities: Array.from({ length: 4 }, (_, i) => ({
        type: "insert", sourceEntityId: `insert-${i}`, layer: "0", blockName: "SYMBOL",
        position: { x: i * 5, y: i * 5, z: 0 }, rotation: 23,
        scale: { x: -1, y: 0.5, z: 1 }, attributes: []
      }))
    };
    const outputPath = join(root, "batch.svg");
    const legacyPath = join(root, "legacy.svg");
    const result = await renderer.renderCadRegionPreviewFiles(transformed, [{ regionId: "all", bounds: transformed.bounds, outputPath }],
      { maxRetainedDefinitions: 1, maxOpenFiles: 1, maxBufferedBytes: 1024 });
    await renderCadDocumentSvgFile({ ...transformed, primaryBoundsSelection: { excludedEntityCount: 0, totalEntityCount: 8 } }, legacyPath);
    const svg = gunzipSync(await readFile(outputPath));
    expect(svg.toString().match(/<use /g)).toHaveLength(4);
    expect(svg.toString().match(/<path /g)).toHaveLength(4);
    expect(result.routedOccurrences).toBe(8);
    const pixels = await sharp(svg).resize(300, 200).removeAlpha().raw().toBuffer();
    const legacyPixels = await sharp(gunzipSync(await readFile(legacyPath))).resize(300, 200).removeAlpha().raw().toBuffer();
    let error = 0;
    for (let i = 0; i < pixels.length; i++) error += Math.abs(pixels[i] - legacyPixels[i]);
    expect(error / pixels.length).toBeLessThan(0.1);
  });

  it("emits all 1,000 disconnected previews with constant file and buffer budgets", async () => {
    const targets = Array.from({ length: 1000 }, (_, i) => ({ regionId: `r-${i}`,
      bounds: { minX: i * 100, minY: 0, maxX: i * 100 + 10, maxY: 10 }, outputPath: join(root, `${i}.svg`) }));
    const input: NormalizedCadDocument = { version: 1, bounds: targets.at(-1)!.bounds, blocks: [],
      entities: targets.map((target, i) => ({ type: "line", sourceEntityId: `line-${i}`, layer: "0",
        start: { x: target.bounds.minX, y: 0, z: 0 }, end: { x: target.bounds.maxX, y: 10, z: 0 } })) };
    const result = await renderer.renderCadRegionPreviewFiles(input, targets, { maxOpenFiles: 2, maxBufferedBytes: 4096 });
    expect(result.previews).toHaveLength(1000);
    expect(result.expandedOccurrences).toBe(1000);
    expect(result.routedOccurrences).toBe(1000);
    expect(result.peakOpenFiles).toBeLessThanOrEqual(2);
    expect(result.peakBufferedBytes).toBeLessThanOrEqual(4096);
    expect((await readdir(root)).filter(path => path.endsWith(".raw"))).toEqual([]);
  }, 30_000);

  it("reframes the compact source without another expansion when flattened output exceeds the per-file cap", async () => {
    const input: NormalizedCadDocument = {
      version: 1, bounds: { minX: 0, minY: 0, maxX: 2010, maxY: 128 },
      primaryBoundsSelection: { excludedEntityCount: 0, totalEntityCount: 25_600 },
      blocks: [{ name: "DENSE", basePoint: { x: 0, y: 0, z: 0 }, entities: Array.from({ length: 128 }, (_, i) => ({
        type: "line", sourceEntityId: `l-${i}`, layer: "0", start: { x: 0, y: i, z: 0 }, end: { x: 10, y: i, z: 0 }
      })) }],
      entities: Array.from({ length: 200 }, (_, i) => ({
        type: "insert", sourceEntityId: `i-${i}`, layer: "0", blockName: "DENSE", position: { x: i * 10, y: 0, z: 0 },
        rotation: 0, scale: { x: 1, y: 1, z: 1 }, attributes: []
      }))
    };
    const sourcePath = join(root, "source.svg");
    input.entities.push({ type: "point", sourceEntityId: "marker", layer: "0", position: { x: 500, y: 50, z: 0 } });
    const rendered = await renderCadDocumentSvgFile(input, sourcePath);
    const expansion = jest.spyOn(geometry, "iterateCadDocumentExpansion");
    const bounds = { minX: 100, minY: 0, maxX: 1900, maxY: 128 };
    const outputPath = join(root, "region.svg");
    const result = await renderer.renderCadRegionPreviewFiles(input, [{ regionId: "dense", bounds, outputPath }], {
      maxOutputBytes: 3000, compactFallback: { path: sourcePath, bounds: input.bounds, rendered }
    });
    expect(expansion).toHaveBeenCalledTimes(1);
    const svg = gunzipSync(await readFile(outputPath)).toString("utf8");
    expect(svg).toContain("<symbol");
    expect(svg).toContain(`transform="${cadViewportSvgTransform(bounds)}"`);
    expect(svg).toContain(`M${Math.round((500 - 3 / cadViewportScale(bounds)) * 1_000_000) / 1_000_000} 50h`);
    expect(result.previews[0].rawSizeBytes).toBe(Buffer.byteLength(svg));
    expect(result.previews[0].sizeBytes).toBeLessThanOrEqual(3000);
    expect(result.totalOutputBytes).toBe(result.previews[0].sizeBytes);
  });
});
