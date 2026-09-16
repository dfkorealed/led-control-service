import { HeadObjectCommand, PutObjectCommand, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStorageService } from "../storage/object-storage.service";
import { ArgvCadConverter } from "./cad-converter";
import { CAD_RENDERED_SVG_MAX_BYTES, renderCadDocumentSvgFile } from "./cad-svg-renderer";
import { parseAsciiDxfStream } from "./dxf-document-parser";
import { RuleBasedLightingSymbolDetector, SITE_DRAWING_20260803_PROFILE } from "./rule-based-lighting-symbol-detector";

const sample = process.env.CAD_SAMPLE_DWG_PATH;
const converterPath = process.env.CAD_SAMPLE_CONVERTER_PATH;

(sample && converterPath ? describe : describe.skip)("provided CAD sample product pipeline", () => {
  jest.setTimeout(180_000);
  it("uses product converter, parser, detector, streaming renderer and ObjectStorageService PUT/HEAD", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-sample-product-"));
    const dxfPath = join(root, "sample.dxf");
    const svgPath = join(root, "sample.svg");
    const repeatedSvgPath = join(root, "sample-repeat.svg");
    let stored: PutObjectCommandInput | undefined;
    const client = { send: jest.fn(async (command: PutObjectCommand | HeadObjectCommand) => {
      if (command instanceof PutObjectCommand) {
        let bytes = 0;
        for await (const chunk of command.input.Body as AsyncIterable<Uint8Array>) bytes += chunk.byteLength;
        expect(bytes).toBe(command.input.ContentLength);
        stored = command.input;
        return {};
      }
      return { ContentLength: stored?.ContentLength, ContentType: stored?.ContentType,
        ContentEncoding: stored?.ContentEncoding, ChecksumSHA256: stored?.ChecksumSHA256, Metadata: stored?.Metadata };
    }) };
    try {
      const converter = new ArgvCadConverter({
        executable: converterPath!, argv: ["-O", "DXF", "-o", "{output}", "{input}"], timeoutMs: 60_000,
        maxOutputBytes: 256 * 1024 * 1024,
        execution: { mode: "macos-development-polling", acknowledgeNonProductionRisk: true }
      });
      await converter.convert({ inputPath: sample!, outputPath: dxfPath });
      const dxf = await stat(dxfPath);
      const rssStarted = process.memoryUsage().rss;
      const startedAt = performance.now();
      const document = await parseAsciiDxfStream(createReadStream(dxfPath));
      const parsedAt = performance.now();
      const detector = new RuleBasedLightingSymbolDetector(SITE_DRAWING_20260803_PROFILE);
      const candidates = await detector.detect(document);
      const detectedAt = performance.now();
      const rendered = await renderCadDocumentSvgFile(document, svgPath, { maxRenderedEntities: 1_000_000, maxBlockDepth: 32 });
      const renderedAt = performance.now();
      const repeated = await renderCadDocumentSvgFile(document, repeatedSvgPath, { maxRenderedEntities: 1_000_000, maxBlockDepth: 32 });
      expect(repeated).toEqual(rendered);
      const storage = new ObjectStorageService(client as never, { bucket: "floor-assets", publicBaseUrl: "" });
      const objectKey = "floors/sample/sample.svg";
      await storage.putFloorRenderedObjectFile(objectKey, svgPath, rendered, rendered.viewport);
      await storage.verifyFloorRenderedObject(objectKey, {
        sizeBytes: rendered.sizeBytes, sha256: rendered.sha256, mimeType: "image/svg+xml", contentEncoding: "gzip", ...rendered.viewport
      });
      expect(document.entities).toHaveLength(26_389);
      expect(candidates.length).toBeGreaterThanOrEqual(1_302);
      expect(candidates.length).toBeLessThanOrEqual(1_308);
      expect(rendered.sizeBytes).toBeLessThanOrEqual(CAD_RENDERED_SVG_MAX_BYTES);
      expect(candidates[0]).toMatchObject({ blockName: "몰드바등", profileVersion: detector.profileVersion, profileDigest: detector.profileDigest });
      process.stdout.write(`${JSON.stringify({ dxfBytes: dxf.size, modelSupportedEntities: document.entities.length,
        blocks: document.blocks.length, candidates: candidates.length, svgBytes: rendered.sizeBytes, rawSvgBytes: rendered.rawSizeBytes,
        observedRssBytes: process.memoryUsage().rss, rssGrowthBytes: process.memoryUsage().rss - rssStarted,
        parseMs: Math.round(parsedAt - startedAt), detectMs: Math.round(detectedAt - parsedAt),
        renderMs: Math.round(renderedAt - detectedAt), profileVersion: detector.profileVersion,
        profileDigest: detector.profileDigest })}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
