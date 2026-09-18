import { createReadStream } from "node:fs";
import { CAD_RENDERED_SVG_MAX_BYTES, renderCadDocumentSvgFile } from "./cad-svg-renderer";
import { parseAsciiDxfStream } from "./dxf-document-parser";
import { DisabledAiLightingSymbolDetector } from "./disabled-ai-lighting-symbol-detector";
import { createCadViewport, measureCadCandidateSvgTransformMatch, projectCadPointToViewport } from "./cad-viewport";
import { FixedLightingDetectorRegistry, type CadImportDetectorProfileId } from "./lighting-detector-registry";
import { encodeCadCoreResponse, type CadCoreRequest, type CadCoreResult } from "./cad-core-executor";
import { detectCadRegions } from "./cad-region-detector";

const MAX_CANDIDATES = 2_000;
let accepted = false;

process.on("message", (request: Omit<CadCoreRequest, "abortSignal">) => {
  if (accepted) return;
  accepted = true;
  void execute(request).then(
    result => writeResponse(encodeCadCoreResponse({ ok: true, result }, request.profileId), 0),
    () => writeResponse(encodeCadCoreResponse({ ok: false, code: "CAD_CORE_FAILED" }, request.profileId), 1)
  );
});

function writeResponse(response: Buffer, exitCode: number): void {
  process.stdout.write(response, () => process.exit(exitCode));
}

async function execute(request: Omit<CadCoreRequest, "abortSignal">): Promise<CadCoreResult> {
  if (!request || typeof request.dxfPath !== "string" || typeof request.renderedPath !== "string") {
    throw new Error("Invalid CAD core request");
  }
  const registry = new FixedLightingDetectorRegistry();
  const rules = registry.get(request.profileId as CadImportDetectorProfileId);
  if (!rules.profileVersion || !rules.profileDigest || rules.profileId !== request.profileId) {
    throw new Error("CAD detector profile metadata mismatch");
  }
  const document = await parseAsciiDxfStream(createReadStream(request.dxfPath));
  const ruleCandidates = await rules.detect(document);
  const aiCandidates = await new DisabledAiLightingSymbolDetector().detect(document);
  const candidates = [...ruleCandidates, ...aiCandidates];
  if (candidates.length > MAX_CANDIDATES) throw new Error("CAD lighting candidate limit exceeded");
  if (new Set(candidates.map(candidate => candidate.sourceEntityId.normalize("NFKC").toUpperCase())).size !== candidates.length) {
    throw new Error("CAD lighting candidate identity collision");
  }
  const regionDetection = detectCadRegions(document, {
    maxExpandedEntities: 1_000_000,
    maxBlockDepth: 32,
    lightCandidates: candidates.map(candidate => ({
      sourceEntityId: candidate.sourceEntityId,
      position: candidate.position
    }))
  });
  const viewport = createCadViewport(document.bounds);
  const projected = candidates.map(candidate => {
    const point = projectCadPointToViewport(candidate.position, document.bounds);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 ||
        point.x > viewport.width || point.y > viewport.height) throw new Error("CAD lighting candidate falls outside the rendered viewport");
    if (candidate.method === "ai" && (!candidate.provider || !candidate.model || !candidate.inputDigest)) {
      throw new Error("AI-assisted CAD candidate is missing reproducibility metadata");
    }
    return {
      sourceEntityId: candidate.sourceEntityId,
      layerName: candidate.layerName,
      blockName: candidate.blockName,
      x: point.x,
      y: point.y,
      rotation: -candidate.rotation,
      confidence: candidate.confidence,
      method: candidate.method,
      ...(candidate.provider ? { provider: candidate.provider } : {}),
      ...(candidate.model ? { model: candidate.model } : {}),
      ...(candidate.inputDigest ? { inputDigest: candidate.inputDigest } : {})
    };
  });
  const rendered = await renderCadDocumentSvgFile(document, request.renderedPath, {
    maxOutputBytes: CAD_RENDERED_SVG_MAX_BYTES,
    maxRenderedEntities: 1_000_000,
    maxBlockDepth: 32
  });
  const usage = process.resourceUsage();
  return {
    profileId: request.profileId,
    profileVersion: rules.profileVersion,
    profileDigest: rules.profileDigest,
    modelEntityCount: document.entities.length,
    blockCount: document.blocks.length,
    candidates: projected,
    excludedRegionPrimitiveCount: regionDetection.excludedPrimitiveCount,
    regions: regionDetection.regions,
    candidateTransformMatch: measureCadCandidateSvgTransformMatch(
      candidates.map(candidate => candidate.position),
      document.bounds,
      0.01
    ),
    rendered,
    observedMaxRssBytes: usage.maxRSS * 1024
  };
}
