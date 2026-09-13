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

  it("one-shot rejects unclaimed after exactly one request without sleeping or writing", async () => {
    const store = { read: vi.fn().mockResolvedValue(null), writeAtomic: vi.fn() };
    const bootstrapClient = { fetchAssignment: vi.fn().mockResolvedValue(null) };
    const sleep = vi.fn().mockRejectedValue(new Error("retry must not run"));
    await expect(resolveGatewayAssignment({ env: manufacturingEnv(), store, bootstrapClient, sleep,
      once: true })).rejects.toThrow("gateway is not claimed");
    expect(bootstrapClient.fetchAssignment).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(store.writeAtomic).not.toHaveBeenCalled();
  });

  it.each(["stored", "remote"])("rejects wrong %s assignment before writing or issuing", async (source) => {
    const store = { read: vi.fn().mockResolvedValue(source === "stored" ? stored : null), writeAtomic: vi.fn() };
    const bootstrapClient = { fetchAssignment: vi.fn().mockResolvedValue(stored) };
    await expect(resolveGatewayAssignment({ env: manufacturingEnv(), store, bootstrapClient, once: true,
      expected: { serialNumber: "NEW", siteId: "new-site", gatewayId: "new-gateway" }
    })).rejects.toThrow("gateway assignment scope mismatch");
    expect(store.writeAtomic).not.toHaveBeenCalled();
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
