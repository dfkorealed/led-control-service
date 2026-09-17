import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { ArgvCadConverter, type CadConverter } from "./cad-converter";

const READY_FILE = ".ready.json";

export async function attestCadConverterExecutable(executable: string, approvedDigest: string) {
  try {
    if (!isAbsolute(executable) || !/^[a-f0-9]{64}$/.test(approvedDigest)) throw new Error("invalid path or digest");
    const identity = await lstat(executable);
    if (!identity.isFile() || identity.isSymbolicLink() || (identity.mode & 0o111) === 0 ||
        (identity.mode & 0o022) !== 0 || (identity.mode & 0o100) === 0) {
      throw new Error("converter executable mode or file identity is not approved");
    }
    const digest = createHash("sha256").update(await readFile(executable)).digest("hex");
    if (digest !== approvedDigest) throw new Error("converter executable digest mismatch");
    return { digest, uid: identity.uid, mode: identity.mode & 0o777 };
  } catch (error) {
    throw new Error(`CAD converter executable attestation failed: ${(error as Error).message}`);
  }
}

export async function processCadSidecarJob(
  jobDirectory: string,
  dependencies: { approvedDigest: string; executable: string; converter: CadConverter }
) {
  await attestCadConverterExecutable(dependencies.executable, dependencies.approvedDigest);
  const request = JSON.parse(await readFile(join(jobDirectory, "request.json"), "utf8")) as Record<string, unknown>;
  if (request.version !== 1 || request.input !== "input" || request.output !== "output") {
    throw new Error("invalid CAD sidecar job request");
  }
  const abort = new AbortController();
  const cancelPoller = setInterval(() => {
    void lstat(join(jobDirectory, "cancel")).then(() => abort.abort(), () => undefined);
  }, 20);
  try {
    const result = await dependencies.converter.convert({
      inputPath: join(jobDirectory, "input"),
      outputPath: join(jobDirectory, "output"),
      abortSignal: abort.signal
    });
    await writeResponse(jobDirectory, { version: 1, ok: true, outputBytes: result.outputBytes });
  } catch (error) {
    await writeResponse(jobDirectory, { version: 1, ok: false, error: boundedError(error) });
  } finally {
    clearInterval(cancelPoller);
  }
}

export async function runCadConverterSidecar(env: NodeJS.ProcessEnv = process.env): Promise<never> {
  const spoolRoot = requiredAbsolute(env.CAD_IMPORT_CONVERTER_SPOOL_ROOT, "CAD_IMPORT_CONVERTER_SPOOL_ROOT");
  const executable = requiredAbsolute(env.CAD_IMPORT_CONVERTER_EXECUTABLE, "CAD_IMPORT_CONVERTER_EXECUTABLE");
  const approvedDigest = env.CAD_IMPORT_CONVERTER_SHA256 ?? "";
  let argv: unknown;
  try { argv = JSON.parse(env.CAD_IMPORT_CONVERTER_ARGV_JSON ?? ""); }
  catch { throw new Error("CAD_IMPORT_CONVERTER_ARGV_JSON must be a JSON string array"); }
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string")) {
    throw new Error("CAD_IMPORT_CONVERTER_ARGV_JSON must be a JSON string array");
  }
  const timeoutMs = positiveInteger(env.CAD_IMPORT_CONVERTER_TIMEOUT_MS, 60_000, "CAD_IMPORT_CONVERTER_TIMEOUT_MS");
  const maxOutputBytes = positiveInteger(env.CAD_IMPORT_MAX_DXF_BYTES, 256 * 1024 * 1024, "CAD_IMPORT_MAX_DXF_BYTES");
  const spool = await lstat(spoolRoot);
  if (!spool.isDirectory() || spool.isSymbolicLink()) throw new Error("CAD converter spool must be a regular directory");
  await attestCadConverterExecutable(executable, approvedDigest);
  const converter = new ArgvCadConverter({
    executable, argv: argv as string[], timeoutMs, maxOutputBytes, execution: { mode: "linux-resource-limited" }
  });
  const readyPath = join(spoolRoot, READY_FILE);
  await writeResponseFile(readyPath, { version: 1, digest: approvedDigest });
  const removeReady = () => { void unlink(readyPath).catch(() => undefined); };
  process.once("SIGTERM", removeReady);
  process.once("SIGINT", removeReady);

  for (;;) {
    await attestCadConverterExecutable(executable, approvedDigest).catch(async error => {
      await unlink(readyPath).catch(() => undefined);
      throw error;
    });
    const names = (await readdir(spoolRoot)).filter(name => name.startsWith("job-")).sort();
    for (const name of names) {
      const jobDirectory = join(spoolRoot, name);
      if (await exists(join(jobDirectory, "request.json")) && !await exists(join(jobDirectory, "response.json"))) {
        await processCadSidecarJob(jobDirectory, { approvedDigest, executable, converter });
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export async function probeCadConverterSidecar(env: NodeJS.ProcessEnv = process.env) {
  const spoolRoot = requiredAbsolute(env.CAD_IMPORT_CONVERTER_SPOOL_ROOT, "CAD_IMPORT_CONVERTER_SPOOL_ROOT");
  const executable = requiredAbsolute(env.CAD_IMPORT_CONVERTER_EXECUTABLE, "CAD_IMPORT_CONVERTER_EXECUTABLE");
  const digest = env.CAD_IMPORT_CONVERTER_SHA256 ?? "";
  await attestCadConverterExecutable(executable, digest);
  const ready = JSON.parse(await readFile(join(spoolRoot, READY_FILE), "utf8")) as Record<string, unknown>;
  if (ready.version !== 1 || ready.digest !== digest) throw new Error("CAD converter sidecar readiness mismatch");
}

async function writeResponse(jobDirectory: string, value: unknown) {
  return writeResponseFile(join(jobDirectory, "response.json"), value);
}

async function writeResponseFile(path: string, value: unknown) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { mode: 0o640 });
  await rename(temporary, path);
}

async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function requiredAbsolute(value: string | undefined, name: string) {
  const normalized = value?.trim();
  if (!normalized || !isAbsolute(normalized)) throw new Error(`${name} must be an absolute path`);
  return normalized;
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : "conversion failed";
  return message.slice(0, 300);
}

if (require.main === module) {
  const action = process.argv[2] ?? "run";
  const execution = action === "healthcheck" ? probeCadConverterSidecar() : runCadConverterSidecar();
  execution.catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
