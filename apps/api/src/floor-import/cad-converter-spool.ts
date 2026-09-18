import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { CadConversionRequest, CadConversionResult, CadConverter } from "./cad-converter";

const READY_FILE = ".ready.json";
const POLL_INTERVAL_MS = 20;
const CANCELLATION_ACK_TIMEOUT_MS = 1_000;
export const SIDECAR_HEARTBEAT_TTL_MS = 2_000;

interface SpoolCadConverterOptions {
  spoolRoot: string;
  approvedDigest: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export class SpoolCadConverter implements CadConverter {
  constructor(private readonly options: SpoolCadConverterOptions) {
    if (!isAbsolute(options.spoolRoot) || !/^[a-f0-9]{64}$/.test(options.approvedDigest) ||
        !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
        !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
      throw new Error("invalid CAD converter sidecar configuration");
    }
  }

  async convert(request: CadConversionRequest): Promise<CadConversionResult> {
    if (!isAbsolute(request.inputPath) || !isAbsolute(request.outputPath) ||
        resolve(request.inputPath) === resolve(request.outputPath)) {
      throw new Error("CAD converter paths must be distinct absolute paths");
    }
    await this.assertReady();
    const jobDirectory = join(this.options.spoolRoot, `job-${randomUUID()}`);
    await mkdir(jobDirectory, { mode: 0o770 });
    await chmod(jobDirectory, 0o770);
    const input = join(jobDirectory, "input");
    const output = join(jobDirectory, "output");
    const response = join(jobDirectory, "response.json");
    const cancel = join(jobDirectory, "cancel");
    let requestPublished = false;
    let terminalResponseObserved = false;
    try {
      await copyFile(request.inputPath, input);
      await chmod(input, 0o640);
      await this.writeJsonAtomically(join(jobDirectory, "request.json"), { version: 1, input: "input", output: "output" });
      requestPublished = true;
      const deadline = Date.now() + this.options.timeoutMs;
      while (Date.now() < deadline) {
        if (request.abortSignal?.aborted) {
          throw new Error("CAD conversion aborted");
        }
        const result = await readJsonIfRegular(response);
        if (result) {
          terminalResponseObserved = true;
          if (result.version !== 1 || typeof result.ok !== "boolean") throw new Error("invalid CAD converter sidecar response");
          if (!result.ok) throw new Error(`CAD converter sidecar failed: ${safeError(result.error)}`);
          const identity = await lstat(output);
          if (!identity.isFile() || identity.isSymbolicLink() || identity.size < 1 || identity.size > this.options.maxOutputBytes ||
              result.outputBytes !== identity.size) {
            throw new Error("CAD converter sidecar output limit or identity check failed");
          }
          await unlink(request.outputPath).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
          await copyFile(output, request.outputPath);
          return { outputPath: request.outputPath, outputBytes: identity.size };
        }
        await this.assertReady();
        await delay(POLL_INTERVAL_MS);
      }
      throw new Error("CAD conversion sidecar time limit exceeded");
    } catch (error) {
      if (requestPublished && !terminalResponseObserved) {
        await signalCancellationAndWait(cancel, response, error instanceof Error && /time limit/i.test(error.message) ? "timeout" : "cancelled");
      }
      throw error;
    } finally {
      await rm(jobDirectory, { recursive: true, force: true });
    }
  }

  private async assertReady() {
    await probeCadConverterSpoolReadiness(this.options.spoolRoot, this.options.approvedDigest);
  }

  private async writeJsonAtomically(path: string, value: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o640, flag: "wx" });
    await rename(temporary, path);
  }
}

async function signalCancellationAndWait(cancelPath: string, responsePath: string, reason = "cancelled") {
  await writeFile(cancelPath, reason, { flag: "wx" }).catch(error => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") throw error;
  });
  const deadline = Date.now() + CANCELLATION_ACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await readJsonIfRegular(responsePath)) return;
    await delay(POLL_INTERVAL_MS);
  }
}

export async function probeCadConverterSpoolReadiness(spoolRoot: string, approvedDigest: string) {
  const ready = await readJsonIfRegular(join(spoolRoot, READY_FILE)).catch(() => null);
  const heartbeatAt = ready?.heartbeatAt;
  const heartbeatAge = typeof heartbeatAt === "number" ? Date.now() - heartbeatAt : Number.POSITIVE_INFINITY;
  if (!ready || ready.version !== 2 || ready.digest !== approvedDigest ||
      typeof ready.instanceId !== "string" || ready.instanceId.length < 1 || ready.instanceId.length > 128 ||
      !Number.isSafeInteger(heartbeatAt) || heartbeatAge < -1_000 || heartbeatAge > SIDECAR_HEARTBEAT_TTL_MS) {
    throw new Error("CAD converter sidecar is not ready or its approved digest does not match");
  }
}

async function readJsonIfRegular(path: string): Promise<Record<string, unknown> | null> {
  try {
    const identity = await lstat(path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.size > 4096) throw new Error("invalid spool control file");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid spool control file");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function safeError(value: unknown) {
  return typeof value === "string" && value.length <= 300 ? value : "conversion failed";
}

function delay(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
