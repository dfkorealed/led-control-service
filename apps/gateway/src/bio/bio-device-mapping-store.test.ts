import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  observedLogicalAddressBeforeAssignment: 0x1234,
  commandId: "command-1",
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

    await expect(store.reserve({ ...firstMapping, commandId: "command-2", fixtureId: "fixture-2" })).rejects.toThrow(/identity conflict/i);
    await expect(store.reserve({ ...firstMapping, commandId: "command-2", fixtureId: "fixture-2", nodeId: "node-2" })).rejects.toThrow(
      /identity conflict/i
    );
    await expect(store.reserve({ ...firstMapping, commandId: "command-2", nodeId: "node-2", deviceUuid: "bio:001122334455" })).rejects.toThrow(
      /identity conflict/i
    );
    await expect(
      store.reserve({ ...firstMapping, commandId: "command-2", fixtureId: "fixture-2", nodeId: "node-2", deviceUuid: "bio:001122334455", nativeUuid: "001122334455" })
    ).rejects.toThrow(/address conflict/i);
    await expect(
      store.reserve({ ...firstMapping, commandId: "command-2", fixtureId: "fixture-2", deviceUuid: "bio:001122334455", nativeUuid: "001122334455", logicalAddress: 0x0102 })
    ).rejects.toThrow(/identity conflict/i);
  });

  it("returns an identical reservation for the same command without rewriting the v2 journal", async () => {
    const store = new BioDeviceMappingStore(await mappingPath());
    const first = await store.reserve(firstMapping);

    await expect(store.reserve(firstMapping)).resolves.toEqual(first);
  });

  it("writes the observed pre-assignment address on every v2 reserved row", async () => {
    const file = await mappingPath();
    const store = new BioDeviceMappingStore(file, () => new Date("2026-09-13T00:00:00.000Z"));

    await store.reserve(firstMapping);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 2,
      mappings: [{
        ...firstMapping,
        status: "reserved",
        updatedAt: "2026-09-13T00:00:00.000Z"
      }]
    });
  });

  it("rejects altered reservations that reuse a command, UUID, or requested address", async () => {
    const store = new BioDeviceMappingStore(await mappingPath());
    await store.reserve(firstMapping);

    await expect(store.reserve({ ...firstMapping, logicalAddress: 0x0102 }))
      .rejects.toThrow(/command|identity conflict/i);
    await expect(store.reserve({ ...firstMapping, commandId: "command-2", fixtureId: "fixture-2", nodeId: "node-2" }))
      .rejects.toThrow(/identity conflict/i);
    await expect(store.reserve({
      ...firstMapping,
      commandId: "command-2",
      fixtureId: "fixture-2",
      nodeId: "node-2",
      deviceUuid: "bio:001122334455",
      nativeUuid: "001122334455"
    })).rejects.toMatchObject({ code: "BIO_ADDRESS_CONFLICT" });
  });

  it("loads a v1 confirmed row safely and migrates subsequent writes to v2", async () => {
    const file = await mappingPath();
    const legacy = {
      version: 1,
      mappings: [{
        fixtureId: "fixture-legacy",
        nodeId: "node-legacy",
        deviceUuid: "bio:010203040506",
        nativeUuid: "010203040506",
        logicalAddress: 0x0020,
        firmware: "1.0.0",
        protocol: "crc16",
        status: "confirmed",
        updatedAt: "2026-09-12T00:00:00.000Z"
      }]
    };
    await writeFile(file, JSON.stringify(legacy));
    const store = new BioDeviceMappingStore(file);

    await expect(store.findByFixtureId("fixture-legacy")).resolves.toEqual(legacy.mappings[0]);
    await store.reserve({
      ...firstMapping,
      fixtureId: "fixture-2",
      nodeId: "node-2",
      commandId: "command-2",
      logicalAddress: 0x0102
    });

    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 2 });
    const restarted = new BioDeviceMappingStore(file);
    await expect(restarted.findByFixtureId("fixture-legacy")).resolves.toEqual(legacy.mappings[0]);
    await expect(restarted.listConfirmed()).resolves.toHaveLength(1);
  });

  it("treats a v1 reserved row as unknown address state instead of guessing its old address", async () => {
    const file = await mappingPath();
    const { observedLogicalAddressBeforeAssignment: _observed, commandId: _commandId, ...legacyMapping } = firstMapping;
    await writeFile(file, JSON.stringify({
      version: 1,
      mappings: [{ ...legacyMapping, status: "reserved", updatedAt: "2026-09-12T00:00:00.000Z" }]
    }));

    await expect(new BioDeviceMappingStore(file).validate())
      .rejects.toMatchObject({ code: "BIO_ADDRESS_STATE_UNKNOWN" });
  });

  it("rejects re-reservation with changed firmware metadata", async () => {
    const store = new BioDeviceMappingStore(await mappingPath());
    await store.reserve(firstMapping);

    await expect(store.reserve({ ...firstMapping, firmware: "1.2.4" })).rejects.toThrow(/command conflict/i);
  });

  it("rejects re-reservation with changed protocol metadata", async () => {
    const store = new BioDeviceMappingStore(await mappingPath());
    await store.reserve(firstMapping);

    await expect(store.reserve({ ...firstMapping, protocol: "55aa-v1" })).rejects.toThrow(/command conflict/i);
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
