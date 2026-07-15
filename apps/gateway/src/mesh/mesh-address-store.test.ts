import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MeshAddressStore } from "./mesh-address-store";

describe("MeshAddressStore", () => {
  it("nodeId를 fixture 선할당 ID로 사용하고 동일 예약은 idempotent하다", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "mesh-address-")), "addresses.json");
    const store = new MeshAddressStore(file);
    const input = { nodeId: "fixture-1", deviceUuid: "00112233445566778899aabbccddeeff", meshAddress: "0x0101" };

    const first = await store.reserve(input);
    const second = await store.reserve(input);
    await store.confirm(input.deviceUuid, 0x0101, 2);

    expect(second).toEqual(first);
    await expect(store.findByFixtureId("fixture-1")).resolves.toEqual(
      expect.objectContaining({ primaryUnicast: 0x0101, elementCount: 2, status: "confirmed" })
    );
  });

  it("예약 또는 확정된 element 주소 범위 충돌을 거부한다", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "mesh-address-")), "addresses.json");
    const store = new MeshAddressStore(file);
    await store.reserve({ nodeId: "fixture-1", deviceUuid: "uuid-1", meshAddress: "0x0101" });
    await store.confirm("uuid-1", 0x0101, 2);

    await expect(
      store.reserve({ nodeId: "fixture-2", deviceUuid: "uuid-2", meshAddress: "0x0102" })
    ).rejects.toThrow(/address conflict/i);
  });

  it("RequestProvData 전에 실제 element 범위를 예약하고 충돌을 거부한다", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "mesh-address-")), "addresses.json");
    const store = new MeshAddressStore(file);
    await store.reserve({ nodeId: "fixture-1", deviceUuid: "uuid-1", meshAddress: "0x0100" });
    await store.reserve({ nodeId: "fixture-2", deviceUuid: "uuid-2", meshAddress: "0x0101" });

    await expect(store.prepareElementRange("uuid-1", 2)).rejects.toThrow(/address conflict/i);
    await expect(store.prepareElementRange("uuid-1", 1)).resolves.toMatchObject({ elementCount: 1 });
  });

  it("BlueZ가 예약과 다른 주소를 반환하면 mapping을 확정하지 않는다", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "mesh-address-")), "addresses.json");
    const store = new MeshAddressStore(file);
    await store.reserve({ nodeId: "fixture-1", deviceUuid: "uuid-1", meshAddress: "0x0101" });

    await expect(store.confirm("uuid-1", 0x0105, 1)).rejects.toThrow(/reserved address/i);
    await expect(store.findByFixtureId("fixture-1")).resolves.toEqual(expect.objectContaining({ status: "reserved" }));
  });

  it("손상된 mapping 파일은 fail-closed로 처리한다", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "mesh-address-")), "addresses.json");
    await writeFile(file, "not-json");
    await expect(new MeshAddressStore(file).findByFixtureId("fixture-1")).rejects.toThrow(/invalid mesh address/i);
  });
});
