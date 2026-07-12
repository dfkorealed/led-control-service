import { describe, expect, it, vi } from "vitest";
import { resolveGatewayAssignment } from "./resolve-assignment";

const stored = {
  siteId: "site-stored",
  gatewayId: "gateway-stored",
  serialNumber: "GW-STORED",
  mqttUrl: "mqtts://stored:8883",
  configVersion: 1
};

describe("resolveGatewayAssignment", () => {
  it("prefers a previously stored assignment", async () => {
    const store = { read: vi.fn().mockResolvedValue(stored), writeAtomic: vi.fn() };
    await expect(resolveGatewayAssignment({ env: {}, store })).resolves.toEqual(stored);
    expect(store.writeAtomic).not.toHaveBeenCalled();
  });

  it("rejects legacy direct identifiers even when the old test flag is set", async () => {
    const store = { read: vi.fn().mockResolvedValue(null), writeAtomic: vi.fn() };
    await expect(
      resolveGatewayAssignment({
        env: {
          GATEWAY_TEST_MODE: "true",
          GATEWAY_SITE_ID: "site-test",
          GATEWAY_ID: "gateway-test",
          GATEWAY_SERIAL: "GW-TEST",
          MQTT_URL: "mqtt://localhost:1883"
        },
        store
      })
    ).rejects.toThrow("manufacturing credential");
  });

  it("rejects legacy identifiers in production without manufacturing credentials", async () => {
    const store = { read: vi.fn().mockResolvedValue(null), writeAtomic: vi.fn() };
    await expect(
      resolveGatewayAssignment({ env: { GATEWAY_SITE_ID: "site-unsafe", GATEWAY_ID: "gateway-unsafe" }, store })
    ).rejects.toThrow("manufacturing credential");
  });

  it("persists an assignment returned by bootstrap", async () => {
    const store = { read: vi.fn().mockResolvedValue(null), writeAtomic: vi.fn() };
    const bootstrapClient = { fetchAssignment: vi.fn().mockResolvedValue(stored) };

    await expect(
      resolveGatewayAssignment({ env: manufacturingEnv(), store, bootstrapClient, sleep: vi.fn() })
    ).resolves.toEqual(stored);
    expect(store.writeAtomic).toHaveBeenCalledWith(stored);
  });
});

function manufacturingEnv() {
  return {
    GATEWAY_SERIAL: "GW-STORED",
    GATEWAY_BOOTSTRAP_URL: "https://api.example/gateway-bootstrap",
    GATEWAY_DEVICE_CERT_PATH: "/device.crt",
    GATEWAY_DEVICE_KEY_PATH: "/device.key",
    GATEWAY_BOOTSTRAP_CA_PATH: "/ca.crt"
  };
}
