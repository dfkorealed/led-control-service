import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupStateStore } from "./group-state-store";
import { writeJsonAtomic } from "./mesh-store-file";

const directories: string[] = [];
const snapshot = {
  groupId: "00000000-0000-4000-8000-000000000012",
  groupAddress: "0xc000",
  version: 3
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GroupStateStore", () => {
  it("initializes an empty durable store only when both state and manifest are absent", async () => {
    const { path } = await fixture();
    const store = new GroupStateStore(path);

    await expect(store.initialize()).resolves.toEqual({ reason: "first_run" });

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1, revision: 1, groups: [] });
    expect(JSON.parse(await readFile(`${path}.manifest`, "utf8"))).toMatchObject({ version: 1, revision: 1 });
  });

  it("restores exact ready state after restart and rejects address or version mismatch", async () => {
    const { path } = await fixture();
    const first = new GroupStateStore(path);
    await first.initialize();
    await first.writeConfiguring(snapshot);
    await first.writeReady(snapshot);

    const restarted = new GroupStateStore(path);
    await expect(restarted.initialize()).resolves.toEqual({ reason: "startup" });
    await expect(restarted.assertReady(snapshot)).resolves.toBeUndefined();
    await expect(restarted.assertReady({ ...snapshot, version: 2 })).rejects.toMatchObject({ code: "MESH_GROUP_NOT_READY" });
    await expect(restarted.assertReady({ ...snapshot, groupAddress: "0xc001" })).rejects.toMatchObject({
      code: "MESH_GROUP_NOT_READY"
    });
  });

  it("fails closed when a previously initialized state file is missing", async () => {
    const { path } = await fixture();
    const store = new GroupStateStore(path);
    await store.initialize();
    await rm(path);

    const restarted = new GroupStateStore(path);
    await expect(restarted.initialize()).resolves.toEqual({ reason: "state_missing" });
    await expect(restarted.assertReady(snapshot)).rejects.toMatchObject({ code: "MESH_GROUP_NOT_READY" });
  });

  it("fails closed on corruption or a manifest revision mismatch", async () => {
    const { path } = await fixture();
    const store = new GroupStateStore(path);
    await store.initialize();
    await writeFile(path, "{broken", "utf8");

    const corrupted = new GroupStateStore(path);
    await expect(corrupted.initialize()).resolves.toEqual({ reason: "state_corrupt" });
    await expect(corrupted.assertReady(snapshot)).rejects.toMatchObject({ code: "MESH_GROUP_NOT_READY" });

    await writeFile(path, JSON.stringify({ version: 1, revision: 4, groups: [] }), "utf8");
    await writeFile(`${path}.manifest`, JSON.stringify({ version: 1, revision: 3 }), "utf8");
    const mismatched = new GroupStateStore(path);
    await expect(mismatched.initialize()).resolves.toEqual({ reason: "state_corrupt" });
  });

  it("persists configuring, ready, and failed without restoring an older ready version", async () => {
    const { path } = await fixture();
    const store = new GroupStateStore(path);
    await store.initialize();
    await store.writeConfiguring(snapshot);
    await store.writeReady(snapshot);
    await store.writeConfiguring({ ...snapshot, version: 4 });
    await store.writeFailed({ ...snapshot, version: 4 });

    await expect(store.assertReady(snapshot)).rejects.toMatchObject({ code: "MESH_GROUP_NOT_READY" });
    await expect(store.assertReady({ ...snapshot, version: 4 })).rejects.toMatchObject({ code: "MESH_GROUP_NOT_READY" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      groups: [{ ...snapshot, version: 4, status: "failed" }]
    });
  });

  it("rejects stale versions and address reuse by another group", async () => {
    const { path } = await fixture();
    const store = new GroupStateStore(path);
    await store.initialize();
    await store.writeConfiguring(snapshot);
    await store.writeReady(snapshot);

    await expect(store.writeConfiguring({ ...snapshot, version: 2 })).rejects.toMatchObject({ code: "MESH_GROUP_STALE_SYNC" });
    await expect(store.writeConfiguring({
      ...snapshot,
      groupId: "00000000-0000-4000-8000-000000000099"
    })).rejects.toMatchObject({ code: "MESH_GROUP_ADDRESS_CONFLICT" });
  });

  it("preserves every trusted group when a write fails and a later configuring retry recovers the store", async () => {
    const { path } = await fixture();
    let failStateWrite = false;
    const writer = vi.fn(async (target: string, value: unknown) => {
      if (failStateWrite && target === path) throw new Error("disk unavailable");
      await writeJsonAtomic(target, value);
    });
    const store = new GroupStateStore(path, () => "2026-08-23T00:00:00.000Z", writer);
    await store.initialize();
    await store.writeConfiguring(snapshot);
    await store.writeReady(snapshot);

    const second = {
      groupId: "00000000-0000-4000-8000-000000000013",
      groupAddress: "0xc001",
      version: 1
    };
    failStateWrite = true;
    await expect(store.writeConfiguring(second)).rejects.toThrow("failed to persist mesh group state");
    await expect(store.assertReady(snapshot)).rejects.toMatchObject({ code: "MESH_GROUP_NOT_READY" });

    failStateWrite = false;
    await store.writeConfiguring(second);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      groups: [
        { ...snapshot, status: "ready" },
        { ...second, status: "configuring" }
      ]
    });
    await expect(store.assertReady(snapshot)).resolves.toBeUndefined();
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "group-state-store-"));
  directories.push(directory);
  return { path: join(directory, "groups.json") };
}
