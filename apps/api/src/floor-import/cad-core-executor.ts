import { fork } from "node:child_process";
import { join } from "node:path";
import type { CadImportDetectorProfileId } from "./lighting-detector-registry";
import type { CadSvgFileResult } from "./cad-svg-renderer";
import { CAD_CORE_MAX_OLD_SPACE_MB } from "./cad-runtime-contract";

export { CAD_CORE_MAX_OLD_SPACE_MB } from "./cad-runtime-contract";
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
}

type ChildResponse = { ok: true; result: CadCoreResult } | { ok: false; code: string };

export class ChildProcessCadCoreExecutor implements CadCoreExecutor {
  private readonly entryPath: string;
  private readonly maxOldSpaceMb: number;
  private readonly timeoutMs: number;

  constructor(options: ChildProcessCadCoreOptions = {}) {
    this.entryPath = options.entryPath ?? join(__dirname, "cad-core-child.js");
    this.maxOldSpaceMb = options.maxOldSpaceMb ?? configuredHeap();
    this.timeoutMs = options.timeoutMs ?? CAD_CORE_WALL_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.maxOldSpaceMb) || this.maxOldSpaceMb < 16 || this.maxOldSpaceMb > CAD_CORE_MAX_OLD_SPACE_MB) {
      throw new Error("Invalid CAD core child heap limit");
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > CAD_CORE_WALL_TIMEOUT_MS) {
      throw new Error("Invalid CAD core child wall limit");
    }
  }

  execute(request: CadCoreRequest): Promise<CadCoreResult> {
    return new Promise((resolve, reject) => {
      const child = fork(this.entryPath, [], {
        execArgv: [`--max-old-space-size=${this.maxOldSpaceMb}`],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { PATH: process.env.PATH, NODE_ENV: "production" }
      });
      let settled = false;
      let stderrBytes = 0;
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_CHILD_ERROR_BYTES) child.kill("SIGKILL");
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
      const timer = setTimeout(() => finish(new Error("CAD core child process wall time limit exceeded")), this.timeoutMs);
      timer.unref();
      request.abortSignal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => finish(new Error("CAD core child process failed")));
      child.once("exit", (code, signal) => {
        if (!settled) finish(new Error(`CAD core child process failed (${signal ?? code ?? "unknown"})`));
      });
      child.on("message", (message: ChildResponse) => {
        if (!message || typeof message !== "object" || !("ok" in message)) {
          finish(new Error("CAD core child process returned an invalid response"));
        } else if (!message.ok) {
          finish(new Error(`CAD core child process failed: ${message.code}`));
        } else {
          try {
            assertCoreManifest(message.result, request.profileId);
            finish(undefined, message.result);
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

function assertCoreManifest(result: CadCoreResult, requestedProfileId: CadImportDetectorProfileId): void {
  if (!result || result.profileId !== requestedProfileId || typeof result.profileVersion !== "string" ||
      result.profileVersion.length < 1 || result.profileVersion.length > 128 ||
      !/^[a-f0-9]{64}$/.test(result.profileDigest) || !Number.isSafeInteger(result.modelEntityCount) ||
      result.modelEntityCount < 0 || !Number.isSafeInteger(result.blockCount) || result.blockCount < 0 ||
      !Array.isArray(result.candidates) ||
      result.candidates.length > MAX_CANDIDATES) throw new Error("invalid core manifest");
  const identities = new Set<string>();
  for (const candidate of result.candidates) {
    if (!candidate || typeof candidate.sourceEntityId !== "string" || candidate.sourceEntityId.length < 1 ||
        candidate.sourceEntityId.length > 512 || typeof candidate.layerName !== "string" ||
        candidate.layerName.length < 1 || candidate.layerName.length > 512 || typeof candidate.blockName !== "string" ||
        candidate.blockName.length > 512 || !Number.isFinite(candidate.x) || candidate.x < 0 ||
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
    if (candidate.inputDigest && !/^[a-f0-9]{64}$/.test(candidate.inputDigest)) throw new Error("invalid core manifest");
  }
  const rendered = result.rendered;
  if (!rendered || !Number.isSafeInteger(rendered.sizeBytes) || rendered.sizeBytes < 1 ||
      rendered.sizeBytes > MAX_RENDERED_BYTES || !Number.isSafeInteger(rendered.rawSizeBytes) || rendered.rawSizeBytes < 1 ||
      !/^[a-f0-9]{64}$/.test(rendered.sha256) || rendered.contentEncoding !== "gzip" ||
      !Number.isSafeInteger(rendered.viewport?.width) || rendered.viewport.width < 1 ||
      !Number.isSafeInteger(rendered.viewport?.height) || rendered.viewport.height < 1) throw new Error("invalid core manifest");
}

function configuredHeap(): number {
  const value = process.env.CAD_CORE_MAX_OLD_SPACE_MB;
  if (value === undefined) return CAD_CORE_MAX_OLD_SPACE_MB;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Invalid CAD_CORE_MAX_OLD_SPACE_MB");
  return parsed;
}
