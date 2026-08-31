import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
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

function ownerPath(root: string) {
  return join(lockPath(root), "owner.json");
}

async function seedLock(root: string, owner: Owner, token = "stale-token") {
  await mkdir(lockPath(root));
  await writeFile(ownerPath(root), `${JSON.stringify({ version: 1, token, ...owner })}\n`);
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
  return JSON.parse(await readFile(ownerPath(root), "utf8")) as {
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
  it("serializes an active owner and releases only its exact ownership record", async () => {
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

    const secondRelease = await acquire(root, second, identities, "token-b");
    await expect(secondRelease()).resolves.toBe(true);
  });

  it("atomically takes over a crashed owner whose PID is absent", async () => {
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

  it("does not let a previous owner release a replacement lock", async () => {
    const root = await createRoot();
    const first = { pid: 101, processStartIdentity: "boot-a" };
    const identities = new Map<number, ProcessIdentity>([[101, { state: "active", processStartIdentity: "boot-a" }]]);
    const release = await acquire(root, first, identities, "token-a");
    await writeFile(ownerPath(root), `${JSON.stringify({
      version: 1,
      token: "token-b",
      pid: 202,
      processStartIdentity: "boot-b"
    })}\n`);

    await expect(release()).resolves.toBe(false);
    await expect(readOwner(root)).resolves.toMatchObject({ token: "token-b" });
  });

  it("fails closed when a stale lock cleanup finds an unexpected file", async () => {
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

  it("releases its new lock and preserves the quarantine when stale cleanup fails", async () => {
    const root = await createRoot();
    await seedLock(root, { pid: 101, processStartIdentity: "old-boot" });

    await expect(acquire(
      root,
      { pid: 202, processStartIdentity: "boot-b" },
      new Map(),
      "token-b",
      { cleanupQuarantine: async () => { throw new Error("simulated quarantine cleanup failure"); } }
    )).rejects.toThrow("simulated quarantine cleanup failure");
    await expect(access(lockPath(root))).rejects.toThrow();
    await expect(readdir(root)).resolves.toHaveLength(1);

    const release = await acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b");
    await expect(release()).resolves.toBe(true);
  });

  it("fails closed instead of waiting on an active lock with abnormal contents", async () => {
    const root = await createRoot();
    await seedLock(root, { pid: 101, processStartIdentity: "boot-a" });
    await writeFile(join(lockPath(root), "unexpected"), "do not remove\n");

    await expect(acquire(
      root,
      { pid: 202, processStartIdentity: "boot-b" },
      new Map([[101, { state: "active", processStartIdentity: "boot-a" }]]),
      "token-b"
    )).rejects.toThrow("lock root contents");
  });

  it.each(["lock root", "owner metadata", "quarantine"])
  ("fails closed for a %s symlink without touching its external target", async (kind) => {
    const root = await createRoot();
    const external = await createRoot();
    const sentinel = join(external, "sentinel.txt");
    await writeFile(sentinel, "keep\n");

    if (kind === "lock root") {
      await symlink(external, lockPath(root), "dir");
    } else if (kind === "owner metadata") {
      await mkdir(lockPath(root));
      await symlink(sentinel, ownerPath(root), "file");
    } else {
      await symlink(external, `${lockPath(root)}.quarantine-external`, "dir");
    }

    await expect(acquire(root, { pid: 202, processStartIdentity: "boot-b" }, new Map(), "token-b"))
      .rejects.toThrow("lock");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
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
