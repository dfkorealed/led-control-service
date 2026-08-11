import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { config } from "dotenv";
import {
  type AcceptanceAckV2,
  type DeviceStatusAckV2,
  gatewayDimmingCommandV2Schema,
  gatewayHeartbeatV2Schema,
  identifyDeviceSchema,
  mqttTopics,
  mqttTopicsV2,
  fixtureStateV2Schema,
  provisionDeviceSchema,
  provisioningScanStartSchema
} from "@led-control/shared";
import { randomUUID } from "node:crypto";
import type { MqttClient } from "mqtt";
import {
  applyIdentifyDevice,
  applyProvisionDevice,
  applyProvisioningScan
} from "./gateway";
import { createAssignmentStore, resolveGatewayAssignment } from "./config/resolve-assignment";
import { createMqttClient } from "./mqtt/create-mqtt-client";
import { CommandJournal } from "./commands/command-journal";
import { handleGatewayDimmingCommand, parseCommandTimeout, type GatewayCommandResult } from "./commands/gateway-command-handler";
import { EventSequenceStore } from "./state/event-sequence-store";
import { createProductionAdapters } from "./adapters/adapter-factory";
import { ApplianceHealth, parseHeartbeatInterval } from "./health/appliance-health";
import type { GatewayAssignment } from "./config/assignment";
import { MqttCertificateClient } from "./identity/mqtt-certificate-client";
import { MqttIdentityStore, type PreparedMqttIdentity } from "./identity/mqtt-identity-store";
import { probeMqttIdentity } from "./identity/mqtt-identity-probe";
import { KeyMaterialStore } from "./identity/key-material-store";
import { DeviceCertificateClient } from "./identity/device-certificate-client";
import { createGatewayCertificateRotation, type CertificateRotation } from "./identity/certificate-rotation";
import { GatewayMqttRuntime, type GatewayMqttClient } from "./runtime/gateway-mqtt-runtime";
import type { BleMeshFixtureStatus, BleMeshResyncReport } from "./gateway";

config({ path: resolve(process.cwd(), "../../.env") });
config();

async function main() {
  if (process.env.GATEWAY_PHASE0_PROBE === "1") {
    await createProductionAdapters(process.env);
    console.log(JSON.stringify({ status: "passed", capability: "bluez-mesh-bootstrap" }));
    process.exit(0);
  }
  const heartbeatMs = parseGatewayHeartbeatInterval(process.env.GATEWAY_HEARTBEAT_MS);
  const health = new ApplianceHealth(process.env.GATEWAY_HEALTH_PATH ?? "/var/run/led-control/health.json", { heartbeatMs });
  await health.startingUnassigned();
  const runtime = await startGatewayRuntime({ env: process.env });
  if (!runtime.adapters.healthProbes) throw new Error("BlueZ health probes are unavailable");
  health.setProbes(runtime.adapters.healthProbes);
  const assignment = runtime.assignment;
  await health.startingAssigned();
  const { siteId, gatewayId, serialNumber: gatewaySerial, mqttUrl } = assignment;
  const gatewayFirmwareVersion = process.env.GATEWAY_FIRMWARE_VERSION || "gateway-dev-local";
  const commandTimeoutMs = parseCommandTimeout(process.env.GATEWAY_BLE_STATUS_TIMEOUT_MS);
  const adapters = runtime.adapters;
  await health.meshReady();
  const adapter = adapters.dimming;
  const scannerAdapter = adapters.scanner;
  const provisioningAdapter = adapters.provisioning;
  const commandJournal = new CommandJournal(process.env.GATEWAY_COMMAND_JOURNAL_PATH ?? "/var/lib/led-control/command-journal.json");
  const eventSequence = new EventSequenceStore(process.env.GATEWAY_EVENT_SEQUENCE_PATH ?? "/var/lib/led-control/event-sequence.json");

  async function handleDimmingPayloadV2(payload: Buffer, source: GatewayMqttClient) {
    const command = gatewayDimmingCommandV2Schema.parse(JSON.parse(payload.toString()));
    let acceptancePublished = false;
    const result = await handleGatewayDimmingCommand(
      adapter,
      commandJournal,
      command,
      async (acceptance) => {
        await publish(source, mqttTopicsV2.acceptanceAck(siteId, gatewayId), acceptance);
        acceptancePublished = true;
      },
      { timeoutMs: commandTimeoutMs }
    );
    if (shouldPublishFinalAcceptance(acceptancePublished, result.acceptance.status)) {
      await publish(source, mqttTopicsV2.acceptanceAck(siteId, gatewayId), result.acceptance);
    }
    await publish(source, mqttTopicsV2.deviceStatusAck(siteId, gatewayId), result.deviceStatus);
    if (shouldPublishFixtureStates(result)) await publishDeviceStates(source, result.deviceStatus, command.brightness);
  }

  async function publishDeviceStates(
    source: GatewayMqttClient,
    deviceStatus: DeviceStatusAckV2,
    fallbackBrightness: number
  ) {
    for (const fixture of deviceStatus.results) {
      const state = fixtureStateV2Schema.parse({
        siteId,
        gatewayId,
        eventId: randomUUID(),
        sequence: await eventSequence.next(),
        occurredAt: deviceStatus.occurredAt,
        fixtureId: fixture.fixtureId,
        brightness: fixture.status === "succeeded" ? fixture.brightness ?? fallbackBrightness : 0,
        powerOn: fixture.status === "succeeded" && (fixture.brightness ?? fallbackBrightness) > 0,
        status: fixture.status === "succeeded" ? "online" : "fault",
        statusReason: fixture.status === "succeeded" ? "reported" : "command_failed",
        ...(fixture.faultCode ? { faultCode: fixture.faultCode } : {}),
        rssi: fixture.rssi ?? null,
        hopCount: fixture.hopCount ?? null
      });
      await publish(source, mqttTopicsV2.fixtureState(siteId, gatewayId), state);
    }
  }

  function publish(client: Pick<MqttClient, "publish">, topic: string, payload: unknown) {
    return new Promise<void>((resolve, reject) => {
      client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => (error ? reject(error) : resolve()));
    });
  }

  async function handleProvisioningScanPayload(payload: Buffer, source: GatewayMqttClient) {
    const command = provisioningScanStartSchema.parse(JSON.parse(payload.toString()));
    const nodes = await applyProvisioningScan(scannerAdapter, command);
    for (const node of nodes) {
      source.publish(mqttTopics.unprovisionedDeviceFound(command.siteId, command.gatewayId), JSON.stringify(node), { qos: 1 });
    }
  }

  async function handleIdentifyPayload(payload: Buffer, _source: GatewayMqttClient) {
    const command = identifyDeviceSchema.parse(JSON.parse(payload.toString()));
    await applyIdentifyDevice(provisioningAdapter, command);
  }

  async function handleProvisionDevicePayload(payload: Buffer, source: GatewayMqttClient) {
    const command = provisionDeviceSchema.parse(JSON.parse(payload.toString()));
    const result = await applyProvisionDevice(provisioningAdapter, command);
    if (result.completed) {
      source.publish(mqttTopics.provisioningCompleted(command.siteId, command.gatewayId), JSON.stringify(result.completed), { qos: 1 });
      return;
    }
    if (result.failed) {
      source.publish(mqttTopics.provisioningFailed(command.siteId, command.gatewayId), JSON.stringify(result.failed), { qos: 1 });
    }
  }

  async function publishHeartbeat() {
    const occurredAt = new Date().toISOString();
    const heartbeat = gatewayHeartbeatV2Schema.parse({
      siteId,
      gatewayId,
      eventId: randomUUID(),
      sequence: await eventSequence.next(),
      occurredAt,
      gatewaySerial,
      firmwareVersion: gatewayFirmwareVersion,
      configVersion: assignment.configVersion
    });
    await publish(mqttRuntime.client, mqttTopicsV2.heartbeat(siteId, gatewayId), heartbeat);
    await health.heartbeatPublished();
  }

  const mqttRuntime = new GatewayMqttRuntime({
    client: runtime.client,
    heartbeatMs,
    subscribe: (client, sessionPresent, force) => subscribeGatewayCommands(client, assignment, sessionPresent, force),
    publishHeartbeat,
    topicHandlers: {
      [mqttTopicsV2.gatewayCommand(siteId, gatewayId, "dimming")]: handleDimmingPayloadV2,
      [mqttTopics.provisioningScanStart(siteId, gatewayId)]: handleProvisioningScanPayload,
      [mqttTopics.identifyDevice(siteId, gatewayId)]: handleIdentifyPayload,
      [mqttTopics.provisionDevice(siteId, gatewayId)]: handleProvisionDevicePayload
    },
    onMessageError: (error, topic) => reportGatewayError(error, `mqtt_message:${topic}`),
    onConnect: async () => {
      await health.mqttConnected();
      await recordMeshResyncOutcome(health, await adapter.resyncFixtureStates());
    },
    onClose: () => health.unhealthy("mqtt_disconnected"),
    onError: () => health.unhealthy("mqtt_error"),
    onRuntimeError: reportGatewayError
  });
  const publishFixtureStatus = createFixtureStatusPublisher({
    siteId,
    gatewayId,
    eventSequence,
    publish: (topic, state) => publish(mqttRuntime.client, topic, state)
  });
  adapter.onFixtureStatus((status) => {
    void publishFixtureStatus(status).catch((error) => void reportGatewayError(error, "mesh_fixture_status"));
  });
  mqttRuntime.start();
  const rotation = startCertificateRotation(assignment, process.env, createMqttIdentityActivation(assignment, process.env, mqttRuntime));
  registerGatewayShutdownHandlers(mqttRuntime, rotation);

  function reportGatewayError(error: unknown, context: string) {
    console.error(`Gateway MQTT ${context} failed`, error);
    return health.unhealthy("mqtt_error");
  }
}

export function shouldPublishFixtureStates(result: Pick<GatewayCommandResult, "fixtureStateObserved">) {
  return result.fixtureStateObserved;
}

export async function recordMeshResyncOutcome(
  health: Pick<ApplianceHealth, "recordMeshResync">,
  report: BleMeshResyncReport,
  logger: Pick<Console, "info" | "warn"> = console
) {
  await health.recordMeshResync(report);
  logger.info(JSON.stringify({ event: "mesh_resync", ...report }));
  if (report.observed !== report.total) {
    logger.warn(JSON.stringify({ event: "mesh_resync_incomplete", ...report }));
  }
}

export function createFixtureStatusPublisher(input: {
  siteId: string;
  gatewayId: string;
  eventSequence: Pick<EventSequenceStore, "next">;
  publish: (topic: string, payload: unknown) => Promise<void>;
  now?: () => string;
}) {
  return async (status: BleMeshFixtureStatus) => {
    const state = fixtureStateV2Schema.parse({
      siteId: input.siteId,
      gatewayId: input.gatewayId,
      eventId: randomUUID(),
      sequence: await input.eventSequence.next(),
      occurredAt: (input.now ?? (() => new Date().toISOString()))(),
      fixtureId: status.fixtureId,
      brightness: status.brightness,
      powerOn: status.powerOn,
      status: status.status,
      statusReason: "mesh_publication",
      ...(status.faultCode ? { faultCode: status.faultCode } : {}),
      rssi: status.rssi,
      hopCount: status.hopCount
    });
    await input.publish(mqttTopicsV2.fixtureState(input.siteId, input.gatewayId), state);
  };
}

export function shouldPublishFinalAcceptance(acceptancePublished: boolean, status: AcceptanceAckV2["status"]) {
  return !acceptancePublished || status === "rejected";
}

export function subscribeGatewayCommands(
  client: Pick<MqttClient, "subscribe">,
  assignment: Pick<GatewayAssignment, "siteId" | "gatewayId">,
  sessionPresent: boolean,
  force = false
) {
  if (sessionPresent && !force) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    client.subscribe(
      [
        mqttTopicsV2.gatewayCommand(assignment.siteId, assignment.gatewayId, "dimming"),
        mqttTopics.provisioningScanStart(assignment.siteId, assignment.gatewayId),
        mqttTopics.identifyDevice(assignment.siteId, assignment.gatewayId),
        mqttTopics.provisionDevice(assignment.siteId, assignment.gatewayId)
      ],
      { qos: 1 },
      (error) => (error ? reject(error) : resolve())
    );
  });
}

export function createGatewayShutdownHandler(
  runtime: Pick<GatewayMqttRuntime, "stop">,
  rotationOrExit?: Pick<CertificateRotation, "stop"> | ((code: number) => void),
  exit: (code: number) => void = (code) => process.exit(code)
) {
  const rotation = typeof rotationOrExit === "function" ? undefined : rotationOrExit;
  const shutdownExit = typeof rotationOrExit === "function" ? rotationOrExit : exit;
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= Promise.all([rotation?.stop(), runtime.stop()])
      .then(() => undefined)
      .then(() => shutdownExit(0))
      .catch((error) => {
        console.error("Gateway shutdown failed", error);
        shutdownExit(1);
      });
    return stopping;
  };
}

export function registerGatewayShutdownHandlers(
  runtime: Pick<GatewayMqttRuntime, "stop">,
  rotationOrExit?: Pick<CertificateRotation, "stop"> | ((code: number) => void),
  exit: (code: number) => void = (code) => process.exit(code)
) {
  const shutdown = createGatewayShutdownHandler(runtime, rotationOrExit, exit);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return () => {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  };
}

export async function startGatewayRuntime(options: {
  env: NodeJS.ProcessEnv;
  resolveAssignment?: () => Promise<GatewayAssignment>;
  ensureMqttIdentity?: (assignment: GatewayAssignment, env: NodeJS.ProcessEnv) => Promise<void>;
  createAdapters?: typeof createProductionAdapters;
  createMqtt?: typeof createMqttClient;
}) {
  const assignment = await (options.resolveAssignment ?? (() =>
    resolveGatewayAssignment({ env: options.env, store: createAssignmentStore(options.env) })
  ))();
  await (options.ensureMqttIdentity ?? ensureMqttIdentity)(assignment, options.env);
  const adapters = await (options.createAdapters ?? createProductionAdapters)(options.env);
  const client = (options.createMqtt ?? createMqttClient)(
    { ...options.env, MQTT_URL: assignment.mqttUrl },
    { gatewayId: assignment.gatewayId }
  );
  return { assignment, adapters, client };
}

export async function ensureMqttIdentity(assignment: GatewayAssignment, env: NodeJS.ProcessEnv) {
  const bootstrapUrl = required(env, "GATEWAY_BOOTSTRAP_URL");
  const client = new MqttCertificateClient({
    url: new URL("/gateway-certificates/mqtt", bootstrapUrl).toString(),
    certificatePath: required(env, "GATEWAY_DEVICE_CERT_PATH"),
    privateKeyPath: required(env, "GATEWAY_DEVICE_KEY_PATH"),
    caPath: required(env, "GATEWAY_BOOTSTRAP_CA_PATH")
  });
  const deviceIdentityRoot = env.GATEWAY_IDENTITY_ROOT ?? "/var/lib/led-control/identity/device";
  const mqttIdentityRoot = env.GATEWAY_MQTT_IDENTITY_ROOT ?? "/var/lib/led-control/identity/mqtt";
  const mqttCaPath = env.GATEWAY_MQTT_CA_SOURCE_PATH ?? join(deviceIdentityRoot, "current", "mqtt-ca.crt");
  const store = new MqttIdentityStore({ identityRoot: mqttIdentityRoot });
  await store.ensure(
    assignment.gatewayId,
    await readFile(mqttCaPath, "utf8"),
    (csrPem) => client.requestCertificate(csrPem),
    (candidate) => probeMqttIdentity(assignment.mqttUrl, candidate)
  );
}

function startCertificateRotation(
  assignment: GatewayAssignment,
  env: NodeJS.ProcessEnv,
  activateMqttIdentity: (prepared: PreparedMqttIdentity) => Promise<void>
): CertificateRotation {
  const bootstrapUrl = required(env, "GATEWAY_BOOTSTRAP_URL");
  const deviceIdentityRoot = env.GATEWAY_IDENTITY_ROOT ?? "/var/lib/led-control/identity/device";
  const mqttIdentityRoot = env.GATEWAY_MQTT_IDENTITY_ROOT ?? "/var/lib/led-control/identity/mqtt";
  const currentDevice = join(deviceIdentityRoot, "current");
  const deviceClient = new DeviceCertificateClient({
    renewUrl: new URL("/gateway-certificates/device/renew", bootstrapUrl).toString(),
    activateUrl: new URL("/gateway-certificates/device/activate", bootstrapUrl).toString(),
    certificatePath: join(currentDevice, "device.crt"),
    privateKeyPath: join(currentDevice, "device.key"),
    caPath: join(currentDevice, "api-ca.crt")
  });
  const mqttClient = new MqttCertificateClient({
    url: new URL("/gateway-certificates/mqtt", bootstrapUrl).toString(),
    certificatePath: join(currentDevice, "device.crt"),
    privateKeyPath: join(currentDevice, "device.key"),
    caPath: required(env, "GATEWAY_BOOTSTRAP_CA_PATH")
  });
  const rotation = createGatewayCertificateRotation({
    gatewayId: assignment.gatewayId,
    deviceStore: new KeyMaterialStore({ identityRoot: deviceIdentityRoot }),
    mqttStore: new MqttIdentityStore({ identityRoot: mqttIdentityRoot }),
    deviceClient,
    mqttClient,
    mqttProbe: (candidate) => probeMqttIdentity(assignment.mqttUrl, candidate),
    activateMqttIdentity
  });
  rotation.start();
  return rotation;
}

export function parseGatewayHeartbeatInterval(value: string | undefined) {
  return parseHeartbeatInterval(value === undefined ? undefined : Number(value));
}

export function createMqttIdentityActivation(
  assignment: Pick<GatewayAssignment, "gatewayId" | "mqttUrl">,
  env: NodeJS.ProcessEnv,
  runtime: Pick<GatewayMqttRuntime, "activate">,
  createMqtt: typeof createMqttClient = createMqttClient
) {
  return async (prepared: PreparedMqttIdentity) => {
    const candidate = prepared.candidate;
    const client = createMqtt({
      ...env,
      MQTT_URL: assignment.mqttUrl,
      MQTT_CA_PATH: candidate.caPath,
      MQTT_CLIENT_CERT_PATH: candidate.certificatePath,
      MQTT_CLIENT_KEY_PATH: candidate.keyPath
    }, { gatewayId: assignment.gatewayId }, { manualConnect: true });
    await runtime.activate(client, prepared);
  };
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for MQTT identity`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
