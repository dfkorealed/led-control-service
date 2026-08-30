import { mkdtemp, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAutomationConfigStore } from "./automation-config-store";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import { automationScope, automationSnapshot } from "./automation-test-fixtures";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileAutomationConfigStore", () => {
  it("atomically persists an owner-only snapshot that a restarted store can recover", async () => {
    const path = await snapshotPath();
    const snapshot = automationSnapshot(4);

    await new FileAutomationConfigStore(path, automationScope).apply(snapshot);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await new FileAutomationConfigStore(path, automationScope).load()).toEqual(snapshot);
    expect(await readdir(join(path, ".."))).toEqual(["automation-snapshot.json"]);
  });

  it("recovers the last renamed snapshot and removes an interrupted temporary write", async () => {
    const path = await snapshotPath();
    const applied = automationSnapshot(4);
    await writeFile(path, `${JSON.stringify(applied)}\n`, { mode: 0o600 });
    await writeFile(`${path}.123.456.tmp`, `${JSON.stringify(automationSnapshot(5))}\n`, { mode: 0o600 });

    const recovered = await new FileAutomationConfigStore(path, automationScope).load();

    expect(recovered).toEqual(applied);
    expect(await readdir(join(path, ".."))).toEqual(["automation-snapshot.json"]);
  });

  it("rejects a corrupt hash or foreign scope without replacing the last valid snapshot", async () => {
    const path = await snapshotPath();
    const store = new FileAutomationConfigStore(path, automationScope);
    const applied = automationSnapshot(4);
    await store.apply(applied);

    await expect(store.apply({ ...automationSnapshot(5), payloadHash: `sha256:${"f".repeat(64)}` }))
      .rejects.toMatchObject({ code: "snapshot_hash_mismatch" });
    await expect(store.apply(automationSnapshot(5, { gatewayId: "00000000-0000-4000-8000-000000000099" })))
      .rejects.toMatchObject({ code: "snapshot_scope_mismatch" });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(applied);
  });

  it("fails closed when the recovered snapshot is invalid", async () => {
    const path = await snapshotPath();
    await writeFile(path, "{not-json}\n", { mode: 0o600 });

    await expect(new FileAutomationConfigStore(path, automationScope).load())
      .rejects.toMatchObject({ code: "snapshot_invalid" });
  });

  it("recovers an uncertain rename by reading back and durably syncing the parent", async () => {
    const path = await snapshotPath();
    const snapshot = automationSnapshot(4);
    let syncAttempts = 0;
    const syncParentDirectory = async (directory: string) => {
      syncAttempts += 1;
      if (syncAttempts === 1) throw new Error("injected parent fsync failure");
      const handle = await open(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    };
    const store = new FileAutomationConfigStore(
      path,
      automationScope,
      (target, value) => writeJsonAtomic(target, value, { syncParentDirectory })
    );

    await store.apply(snapshot);

    expect(syncAttempts).toBe(2);
    expect(await store.load()).toEqual(snapshot);
  });
});

async function snapshotPath() {
  const directory = await mkdtemp(join(tmpdir(), "automation-config-store-"));
  directories.push(directory);
  return join(directory, "automation-snapshot.json");
}
