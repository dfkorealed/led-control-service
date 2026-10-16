import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BioDeviceMappingStore } from "./bio-device-mapping-store";
import { mappingInput, removalCommand, removalNow } from "../../test/registration-removal-fixtures";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bio-retirement-")); roots.push(root);
  const path = join(root, "mappings.json"), store = new BioDeviceMappingStore(path, () => removalNow);
  await store.reserve(mappingInput); await store.confirm(mappingInput.deviceUuid, mappingInput.logicalAddress);
  return { root, path, store };
}
describe("durable BIO registration retirement", () => {
  it("atomically removes only the exact registration and retains its fence across restart", async () => {
    const { path, store } = await fixture();
    const other = { ...mappingInput, fixtureId: "other", nodeId: "other-node", commandId: "other-command",
      nativeUuid: "001122334466", deviceUuid: "bio:001122334466", logicalAddress: 0x101 };
    await store.reserve(other); await store.confirm(other.deviceUuid, other.logicalAddress);
    const captured = (await store.findByFixtureId(mappingInput.fixtureId))!;
    let changes = 0; store.onChange(() => { changes++; });
    await store.retireRegistration(removalCommand());
    expect(changes).toBeGreaterThan(0);
    expect(store.isRegistrationCurrent(captured)).toBe(false);
    const restarted = new BioDeviceMappingStore(path);
    expect(await restarted.findByFixtureId(mappingInput.fixtureId)).toBeNull();
    expect(await restarted.findByFixtureId(other.fixtureId)).toMatchObject(other);
    expect(await restarted.retirement(removalCommand())).not.toBeNull();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 3, retirements: [{ command: removalCommand() }] });
  });
  it.each(["fixtureId", "nodeId", "deviceUuid", "meshAddress", "originalProvisionCommandId"] as const)("rejects a mismatched %s without retiring", async key => {
    const { store } = await fixture();
    const value = key === "meshAddress" ? "0x0101" : key === "deviceUuid" ? "bio:001122334466" : "77777777-7777-4777-8777-777777777777";
    await expect(store.retireRegistration(removalCommand({ [key]: value }))).rejects.toThrow();
    expect(await store.findByFixtureId(mappingInput.fixtureId)).not.toBeNull();
  });
  it("blocks original provision replay forever but permits the same product with new IDs and a new address", async () => {
    const { path, store } = await fixture(); await store.retireRegistration(removalCommand());
    const restarted = new BioDeviceMappingStore(path);
    await expect(restarted.reserve(mappingInput)).rejects.toThrow();
    const fresh = { ...mappingInput, fixtureId: "new-fixture", nodeId: "new-node", commandId: "new-command", logicalAddress: 0x101 };
    await expect(restarted.reserve({ ...fresh, logicalAddress: 0x100 })).rejects.toThrow();
    await restarted.reserve(fresh); await restarted.confirm(fresh.deviceUuid, fresh.logicalAddress);
    expect(await restarted.findByFixtureId(fresh.fixtureId)).toMatchObject(fresh);
    await expect(restarted.reserve(mappingInput)).rejects.toThrow();
  });
  it("does not silently recreate a lost mapping file after tombstones were written", async () => {
    const { path, store } = await fixture(); await store.retireRegistration(removalCommand()); await rm(path);
    await expect(new BioDeviceMappingStore(path).validate()).rejects.toThrow();
  });
});
