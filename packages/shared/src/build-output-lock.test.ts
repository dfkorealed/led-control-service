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
import { afterEach, describe, expect, it } from "vitest";
import { acquireOutputLock } from "../scripts/build-output-lock.mjs";

type Owner = { pid: number; processStartIdentity: string };
type ProcessIdentity =
  | { state: "active"; processStartIdentity: string }
  | { state: "missing" }
  | { state: "unknown" };

const temporaryDirectories: string[] = [];

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
  let now = 0;
  return acquireOutputLock({
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

  it("removes a stale orphan temp directory through its exact marker", async () => {
    const root = await createRoot();
    await seedTemp(root, { pid: 101, processStartIdentity: "old-boot" });

    const release = await acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b");
    await expect(access(tempPath(root, "stale-token"))).rejects.toThrow();
    await expect(release()).resolves.toBe(true);
  });

  it("waits for an active orphan temp directory instead of stealing it", async () => {
    const root = await createRoot();
    await seedTemp(root, { pid: 101, processStartIdentity: "boot-a" });

    await expect(acquire(
      root,
      { pid: 202, processStartIdentity: "boot-b" },
      new Map([[101, { state: "active", processStartIdentity: "boot-a" }]]),
      "token-b"
    )).rejects.toThrow("timed out");
  });

  it.each(["lock root", "owner marker", "temp directory", "temp marker"])
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
    } else if (kind === "temp directory") {
      await symlink(external, tempPath(root, "token-a"), "dir");
    } else {
      await mkdir(tempPath(root, "token-a"));
      await symlink(sentinel, ownerMarkerPath(tempPath(root, "token-a"), "token-a"), "file");
    }

    await expect(acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b"))
      .rejects.toThrow("shared build");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
  });

  it("fails closed for a non-directory orphan temp path", async () => {
    const root = await createRoot();
    await writeFile(tempPath(root, "token-a"), "not a directory\n");

    await expect(acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b"))
      .rejects.toThrow("shared build lock temp");
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
