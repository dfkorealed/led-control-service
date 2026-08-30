import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface AtomicJsonWriteOptions {
  syncParentDirectory?: (directory: string) => Promise<void>;
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
    } catch (error) {
      // rename may already have committed. Confirm the exact target and retry the
      // durability barrier before allowing callers to swap in-memory state.
      if (!isDeepStrictEqual(await readJsonFile(path), value)) throw error;
      await syncParentDirectory(directory);
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
  } catch (error) {
    if (await readJsonFile(path) !== null) throw error;
    await syncParentDirectory(directory);
  }
}

async function syncDirectory(directory: string) {
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}
