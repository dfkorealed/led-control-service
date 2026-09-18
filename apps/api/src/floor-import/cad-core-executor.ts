import { fork } from "node:child_process";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import type { CadImportDetectorProfileId } from "./lighting-detector-registry";
import type { CadSvgFileResult } from "./cad-svg-renderer";
import type { CadCandidateSvgTransformMatch } from "./cad-viewport";
import { CAD_RENDERED_SVG_RAW_MAX_BYTES } from "./cad-resource-limits";
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
}

export interface CadCoreResult {
  profileId: CadImportDetectorProfileId;
  profileVersion: string;
  profileDigest: string;
  modelEntityCount: number;
  blockCount: number;
  candidates: CadCoreCandidate[];
  candidateTransformMatch: CadCandidateSvgTransformMatch;
  rendered: CadSvgFileResult;
  observedMaxRssBytes?: number;
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
        profileId: request.profileId
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
      !Array.isArray(result.candidates) ||
      result.candidates.length > MAX_CANDIDATES) throw new Error("invalid core manifest");
  const identities = new Set<string>();
  for (const candidate of result.candidates) {
    if (!candidate || typeof candidate.sourceEntityId !== "string" || utf8Length(candidate.sourceEntityId) < 1 ||
        utf8Length(candidate.sourceEntityId) > 512 || typeof candidate.layerName !== "string" ||
        utf8Length(candidate.layerName) < 1 || utf8Length(candidate.layerName) > 512 || typeof candidate.blockName !== "string" ||
        utf8Length(candidate.blockName) > 512 || !Number.isFinite(candidate.x) || candidate.x < 0 ||
        !Number.isFinite(candidate.y) || candidate.y < 0 || !Number.isFinite(candidate.rotation) ||
        !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1 ||
        (candidate.method !== "rule" && candidate.method !== "ai")) throw new Error("invalid core manifest");
    const identity = candidate.sourceEntityId.normalize("NFKC").toUpperCase();
    if (identities.has(identity)) throw new Error("invalid core manifest");
    identities.add(identity);
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
