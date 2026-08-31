import type { GatewayAdapters } from "../adapters/adapter-factory";
import type {
  BleMeshCommandReport,
  BleMeshFixtureStatus,
  BleMeshLightingObservation,
  BleMeshResyncReport,
} from "../gateway";
import type { ClockTrustProvider } from "./clock-trust-provider";

export type SoftwareAutomationSensorEdge = "detected" | "cleared";

export interface SoftwareAutomationSimulatorFixture {
  fixtureId: string;
  vehicleSensor?: {
    meshNodeId: string;
    primaryUnicast: number;
  };
}

export interface SoftwareAutomationSimulator {
  adapters: GatewayAdapters;
  clockTrust: ClockTrustProvider;
  wallClock(): Date;
  monotonicClock(): number;
  advanceClock(advanceMs: number): { wallClockMs: number; monotonicMs: number };
  injectSensorEdge(fixtureId: string, edge: SoftwareAutomationSensorEdge): Promise<void>;
}

interface SoftwareAutomationSimulatorIpcChannel {
  connected?: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
  send?(message: unknown): boolean;
}

export function createSoftwareAutomationSimulator(options: {
  nodeEnv: string | undefined;
  enabled: boolean;
  fixtures?: SoftwareAutomationSimulatorFixture[];
}): SoftwareAutomationSimulator | null {
  if (options.nodeEnv === "production" && options.enabled) {
    throw new Error("software automation simulator is forbidden in production");
  }
  if (options.nodeEnv !== "test" || !options.enabled) return null;

  const fixtures = new Map(
    (options.fixtures ?? []).map((fixture) => [fixture.fixtureId, { ...fixture, brightness: 0 }]),
  );
  const fixtureStatusListeners = new Set<(status: BleMeshFixtureStatus) => void>();
  const lightingObservationListeners = new Set<(observation: BleMeshLightingObservation) => void>();
  const sensorListeners = new Set<(sourceUnicast: number, data: Uint8Array) => void>();
  let clockOffsetMs = 0;
  const wallClock = () => new Date(Date.now() + clockOffsetMs);
  const monotonicClock = () => performance.now() + clockOffsetMs;

  const applyBrightness = async (fixtureIds: string[], brightness: number): Promise<BleMeshCommandReport[]> => {
    const reports: BleMeshCommandReport[] = [];
    for (const fixtureId of fixtureIds) {
      const fixture = fixtures.get(fixtureId);
      if (!fixture) throw new Error(`software automation fixture is not configured: ${fixtureId}`);
      fixture.brightness = brightness;
      const observedAt = wallClock().toISOString();
      const report = {
        fixtureId,
        acknowledged: true,
        outcome: "applied" as const,
        brightness,
        rssi: -42,
        hopCount: 1,
      };
      reports.push(report);
      for (const listener of lightingObservationListeners) {
        listener({ fixtureId, brightness, powerOn: brightness > 0, observedAt });
      }
      for (const listener of fixtureStatusListeners) {
        listener({
          fixtureId,
          brightness,
          powerOn: brightness > 0,
          status: "online",
          health: { faultCodes: [], observedAt },
          rssi: report.rssi,
          hopCount: report.hopCount,
        });
      }
    }
    return reports;
  };

  const emitCurrentFixtures = (fixtureIds: string[]): BleMeshResyncReport => {
    for (const fixtureId of fixtureIds) {
      const fixture = fixtures.get(fixtureId);
      if (!fixture) continue;
      const observedAt = wallClock().toISOString();
      const status = {
        fixtureId,
        brightness: fixture.brightness,
        powerOn: fixture.brightness > 0,
        status: "online" as const,
        health: { faultCodes: [], observedAt },
        rssi: -42,
        hopCount: 1,
      };
      for (const listener of fixtureStatusListeners) listener(status);
      for (const listener of lightingObservationListeners) {
        listener({
          fixtureId,
          brightness: fixture.brightness,
          powerOn: fixture.brightness > 0,
          observedAt,
        });
      }
    }
    return {
      total: fixtureIds.length,
      configured: fixtureIds.length,
      observed: fixtureIds.length,
      healthPending: 0,
      timedOut: 0,
      failed: 0,
    };
  };

  const adapters: GatewayAdapters = {
    dimming: {
      setBrightness: applyBrightness,
      applyUnicast: async (fixtureId, brightness) => (await applyBrightness([fixtureId], brightness))[0]!,
      applyParallelUnicast: (fixtureIds, brightness) => applyBrightness(fixtureIds, brightness),
      applyMeshGroup: (_groupAddress, fixtureIds, brightness) => applyBrightness(fixtureIds, brightness),
      onFixtureStatus(listener) {
        fixtureStatusListeners.add(listener);
        return () => fixtureStatusListeners.delete(listener);
      },
      onLightingObservation(listener) {
        lightingObservationListeners.add(listener);
        return () => lightingObservationListeners.delete(listener);
      },
      async resyncFixtureStates() {
        return emitCurrentFixtures([...fixtures.keys()]);
      },
      async resyncLightingFixtures(fixtureIds) {
        return emitCurrentFixtures(fixtureIds);
      },
      async syncGroupSubscriptions(command) {
        return {
          siteId: command.siteId,
          gatewayId: command.gatewayId,
          groupId: command.groupId,
          version: command.version,
          groupAddress: command.groupAddress,
          occurredAt: new Date().toISOString(),
          operations: command.expectedOperations.map((operation) => ({ ...operation, status: "ready" as const })),
        };
      },
    },
    scanner: { async scan() { return []; } },
    provisioning: {
      async identify() {},
      async provision(command) {
        return {
          sessionId: command.sessionId,
          nodeId: command.nodeId,
          deviceUuid: command.deviceUuid,
          meshAddress: command.meshAddress,
          firmwareVersion: "software-automation-simulator",
          rssi: -42,
          hopCount: 1,
          completedAt: new Date().toISOString(),
        };
      },
    },
    vehicleSensors: {
      async listConfirmedSources() {
        return [...fixtures.values()].flatMap((fixture) => fixture.vehicleSensor ? [{
          fixtureId: fixture.fixtureId,
          meshNodeId: fixture.vehicleSensor.meshNodeId,
          primaryUnicast: fixture.vehicleSensor.primaryUnicast,
          elementCount: 1,
        }] : []);
      },
      async resolveByFixtureId(fixtureId) {
        const fixture = fixtures.get(fixtureId);
        return fixture?.vehicleSensor ? {
          fixtureId,
          meshNodeId: fixture.vehicleSensor.meshNodeId,
          primaryUnicast: fixture.vehicleSensor.primaryUnicast,
        } : null;
      },
      async resolveBySourceUnicast(sourceUnicast) {
        const fixture = [...fixtures.values()].find((candidate) =>
          candidate.vehicleSensor?.primaryUnicast === sourceUnicast);
        return fixture?.vehicleSensor ? {
          fixtureId: fixture.fixtureId,
          meshNodeId: fixture.vehicleSensor.meshNodeId,
          primaryUnicast: fixture.vehicleSensor.primaryUnicast,
        } : null;
      },
      async configureSource() {
        return { sensorServerBound: true, vendorVehicleEventModelBound: true };
      },
      async send() {},
      onMessage(listener) {
        sensorListeners.add(listener);
        return () => sensorListeners.delete(listener);
      },
    },
    healthProbes: {
      async dbusOwner() { return true; },
      async bluezAttached() { return true; },
      async mappingValid() { return true; },
    },
  };

  return {
    adapters,
    clockTrust: { async isTrusted() { return true; } },
    wallClock,
    monotonicClock,
    advanceClock(advanceMs) {
      if (!Number.isInteger(advanceMs) || advanceMs < 0 || advanceMs > 86_400_000) {
        throw new Error("software automation clock advance must be an integer from 0 to 86400000ms");
      }
      clockOffsetMs += advanceMs;
      return { wallClockMs: wallClock().getTime(), monotonicMs: monotonicClock() };
    },
    async injectSensorEdge(fixtureId, edge) {
      const fixture = fixtures.get(fixtureId);
      if (!fixture?.vehicleSensor) {
        throw new Error(`software automation sensor is not configured: ${fixtureId}`);
      }
      const value = edge === "detected" ? 1 : 0;
      const status = Uint8Array.from([0x52, 0xa0, 0x09, value]);
      for (const listener of sensorListeners) listener(fixture.vehicleSensor.primaryUnicast, status);
    },
  };
}

export function createSoftwareAutomationSimulatorFromEnvironment(env: NodeJS.ProcessEnv) {
  const enabled = env.AUTOMATION_E2E_SIMULATOR === "1";
  if (env.NODE_ENV !== "test" || !enabled) {
    return createSoftwareAutomationSimulator({ nodeEnv: env.NODE_ENV, enabled });
  }
  return createSoftwareAutomationSimulator({
    nodeEnv: env.NODE_ENV,
    enabled,
    fixtures: parseSimulatorFixtures(env.AUTOMATION_E2E_SIMULATOR_FIXTURES),
  });
}

export function attachSoftwareAutomationSimulatorIpc(
  simulator: SoftwareAutomationSimulator,
  channel: SoftwareAutomationSimulatorIpcChannel,
  token: string,
  options: { onClockAdvanced?: () => Promise<void> } = {},
) {
  if (!token) throw new Error("software automation simulator IPC token is required");
  const onMessage = (message: unknown) => {
    if (!channel.connected) return;
    if (isSensorEdgeMessage(message, token)) {
      void simulator.injectSensorEdge(message.fixtureId, message.edge)
        .then(() => sendIpcResult(channel, "automation-e2e-sensor-edge-result", message.requestId, true))
        .catch((error) => sendIpcResult(
          channel,
          "automation-e2e-sensor-edge-result",
          message.requestId,
          false,
          error instanceof Error ? error.message : "software automation sensor edge failed",
        ));
      return;
    }
    if (!isClockAdvanceMessage(message, token)) return;
    void Promise.resolve()
      .then(() => simulator.advanceClock(message.advanceMs))
      .then(async (clock) => {
        await options.onClockAdvanced?.();
        sendIpcResult(
          channel,
          "automation-e2e-clock-advance-result",
          message.requestId,
          true,
          undefined,
          clock,
        );
      })
      .catch((error) => sendIpcResult(
        channel,
        "automation-e2e-clock-advance-result",
        message.requestId,
        false,
        error instanceof Error ? error.message : "software automation clock advance failed",
      ));
  };
  channel.on("message", onMessage);
  return () => channel.off("message", onMessage);
}

function isClockAdvanceMessage(message: unknown, token: string): message is {
  type: "automation-e2e-clock-advance";
  token: string;
  requestId: string;
  advanceMs: number;
} {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const value = message as Record<string, unknown>;
  return value.type === "automation-e2e-clock-advance" &&
    value.token === token &&
    typeof value.requestId === "string" && value.requestId.length > 0 &&
    typeof value.advanceMs === "number" && Number.isInteger(value.advanceMs) &&
    value.advanceMs >= 0 && value.advanceMs <= 86_400_000;
}

function isSensorEdgeMessage(message: unknown, token: string): message is {
  type: "automation-e2e-sensor-edge";
  token: string;
  requestId: string;
  fixtureId: string;
  edge: SoftwareAutomationSensorEdge;
} {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const value = message as Record<string, unknown>;
  return value.type === "automation-e2e-sensor-edge" &&
    value.token === token &&
    typeof value.requestId === "string" && value.requestId.length > 0 &&
    typeof value.fixtureId === "string" && value.fixtureId.length > 0 &&
    (value.edge === "detected" || value.edge === "cleared");
}

function sendIpcResult(
  channel: SoftwareAutomationSimulatorIpcChannel,
  type: "automation-e2e-sensor-edge-result" | "automation-e2e-clock-advance-result",
  requestId: string,
  ok: boolean,
  error?: string,
  details: Record<string, unknown> = {},
) {
  if (!channel.connected || !channel.send) return;
  channel.send({
    type,
    requestId,
    ok,
    ...details,
    ...(error ? { error } : {}),
  });
}

function parseSimulatorFixtures(value: string | undefined): SoftwareAutomationSimulatorFixture[] {
  if (!value) throw new Error("AUTOMATION_E2E_SIMULATOR_FIXTURES is required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("AUTOMATION_E2E_SIMULATOR_FIXTURES is invalid");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("AUTOMATION_E2E_SIMULATOR_FIXTURES is invalid");
  }
  const fixtures = parsed.map((entry): SoftwareAutomationSimulatorFixture => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("AUTOMATION_E2E_SIMULATOR_FIXTURES is invalid");
    }
    const fixture = entry as Record<string, unknown>;
    if (typeof fixture.fixtureId !== "string" || !fixture.fixtureId.trim()) {
      throw new Error("AUTOMATION_E2E_SIMULATOR_FIXTURES is invalid");
    }
    if (fixture.vehicleSensor === undefined) return { fixtureId: fixture.fixtureId };
    if (!fixture.vehicleSensor || typeof fixture.vehicleSensor !== "object" ||
      Array.isArray(fixture.vehicleSensor)) {
      throw new Error("AUTOMATION_E2E_SIMULATOR_FIXTURES is invalid");
    }
    const sensor = fixture.vehicleSensor as Record<string, unknown>;
    if (typeof sensor.meshNodeId !== "string" || !sensor.meshNodeId.trim() ||
      !Number.isInteger(sensor.primaryUnicast) || Number(sensor.primaryUnicast) < 1 ||
      Number(sensor.primaryUnicast) > 0x7fff) {
      throw new Error("AUTOMATION_E2E_SIMULATOR_FIXTURES is invalid");
    }
    return {
      fixtureId: fixture.fixtureId,
      vehicleSensor: {
        meshNodeId: sensor.meshNodeId,
        primaryUnicast: Number(sensor.primaryUnicast),
      },
    };
  });
  if (new Set(fixtures.map(({ fixtureId }) => fixtureId)).size !== fixtures.length) {
    throw new Error("AUTOMATION_E2E_SIMULATOR_FIXTURES is invalid");
  }
  return fixtures;
}
