import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CAD_RENDERED_SVG_MAX_BYTES, renderCadDocumentSvgFile } from "./cad-svg-renderer";
import { parseAsciiDxfStream } from "./dxf-document-parser";
import { DisabledAiLightingSymbolDetector } from "./disabled-ai-lighting-symbol-detector";
import { createCadViewport, measureCadCandidateSvgTransformMatch, projectCadPointToViewport } from "./cad-viewport";
import { FixedLightingDetectorRegistry, type CadImportDetectorProfileId } from "./lighting-detector-registry";
import { encodeCadCoreResponse, type CadCoreRequest, type CadCoreResult } from "./cad-core-executor";
import { detectCadRegions } from "./cad-region-detector";
import { buildCadScene } from "./cad-scene-builder";
import { cadRegionPreviewPersistenceIdentity, cadScenePersistenceIdentity } from "./cad-scene-persistence";
import { renderCadRegionPreviewFiles } from "./cad-region-preview-renderer";

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
  const detectedCandidates = [...ruleCandidates, ...aiCandidates];
  if (detectedCandidates.length > MAX_CANDIDATES) throw new Error("CAD lighting candidate limit exceeded");
  if (new Set(detectedCandidates.map(candidate => candidate.sourceEntityId.normalize("NFKC").toUpperCase())).size !== detectedCandidates.length) {
    throw new Error("CAD lighting candidate identity collision");
  }
  const regionDetection = detectCadRegions(document, {
    maxExpandedEntities: 1_000_000,
    maxBlockDepth: 32,
    lightCandidates: detectedCandidates.map(candidate => ({
      sourceEntityId: candidate.sourceEntityId,
      position: candidate.position
    }))
  });
  const candidates = detectedCandidates.map(candidate => ({
    ...candidate,
    position: regionDetection.candidatePositions.get(candidate.sourceEntityId) ?? candidate.position
  }));
  const selectedRegion = request.selectedRegionId
    ? regionDetection.regions.find(region => region.regionId === request.selectedRegionId)
    : regionDetection.regions.length === 1 ? regionDetection.regions[0] : undefined;
  if (request.selectedRegionId && !selectedRegion) throw new Error("Selected CAD region no longer exists");
  if ((request.artifactDirectory === undefined) !== (request.jobId === undefined) ||
      request.artifactDirectory && (!isAbsolute(request.artifactDirectory) || !/^[a-f0-9-]{36}$/i.test(request.jobId!))) {
    throw new Error("Invalid CAD artifact request");
  }
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
      ...(candidate.inputDigest ? { inputDigest: candidate.inputDigest } : {}),
      sourcePosition: { x: candidate.position.x, y: candidate.position.y }
    };
  });
  // The fallback asset and `candidates` share the full-document viewport. Only
  // native scene geometry and selectedCandidates use the selected-region frame.
  const rendered = await renderCadDocumentSvgFile(document, request.renderedPath, {
    maxOutputBytes: CAD_RENDERED_SVG_MAX_BYTES,
    maxRenderedEntities: 1_000_000,
    maxBlockDepth: 32
  });
  const regionPreviews = [];
  if (request.artifactDirectory && request.jobId && !request.selectedRegionId) {
    const identities = new Map(regionDetection.regions.map(region => [
      region.regionId, cadRegionPreviewPersistenceIdentity(request.jobId!, region.regionId)
    ]));
    const batch = await renderCadRegionPreviewFiles(document, regionDetection.regions.map(region => ({
      regionId: region.regionId,
      bounds: region.bounds,
      outputPath: join(request.artifactDirectory!, `${identities.get(region.regionId)!.assetId}.svg`)
    })), { compactFallback: { path: request.renderedPath, bounds: document.bounds, rendered } });
    for (const preview of batch.previews) {
      const identity = identities.get(preview.regionId)!;
      const filename = `${identity.assetId}.svg`;
      regionPreviews.push({
        regionId: preview.regionId,
        assetId: identity.assetId,
        filename,
        sizeBytes: preview.sizeBytes,
        sha256: preview.sha256,
        viewport: preview.viewport
      });
    }
  }
  let scene = null;
  let selectedCandidates = undefined;
  if (selectedRegion && request.artifactDirectory && request.jobId) {
    const identity = cadScenePersistenceIdentity(request.jobId, selectedRegion.regionId);
    const built = buildCadScene(document, selectedRegion, {
      sceneId: identity.sceneId,
      manifestAssetId: identity.manifestAssetId,
      tileAssetId: identity.tileAssetId
    });
    const manifestFilename = `${identity.manifestAssetId}.json`;
    await writeFile(join(request.artifactDirectory, manifestFilename), built.manifestPayload, { flag: "wx", mode: 0o600 });
    for (const tile of built.tiles) {
      await writeFile(join(request.artifactDirectory, `${tile.descriptor.assetId}.bin`), tile.payload, { flag: "wx", mode: 0o600 });
    }
    scene = {
      sceneId: identity.sceneId,
      manifestAssetId: identity.manifestAssetId,
      manifestFilename,
      manifestByteSize: built.manifest.byteSize,
      manifestSha256: built.manifest.sha256,
      width: built.manifest.width,
      height: built.manifest.height,
      sourceBounds: { ...built.manifest.sourceBounds },
      transform: { ...built.manifest.transform }
    };
    const selectedCandidateIds = new Set(regionDetection.candidateRegionAssignments
      .filter(assignment => assignment.regionId === selectedRegion.regionId)
      .map(assignment => normalizeCandidateIdentity(assignment.sourceEntityId)));
    selectedCandidates = candidates
      .filter(candidate => selectedCandidateIds.has(normalizeCandidateIdentity(candidate.sourceEntityId)))
      .map(candidate => ({
        sourceEntityId: candidate.sourceEntityId,
        layerName: candidate.layerName,
        blockName: candidate.blockName,
        x: candidate.position.x * built.manifest.transform.scaleX + built.manifest.transform.translateX,
        y: candidate.position.y * built.manifest.transform.scaleY + built.manifest.transform.translateY,
        rotation: -candidate.rotation,
        confidence: candidate.confidence,
        method: candidate.method,
        ...(candidate.provider ? { provider: candidate.provider } : {}),
        ...(candidate.model ? { model: candidate.model } : {}),
        ...(candidate.inputDigest ? { inputDigest: candidate.inputDigest } : {})
      }));
  }
  const usage = process.resourceUsage();
  return {
    profileId: request.profileId,
    profileVersion: rules.profileVersion,
    profileDigest: rules.profileDigest,
    modelEntityCount: document.entities.length,
    blockCount: document.blocks.length,
    candidates: projected,
    selectedCandidates,
    candidateRegionAssignments: regionDetection.candidateRegionAssignments,
    excludedRegionPrimitiveCount: regionDetection.excludedPrimitiveCount,
    regions: regionDetection.regions,
    candidateTransformMatch: measureCadCandidateSvgTransformMatch(
      candidates.map(candidate => candidate.position),
      document.bounds,
      0.01
    ),
    rendered,
    regionPreviews,
    scene,
    observedMaxRssBytes: usage.maxRSS * 1024
  };
}

function normalizeCandidateIdentity(value: string) {
  return value.normalize("NFKC").toUpperCase();
}
