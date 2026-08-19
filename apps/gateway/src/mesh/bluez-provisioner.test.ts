import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BLUEZ_APPLICATION_PATHS } from "./bluez-dbus-application";
import { BluezProvisioner } from "./bluez-provisioner";

class FakeApplication extends EventEmitter {
  start = vi.fn(async () => undefined);
}

class FakeTransport {
  calls: Array<{ path: string; interfaceName: string; method: string; args: unknown[] }> = [];
  responses = new Map<string, unknown>();

  async call<T>(_service: string, path: string, interfaceName: string, method: string, args: unknown[]): Promise<T> {
    this.calls.push({ path, interfaceName, method, args });
    const key = `${interfaceName}.${method}`;
    const response = this.responses.get(key);
    if (response instanceof Error) throw response;
    return response as T;
  }
}

class FakeIdentityStore {
  identity: { uuid: Uint8Array; token?: bigint } = { uuid: Uint8Array.from({ length: 16 }, (_, index) => index) };
  saveToken = vi.fn(async (token: bigint) => {
    this.identity.token = token;
  });
  loadOrCreate = vi.fn(async () => this.identity);
}

class FakeAddressStore {
  reservation = { primaryUnicast: 0x0100 };
  reserve = vi.fn(async () => this.reservation);
  confirm = vi.fn(async () => ({ fixtureId: "node-1" }));
}

function createFixture(options: { logger?: { info(message: string): void } } = {}) {
  const application = new FakeApplication();
  const transport = new FakeTransport();
  const identity = new FakeIdentityStore();
  const addresses = new FakeAddressStore();
  return {
    application,
    transport,
    identity,
    addresses,
    provisioner: new BluezProvisioner(
      transport,
      application,
      identity,
      addresses,
      { provisioningTimeoutMs: 100, ...options }
    )
  };
}

describe("BluezProvisioner", () => {
  it("creates a network once, persists its token, and attaches the application", async () => {
    const fixture = createFixture();
    fixture.transport.responses.set("org.bluez.mesh.Network1.Attach", ["/org/bluez/mesh/node1", []]);

    const start = fixture.provisioner.start();
    await vi.waitFor(() => expect(fixture.transport.calls[0]?.method).toBe("CreateNetwork"));
    fixture.application.emit("joinComplete", { token: { low: 0x1234, high: 0, unsigned: true } });
    await start;

    expect(fixture.application.start).toHaveBeenCalledOnce();
    expect(fixture.identity.saveToken).toHaveBeenCalledWith(0x1234n);
    expect(fixture.transport.calls.map((call) => call.method)).toEqual(["CreateNetwork", "Attach"]);
    expect(fixture.transport.calls[0]?.args).toEqual([BLUEZ_APPLICATION_PATHS.root, Array.from(fixture.identity.identity.uuid)]);
    expect(fixture.provisioner.nodePath).toBe("/org/bluez/mesh/node1");
  });

  it("attaches immediately when a persisted token exists", async () => {
    const fixture = createFixture();
    fixture.identity.identity.token = 99n;
    fixture.transport.responses.set("org.bluez.mesh.Network1.Attach", ["/org/bluez/mesh/node99", []]);

    await fixture.provisioner.start();

    expect(fixture.transport.calls.map((call) => call.method)).toEqual(["Attach"]);
    expect(fixture.transport.calls[0]?.args).toEqual([BLUEZ_APPLICATION_PATHS.root, "99"]);
  });

  it("deduplicates scan results by UUID and keeps the strongest RSSI", async () => {
    const fixture = createFixture();
    fixture.identity.identity.token = 1n;
    fixture.transport.responses.set("org.bluez.mesh.Network1.Attach", ["/org/bluez/mesh/node1", []]);
    await fixture.provisioner.start();

    const scan = fixture.provisioner.scan(1);
    await vi.waitFor(() => expect(fixture.transport.calls.some((call) => call.method === "UnprovisionedScan")).toBe(true));
    const uuid = Uint8Array.from(Buffer.from("44464b4c454401010101aabbccddeeff", "hex"));
    fixture.application.emit("scanResult", { rssi: -70, data: uuid, options: [] });
    fixture.application.emit("scanResult", { rssi: -45, data: Uint8Array.from([...uuid, 0, 0]), options: [] });

    await expect(scan).resolves.toEqual([
      { deviceUuid: Buffer.from(uuid).toString("hex"), rssi: -45, oobCapability: "none" }
    ]);
  });

  it("ignores third-party UUIDs and only returns DFK product identities", async () => {
    const logger = { info: vi.fn() };
    const fixture = createFixture({ logger });
    fixture.identity.identity.token = 1n;
    fixture.transport.responses.set("org.bluez.mesh.Network1.Attach", ["/org/bluez/mesh/node1", []]);
    await fixture.provisioner.start();

    const scan = fixture.provisioner.scan(1);
    await vi.waitFor(() => expect(fixture.transport.calls.some((call) => call.method === "UnprovisionedScan")).toBe(true));
    fixture.application.emit("scanResult", {
      rssi: -30,
      data: Uint8Array.from(Buffer.from("00112233445566778899aabbccddeeff", "hex")),
      options: []
    });
    fixture.application.emit("scanResult", {
      rssi: -60,
      data: Uint8Array.from(Buffer.from("44464b4c454401010101aabbccddeeff", "hex")),
      options: []
    });

    await expect(scan).resolves.toEqual([{
      deviceUuid: "44464b4c454401010101aabbccddeeff",
      rssi: -60,
      oobCapability: "none"
    }]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"reason":"unsupported_product_identity"'));
  });

  it("reserves and confirms the requested address after AddNodeComplete", async () => {
    const fixture = createFixture();
    fixture.identity.identity.token = 1n;
    fixture.transport.responses.set("org.bluez.mesh.Network1.Attach", ["/org/bluez/mesh/node1", []]);
    await fixture.provisioner.start();
    const uuidHex = "00112233445566778899aabbccddeeff";

    const provision = fixture.provisioner.provision({ nodeId: "node-1", deviceUuid: uuidHex, meshAddress: "0x0100" });
    await vi.waitFor(() => expect(fixture.transport.calls.some((call) => call.method === "AddNode")).toBe(true));
    fixture.application.emit("nodeAdded", {
      uuid: Uint8Array.from(Buffer.from(uuidHex, "hex")),
      unicast: 0x0100,
      count: 2
    });

    await expect(provision).resolves.toEqual({ primaryUnicast: 0x0100, elementCount: 2 });
    expect(fixture.addresses.reserve).toHaveBeenCalledWith({ nodeId: "node-1", deviceUuid: uuidHex, meshAddress: "0x0100" });
    expect(fixture.addresses.confirm).toHaveBeenCalledWith(uuidHex, 0x0100, 2);
  });

  it("rejects concurrent AddNode and propagates BlueZ failure", async () => {
    const fixture = createFixture();
    fixture.identity.identity.token = 1n;
    fixture.transport.responses.set("org.bluez.mesh.Network1.Attach", ["/org/bluez/mesh/node1", []]);
    await fixture.provisioner.start();
    const first = fixture.provisioner.provision({
      nodeId: "node-1",
      deviceUuid: "00112233445566778899aabbccddeeff",
      meshAddress: "0x0100"
    });
    await expect(
      fixture.provisioner.provision({
        nodeId: "node-2",
        deviceUuid: "ffeeddccbbaa99887766554433221100",
        meshAddress: "0x0200"
      })
    ).rejects.toThrow("already in progress");
    fixture.application.emit("nodeAddFailed", {
      uuid: Uint8Array.from(Buffer.from("00112233445566778899aabbccddeeff", "hex")),
      reason: "timeout"
    });
    await expect(first).rejects.toThrow("timeout");
  });
});
