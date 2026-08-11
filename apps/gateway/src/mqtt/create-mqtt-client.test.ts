import { describe, expect, it, vi } from "vitest";
import { createMqttConnectionOptions } from "./create-mqtt-client";

vi.mock("node:fs", () => ({ readFileSync: vi.fn(() => Buffer.from("test-certificate")) }));

describe("createMqttConnectionOptions", () => {
  it("rejects plaintext MQTT in production", () => {
    expect(() => createMqttConnectionOptions({ NODE_ENV: "production", MQTT_URL: "mqtt://broker:1883" })).toThrow(
      "mqtts://"
    );
  });

  it("rejects plaintext even when a legacy local override is set", () => {
    expect(() =>
      createMqttConnectionOptions({ MQTT_URL: "mqtt://localhost:1883", MQTT_ALLOW_INSECURE_LOCAL: "true" })
    ).toThrow("mqtts://");
  });

  it("requires the CA and device certificate paths for TLS", () => {
    expect(() => createMqttConnectionOptions({ MQTT_URL: "mqtts://broker:8883" })).toThrow("MQTT_CA_PATH");
  });

  it("uses the assigned gateway ID for a durable MQTT 5 session", () => {
    const { options } = createMqttConnectionOptions(
      {
        MQTT_URL: "mqtts://broker:8883",
        MQTT_CA_PATH: "/certs/ca.crt",
        MQTT_CLIENT_CERT_PATH: "/certs/gateway.crt",
        MQTT_CLIENT_KEY_PATH: "/certs/gateway.key"
      },
      { gatewayId: "55555555-5555-4555-8555-555555555555" }
    );

    expect(options).toMatchObject({
      clientId: "gateway-55555555-5555-4555-8555-555555555555",
      clean: false,
      resubscribe: false,
      protocolVersion: 5,
      properties: { sessionExpiryInterval: 604800 }
    });
  });
});
