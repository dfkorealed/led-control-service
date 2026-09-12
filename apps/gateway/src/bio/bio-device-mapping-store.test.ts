import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BioDeviceMappingStore } from "./bio-device-mapping-store";

const firstMapping = {
  fixtureId: "fixture-1",
  nodeId: "node-1",
  deviceUuid: "bio:a1b2c3d4e5f6",
  nativeUuid: "a1b2c3d4e5f6",
  logicalAddress: 0x0101,
  firmware: "1.2.3",
  protocol: "gs-v1"
};

async function mappingPath() {
  return path.join(await mkdtemp(path.join(tmpdir(), "bio-device-mapping-")), "mappings.json");
}

describe("BioDeviceMappingStore", () => {
  it("persists a confirmed mapping and recovers its canonical identity after restart", async () => {
    const file = await mappingPath();
    const store = new BioDeviceMappingStore(file, () => new Date("2026-09-12T00:00:00.000Z"));

    await store.reserve(firstMapping);
    await store.confirm(firstMapping.deviceUuid, firstMapping.logicalAddress);

    const restarted = new BioDeviceMappingStore(file);
    await expect(restarted.findByFixtureId("fixture-1")).resolves.toEqual({
      ...firstMapping,
      status: "confirmed",
      updatedAt: "2026-09-12T00:00:00.000Z"
    });
    await expect(restarted.findByDeviceUuid("bio:a1b2c3d4e5f6")).resolves.toEqual(
      expect.objectContaining({ nativeUuid: "a1b2c3d4e5f6", logicalAddress: 0x0101, status: "confirmed" })
    );
    await expect(restarted.findByNativeUuid("a1b2c3d4e5f6")).resolves.toEqual(
      expect.objectContaining({ fixtureId: "fixture-1" })
    );
    await expect(restarted.findByLogicalAddress(0x0101)).resolves.toEqual(
      expect.objectContaining({ deviceUuid: "bio:a1b2c3d4e5f6" })
    );
  });

  it("rejects a second fixture, BIO UUID, native UUID, or address that conflicts with a reservation", async () => {
    const store = new BioDeviceMappingStore(await mappingPath());
    await store.reserve(firstMapping);

    await expect(store.reserve({ ...firstMapping, fixtureId: "fixture-2" })).rejects.toThrow(/identity conflict/i);
    await expect(store.reserve({ ...firstMapping, fixtureId: "fixture-2", nodeId: "node-2" })).rejects.toThrow(
      /identity conflict/i
    );
    await expect(store.reserve({ ...firstMapping, nodeId: "node-2", deviceUuid: "bio:001122334455" })).rejects.toThrow(
      /identity conflict/i
    );
    await expect(
      store.reserve({ ...firstMapping, fixtureId: "fixture-2", nodeId: "node-2", deviceUuid: "bio:001122334455", nativeUuid: "001122334455" })
    ).rejects.toThrow(/address conflict/i);
  });

  it("keeps reserved mappings out of lookup and confirmed control candidates", async () => {
    const store = new BioDeviceMappingStore(await mappingPath());
    await store.reserve(firstMapping);

    await expect(store.findByFixtureId(firstMapping.fixtureId)).resolves.toBeNull();
    await expect(store.findByDeviceUuid(firstMapping.deviceUuid)).resolves.toBeNull();
    await expect(store.findByNativeUuid(firstMapping.nativeUuid)).resolves.toBeNull();
    await expect(store.findByLogicalAddress(firstMapping.logicalAddress)).resolves.toBeNull();
    await expect(store.listConfirmed()).resolves.toEqual([]);
  });

  it("rejects reserved confirmation with a different logical address and does not expose it", async () => {
    const store = new BioDeviceMappingStore(await mappingPath());
    await store.reserve(firstMapping);

    await expect(store.confirm(firstMapping.deviceUuid, 0x0102)).rejects.toThrow(/reserved address/i);
    await expect(store.findByFixtureId(firstMapping.fixtureId)).resolves.toBeNull();
  });

  it("rejects addresses outside the BIO assignment range", async () => {
    const store = new BioDeviceMappingStore(await mappingPath());

    await expect(store.reserve({ ...firstMapping, logicalAddress: 0x0000 })).rejects.toThrow(/logical address/i);
    await expect(store.reserve({ ...firstMapping, logicalAddress: 0x8000 })).rejects.toThrow(/logical address/i);
  });

  it("fails closed when a persisted mapping file is corrupt", async () => {
    const file = await mappingPath();
    await writeFile(file, "not-json");

    await expect(new BioDeviceMappingStore(file).listConfirmed()).rejects.toThrow(/invalid BIO device mapping/i);
  });
});
