import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface AtomicJsonWriteOptions {
  syncParentDirectory?: (directory: string) => Promise<void>;
}

export interface JsonReadOptions {
  maxBytes?: number;
}

export class AtomicJsonCommitUncertainError extends Error {
  readonly code = "atomic_json_commit_uncertain";

  constructor(readonly path: string, options?: ErrorOptions) {
    super("atomic JSON commit is uncertain", options);
    this.name = "AtomicJsonCommitUncertainError";
  }
}

export async function readJsonFile(path: string, options: JsonReadOptions = {}): Promise<unknown | null> {
  try {
    const text = options.maxBytes === undefined
      ? await readFile(path, "utf8")
      : await readFileBounded(path, options.maxBytes);
    return JSON.parse(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readFileBounded(path: string, maxBytes: number) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("invalid_json_file_size_limit");
  const file = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - totalBytes));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, totalBytes);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > maxBytes) throw new Error("json_file_size_limit_exceeded");
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function writeJsonAtomic(path: string, value: unknown, options: AtomicJsonWriteOptions = {}) {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const syncParentDirectory = options.syncParentDirectory ?? syncDirectory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    try {
      await syncParentDirectory(directory);
    } catch (firstSyncError) {
      // rename may already have committed. Confirm the exact target and retry the
      // durability barrier before allowing callers to swap in-memory state.
      let target: unknown;
      try {
        target = await readJsonFile(path);
      } catch (readbackError) {
        throw uncertainCommit(path, firstSyncError, readbackError);
      }
      if (!isDeepStrictEqual(target, value)) throw uncertainCommit(path, firstSyncError);
      try {
        await syncParentDirectory(directory);
      } catch (retrySyncError) {
        throw uncertainCommit(path, firstSyncError, retrySyncError);
      }
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function removeFileDurable(path: string, options: AtomicJsonWriteOptions = {}) {
  const directory = dirname(path);
  const syncParentDirectory = options.syncParentDirectory ?? syncDirectory;
  await rm(path, { force: true });
  try {
    await syncParentDirectory(directory);
  } catch (firstSyncError) {
    if (await readJsonFile(path) !== null) throw uncertainCommit(path, firstSyncError);
    try {
      await syncParentDirectory(directory);
    } catch (retrySyncError) {
      throw uncertainCommit(path, firstSyncError, retrySyncError);
    }
  }
}

function uncertainCommit(path: string, ...causes: unknown[]) {
  return new AtomicJsonCommitUncertainError(path, {
    cause: causes.length === 1 ? causes[0] : new AggregateError(causes, "atomic JSON durability barriers failed")
  });
}

async function syncDirectory(directory: string) {
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}
