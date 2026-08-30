import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface AtomicJsonWriteOptions {
  syncParentDirectory?: (directory: string) => Promise<void>;
}

export class AtomicJsonCommitUncertainError extends Error {
  readonly code = "atomic_json_commit_uncertain";

  constructor(readonly path: string, options?: ErrorOptions) {
    super("atomic JSON commit is uncertain", options);
    this.name = "AtomicJsonCommitUncertainError";
  }
}

export async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown, options: AtomicJsonWriteOptions = {}) {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
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
