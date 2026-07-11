import { describe, expect, it } from "vitest";
import { createMqttConnectionOptions } from "./create-mqtt-client";

describe("createMqttConnectionOptions", () => {
  it("rejects plaintext MQTT in production", () => {
    expect(() => createMqttConnectionOptions({ NODE_ENV: "production", MQTT_URL: "mqtt://broker:1883" })).toThrow(
      "mqtts://"
    );
  });

  it("allows plaintext only for an explicit local profile", () => {
    expect(
      createMqttConnectionOptions({ MQTT_URL: "mqtt://localhost:1883", MQTT_ALLOW_INSECURE_LOCAL: "true" })
    ).toEqual({ url: "mqtt://localhost:1883", options: {} });
  });

  it("requires the CA and device certificate paths for TLS", () => {
    expect(() => createMqttConnectionOptions({ MQTT_URL: "mqtts://broker:8883" })).toThrow("MQTT_CA_PATH");
  });
});
