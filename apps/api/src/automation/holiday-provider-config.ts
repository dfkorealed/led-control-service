import * as fs from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { HolidayProvider, KasiHolidayProvider } from "./holiday-provider";

/** Server-only credential boundary: errors must never expose a key, path or request URL. */
export function createConfiguredHolidayProvider(env: NodeJS.ProcessEnv): HolidayProvider | undefined {
  const path = env.KASI_HOLIDAY_SERVICE_KEY_PATH;
  if (!path || !isAbsolute(path) || typeof process.getuid !== "function"
    || typeof fs.constants.O_NOFOLLOW !== "number" || typeof fs.constants.O_DIRECTORY !== "number") return undefined;
  let parent: number | undefined;
  let file: number | undefined;
  try {
    const uid = process.getuid();
    parent = fs.openSync(dirname(path), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const directory = fs.fstatSync(parent);
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o7777) !== 0o700) return undefined;
    // O_NONBLOCK also prevents a malicious FIFO from blocking boot before fstat can reject it.
    file = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(file);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || stat.size > 512) return undefined;
    // Read only this inspected descriptor. One extra byte detects growth after fstat
    // without an unbounded allocation/read, including a concurrent append.
    const bytes = Buffer.alloc(513);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(file, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > 512) return undefined;
    const raw = bytes.toString("utf8", 0, size);
    // Accept exactly one trailing LF; trim() would also hide forbidden whitespace/newlines.
    const key = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!/^[A-Za-z0-9+/%=._-]{16,256}$/.test(key)) return undefined;
    return new KasiHolidayProvider(key);
  } catch {
    return undefined;
  } finally {
    for (const descriptor of [file, parent]) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* Cleanup errors must not fail API boot or reveal a protected path. */ }
      }
    }
  }
}
