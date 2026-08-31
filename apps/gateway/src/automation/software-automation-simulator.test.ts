import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  attachSoftwareAutomationSimulatorIpc,
  createSoftwareAutomationSimulator,
  createSoftwareAutomationSimulatorFromEnvironment,
} from "./software-automation-simulator";

describe("createSoftwareAutomationSimulator", () => {
  it("fails closed when production attempts to enable the simulator", () => {
    expect(() => createSoftwareAutomationSimulator({ nodeEnv: "production", enabled: true })).toThrow(
      "software automation simulator is forbidden in production",
    );
  });

  it.each([
    { nodeEnv: "test", enabled: false },
    { nodeEnv: "development", enabled: true },
    { nodeEnv: undefined, enabled: true },
  ])("stays disabled outside the explicit test environment: %o", ({ nodeEnv, enabled }) => {
    expect(createSoftwareAutomationSimulator({ nodeEnv, enabled })).toBeNull();
  });

  it("implements dimming and private sensor input through the Gateway adapter contracts", async () => {
    const simulator = createSoftwareAutomationSimulator({
      nodeEnv: "test",
      enabled: true,
      fixtures: [
        { fixtureId: "target-1" },
        {
          fixtureId: "sensor-1",
          vehicleSensor: { meshNodeId: "mesh-node-1", primaryUnicast: 0x1201 },
        },
      ],
    });
    expect(simulator).not.toBeNull();
    if (!simulator) throw new Error("explicit test simulator was not created");

    const observations: Array<{ fixtureId: string; brightness: number }> = [];
    simulator.adapters.dimming.onLightingObservation(({ fixtureId, brightness }) => {
      observations.push({ fixtureId, brightness });
    });
    const reports = await simulator.adapters.dimming.setBrightness(["target-1"], 40);

    expect(reports).toEqual([
      {
        fixtureId: "target-1",
        acknowledged: true,
        outcome: "applied",
        brightness: 40,
        rssi: -42,
        hopCount: 1,
      },
    ]);
    expect(observations).toEqual([{ fixtureId: "target-1", brightness: 40 }]);
    await expect(simulator.clockTrust.isTrusted(new Date("2026-08-31T00:00:00.000Z"))).resolves.toBe(true);

    const sensorMessages: Array<{ sourceUnicast: number; data: number[] }> = [];
    simulator.adapters.vehicleSensors.onMessage((sourceUnicast, data) => {
      sensorMessages.push({ sourceUnicast, data: [...data] });
    });
    await simulator.injectSensorEdge("sensor-1", "detected");
    await simulator.injectSensorEdge("sensor-1", "cleared");

    expect(sensorMessages).toEqual([
      { sourceUnicast: 0x1201, data: [0x52, 0xa0, 0x09, 0x01] },
      { sourceUnicast: 0x1201, data: [0x52, 0xa0, 0x09, 0x00] },
    ]);
  });

  it("accepts sensor edges only through an authenticated child IPC message", async () => {
    const simulator = createSoftwareAutomationSimulator({
      nodeEnv: "test",
      enabled: true,
      fixtures: [{
        fixtureId: "sensor-1",
        vehicleSensor: { meshNodeId: "mesh-node-1", primaryUnicast: 0x1201 },
      }],
    });
    if (!simulator) throw new Error("explicit test simulator was not created");
    const processChannel = new EventEmitter() as EventEmitter & {
      connected: boolean;
      send(message: unknown): boolean;
    };
    processChannel.connected = true;
    const response = new Promise<unknown>((resolve) => {
      processChannel.send = (message) => {
        resolve(message);
        return true;
      };
    });
    const messages: number[][] = [];
    simulator.adapters.vehicleSensors.onMessage((_sourceUnicast, data) => messages.push([...data]));
    const detach = attachSoftwareAutomationSimulatorIpc(simulator, processChannel, "private-token");

    processChannel.emit("message", {
      type: "automation-e2e-sensor-edge",
      token: "private-token",
      requestId: "edge-1",
      fixtureId: "sensor-1",
      edge: "detected",
    });

    await expect(response).resolves.toEqual({
      type: "automation-e2e-sensor-edge-result",
      requestId: "edge-1",
      ok: true,
    });
    expect(messages).toEqual([[0x52, 0xa0, 0x09, 0x01]]);
    detach();
  });

  it("reads simulator fixtures only when both exact E2E environment switches are set", async () => {
    expect(createSoftwareAutomationSimulatorFromEnvironment({
      NODE_ENV: "development",
      AUTOMATION_E2E_SIMULATOR: "1",
      AUTOMATION_E2E_SIMULATOR_FIXTURES: "not-json",
    })).toBeNull();

    const simulator = createSoftwareAutomationSimulatorFromEnvironment({
      NODE_ENV: "test",
      AUTOMATION_E2E_SIMULATOR: "1",
      AUTOMATION_E2E_SIMULATOR_FIXTURES: JSON.stringify([{
        fixtureId: "sensor-1",
        vehicleSensor: { meshNodeId: "mesh-node-1", primaryUnicast: 0x1201 },
      }]),
    });
    if (!simulator) throw new Error("explicit test simulator was not created");

    expect(await simulator.adapters.vehicleSensors.listConfirmedSources()).toEqual([{
      fixtureId: "sensor-1",
      meshNodeId: "mesh-node-1",
      primaryUnicast: 0x1201,
      elementCount: 1,
    }]);
  });
});
