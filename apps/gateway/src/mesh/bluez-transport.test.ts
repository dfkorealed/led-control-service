import { describe, expect, it } from "vitest";
import { BluezTransport, BluezTransportError, type DbusBus } from "./bluez-transport";

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

describe("BluezTransport", () => {
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
