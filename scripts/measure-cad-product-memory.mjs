#!/usr/bin/env node

import { createRequire } from "node:module";
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
  const { ChildProcessCadCoreExecutor } = require("../apps/api/dist/src/floor-import/cad-core-executor.js");
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
    const result = await new ChildProcessCadCoreExecutor().execute({
      dxfPath, renderedPath: svgPath, profileId: "site-drawing-20260803-v1"
    });
    process.stdout.write(`${JSON.stringify({
      parentMaxRssBytes: process.resourceUsage().maxRSS * 1024,
      childMaxRssBytes: result.observedMaxRssBytes,
      candidates: result.candidates.length,
      modelEntityCount: result.modelEntityCount,
      blockCount: result.blockCount,
      rawSvgBytes: result.rendered.rawSizeBytes,
      storedSvgBytes: result.rendered.sizeBytes,
      storedSvgSha256: result.rendered.sha256,
      profileVersion: result.profileVersion,
      profileDigest: result.profileDigest
    })}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
