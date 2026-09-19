import { fork } from "node:child_process";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import {
  CAD_MAP_EXTREME_MIN_SHORT_SIDE,
  CAD_MAP_MAX_LONG_SIDE,
  type CadBounds,
  type CadSceneTransform
} from "@led-control/shared";
import type { CadImportDetectorProfileId } from "./lighting-detector-registry";
import type { CadSvgFileResult } from "./cad-svg-renderer";
import type { CadCandidateSvgTransformMatch } from "./cad-viewport";
import {
  CAD_MAX_DETECTED_REGIONS,
  type CadCandidateRegionAssignment,
  type CadDetectedRegion
} from "./cad-region-detector";
import {
  candidateRegionDigestsEqual,
  computeCandidateRegionDigests,
  normalizeCadCandidateIdentity,
  type CadCandidateRegionDigestMap
} from "./cad-candidate-region-digest";
import { CAD_RENDERED_SVG_RAW_MAX_BYTES } from "./cad-resource-limits";
import { canonicalArtifactSchema, type CadCanonicalArtifact } from "./cad-canonical-spool";
import {
  CAD_CGROUP_MEMORY_BYTES,
  CAD_CORE_MAX_OLD_SPACE_MB,
  CAD_CORE_RESPONSE_MAX_BYTES,
  CAD_MAX_PARSED_ENTITIES,
  CAD_MAX_UNSUPPORTED_ENTITY_TYPE_BYTES,
  CAD_MAX_UNSUPPORTED_ENTITY_TYPES
} from "./cad-runtime-contract";

export { CAD_CORE_MAX_OLD_SPACE_MB, CAD_CORE_RESPONSE_MAX_BYTES } from "./cad-runtime-contract";
export const CAD_CORE_WALL_TIMEOUT_MS = 60_000;
const MAX_CHILD_ERROR_BYTES = 64 * 1024;
const MAX_CANDIDATES = 2_000;
const MAX_RENDERED_BYTES = 8 * 1024 * 1024;

export interface CadCoreRequest {
  dxfPath: string;
  renderedPath: string;
  profileId: CadImportDetectorProfileId;
  artifactDirectory?: string;
  jobId?: string;
  selectedRegionId?: string | null;
  expectedCandidateRegionDigests?: CadCandidateRegionDigestMap;
  abortSignal?: AbortSignal;
}

export interface CadCoreCandidate {
  sourceEntityId: string;
  layerName: string;
  blockName: string;
  x: number;
  y: number;
  rotation: number;
  confidence: number;
  method: "rule" | "ai";
  provider?: string;
  model?: string;
  inputDigest?: string;
  sourcePosition?: { x: number; y: number };
}

export interface CadCoreResult {
  profileId: CadImportDetectorProfileId;
  profileVersion: string;
  profileDigest: string;
  modelEntityCount: number;
  blockCount: number;
  candidates: CadCoreCandidate[];
  selectedCandidates?: CadCoreCandidate[];
  candidateRegionAssignments?: CadCandidateRegionAssignment[];
  excludedRegionPrimitiveCount: number;
  regions: CadDetectedRegion[];
  candidateTransformMatch: CadCandidateSvgTransformMatch;
  rendered: CadSvgFileResult;
  regionPreviews?: CadCoreRegionPreviewArtifact[];
  scene?: CadCoreSceneArtifact | null;
  canonical?: CadCanonicalArtifact;
  observedMaxRssBytes?: number;
}

export interface CadCoreRegionPreviewArtifact {
  regionId: string;
  assetId: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  viewport: { width: number; height: number };
}

export interface CadCoreSceneArtifact {
  sceneId: string;
  manifestAssetId: string;
  manifestFilename: string;
  manifestByteSize: number;
  manifestSha256: string;
  width: number;
  height: number;
  sourceBounds: CadBounds;
  transform: CadSceneTransform;
}

export interface CadCoreExecutor {
  execute(request: CadCoreRequest): Promise<CadCoreResult>;
}

interface ChildProcessCadCoreOptions {
  entryPath?: string;
  maxOldSpaceMb?: number;
  timeoutMs?: number;
  forkProcess?: typeof fork;
}

type ChildResponse = { ok: true; result: CadCoreResult } | { ok: false; code: string };

export class ChildProcessCadCoreExecutor implements CadCoreExecutor {
  private readonly entryPath: string;
  private readonly maxOldSpaceMb: number;
  private readonly timeoutMs: number;
  private readonly forkProcess: typeof fork;

  constructor(options: ChildProcessCadCoreOptions = {}) {
    this.entryPath = options.entryPath ?? join(__dirname, "cad-core-child.js");
    this.maxOldSpaceMb = options.maxOldSpaceMb ?? configuredHeap();
    this.timeoutMs = options.timeoutMs ?? CAD_CORE_WALL_TIMEOUT_MS;
    this.forkProcess = options.forkProcess ?? fork;
    if (!Number.isSafeInteger(this.maxOldSpaceMb) || this.maxOldSpaceMb < 16 || this.maxOldSpaceMb > CAD_CORE_MAX_OLD_SPACE_MB) {
      throw new Error("Invalid CAD core child heap limit");
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > CAD_CORE_WALL_TIMEOUT_MS) {
      throw new Error("Invalid CAD core child wall limit");
    }
  }

  execute(request: CadCoreRequest): Promise<CadCoreResult> {
    return new Promise((resolve, reject) => {
      const child = this.forkProcess(this.entryPath, [], {
        execArgv: [`--max-old-space-size=${this.maxOldSpaceMb}`],
        serialization: "advanced",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { PATH: process.env.PATH, NODE_ENV: "production" }
      });
      let settled = false;
      let stderrBytes = 0;
      let responseBytes = 0;
      let validResult: CadCoreResult | undefined;
      let exitedSuccessfully = false;
      const responseChunks: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_CHILD_ERROR_BYTES) {
          finish(new Error("CAD core child stderr byte limit exceeded"));
        }
      });
      const finish = (error?: Error, result?: CadCoreResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.abortSignal?.removeEventListener("abort", abort);
        if (child.connected) child.disconnect();
        if (!child.killed) child.kill("SIGKILL");
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(new Error("CAD core child process aborted"));
      const finishSuccessWhenComplete = () => {
        if (validResult && exitedSuccessfully) finish(undefined, validResult);
      };
      const timer = setTimeout(() => finish(new Error("CAD core child process wall time limit exceeded")), this.timeoutMs);
      timer.unref();
      request.abortSignal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => finish(new Error("CAD core child process failed")));
      child.once("close", (code, signal) => {
        if (settled) return;
        if (signal || code !== 0) {
          finish(new Error(`CAD core child process failed (${signal ?? code ?? "unknown"})`));
          return;
        }
        exitedSuccessfully = true;
        finishSuccessWhenComplete();
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        responseBytes += chunk.length;
        if (responseBytes > CAD_CORE_RESPONSE_MAX_BYTES) {
          finish(new Error("CAD core child response byte limit exceeded"));
          return;
        }
        responseChunks.push(chunk);
      });
      child.stdout?.once("end", () => {
        if (settled) return;
        let message: ChildResponse;
        try {
          message = JSON.parse(Buffer.concat(responseChunks, responseBytes).toString("utf8")) as ChildResponse;
        } catch {
          finish(new Error("CAD core child process returned an invalid response"));
          return;
        }
        if (!message || typeof message !== "object" || !("ok" in message)) {
          finish(new Error("CAD core child process returned an invalid response"));
        } else if (!message.ok) {
          finish(new Error(`CAD core child process failed: ${message.code}`));
        } else {
          try {
            assertCoreManifest(message.result, request.profileId);
            assertCoreArtifactContract(message.result, request);
            validResult = message.result;
            finishSuccessWhenComplete();
          } catch {
            finish(new Error("CAD core child process returned an invalid bounded manifest"));
          }
        }
      });
      if (request.abortSignal?.aborted) {
        finish(new Error("CAD core child process aborted"));
        return;
      }
      child.send({
        dxfPath: request.dxfPath,
        renderedPath: request.renderedPath,
        profileId: request.profileId,
        ...(request.artifactDirectory ? { artifactDirectory: request.artifactDirectory } : {}),
        ...(request.jobId ? { jobId: request.jobId } : {}),
        ...(request.selectedRegionId !== undefined ? { selectedRegionId: request.selectedRegionId } : {})
      }, error => { if (error) finish(new Error("CAD core child process IPC failed")); });
    });
  }
}

export function encodeCadCoreResponse(
  response: ChildResponse,
  requestedProfileId: CadImportDetectorProfileId
): Buffer {
  if (response.ok) assertCoreManifest(response.result, requestedProfileId);
  const encoded = Buffer.from(JSON.stringify(response), "utf8");
  if (encoded.length > CAD_CORE_RESPONSE_MAX_BYTES) throw new Error("CAD core child response byte limit exceeded");
  return encoded;
}

export function assertCoreManifest(result: CadCoreResult, requestedProfileId: CadImportDetectorProfileId): void {
  if (!result || result.profileId !== requestedProfileId || typeof result.profileVersion !== "string" ||
      utf8Length(result.profileVersion) < 1 || utf8Length(result.profileVersion) > 128 ||
      !/^[a-f0-9]{64}$/.test(result.profileDigest) || !Number.isSafeInteger(result.modelEntityCount) ||
      result.modelEntityCount < 0 || result.modelEntityCount > CAD_MAX_PARSED_ENTITIES ||
      !Number.isSafeInteger(result.blockCount) || result.blockCount < 0 || result.blockCount > 100_000 ||
      !Array.isArray(result.candidates)) throw new Error("invalid core manifest");
  assertCandidateList(result.candidates);
  if (!Number.isSafeInteger(result.excludedRegionPrimitiveCount) || result.excludedRegionPrimitiveCount < 0 ||
      result.excludedRegionPrimitiveCount > CAD_MAX_PARSED_ENTITIES ||
      !Array.isArray(result.regions) || result.regions.length > CAD_MAX_DETECTED_REGIONS) {
    throw new Error("invalid core manifest");
  }
  const regionIds = new Set<string>();
  let regionPrimitiveCount = 0;
  let regionLightCandidateCount = 0;
  for (const region of result.regions) {
    const bounds = region?.bounds;
    if (!region || !/^region-[a-f0-9]{24}$/.test(region.regionId) || regionIds.has(region.regionId) ||
        !bounds || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY) ||
        !Number.isFinite(bounds.maxX) || !Number.isFinite(bounds.maxY) ||
        bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY ||
        !Number.isSafeInteger(region.primitiveCount) || region.primitiveCount < 1 ||
        region.primitiveCount > CAD_MAX_PARSED_ENTITIES ||
        !Number.isSafeInteger(region.textCount) || region.textCount < 0 || region.textCount > region.primitiveCount ||
        !Number.isSafeInteger(region.lightCandidateCount) || region.lightCandidateCount < 0 ||
        region.lightCandidateCount > region.primitiveCount || !Number.isFinite(region.area) || region.area <= 0) {
      throw new Error("invalid core manifest");
    }
    const computedArea = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
    if (Math.abs(region.area - computedArea) > Math.max(1, computedArea) * 1e-9) {
      throw new Error("invalid core manifest");
    }
    regionIds.add(region.regionId);
    regionPrimitiveCount += region.primitiveCount;
    regionLightCandidateCount += region.lightCandidateCount;
    if (!Number.isSafeInteger(regionPrimitiveCount) || regionPrimitiveCount > CAD_MAX_PARSED_ENTITIES) {
      throw new Error("invalid core manifest");
    }
    if (!Number.isSafeInteger(regionLightCandidateCount) || regionLightCandidateCount > MAX_CANDIDATES) {
      throw new Error("invalid core manifest");
    }
  }
  const transform = result.candidateTransformMatch;
  if (!transform || transform.candidateCount !== result.candidates.length ||
      transform.matchedCount !== transform.candidateCount ||
      transform.matchRate !== (transform.candidateCount === 0 ? null : 1) ||
      transform.tolerancePx !== 0.01 || !Number.isFinite(transform.maxDeltaPx) ||
      transform.maxDeltaPx < 0 || transform.maxDeltaPx > transform.tolerancePx) {
    throw new Error("invalid core manifest");
  }
  const rendered = result.rendered;
  if (!rendered || !Number.isSafeInteger(rendered.sizeBytes) || rendered.sizeBytes < 1 ||
      rendered.sizeBytes > MAX_RENDERED_BYTES || !Number.isSafeInteger(rendered.rawSizeBytes) || rendered.rawSizeBytes < 1 ||
      rendered.rawSizeBytes > CAD_RENDERED_SVG_RAW_MAX_BYTES ||
      !/^[a-f0-9]{64}$/.test(rendered.sha256) || rendered.contentEncoding !== "gzip" ||
      !Number.isSafeInteger(rendered.viewport?.width) || rendered.viewport.width < 1 ||
      rendered.viewport.width > 2_400 || !Number.isSafeInteger(rendered.viewport?.height) || rendered.viewport.height < 1 ||
      rendered.viewport.height > 1_600 || !Number.isSafeInteger(rendered.renderedOccurrences) || rendered.renderedOccurrences < 0 ||
      rendered.renderedOccurrences > CAD_MAX_PARSED_ENTITIES ||
      !Number.isSafeInteger(rendered.excludedEntityCount) || rendered.excludedEntityCount! < 0 ||
      rendered.excludedEntityCount! > CAD_MAX_PARSED_ENTITIES) throw new Error("invalid core manifest");
  const accountedRegionPrimitives = regionPrimitiveCount + result.excludedRegionPrimitiveCount;
  if (!Number.isSafeInteger(accountedRegionPrimitives) || accountedRegionPrimitives !== rendered.renderedOccurrences ||
      regionLightCandidateCount !== result.candidates.length) {
    throw new Error("invalid core manifest");
  }
  for (const candidate of result.candidates) {
    if (candidate.x > rendered.viewport.width || candidate.y > rendered.viewport.height) throw new Error("invalid core manifest");
  }
  const unsupported = rendered.unsupportedEntityCounts;
  if (!unsupported || typeof unsupported !== "object" || Array.isArray(unsupported)) throw new Error("invalid core manifest");
  const unsupportedEntries = Object.entries(unsupported);
  if (unsupportedEntries.length > CAD_MAX_UNSUPPORTED_ENTITY_TYPES) throw new Error("invalid core manifest");
  let unsupportedOccurrences = 0;
  for (const [type, count] of unsupportedEntries) {
    if (utf8Length(type) < 1 || utf8Length(type) > CAD_MAX_UNSUPPORTED_ENTITY_TYPE_BYTES ||
        type !== type.trim().toUpperCase() || !/^[A-Z0-9_$-]+$/.test(type) ||
        !Number.isSafeInteger(count) || count < 1) throw new Error("invalid core manifest");
    unsupportedOccurrences += count;
    if (!Number.isSafeInteger(unsupportedOccurrences) || unsupportedOccurrences > CAD_MAX_PARSED_ENTITIES) {
      throw new Error("invalid core manifest");
    }
  }
  if (result.observedMaxRssBytes !== undefined &&
      (!Number.isSafeInteger(result.observedMaxRssBytes) || result.observedMaxRssBytes < 1 ||
       result.observedMaxRssBytes > CAD_CGROUP_MEMORY_BYTES)) throw new Error("invalid core manifest");
}

function assertCoreArtifactContract(result: CadCoreResult, request: CadCoreRequest): void {
  if (!request.artifactDirectory && !request.jobId) return;
  if (!request.artifactDirectory || !request.jobId || !Array.isArray(result.regionPreviews)) {
    throw new Error("invalid core artifact manifest");
  }
  if (request.selectedRegionId && !request.expectedCandidateRegionDigests) {
    throw new Error("invalid core artifact manifest");
  }
  const selectedRegionId = request.selectedRegionId ?? (result.regions.length === 1 ? result.regions[0]?.regionId : null);
  if (request.selectedRegionId && !result.regions.some(region => region.regionId === request.selectedRegionId)) {
    throw new Error("invalid core artifact manifest");
  }
  const expectedPreviewCount = request.selectedRegionId ? 0 : result.regions.length;
  if (result.regionPreviews.length !== expectedPreviewCount ||
      new Set(result.regionPreviews.map(preview => preview.regionId)).size !== result.regionPreviews.length) {
    throw new Error("invalid core artifact manifest");
  }
  for (const preview of result.regionPreviews) {
    if (!result.regions.some(region => region.regionId === preview.regionId) ||
        !uuid(preview.assetId) || preview.filename !== `${preview.assetId}.svg` ||
        !Number.isSafeInteger(preview.sizeBytes) || preview.sizeBytes < 1 ||
        !/^[a-f0-9]{64}$/.test(preview.sha256) ||
        !Number.isSafeInteger(preview.viewport.width) || preview.viewport.width < 1 || preview.viewport.width > 2_400 ||
        !Number.isSafeInteger(preview.viewport.height) || preview.viewport.height < 1 || preview.viewport.height > 1_600) {
      throw new Error("invalid core artifact manifest");
    }
  }
  if (selectedRegionId === null) {
    if (result.scene !== null || result.selectedCandidates !== undefined || result.canonical !== undefined) {
      throw new Error("invalid core artifact manifest");
    }
    return;
  }
  canonicalArtifactSchema.parse(result.canonical);
  const selectedRegion = result.regions.find(region => region.regionId === selectedRegionId);
  const sourceBounds = result.scene?.sourceBounds;
  const transform = result.scene?.transform;
  if (!result.scene || !uuid(result.scene.sceneId) || !uuid(result.scene.manifestAssetId) ||
      result.scene.manifestFilename !== `${result.scene.manifestAssetId}.json` ||
      !Number.isSafeInteger(result.scene.manifestByteSize) || result.scene.manifestByteSize < 1 ||
      !/^[a-f0-9]{64}$/.test(result.scene.manifestSha256) ||
      !Number.isSafeInteger(result.scene.width) || result.scene.width < CAD_MAP_EXTREME_MIN_SHORT_SIDE ||
      result.scene.width > CAD_MAP_MAX_LONG_SIDE ||
      !Number.isSafeInteger(result.scene.height) || result.scene.height < CAD_MAP_EXTREME_MIN_SHORT_SIDE ||
      result.scene.height > CAD_MAP_MAX_LONG_SIDE || !Array.isArray(result.selectedCandidates) ||
      !selectedRegion || !sameBounds(sourceBounds, selectedRegion.bounds) || !validSceneTransform(transform) ||
      result.selectedCandidates.length !== selectedRegion.lightCandidateCount) {
    throw new Error("invalid core artifact manifest");
  }
  const selectedByIdentity = assertCandidateList(
    result.selectedCandidates,
    result.scene.width,
    result.scene.height
  );
  const detectedByIdentity = new Map(
    result.candidates.map(candidate => [candidateIdentity(candidate), candidate] as const)
  );
  const assignments = result.candidateRegionAssignments;
  if (!Array.isArray(assignments) || assignments.length !== result.candidates.length ||
      assignments.length > MAX_CANDIDATES) {
    throw new Error("invalid core artifact manifest");
  }
  const assignmentByIdentity = new Map<string, string>();
  const assignmentCounts = new Map<string, number>();
  const validRegionIds = new Set(result.regions.map(region => region.regionId));
  for (const assignment of assignments) {
    if (!assignment || typeof assignment.sourceEntityId !== "string" ||
        utf8Length(assignment.sourceEntityId) < 1 || utf8Length(assignment.sourceEntityId) > 512 ||
        typeof assignment.regionId !== "string" || !validRegionIds.has(assignment.regionId)) {
      throw new Error("invalid core artifact manifest");
    }
    const identity = normalizeCandidateIdentity(assignment.sourceEntityId);
    if (!detectedByIdentity.has(identity) || assignmentByIdentity.has(identity)) {
      throw new Error("invalid core artifact manifest");
    }
    assignmentByIdentity.set(identity, assignment.regionId);
    assignmentCounts.set(assignment.regionId, (assignmentCounts.get(assignment.regionId) ?? 0) + 1);
  }
  if (result.regions.some(region => (assignmentCounts.get(region.regionId) ?? 0) !== region.lightCandidateCount)) {
    throw new Error("invalid core artifact manifest");
  }
  if (request.expectedCandidateRegionDigests) {
    const actualDigests = computeCandidateRegionDigests(
      result.regions.map(region => region.regionId),
      assignments
    );
    if (!candidateRegionDigestsEqual(actualDigests, request.expectedCandidateRegionDigests)) {
      throw new Error("invalid core artifact manifest");
    }
  }
  const expectedSelectedIdentities = new Set<string>();
  for (const detected of result.candidates) {
    const source = detected.sourcePosition;
    if (!source || !Number.isFinite(source.x) || !Number.isFinite(source.y)) {
      throw new Error("invalid core artifact manifest");
    }
    const identity = candidateIdentity(detected);
    const assignedRegionId = assignmentByIdentity.get(identity);
    if (!assignedRegionId) throw new Error("invalid core artifact manifest");
    if (assignedRegionId === selectedRegionId) {
      expectedSelectedIdentities.add(candidateIdentity(detected));
    }
  }
  if (expectedSelectedIdentities.size !== selectedRegion.lightCandidateCount ||
      selectedByIdentity.size !== expectedSelectedIdentities.size) {
    throw new Error("invalid core artifact manifest");
  }
  for (const [identity, selected] of selectedByIdentity) {
    const detected = detectedByIdentity.get(identity);
    if (!detected || !expectedSelectedIdentities.has(identity) ||
        !sameCandidateDetection(selected, detected) ||
        !matchesSceneTransform(selected, detected.sourcePosition!, transform!)) {
      throw new Error("invalid core artifact manifest");
    }
  }
}

function assertCandidateList(
  candidates: CadCoreCandidate[],
  maxX?: number,
  maxY?: number
): Map<string, CadCoreCandidate> {
  if (candidates.length > MAX_CANDIDATES) throw new Error("invalid core manifest");
  const identities = new Map<string, CadCoreCandidate>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.sourceEntityId !== "string" || utf8Length(candidate.sourceEntityId) < 1 ||
        utf8Length(candidate.sourceEntityId) > 512 || typeof candidate.layerName !== "string" ||
        utf8Length(candidate.layerName) < 1 || utf8Length(candidate.layerName) > 512 || typeof candidate.blockName !== "string" ||
        utf8Length(candidate.blockName) > 512 || !Number.isFinite(candidate.x) || candidate.x < 0 ||
        (maxX !== undefined && candidate.x > maxX) || !Number.isFinite(candidate.y) || candidate.y < 0 ||
        (maxY !== undefined && candidate.y > maxY) || !Number.isFinite(candidate.rotation) ||
        !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1 ||
        (candidate.method !== "rule" && candidate.method !== "ai")) throw new Error("invalid core manifest");
    const identity = candidateIdentity(candidate);
    if (identities.has(identity)) throw new Error("invalid core manifest");
    identities.set(identity, candidate);
    if (candidate.method === "ai" && (!candidate.provider || !candidate.model || !candidate.inputDigest)) {
      throw new Error("invalid core manifest");
    }
    if (candidate.method === "rule" && (candidate.provider || candidate.model || candidate.inputDigest)) {
      throw new Error("invalid core manifest");
    }
    if (candidate.provider && utf8Length(candidate.provider) > 128 ||
        candidate.model && utf8Length(candidate.model) > 128) throw new Error("invalid core manifest");
    if (candidate.inputDigest && !/^[a-f0-9]{64}$/.test(candidate.inputDigest)) throw new Error("invalid core manifest");
  }
  return identities;
}

function candidateIdentity(candidate: CadCoreCandidate): string {
  return normalizeCandidateIdentity(candidate.sourceEntityId);
}

function normalizeCandidateIdentity(value: string): string {
  return normalizeCadCandidateIdentity(value);
}

function sameCandidateDetection(selected: CadCoreCandidate, detected: CadCoreCandidate): boolean {
  return selected.layerName === detected.layerName &&
    selected.blockName === detected.blockName &&
    selected.confidence === detected.confidence &&
    selected.rotation === detected.rotation &&
    selected.method === detected.method &&
    selected.provider === detected.provider &&
    selected.model === detected.model &&
    selected.inputDigest === detected.inputDigest;
}

function sameBounds(actual: CadBounds | undefined, expected: CadBounds): boolean {
  return Boolean(actual) && actual!.minX === expected.minX && actual!.minY === expected.minY &&
    actual!.maxX === expected.maxX && actual!.maxY === expected.maxY;
}

function validSceneTransform(value: CadSceneTransform | undefined): boolean {
  return Boolean(value) && Number.isFinite(value!.scaleX) && value!.scaleX > 0 &&
    Number.isFinite(value!.scaleY) && value!.scaleY !== 0 &&
    Number.isFinite(value!.translateX) && Number.isFinite(value!.translateY);
}

function matchesSceneTransform(
  selected: CadCoreCandidate,
  source: { x: number; y: number },
  transform: CadSceneTransform
): boolean {
  const expectedX = source.x * transform.scaleX + transform.translateX;
  const expectedY = source.y * transform.scaleY + transform.translateY;
  return nearlyEqual(selected.x, expectedX) && nearlyEqual(selected.y, expectedY);
}

function nearlyEqual(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
}

function uuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function configuredHeap(): number {
  const value = process.env.CAD_CORE_MAX_OLD_SPACE_MB;
  if (value === undefined) return CAD_CORE_MAX_OLD_SPACE_MB;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Invalid CAD_CORE_MAX_OLD_SPACE_MB");
  return parsed;
}
