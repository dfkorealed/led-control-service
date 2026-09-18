import { readFileSync } from "node:fs";
import { CAD_IMPORT_TEMP_VOLUME_BYTES } from "./cad-resource-limits";

export const CAD_API_MAX_OLD_SPACE_MB = 256;
export const CAD_CORE_MAX_OLD_SPACE_MB = 384;
export const CAD_CGROUP_MEMORY_BYTES = 1408 * 1024 * 1024;
export const CAD_IMPORT_CONCURRENCY = 1;

type ReadTextFile = (path: string) => string;

export function assertCadProductionRuntime(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  readText: ReadTextFile = path => readFileSync(path, "utf8")
): void {
  if (env.NODE_ENV !== "production") return;
  if (env.NODE_OPTIONS !== `--max-old-space-size=${CAD_API_MAX_OLD_SPACE_MB}` ||
      env.CAD_CORE_MAX_OLD_SPACE_MB !== String(CAD_CORE_MAX_OLD_SPACE_MB) ||
      env.CAD_IMPORT_MAX_CONCURRENT_JOBS !== String(CAD_IMPORT_CONCURRENCY) ||
      env.CAD_IMPORT_TEMP_VOLUME_BYTES !== String(CAD_IMPORT_TEMP_VOLUME_BYTES)) {
    throw new Error("CAD production runtime limits do not match the approved contract");
  }
  if (platform !== "linux") {
    if (env.CAD_CGROUP_REQUIRED === "1") throw new Error("CAD production runtime requires a Linux cgroup gate");
    return;
  }

  const raw = readCgroupMemoryLimit(readText);
  if (raw === null || raw === "max" || Number(raw) !== CAD_CGROUP_MEMORY_BYTES) {
    throw new Error(`CAD production cgroup memory limit must be exactly ${CAD_CGROUP_MEMORY_BYTES} bytes`);
  }
}

function readCgroupMemoryLimit(readText: ReadTextFile): string | null {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try { return readText(path).trim(); }
    catch { /* Try the other cgroup layout. */ }
  }
  return null;
}
