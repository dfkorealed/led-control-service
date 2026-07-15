import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MeshIdentityStore } from "./mesh-identity-store";

describe("MeshIdentityStore", () => {
  it("provisioner UUID와 64-bit token을 재시작 후 동일하게 복원한다", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mesh-identity-"));
    const file = path.join(dir, "identity.json");
    const first = new MeshIdentityStore(file);
    const identity = await first.loadOrCreate();
    await first.saveToken(0xffff_ffff_ffff_fffen);

    const restored = await new MeshIdentityStore(file).loadOrCreate();

    expect([...restored.uuid]).toEqual([...identity.uuid]);
    expect(restored.token).toBe(0xffff_ffff_ffff_fffen);
    expect(JSON.parse(await readFile(file, "utf8")).tokenHex).toBe("fffffffffffffffe");
  });

  it("손상된 identity 파일은 새 UUID로 덮어쓰지 않고 실패한다", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mesh-identity-"));
    const file = path.join(dir, "identity.json");
    await writeFile(file, "{broken");

    await expect(new MeshIdentityStore(file).loadOrCreate()).rejects.toThrow(/invalid mesh identity/i);
  });
});
