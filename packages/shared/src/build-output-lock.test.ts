import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireOutputLock } from "../scripts/build-output-lock.mjs";

type Owner = { pid: number; processStartIdentity: string };
type ProcessIdentity =
  | { state: "active"; processStartIdentity: string }
  | { state: "missing" }
  | { state: "unknown" };

const temporaryDirectories: string[] = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function capture<T>(promise: Promise<T>) {
  try {
    return { status: "fulfilled" as const, value: await promise };
  } catch (reason) {
    return { status: "rejected" as const, reason };
  }
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "led-shared-output-lock-"));
  temporaryDirectories.push(root);
  return root;
}

function lockPath(root: string) {
  return join(root, ".build-output.lock");
}

function tempPath(root: string, token: string) {
  return join(root, `.build-output.lock.tmp-${token}`);
}

function ownerMarkerPath(directory: string, token: string) {
  return join(directory, `.owner.${token}`);
}

async function seedOwnerDirectory(directory: string, owner: Owner, token = "stale-token") {
  await mkdir(directory);
  await writeFile(
    ownerMarkerPath(directory, token),
    `${JSON.stringify({ version: 1, token, ...owner })}\n`
  );
}

async function seedLock(root: string, owner: Owner, token = "stale-token") {
  await seedOwnerDirectory(lockPath(root), owner, token);
}

async function seedTemp(root: string, owner: Owner, token = "stale-token") {
  await seedOwnerDirectory(tempPath(root, token), owner, token);
}

function acquire(
  root: string,
  owner: Owner,
  identities: Map<number, ProcessIdentity>,
  token: string,
  options: Record<string, unknown> = {}
) {
  return acquireWith(acquireOutputLock, root, owner, identities, token, options);
}

function acquireWith(
  acquireLock: typeof acquireOutputLock,
  root: string,
  owner: Owner,
  identities: Map<number, ProcessIdentity>,
  token: string,
  options: Record<string, unknown> = {}
) {
  let now = 0;
  return acquireLock({
    lockPath: lockPath(root),
    owner,
    token,
    timeoutMs: 10,
    pollIntervalMs: 1,
    now: () => now,
    sleep: async () => {
      now += 10;
    },
    readProcessIdentity: async (pid) => identities.get(pid) ?? { state: "missing" },
    ...options
  });
}

async function readOwner(root: string) {
  const entries = await readdir(lockPath(root));
  expect(entries).toHaveLength(1);
  return JSON.parse(await readFile(join(lockPath(root), entries[0]), "utf8")) as {
    version: number;
    token: string;
    pid: number;
    processStartIdentity: string;
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("shared build output lock", () => {
  it("publishes a visible lock only after its token-specific owner marker is complete", async () => {
    const root = await createRoot();
    const release = await acquire(
      root,
      { pid: 101, processStartIdentity: "boot-a" },
      new Map(),
      "token-a"
    );

    await expect(readdir(lockPath(root))).resolves.toEqual([".owner.token-a"]);
    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-a", pid: 101 });
    await expect(release()).resolves.toBe(true);
  });

  it("serializes an active owner and times out without stealing it", async () => {
    const root = await createRoot();
    const first = { pid: 101, processStartIdentity: "boot-a" };
    const second = { pid: 202, processStartIdentity: "boot-b" };
    const identities = new Map<number, ProcessIdentity>([
      [101, { state: "active", processStartIdentity: "boot-a" }],
      [202, { state: "active", processStartIdentity: "boot-b" }]
    ]);
    const release = await acquire(root, first, identities, "token-a");

    await expect(acquire(root, second, identities, "token-b")).rejects.toThrow("timed out");
    await expect(release()).resolves.toBe(true);
  });

  it("takes over a crashed owner by unlinking only its exact marker", async () => {
    const root = await createRoot();
    await seedLock(root, { pid: 101, processStartIdentity: "boot-a" });
    const release = await acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b");

    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-b", pid: 202 });
    await expect(release()).resolves.toBe(true);
  });

  it("takes over a reused PID only when its current start identity differs", async () => {
    const root = await createRoot();
    await seedLock(root, { pid: 101, processStartIdentity: "old-boot" });
    const release = await acquire(
      root,
      { pid: 202, processStartIdentity: "new-owner" },
      new Map([[101, { state: "active", processStartIdentity: "reused-pid-new-boot" }]]),
      "token-b"
    );

    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-b" });
    await expect(release()).resolves.toBe(true);
  });

  it("fails closed when a recorded owner identity cannot be verified", async () => {
    const root = await createRoot();
    await seedLock(root, { pid: 101, processStartIdentity: "boot-a" });

    await expect(acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map([[101, { state: "unknown" }]]), "token-b"))
      .rejects.toThrow("cannot be verified");
    await expect(readOwner(root)).resolves.toMatchObject({ token: "stale-token" });
  });

  it("does not let a previous owner release a successor", async () => {
    const root = await createRoot();
    const first = { pid: 101, processStartIdentity: "boot-a" };
    const identities = new Map<number, ProcessIdentity>([[101, { state: "active", processStartIdentity: "boot-a" }]]);
    const release = await acquire(root, first, identities, "token-a");
    await unlink(ownerMarkerPath(lockPath(root), "token-a"));
    await rmdir(lockPath(root));
    await seedLock(root, { pid: 202, processStartIdentity: "boot-b" }, "token-b");

    await expect(release()).resolves.toBe(false);
    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-b" });
  });

  it("aborts a late stale takeover when its old marker was replaced by a successor", async () => {
    const root = await createRoot();
    await seedLock(root, { pid: 101, processStartIdentity: "boot-a" }, "token-a");
    const identities = new Map<number, ProcessIdentity>([
      [303, { state: "active", processStartIdentity: "boot-c" }]
    ]);

    await expect(acquire(
      root,
      { pid: 202, processStartIdentity: "boot-b" },
      identities,
      "token-b",
      {
        beforeOwnerMarkerUnlink: async () => {
          await unlink(ownerMarkerPath(lockPath(root), "token-a"));
          await rmdir(lockPath(root));
          await seedLock(root, { pid: 303, processStartIdentity: "boot-c" }, "token-c");
        }
      }
    )).rejects.toThrow("timed out");
    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-c" });
  });

  it("recovers an empty release artifact before retrying acquisition", async () => {
    const root = await createRoot();
    await mkdir(lockPath(root));

    const release = await acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b");
    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-b" });
    await expect(release()).resolves.toBe(true);
  });

  it("fails closed for an abnormal stale lock without removing an external sentinel", async () => {
    const root = await createRoot();
    const external = await createRoot();
    const sentinel = join(external, "sentinel.txt");
    await writeFile(sentinel, "keep\n");
    await seedLock(root, { pid: 101, processStartIdentity: "old-boot" });
    await writeFile(join(lockPath(root), "unexpected"), "do not remove\n");

    await expect(acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b"))
      .rejects.toThrow("lock root contents");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
  });

  it("removes a completed orphan temp directory through its exact marker", async () => {
    const root = await createRoot();
    await seedTemp(root, { pid: 101, processStartIdentity: "old-boot" });

    const release = await acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b");
    await expect(access(tempPath(root, "stale-token"))).rejects.toThrow();
    await expect(release()).resolves.toBe(true);
  });

  it("does not let another contender's active temp block fixed lock acquisition", async () => {
    const root = await createRoot();
    await seedTemp(root, { pid: 101, processStartIdentity: "boot-a" });

    const release = await acquire(
      root,
      { pid: 202, processStartIdentity: "boot-b" },
      new Map([[101, { state: "active", processStartIdentity: "boot-a" }]]),
      "token-b"
    );
    await expect(access(tempPath(root, "stale-token"))).rejects.toThrow();
    await expect(release()).resolves.toBe(true);
  });

  it("removes an empty orphan temp without blocking fixed lock acquisition", async () => {
    const root = await createRoot();
    await mkdir(tempPath(root, "orphan-token"));

    const release = await acquire(
      root,
      { pid: 202, processStartIdentity: "boot-b" },
      new Map(),
      "token-b"
    );
    await expect(access(tempPath(root, "orphan-token"))).rejects.toThrow();
    await expect(release()).resolves.toBe(true);
  });

  it("removes a partial owner marker orphan without blocking fixed lock acquisition", async () => {
    const root = await createRoot();
    const token = "orphan-token";
    await mkdir(tempPath(root, token));
    await writeFile(ownerMarkerPath(tempPath(root, token), token), '{"version":');

    const release = await acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b");
    await expect(access(tempPath(root, token))).rejects.toThrow();
    await expect(release()).resolves.toBe(true);
  });

  it("prevents completed temp cleanup from handing a markerless fixed lock to its publisher", async () => {
    const root = await createRoot();
    const temporary = tempPath(root, "token-a");
    const fixed = lockPath(root);
    const publisherRenameEntered = deferred();
    const allowPublisherRename = deferred();
    const cleanupModeSeen = deferred<"direct-rmdir" | "quarantine">();
    const allowDirectRmdirCleanup = deferred();
    let cleanupModeResolved = false;
    const signalCleanupMode = (mode: "direct-rmdir" | "quarantine") => {
      if (!cleanupModeResolved) {
        cleanupModeResolved = true;
        cleanupModeSeen.resolve(mode);
      }
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        rename: async (oldPath: string, newPath: string) => {
          if (oldPath === temporary && newPath === fixed) {
            publisherRenameEntered.resolve();
            await allowPublisherRename.promise;
          } else if (oldPath === temporary && newPath.startsWith(`${temporary}.quarantine-`)) {
            const result = await actual.rename(oldPath, newPath);
            signalCleanupMode("quarantine");
            return result;
          }
          return actual.rename(oldPath, newPath);
        },
        rmdir: async (path: string) => {
          if (path === temporary) {
            signalCleanupMode("direct-rmdir");
            await allowDirectRmdirCleanup.promise;
          }
          return actual.rmdir(path);
        }
      };
    });

    try {
      const { acquireOutputLock: instrumentedAcquire } =
        await import("../scripts/build-output-lock.mjs?completed-temp-cleanup-race");
      const identities = new Map<number, ProcessIdentity>([
        [101, { state: "active", processStartIdentity: "boot-a" }],
        [202, { state: "active", processStartIdentity: "boot-b" }]
      ]);
      let now = 0;
      const acquireWithInstrumentedFilesystem = (owner: Owner, token: string) => instrumentedAcquire({
        lockPath: fixed,
        owner,
        token,
        timeoutMs: 10,
        pollIntervalMs: 1,
        now: () => now,
        sleep: async () => {
          now += 10;
        },
        readProcessIdentity: async (pid) => identities.get(pid) ?? { state: "missing" }
      });

      const publisherOutcome = capture(acquireWithInstrumentedFilesystem(
        { pid: 101, processStartIdentity: "boot-a" },
        "token-a"
      ));
      await publisherRenameEntered.promise;

      const cleanerOutcome = capture(acquireWithInstrumentedFilesystem(
        { pid: 202, processStartIdentity: "boot-b" },
        "token-b"
      ));
      const cleanupMode = await cleanupModeSeen.promise;

      if (cleanupMode === "quarantine") {
        const cleaner = await cleanerOutcome;
        expect(cleaner.status).toBe("fulfilled");
        if (cleaner.status !== "fulfilled") return;

        allowPublisherRename.resolve();
        const publisher = await publisherOutcome;
        expect(publisher.status).toBe("rejected");
        if (publisher.status === "rejected") {
          expect(publisher.reason).toMatchObject({ message: expect.stringContaining("timed out") });
        }
        await expect(readOwner(root)).resolves.toMatchObject({ token: "token-b" });
        await expect(cleaner.value()).resolves.toBe(true);
        return;
      }

      allowPublisherRename.resolve();
      allowDirectRmdirCleanup.resolve();
      const [publisher, cleaner] = await Promise.all([publisherOutcome, cleanerOutcome]);

      expect(publisher.status).toBe("rejected");
      if (publisher.status === "rejected") {
        expect(publisher.reason).toMatchObject({ message: expect.stringContaining("timed out") });
      }
      if (publisher.status === "fulfilled") await publisher.value();
      if (cleaner.status === "fulfilled") await cleaner.value();
    } finally {
      allowPublisherRename.resolve();
      allowDirectRmdirCleanup.resolve();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("keeps the fixed lock owner when a publisher wins before temp quarantine", async () => {
    const root = await createRoot();
    const temporary = tempPath(root, "token-a");
    const fixed = lockPath(root);
    const publisherRenameEntered = deferred();
    const allowPublisherRename = deferred();
    const cleanupAttempted = deferred<"direct-rmdir" | "quarantine">();
    const allowTempCleanup = deferred();
    let cleanupAttemptResolved = false;
    const signalCleanupAttempt = (mode: "direct-rmdir" | "quarantine") => {
      if (!cleanupAttemptResolved) {
        cleanupAttemptResolved = true;
        cleanupAttempted.resolve(mode);
      }
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        rename: async (oldPath: string, newPath: string) => {
          if (oldPath === temporary && newPath === fixed) {
            publisherRenameEntered.resolve();
            await allowPublisherRename.promise;
          } else if (oldPath === temporary && newPath.startsWith(`${temporary}.quarantine-`)) {
            signalCleanupAttempt("quarantine");
            await allowTempCleanup.promise;
          }
          return actual.rename(oldPath, newPath);
        },
        rmdir: async (path: string) => {
          if (path === temporary) {
            signalCleanupAttempt("direct-rmdir");
            await allowTempCleanup.promise;
          }
          return actual.rmdir(path);
        }
      };
    });

    try {
      const { acquireOutputLock: instrumentedAcquire } =
        await import("../scripts/build-output-lock.mjs?publisher-wins-temp-cleanup");
      const identities = new Map<number, ProcessIdentity>([
        [101, { state: "active", processStartIdentity: "boot-a" }],
        [202, { state: "active", processStartIdentity: "boot-b" }]
      ]);
      const publisherOutcome = capture(acquireWith(
        instrumentedAcquire,
        root,
        { pid: 101, processStartIdentity: "boot-a" },
        identities,
        "token-a"
      ));
      await publisherRenameEntered.promise;

      const cleanerOutcome = capture(acquireWith(
        instrumentedAcquire,
        root,
        { pid: 202, processStartIdentity: "boot-b" },
        identities,
        "token-b"
      ));
      await cleanupAttempted.promise;

      allowPublisherRename.resolve();
      const publisher = await publisherOutcome;
      expect(publisher.status).toBe("fulfilled");
      if (publisher.status !== "fulfilled") return;
      await expect(readOwner(root)).resolves.toMatchObject({ token: "token-a", pid: 101 });

      allowTempCleanup.resolve();
      const cleaner = await cleanerOutcome;
      expect(cleaner.status).toBe("rejected");
      if (cleaner.status === "rejected") {
        expect(cleaner.reason).toMatchObject({ message: expect.stringContaining("timed out") });
      }
      await expect(readOwner(root)).resolves.toMatchObject({ token: "token-a", pid: 101 });
      await expect(publisher.value()).resolves.toBe(true);
    } finally {
      allowPublisherRename.resolve();
      allowTempCleanup.resolve();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("recreates a completed temp with the same token after a cleaner quarantines the first one", async () => {
    const root = await createRoot();
    const temporary = tempPath(root, "token-a");
    const fixed = lockPath(root);
    const publisherRenameEntered = deferred();
    const allowFirstPublisherRename = deferred();
    const cleanupModeSeen = deferred<"direct-rmdir" | "quarantine">();
    const allowDirectRmdirCleanup = deferred();
    let cleanupModeResolved = false;
    let publisherRenameAttempts = 0;
    const signalCleanupMode = (mode: "direct-rmdir" | "quarantine") => {
      if (!cleanupModeResolved) {
        cleanupModeResolved = true;
        cleanupModeSeen.resolve(mode);
      }
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        rename: async (oldPath: string, newPath: string) => {
          if (oldPath === temporary && newPath === fixed) {
            publisherRenameAttempts += 1;
            if (publisherRenameAttempts === 1) {
              publisherRenameEntered.resolve();
              await allowFirstPublisherRename.promise;
            }
          } else if (oldPath === temporary && newPath.startsWith(`${temporary}.quarantine-`)) {
            const result = await actual.rename(oldPath, newPath);
            signalCleanupMode("quarantine");
            return result;
          }
          return actual.rename(oldPath, newPath);
        },
        rmdir: async (path: string) => {
          if (path === temporary) {
            signalCleanupMode("direct-rmdir");
            await allowDirectRmdirCleanup.promise;
          }
          return actual.rmdir(path);
        }
      };
    });

    try {
      const { acquireOutputLock: instrumentedAcquire } =
        await import("../scripts/build-output-lock.mjs?publisher-retries-after-quarantine");
      const identities = new Map<number, ProcessIdentity>([
        [101, { state: "active", processStartIdentity: "boot-a" }],
        [202, { state: "active", processStartIdentity: "boot-b" }]
      ]);
      const publisherOutcome = capture(acquireWith(
        instrumentedAcquire,
        root,
        { pid: 101, processStartIdentity: "boot-a" },
        identities,
        "token-a"
      ));
      await publisherRenameEntered.promise;

      const cleanerOutcome = capture(acquireWith(
        instrumentedAcquire,
        root,
        { pid: 202, processStartIdentity: "boot-b" },
        identities,
        "token-b"
      ));
      const cleanupMode = await cleanupModeSeen.promise;

      if (cleanupMode === "quarantine") {
        const cleaner = await cleanerOutcome;
        expect(cleaner.status).toBe("fulfilled");
        if (cleaner.status !== "fulfilled") return;
        await expect(cleaner.value()).resolves.toBe(true);
      }

      allowFirstPublisherRename.resolve();
      allowDirectRmdirCleanup.resolve();
      const publisher = await publisherOutcome;

      expect(publisher.status).toBe("fulfilled");
      if (publisher.status !== "fulfilled") return;
      expect(publisherRenameAttempts).toBeGreaterThan(1);
      await expect(readOwner(root)).resolves.toMatchObject({ token: "token-a", pid: 101 });
      await expect(publisher.value()).resolves.toBe(true);

      if (cleanupMode === "direct-rmdir") {
        const cleaner = await cleanerOutcome;
        if (cleaner.status === "fulfilled") await cleaner.value();
      }
    } finally {
      allowFirstPublisherRename.resolve();
      allowDirectRmdirCleanup.resolve();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it.each(["lock root", "owner marker"])
  ("fails closed for a %s symlink without touching its external target", async (kind) => {
    const root = await createRoot();
    const external = await createRoot();
    const sentinel = join(external, "sentinel.txt");
    await writeFile(sentinel, "keep\n");

    if (kind === "lock root") {
      await symlink(external, lockPath(root), "dir");
    } else if (kind === "owner marker") {
      await mkdir(lockPath(root));
      await symlink(sentinel, ownerMarkerPath(lockPath(root), "token-a"), "file");
    }

    await expect(acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b"))
      .rejects.toThrow("shared build");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
  });

  it.each(["temp directory", "temp marker", "non-directory temp"])
  ("ignores a %s without changing its external or invalid path", async (kind) => {
    const root = await createRoot();
    const external = await createRoot();
    const sentinel = join(external, "sentinel.txt");
    await writeFile(sentinel, "keep\n");

    if (kind === "temp directory") {
      await symlink(external, tempPath(root, "token-a"), "dir");
    } else if (kind === "temp marker") {
      await mkdir(tempPath(root, "token-a"));
      await symlink(sentinel, ownerMarkerPath(tempPath(root, "token-a"), "token-a"), "file");
    } else {
      await writeFile(tempPath(root, "token-a"), "not a directory\n");
    }

    const release = await acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b");
    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-b" });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
    if (kind === "non-directory temp") {
      await expect(readFile(tempPath(root, "token-a"), "utf8")).resolves.toBe("not a directory\n");
    }
    await expect(release()).resolves.toBe(true);
  });

  it("quarantines a multi-entry temp without deleting its files or blocking fixed lock acquisition", async () => {
    const root = await createRoot();
    const token = "orphan-token";
    const temporary = tempPath(root, token);
    await mkdir(temporary);
    await writeFile(ownerMarkerPath(temporary, token), '{"version":');
    await writeFile(join(temporary, "unexpected"), "keep\n");

    const release = await acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b");

    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-b" });
    await expect(access(temporary)).rejects.toThrow();
    const rootEntries = await readdir(root);
    const quarantineName = rootEntries.find((entry) =>
      entry.startsWith(".build-output.lock.tmp-orphan-token.quarantine-")
    );
    expect(quarantineName).toBeDefined();
    await expect(readFile(join(root, quarantineName ?? "", "unexpected"), "utf8")).resolves.toBe("keep\n");
    await expect(release()).resolves.toBe(true);
  });

  it.each(["quarantine symlink", "quarantine non-directory"])
  ("ignores a %s without touching it or blocking fixed lock acquisition", async (kind) => {
    const root = await createRoot();
    const external = await createRoot();
    const sentinel = join(external, "sentinel.txt");
    const quarantinePath = `${tempPath(root, "token-a")}.quarantine-fixed`;
    await writeFile(sentinel, "keep\n");

    if (kind === "quarantine symlink") {
      await symlink(external, quarantinePath, "dir");
    } else {
      await writeFile(quarantinePath, "not a directory\n");
    }

    const release = await acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b");

    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-b" });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
    if (kind === "quarantine non-directory") {
      await expect(readFile(quarantinePath, "utf8")).resolves.toBe("not a directory\n");
    }
    await expect(release()).resolves.toBe(true);
  });

  it("retries publishing after another contender cleans its just-created temp directory", async () => {
    const root = await createRoot();
    let markTempCreated: (() => void) | undefined;
    const tempCreated = new Promise<void>((resolve) => {
      markTempCreated = resolve;
    });
    let resumeFirstAttempt: (() => void) | undefined;
    const firstAttemptCanContinue = new Promise<void>((resolve) => {
      resumeFirstAttempt = resolve;
    });
    const first = acquire(
      root,
      { pid: 101, processStartIdentity: "boot-a" },
      new Map(),
      "token-a",
      {
        afterTemporaryDirectoryCreated: async () => {
          markTempCreated?.();
          await firstAttemptCanContinue;
        }
      }
    );

    await tempCreated;

    const secondRelease = await acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b");
    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-b" });
    await expect(secondRelease()).resolves.toBe(true);

    resumeFirstAttempt?.();
    const firstRelease = await first;
    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-a" });
    await expect(firstRelease()).resolves.toBe(true);
  });

  it("allows independent package roots to acquire output locks concurrently", async () => {
    const firstRoot = await createRoot();
    const secondRoot = await createRoot();
    const [firstRelease, secondRelease] = await Promise.all([
      acquire(firstRoot, { pid: 101, processStartIdentity: "boot-a" }, new Map(), "token-a"),
      acquire(secondRoot, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b")
    ]);

    await expect(Promise.all([firstRelease(), secondRelease()])).resolves.toEqual([true, true]);
    await expect(access(lockPath(firstRoot))).rejects.toThrow();
    await expect(access(lockPath(secondRoot))).rejects.toThrow();
  });
});
