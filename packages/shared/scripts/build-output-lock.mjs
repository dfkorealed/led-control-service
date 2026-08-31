import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const OWNER_MARKER_PREFIX = ".owner.";
const TEMPORARY_DIRECTORY_MARKER = ".tmp-";

export async function acquireOutputLock(options) {
  const lockPath = assertLockPath(options.lockPath);
  const timeoutMs = assertPositiveInteger(options.timeoutMs ?? 60_000, "shared build lock timeout");
  const pollIntervalMs = assertPositiveInteger(options.pollIntervalMs ?? 20, "shared build lock poll interval");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const readProcessIdentity = options.readProcessIdentity ?? readProcessIdentityFromSystem;
  const beforeOwnerMarkerUnlink = options.beforeOwnerMarkerUnlink;
  const afterTemporaryDirectoryCreated = options.afterTemporaryDirectoryCreated;
  const owner = options.owner ?? await currentOwner(readProcessIdentity);
  const token = assertToken(options.token ?? randomUUID());
  const expectedOwner = { version: 1, token, ...assertOwner(owner) };
  const deadline = now() + timeoutMs;

  while (true) {
    await cleanOrphanTemps(lockPath);

    if (await publishCompletedLock(lockPath, expectedOwner, afterTemporaryDirectoryCreated)) {
      return createRelease(lockPath, expectedOwner, beforeOwnerMarkerUnlink);
    }

    let lock;
    try {
      lock = await inspectOwnerDirectory(lockPath, "lock root");
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    if (lock.state === "empty") {
      await removeEmptyDirectory(lockPath, "lock root");
      continue;
    }

    const identity = await readProcessIdentity(lock.owner.pid);
    if (identity.state === "unknown") {
      throw new Error("shared build lock owner identity cannot be verified");
    }
    if (identity.state === "missing" || identity.processStartIdentity !== lock.owner.processStartIdentity) {
      await relinquishOwnerDirectory(lockPath, lock.owner, "lock root", beforeOwnerMarkerUnlink);
      continue;
    }
    await waitForRetry(deadline, now, sleep, pollIntervalMs);
  }
}

function createRelease(lockPath, expectedOwner, beforeOwnerMarkerUnlink) {
  return async () => {
    try {
      return await relinquishOwnerDirectory(
        lockPath,
        expectedOwner,
        "lock root",
        beforeOwnerMarkerUnlink
      );
    } catch {
      return false;
    }
  };
}

async function publishCompletedLock(lockPath, owner, afterTemporaryDirectoryCreated) {
  const parent = dirname(lockPath);
  await assertRealDirectory(parent, "shared build lock parent");
  await assertExistingLockRootIsRealDirectory(lockPath);
  const temporaryPath = temporaryDirectoryPath(lockPath, owner.token);
  try {
    await mkdir(temporaryPath);
  } catch (error) {
    if (isExistingPathError(error)) return false;
    throw error;
  }

  try {
    // Test seam for the race where another contender removes this unpublished temp path.
    if (afterTemporaryDirectoryCreated) await afterTemporaryDirectoryCreated();
    await writeOwnerMarker(temporaryPath, owner);
    await rename(temporaryPath, lockPath);
    return true;
  } catch (error) {
    const removed = await removeTemporaryDirectory(temporaryPath, owner.token);
    if (isErrorCode(error, "ENOENT") || isExistingPathError(error)) return false;
    if (!removed) throw new Error("shared build temporary lock cleanup could not be verified", { cause: error });
    throw error;
  }
}

async function assertExistingLockRootIsRealDirectory(lockPath) {
  try {
    await assertRealDirectory(lockPath, "shared build lock root");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

async function cleanOrphanTemps(lockPath) {
  const parent = dirname(lockPath);
  const prefix = `${basename(lockPath)}${TEMPORARY_DIRECTORY_MARKER}`;
  await assertRealDirectory(parent, "shared build lock parent");
  const entries = await readdir(parent, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const token = tryToken(entry.name.slice(prefix.length));
    if (!token) continue;
    const temporaryPath = join(parent, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    await removeTemporaryDirectory(temporaryPath, token);
  }
}

async function removeTemporaryDirectory(directory, token) {
  const quarantinePath = await quarantineTemporaryDirectory(directory);
  if (!quarantinePath) return false;
  return removeQuarantinedTemporaryDirectory(quarantinePath, token);
}

async function quarantineTemporaryDirectory(directory) {
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }

  const quarantinePath = `${directory}.quarantine-${randomUUID()}`;
  try {
    await rename(directory, quarantinePath);
    return quarantinePath;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function removeQuarantinedTemporaryDirectory(directory, token) {
  let entries;
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }

  if (entries.length === 0) return removeEmptyDirectory(directory, "temporary lock");
  if (entries.length !== 1 || entries[0].name !== `${OWNER_MARKER_PREFIX}${token}` || !entries[0].isFile()) {
    return false;
  }

  const markerPath = ownerMarkerPath(directory, token);
  const markerStats = await lstat(markerPath);
  if (markerStats.isSymbolicLink() || !markerStats.isFile()) return false;
  try {
    await unlink(markerPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  try {
    await rmdir(directory);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTEMPTY")) return false;
    throw error;
  }
}

async function relinquishOwnerDirectory(directory, expectedOwner, label, beforeOwnerMarkerUnlink) {
  const current = await inspectOwnerDirectory(directory, label, expectedOwner.token);
  if (current.state === "empty" || !sameOwner(current.owner, expectedOwner)) return false;
  if (beforeOwnerMarkerUnlink) await beforeOwnerMarkerUnlink();

  try {
    await unlink(ownerMarkerPath(directory, expectedOwner.token));
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }

  try {
    await rmdir(directory);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTEMPTY")) return false;
    throw error;
  }
}

async function removeEmptyDirectory(directory, label) {
  const inspected = await inspectOwnerDirectory(directory, label);
  if (inspected.state !== "empty") return false;
  try {
    await rmdir(directory);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTEMPTY")) return false;
    throw error;
  }
}

async function writeOwnerMarker(directory, owner) {
  const path = ownerMarkerPath(directory, owner.token);
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

async function inspectOwnerDirectory(directory, label, expectedToken) {
  await assertRealDirectory(directory, `shared build ${label}`);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length === 0) return { state: "empty" };
  if (entries.length !== 1 || !entries[0].isFile() || !entries[0].name.startsWith(OWNER_MARKER_PREFIX)) {
    throw new Error(`invalid shared build ${label} contents`);
  }

  const token = assertToken(entries[0].name.slice(OWNER_MARKER_PREFIX.length));
  if (expectedToken && token !== expectedToken) {
    throw new Error(`invalid shared build ${label} owner marker`);
  }
  const path = ownerMarkerPath(directory, token);
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`invalid shared build ${label} owner marker`);
  }
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`invalid shared build ${label} owner marker`);
    const owner = parseOwner(await handle.readFile("utf8"), label);
    if (owner.token !== token) throw new Error(`invalid shared build ${label} owner marker`);
    return { state: "owner", owner };
  } finally {
    await handle.close();
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
    throw new Error(`invalid shared build ${label} owner marker`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid shared build ${label} owner marker`);
  }
  const keys = Object.keys(parsed).sort().join(",");
  if (keys !== "pid,processStartIdentity,token,version" || parsed.version !== 1) {
    throw new Error(`invalid shared build ${label} owner marker`);
  }
  return {
    version: 1,
    token: assertToken(parsed.token),
    ...assertOwner(parsed)
  };
}

function temporaryDirectoryPath(lockPath, token) {
  return join(dirname(lockPath), `${basename(lockPath)}${TEMPORARY_DIRECTORY_MARKER}${token}`);
}

function ownerMarkerPath(directory, token) {
  return join(directory, `${OWNER_MARKER_PREFIX}${token}`);
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

function assertToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("invalid shared build lock owner token");
  }
  return value;
}

function tryToken(value) {
  try {
    return assertToken(value);
  } catch {
    return undefined;
  }
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

async function waitForRetry(deadline, now, sleep, pollIntervalMs) {
  if (now() >= deadline) throw new Error("timed out waiting for shared build output lock");
  await sleep(pollIntervalMs);
}

function sameOwner(left, right) {
  return left.version === right.version
    && left.token === right.token
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity;
}

function isExistingPathError(error) {
  return isErrorCode(error, "EEXIST") || isErrorCode(error, "ENOTEMPTY");
}

function isErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function noFollowFlag() {
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("shared build requires O_NOFOLLOW support");
  return constants.O_NOFOLLOW;
}
