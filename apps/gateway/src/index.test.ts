import { describe, expect, it, vi } from "vitest";
import {
  createFixtureStatusPublisher,
  createMeshGroupResyncRequest,
  observedFixtureResults,
  publishObservedDeviceStates,
  createMqttIdentityActivation,
  parseGatewayHeartbeatInterval,
  recordMeshResyncOutcome,
  registerGatewayShutdownHandlers,
  shouldPublishFinalAcceptance,
  shouldPublishFixtureStates,
  startGatewayRuntime,
  subscribeGatewayCommands
} from "./index";

const scopedSiteId = "00000000-0000-4000-8000-000000000003";
const scopedGatewayId = "00000000-0000-4000-8000-000000000004";
const scopedFixtureId = "00000000-0000-4000-8000-000000000005";

const assignment = {
  siteId: "site-27",
  gatewayId: "gateway-27",
  serialNumber: "GW-27",
  mqttUrl: "mqtts://broker.example:8883",
  configVersion: 1
};

describe("startGatewayRuntime", () => {
  it("creates a strict startup mesh-group resync request", () => {
    expect(createMeshGroupResyncRequest(
      { siteId: scopedSiteId, gatewayId: scopedGatewayId },
      "state_missing",
      () => "2026-08-23T00:00:00.000Z",
      () => "11111111-1111-4111-8111-111111111111"
    )).toEqual({
      siteId: scopedSiteId,
      gatewayId: scopedGatewayId,
      eventId: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-08-23T00:00:00.000Z",
      reason: "state_missing"
    });
  });

  it("returns only applied and state-mismatch fixtures with actual observed brightness", () => {
    expect(observedFixtureResults({
      fixtureStateObserved: true,
      observedFixtureIds: [scopedFixtureId, "00000000-0000-4000-8000-000000000006"],
      deviceStatus: {
        results: [
          { fixtureId: scopedFixtureId, status: "failed", brightness: 31, faultCode: "state_mismatch" },
          { fixtureId: "00000000-0000-4000-8000-000000000006", status: "timed_out", faultCode: "status_timeout" }
        ]
      }
    } as never)).toEqual([
      { fixtureId: scopedFixtureId, status: "failed", brightness: 31, faultCode: "state_mismatch" }
    ]);
  });

  it("publishes fixture state only for the observed member of a partial command", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const next = vi.fn().mockResolvedValue(21);
    await publishObservedDeviceStates({
      siteId: scopedSiteId,
      gatewayId: scopedGatewayId,
      eventSequence: { next },
      publish,
      fallbackBrightness: 70,
      result: {
        fixtureStateObserved: true,
        observedFixtureIds: [scopedFixtureId],
        deviceStatus: {
          occurredAt: "2026-08-23T00:00:00.000Z",
          results: [
            { fixtureId: scopedFixtureId, status: "failed", brightness: 31, faultCode: "state_mismatch" },
            { fixtureId: "00000000-0000-4000-8000-000000000006", status: "timed_out", faultCode: "status_timeout" }
          ]
        }
      } as never
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      `sites/${scopedSiteId}/gateways/${scopedGatewayId}/state/fixtures`,
      expect.objectContaining({ fixtureId: scopedFixtureId, brightness: 31, powerOn: true, status: "fault" })
    );
  });
  it("publishes mapped Mesh status only on the assigned gateway v2 topic with a persisted sequence", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const next = vi.fn().mockResolvedValue(41);
    const publishFixtureStatus = createFixtureStatusPublisher({
      siteId: scopedSiteId,
      gatewayId: scopedGatewayId,
      eventSequence: { next },
      publish,
      now: () => "2026-08-11T00:00:00.000Z"
    });

    await publishFixtureStatus({
      fixtureId: scopedFixtureId,
      brightness: 75,
      powerOn: true,
      status: "fault",
      faultCode: "health:02e5:01",
      health: { faultCodes: [1], observedAt: "2026-08-10T23:59:59.000Z" },
      rssi: null,
      hopCount: null
    });

    expect(publish).toHaveBeenCalledWith(
      `sites/${scopedSiteId}/gateways/${scopedGatewayId}/state/fixtures`,
      expect.objectContaining({
        siteId: scopedSiteId,
        gatewayId: scopedGatewayId,
        fixtureId: scopedFixtureId,
        sequence: 41,
        occurredAt: "2026-08-11T00:00:00.000Z",
        health: { faultCodes: [1], observedAt: "2026-08-10T23:59:59.000Z" },
        statusReason: "mesh_publication"
      })
    );
  });

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
        "sites/site-27/gateways/gateway-27/commands/provision-device",
        "sites/site-27/gateways/gateway-27/commands/mesh-group/subscription-sync",
        "sites/site-27/gateways/gateway-27/commands/mesh-group/resync-ack"
      ],
      { qos: 1 },
      expect.any(Function)
    );
  });

  it("does not publish fixture-state for a command result without fixture observation", () => {
    expect(shouldPublishFixtureStates({ fixtureStateObserved: false })).toBe(false);
    expect(shouldPublishFixtureStates({ fixtureStateObserved: true })).toBe(true);
  });

  it("records and logs a mixed startup resync outcome", async () => {
    const health = { recordMeshResync: vi.fn().mockResolvedValue(undefined) };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const report = { total: 4, configured: 4, observed: 2, healthPending: 1, timedOut: 1, failed: 1 };

    await recordMeshResyncOutcome(health, report, logger);

    expect(health.recordMeshResync).toHaveBeenCalledWith(report);
    expect(JSON.parse(logger.info.mock.calls[0][0])).toEqual({ event: "mesh_resync", ...report });
    expect(JSON.parse(logger.warn.mock.calls[0][0])).toEqual({ event: "mesh_resync_incomplete", ...report });
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

    const prepared = {
      candidate,
      commit: vi.fn(),
      rollback: vi.fn(),
      finalize: vi.fn(),
      isCommitted: vi.fn(() => false),
      isCurrentCandidate: vi.fn(async () => false)
    };
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
