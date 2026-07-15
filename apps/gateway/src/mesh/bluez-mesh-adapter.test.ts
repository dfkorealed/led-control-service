import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BluezMeshAdapter } from "./bluez-mesh-adapter";

function fixture() {
  const application = new EventEmitter();
  const transport = {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    call: vi.fn(async (_service: string, _path: string, _interfaceName: string, method: string, args: unknown[]) => {
      transport.calls.push({ method, args });
    })
  };
  const provisioner = {
    nodePath: "/org/bluez/mesh/node1",
    start: vi.fn(async () => undefined),
    scan: vi.fn(async () => [{ deviceUuid: "00112233445566778899aabbccddeeff", rssi: -48, oobCapability: "none" as const }]),
    provision: vi.fn(async () => ({ primaryUnicast: 0x0100, elementCount: 1 }))
  };
  const addresses = {
    findByFixtureId: vi.fn(async (fixtureId: string) => fixtureId === "fixture-1" ? {
      fixtureId, primaryUnicast: 0x0100, status: "confirmed" as const
    } : null)
  };
  const config = { configureNode: vi.fn(async () => ({ compositionPage: 0 })) };
  const transactions = { next: vi.fn(async () => 7) };
  return {
    application, transport, provisioner, addresses, config, transactions,
    adapter: new BluezMeshAdapter(transport, application, provisioner, addresses, () => config, transactions, {
      responseTimeoutMs: 100,
      scanSeconds: 1
    })
  };
}

describe("BluezMeshAdapter", () => {
  it("does not acknowledge brightness until a matching Lightness Status arrives", async () => {
    const f = fixture();
    const command = f.adapter.setBrightness(["fixture-1"], 50);
    await vi.waitFor(() => expect(f.transport.calls).toHaveLength(1));
    let settled = false;
    void command.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    f.application.emit("messageReceived", {
      source: 0x0100,
      data: Uint8Array.from([0x82, 0x4e, 0x00, 0x80])
    });
    await expect(command).resolves.toEqual([
      { fixtureId: "fixture-1", acknowledged: true, brightness: 50, rssi: null, hopCount: null }
    ]);
  });

  it("fails an unmapped fixture before sending", async () => {
    const f = fixture();
    await expect(f.adapter.setBrightness(["missing"], 60)).resolves.toMatchObject([
      { fixtureId: "missing", acknowledged: false, faultCode: "MESH_MAPPING_NOT_FOUND" }
    ]);
    expect(f.transport.call).not.toHaveBeenCalled();
  });

  it("normalizes scan and configures a provisioned node before completion", async () => {
    const f = fixture();
    await expect(f.adapter.scan({ sessionId: "session-1" } as never)).resolves.toMatchObject([
      { sessionId: "session-1", deviceUuid: "00112233445566778899aabbccddeeff", serialNumber: "00112233445566778899aabbccddeeff" }
    ]);
    await expect(f.adapter.provision({
      sessionId: "session-1",
      nodeId: "fixture-1",
      deviceUuid: "00112233445566778899aabbccddeeff",
      meshAddress: "0x0100"
    } as never)).resolves.toMatchObject({ nodeId: "fixture-1", meshAddress: "0x0100" });
    expect(f.config.configureNode).toHaveBeenCalledWith({ unicast: 0x0100, elementCount: 1 });
  });
});
