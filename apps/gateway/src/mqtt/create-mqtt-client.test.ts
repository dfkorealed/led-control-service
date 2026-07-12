import { describe, expect, it } from "vitest";
import { createMqttConnectionOptions } from "./create-mqtt-client";

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
});
