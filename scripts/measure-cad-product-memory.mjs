#!/usr/bin/env node

import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [sampleArg, converterArg] = process.argv.slice(2);
if (!sampleArg || !converterArg) {
  process.stderr.write("Usage: node scripts/measure-cad-product-memory.mjs <sample.dwg> <absolute-converter>\n");
  process.exitCode = 2;
} else {
  const require = createRequire(import.meta.url);
  const { ArgvCadConverter } = require("../apps/api/dist/src/floor-import/cad-converter.js");
  const { parseAsciiDxfStream } = require("../apps/api/dist/src/floor-import/dxf-document-parser.js");
  const { renderCadDocumentSvgFile } = require("../apps/api/dist/src/floor-import/cad-svg-renderer.js");
  const { RuleBasedLightingSymbolDetector, SITE_DRAWING_20260803_PROFILE } = require("../apps/api/dist/src/floor-import/rule-based-lighting-symbol-detector.js");
  const root = await mkdtemp(join(tmpdir(), "cad-memory-hil-"));
  try {
    const dxfPath = join(root, "sample.dxf");
    const svgPath = join(root, "sample.svg");
    const converter = new ArgvCadConverter({
      executable: resolve(converterArg), argv: ["-O", "DXF", "-o", "{output}", "{input}"], timeoutMs: 60_000,
      maxOutputBytes: 256 * 1024 * 1024,
      execution: { mode: "macos-development-polling", acknowledgeNonProductionRisk: true }
    });
    await converter.convert({ inputPath: resolve(sampleArg), outputPath: dxfPath });
    const document = await parseAsciiDxfStream(createReadStream(dxfPath));
    const detector = new RuleBasedLightingSymbolDetector(SITE_DRAWING_20260803_PROFILE);
    const candidates = await detector.detect(document);
    const rendered = await renderCadDocumentSvgFile(document, svgPath, { maxRenderedEntities: 1_000_000, maxBlockDepth: 32 });
    process.stdout.write(`${JSON.stringify({
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      candidates: candidates.length,
      rawSvgBytes: rendered.rawSizeBytes,
      storedSvgBytes: rendered.sizeBytes,
      profileVersion: detector.profileVersion,
      profileDigest: detector.profileDigest
    })}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
