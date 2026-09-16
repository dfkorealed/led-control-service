import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderCadDocumentSvg } from "./cad-svg-renderer";
import { parseAsciiDxfStream } from "./dxf-document-parser";
import { RuleBasedLightingSymbolDetector } from "./rule-based-lighting-symbol-detector";

const runFile = promisify(execFile);
const sample = process.env.CAD_SAMPLE_DWG_PATH;
const converter = process.env.CAD_SAMPLE_CONVERTER_PATH;

(sample && converter ? describe : describe.skip)("provided CAD sample product pipeline", () => {
  jest.setTimeout(120_000);

  it("converts, streams, detects and renders within production bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-sample-product-"));
    const dxfPath = join(root, "sample.dxf");
    try {
      await runFile(converter!, ["-O", "DXF", "-o", dxfPath, sample!], { timeout: 60_000, maxBuffer: 1024 * 1024 });
      const dxf = await stat(dxfPath);
      expect(dxf.size).toBeLessThanOrEqual(256 * 1024 * 1024);

      const startedAt = performance.now();
      const document = await parseAsciiDxfStream(createReadStream(dxfPath));
      const parsedAt = performance.now();
      const detector = new RuleBasedLightingSymbolDetector({ maxDurationMs: 30_000 });
      const candidates = await detector.detect(document);
      const detectedAt = performance.now();
      const svg = renderCadDocumentSvg(document, {
        maxOutputBytes: 128 * 1024 * 1024, maxRenderedEntities: 1_000_000, maxBlockDepth: 32,
        trustDocumentBounds: true, includeEntityMetadata: false, compactPaths: true
      });
      const renderedAt = performance.now();

      expect(document.entities).toHaveLength(26_389);
      expect(candidates.length).toBeGreaterThanOrEqual(1_302);
      expect(candidates.length).toBeLessThanOrEqual(1_308);
      expect(Buffer.byteLength(svg)).toBeLessThanOrEqual(128 * 1024 * 1024);
      expect(candidates[0]).toMatchObject({
        blockName: "몰드바등", profileVersion: detector.profileVersion, profileDigest: detector.profileDigest
      });
      process.stdout.write(`${JSON.stringify({
        dxfBytes: dxf.size,
        modelSupportedEntities: document.entities.length,
        blocks: document.blocks.length,
        candidates: candidates.length,
        svgBytes: Buffer.byteLength(svg),
        parseMs: Math.round(parsedAt - startedAt),
        detectMs: Math.round(detectedAt - parsedAt),
        renderMs: Math.round(renderedAt - detectedAt),
        profileVersion: detector.profileVersion,
        profileDigest: detector.profileDigest
      })}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
