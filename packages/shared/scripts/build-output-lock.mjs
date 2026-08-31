import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const OWNER_FILENAME = "owner.json";

export async function acquireOutputLock(options) {
  const lockPath = assertLockPath(options.lockPath);
  const timeoutMs = assertPositiveInteger(options.timeoutMs ?? 60_000, "shared build lock timeout");
  const pollIntervalMs = assertPositiveInteger(options.pollIntervalMs ?? 20, "shared build lock poll interval");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const readProcessIdentity = options.readProcessIdentity ?? readProcessIdentityFromSystem;
  const cleanupQuarantine = options.cleanupQuarantine ?? removeOwnerDirectory;
  const owner = options.owner ?? await currentOwner(readProcessIdentity);
  const token = assertNonEmptyString(options.token ?? randomUUID(), "shared build lock token");
  const expectedOwner = { version: 1, token, ...assertOwner(owner) };
  const deadline = now() + timeoutMs;

  await assertQuarantinesSafe(lockPath);
  while (true) {
    try {
      await createLock(lockPath, expectedOwner);
      return createRelease(lockPath, expectedOwner);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }

    let recordedOwner;
    try {
      recordedOwner = await readOwner(lockPath, "lock root");
      await assertOnlyOwnerMetadata(lockPath, "lock root");
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      if (now() >= deadline) throw new Error("shared build lock owner identity cannot be verified");
      await sleep(pollIntervalMs);
      continue;
    }
    const identity = await readProcessIdentity(recordedOwner.pid);
    if (identity.state === "unknown") {
      throw new Error("shared build lock owner identity cannot be verified");
    }
    if (identity.state === "missing" || identity.processStartIdentity !== recordedOwner.processStartIdentity) {
      const release = await takeoverStaleLock(lockPath, recordedOwner, expectedOwner, cleanupQuarantine);
      if (release) return release;
      continue;
    }
    if (now() >= deadline) throw new Error("timed out waiting for shared build output lock");
    await sleep(pollIntervalMs);
  }
}

async function takeoverStaleLock(lockPath, staleOwner, expectedOwner, cleanupQuarantine) {
  const quarantinePath = `${lockPath}.quarantine-${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }

  let release;
  try {
    const quarantinedOwner = await readOwner(quarantinePath, "quarantine");
    if (!sameOwner(quarantinedOwner, staleOwner)) {
      throw new Error("shared build lock quarantine owner changed during takeover");
    }
    await assertOnlyOwnerMetadata(quarantinePath, "quarantine");
    await createLock(lockPath, expectedOwner);
    release = createRelease(lockPath, expectedOwner);
    await cleanupQuarantine(quarantinePath, staleOwner, "quarantine");
    return release;
  } catch (error) {
    if (release) await release();
    throw error;
  }
}

function createRelease(lockPath, expectedOwner) {
  return async () => {
    let recordedOwner;
    try {
      recordedOwner = await readOwner(lockPath, "lock root");
      await assertOnlyOwnerMetadata(lockPath, "lock root");
    } catch {
      return false;
    }
    if (!sameOwner(recordedOwner, expectedOwner)) return false;
    await removeOwnerDirectory(lockPath, expectedOwner, "lock root");
    return true;
  };
}

async function createLock(lockPath, owner) {
  await assertRealDirectory(dirname(lockPath), "shared build lock parent");
  await mkdir(lockPath);
  try {
    await writeOwner(lockPath, owner);
  } catch (error) {
    await removeOwnerDirectoryIfEmpty(lockPath);
    throw error;
  }
}

async function writeOwner(lockPath, owner) {
  const path = join(lockPath, OWNER_FILENAME);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
    0o600
  );
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
  } finally {
    await handle.close();
  }
}

async function readOwner(lockPath, label) {
  await assertRealDirectory(lockPath, `shared build ${label}`);
  const path = join(lockPath, OWNER_FILENAME);
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`invalid shared build ${label} owner metadata`);
  }
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`invalid shared build ${label} owner metadata`);
    return parseOwner(await handle.readFile("utf8"), label);
  } finally {
    await handle.close();
  }
}

async function assertOnlyOwnerMetadata(lockPath, label) {
  await assertRealDirectory(lockPath, `shared build ${label}`);
  const entries = await readdir(lockPath, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== OWNER_FILENAME || !entries[0].isFile()) {
    throw new Error(`invalid shared build ${label} contents`);
  }
  const stats = await lstat(join(lockPath, OWNER_FILENAME));
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`invalid shared build ${label} owner metadata`);
  }
}

async function removeOwnerDirectory(lockPath, expectedOwner, label) {
  const currentOwner = await readOwner(lockPath, label);
  await assertOnlyOwnerMetadata(lockPath, label);
  if (!sameOwner(currentOwner, expectedOwner)) return false;
  await unlink(join(lockPath, OWNER_FILENAME));
  await rmdir(lockPath);
  return true;
}

async function removeOwnerDirectoryIfEmpty(lockPath) {
  try {
    const entries = await readdir(lockPath);
    if (entries.length === 0) await rmdir(lockPath);
  } catch {
    // A failed lock creation leaves an abnormal path for the next build to reject.
  }
}

async function assertQuarantinesSafe(lockPath) {
  const parent = dirname(lockPath);
  const prefix = `${basename(lockPath)}.quarantine-`;
  await assertRealDirectory(parent, "shared build lock parent");
  const entries = await readdir(parent, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const path = join(parent, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("invalid shared build lock quarantine");
    }
    const owner = await readOwner(path, "quarantine");
    await assertOnlyOwnerMetadata(path, "quarantine");
    await removeOwnerDirectory(path, owner, "quarantine");
  }
}

async function currentOwner(readProcessIdentity) {
  const identity = await readProcessIdentity(process.pid);
  if (identity.state !== "active") {
    throw new Error("shared build process start identity cannot be verified");
  }
  return { pid: process.pid, processStartIdentity: identity.processStartIdentity };
}

export async function readProcessIdentityFromSystem(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: "unknown" };
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isErrorCode(error, "ESRCH")) return { state: "missing" };
    return { state: "unknown" };
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const processStartIdentity = result.status === 0 ? result.stdout.trim() : "";
  return processStartIdentity ? { state: "active", processStartIdentity } : { state: "unknown" };
}

function parseOwner(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`invalid shared build ${label} owner metadata`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid shared build ${label} owner metadata`);
  }
  const keys = Object.keys(parsed).sort().join(",");
  if (keys !== "pid,processStartIdentity,token,version" || parsed.version !== 1) {
    throw new Error(`invalid shared build ${label} owner metadata`);
  }
  return {
    version: 1,
    token: assertNonEmptyString(parsed.token, `shared build ${label} owner token`),
    ...assertOwner(parsed)
  };
}

function assertOwner(owner) {
  if (!owner || typeof owner !== "object" || !Number.isSafeInteger(owner.pid) || owner.pid < 1) {
    throw new Error("invalid shared build lock owner");
  }
  return {
    pid: owner.pid,
    processStartIdentity: assertNonEmptyString(owner.processStartIdentity, "shared build process start identity")
  };
}

function assertLockPath(path) {
  if (typeof path !== "string" || !path) throw new Error("invalid shared build lock path");
  return path;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${label}`);
  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

async function assertRealDirectory(path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`invalid ${label}`);
}

function sameOwner(left, right) {
  return left.version === right.version
    && left.token === right.token
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity;
}

function isErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function noFollowFlag() {
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("shared build requires O_NOFOLLOW support");
  return constants.O_NOFOLLOW;
}
