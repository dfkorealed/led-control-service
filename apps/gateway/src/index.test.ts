import { describe, expect, it, vi } from "vitest";
import { startGatewayRuntime } from "./index";

const assignment = {
  siteId: "site-27",
  gatewayId: "gateway-27",
  serialNumber: "GW-27",
  mqttUrl: "mqtts://broker.example:8883",
  configVersion: 1
};

describe("startGatewayRuntime", () => {
  it("fails closed before BlueZ and MQTT startup when the current MQTT identity has unsafe permissions", async () => {
    const createAdapters = vi.fn();
    const createMqtt = vi.fn();

    await expect(startGatewayRuntime({
      env: {},
      resolveAssignment: async () => assignment,
      ensureMqttIdentity: async () => { throw new Error("MQTT identity permissions are invalid"); },
      createAdapters,
      createMqtt
    })).rejects.toThrow("MQTT identity permissions are invalid");

    expect(createAdapters).not.toHaveBeenCalled();
    expect(createMqtt).not.toHaveBeenCalled();
  });

  it("starts BlueZ and MQTT only after the assigned MQTT identity is ready", async () => {
    const calls: string[] = [];
    const adapters = { dimming: {}, scanner: {}, provisioning: {} };
    const mqtt = {};

    await expect(startGatewayRuntime({
      env: { MQTT_URL: "mqtts://ignored.example:8883" },
      resolveAssignment: async () => { calls.push("assignment"); return assignment; },
      ensureMqttIdentity: async (received) => { calls.push("identity"); expect(received).toEqual(assignment); },
      createAdapters: (async () => { calls.push("bluez"); return adapters; }) as never,
      createMqtt: ((env: NodeJS.ProcessEnv) => { calls.push("mqtt"); expect(env.MQTT_URL).toBe(assignment.mqttUrl); return mqtt; }) as never
    })).resolves.toEqual({ assignment, adapters, client: mqtt });

    expect(calls).toEqual(["assignment", "identity", "bluez", "mqtt"]);
  });
});
