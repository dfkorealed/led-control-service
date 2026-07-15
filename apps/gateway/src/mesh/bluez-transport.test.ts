import { describe, expect, it } from "vitest";
import {
  BluezTransport,
  BluezTransportError,
  normalizeDbusMethodReturn,
  type DbusBus
} from "./bluez-transport";

class FakeBus implements DbusBus {
  readonly calls: Array<{ service: string; path: string; interfaceName: string; method: string }> = [];

  async getInterface(service: string, path: string, interfaceName: string) {
    if (path === "/bad") throw new Error("unknown object path");

    return {
      Attach: async () => {
        this.calls.push({ service, path, interfaceName, method: "Attach" });
        return ["/org/bluez/mesh/node1", []];
      }
    };
  }
}

class CallbackBus implements DbusBus {
  async getInterface() {
    return {
      nodePath: "/org/bluez/mesh/node-callback",
      Attach(this: { nodePath: string }, _path: string, _token: bigint, callback: (error: Error | null, nodePath: string, config: unknown[]) => void) {
        callback(null, this.nodePath, []);
      }
    };
  }
}

describe("BluezTransport", () => {
  it("flattens the two-value RequestProvData reply for dbus-native", () => {
    expect(normalizeDbusMethodReturn({ type: 2, signature: "qq", body: [[0, 0x0100]] })).toEqual({
      type: 2,
      signature: "qq",
      body: [0, 0x0100]
    });
  });

  it("reuses one long-running D-Bus session", async () => {
    const bus = new FakeBus();
    let createdCount = 0;
    const transport = new BluezTransport(() => {
      createdCount += 1;
      return bus;
    });

    await transport.call("org.bluez.mesh", "/org/bluez/mesh", "org.bluez.mesh.Network1", "Attach", []);
    await transport.call("org.bluez.mesh", "/org/bluez/mesh", "org.bluez.mesh.Network1", "Attach", []);

    expect(createdCount).toBe(1);
    expect(bus.calls).toHaveLength(2);
  });

  it("promisifies native callback methods and preserves multiple return values", async () => {
    const transport = new BluezTransport(() => new CallbackBus());
    await expect(
      transport.call("org.bluez.mesh", "/org/bluez/mesh", "org.bluez.mesh.Network1", "Attach", ["/app", 1n])
    ).resolves.toEqual(["/org/bluez/mesh/node-callback", []]);
  });

  it("maps D-Bus failures to a stable gateway error", async () => {
    const transport = new BluezTransport(() => new FakeBus());

    await expect(transport.call("org.bluez.mesh", "/bad", "org.bluez.mesh.Network1", "Attach", [])).rejects.toEqual(
      expect.objectContaining<Partial<BluezTransportError>>({
        name: "BluezTransportError",
        code: "BLUEZ_DBUS_ERROR"
      })
    );
  });
});
