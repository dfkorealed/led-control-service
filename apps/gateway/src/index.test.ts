import { describe, expect, it, vi } from "vitest";
import {
  createMqttIdentityActivation,
  parseGatewayHeartbeatInterval,
  registerGatewayShutdownHandlers,
  shouldPublishFinalAcceptance,
  shouldPublishFixtureStates,
  startGatewayRuntime,
  subscribeGatewayCommands
} from "./index";

const assignment = {
  siteId: "site-27",
  gatewayId: "gateway-27",
  serialNumber: "GW-27",
  mqttUrl: "mqtts://broker.example:8883",
  configVersion: 1
};

describe("startGatewayRuntime", () => {
  it("stops the MQTT runtime before exiting for SIGTERM", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const stopRotation = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const unregister = registerGatewayShutdownHandlers({ stop } as never, { stop: stopRotation } as never, exit);

    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopRotation).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("rejects an invalid heartbeat interval before gateway startup", () => {
    expect(() => parseGatewayHeartbeatInterval("NaN")).toThrow("positive finite integer");
    expect(() => parseGatewayHeartbeatInterval("Infinity")).toThrow("positive finite integer");
    expect(() => parseGatewayHeartbeatInterval("0")).toThrow("positive finite integer");
  });

  it("subscribes command topics only when MQTT reports a new session", () => {
    const subscribe = vi.fn((_topics, _options, callback?: (error?: Error) => void) => callback?.());
    const client = { subscribe };

    subscribeGatewayCommands(client as never, assignment, false);
    subscribeGatewayCommands(client as never, assignment, true);

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(
      [
        "sites/site-27/gateways/gateway-27/commands/dimming",
        "sites/site-27/gateways/gateway-27/commands/provisioning-scan-start",
        "sites/site-27/gateways/gateway-27/commands/identify-device",
        "sites/site-27/gateways/gateway-27/commands/provision-device"
      ],
      { qos: 1 },
      expect.any(Function)
    );
  });

  it("does not publish fixture-state for a command result without fixture observation", () => {
    expect(shouldPublishFixtureStates({ fixtureStateObserved: false })).toBe(false);
    expect(shouldPublishFixtureStates({ fixtureStateObserved: true })).toBe(true);
  });

  it("publishes a terminal rejection after an earlier acceptance was published", () => {
    expect(shouldPublishFinalAcceptance(true, "accepted")).toBe(false);
    expect(shouldPublishFinalAcceptance(true, "rejected")).toBe(true);
    expect(shouldPublishFinalAcceptance(false, "accepted")).toBe(true);
  });

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
      createMqtt: ((env: NodeJS.ProcessEnv, identity: { gatewayId: string }) => {
        calls.push("mqtt");
        expect(env.MQTT_URL).toBe(assignment.mqttUrl);
        expect(identity).toEqual({ gatewayId: assignment.gatewayId });
        return mqtt;
      }) as never
    })).resolves.toEqual({ assignment, adapters, client: mqtt });

    expect(calls).toEqual(["assignment", "identity", "bluez", "mqtt"]);
  });

  it("creates a rotated MQTT client from the probed candidate paths before activating the runtime", async () => {
    const candidate = {
      generationPath: "/identity/mqtt/pending-generations/candidate",
      certificatePath: "/identity/mqtt/pending-generations/candidate/gateway.crt",
      keyPath: "/identity/mqtt/pending-generations/candidate/gateway.key",
      caPath: "/identity/mqtt/pending-generations/candidate/mqtt-ca.crt"
    };
    const client = {};
    const createMqtt = vi.fn(() => client);
    const runtime = { activate: vi.fn().mockResolvedValue(undefined) };

    const prepared = { candidate, commit: vi.fn(), rollback: vi.fn(), finalize: vi.fn(), isCommitted: vi.fn(() => false) };
    await createMqttIdentityActivation(assignment, { MQTT_URL: "mqtts://ignored.example:8883" }, runtime as never, createMqtt as never)(prepared);

    expect(createMqtt).toHaveBeenCalledWith({
      MQTT_URL: assignment.mqttUrl,
      MQTT_CA_PATH: candidate.caPath,
      MQTT_CLIENT_CERT_PATH: candidate.certificatePath,
      MQTT_CLIENT_KEY_PATH: candidate.keyPath
    }, { gatewayId: assignment.gatewayId }, { manualConnect: true });
    expect(runtime.activate).toHaveBeenCalledWith(client, prepared);
  });
});
