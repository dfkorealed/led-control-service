import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { config } from "dotenv";
import {
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
import { handleGatewayDimmingCommand, parseCommandTimeout } from "./commands/gateway-command-handler";
import { EventSequenceStore } from "./state/event-sequence-store";
import { createProductionAdapters } from "./adapters/adapter-factory";
import { ApplianceHealth } from "./health/appliance-health";
import type { GatewayAssignment } from "./config/assignment";
import { MqttCertificateClient } from "./identity/mqtt-certificate-client";
import { MqttIdentityStore } from "./identity/mqtt-identity-store";
import { probeMqttIdentity } from "./identity/mqtt-identity-probe";
import { KeyMaterialStore } from "./identity/key-material-store";
import { DeviceCertificateClient } from "./identity/device-certificate-client";
import { createGatewayCertificateRotation } from "./identity/certificate-rotation";

config({ path: resolve(process.cwd(), "../../.env") });
config();

async function main() {
  if (process.env.GATEWAY_PHASE0_PROBE === "1") {
    await createProductionAdapters(process.env);
    console.log(JSON.stringify({ status: "passed", capability: "bluez-mesh-bootstrap" }));
    process.exit(0);
  }
  const health = new ApplianceHealth(process.env.GATEWAY_HEALTH_PATH ?? "/var/run/led-control/health.json");
  await health.startingUnassigned();
  const runtime = await startGatewayRuntime({ env: process.env });
  const assignment = runtime.assignment;
  startCertificateRotation(assignment, process.env);
  await health.startingAssigned();
  const { siteId, gatewayId, serialNumber: gatewaySerial, mqttUrl } = assignment;
  const gatewayFirmwareVersion = process.env.GATEWAY_FIRMWARE_VERSION || "gateway-dev-local";
  const heartbeatMs = Number(process.env.GATEWAY_HEARTBEAT_MS ?? 5000);
  const commandTimeoutMs = parseCommandTimeout(process.env.GATEWAY_BLE_STATUS_TIMEOUT_MS);
  const adapters = runtime.adapters;
  await health.meshReady();
  const adapter = adapters.dimming;
  const scannerAdapter = adapters.scanner;
  const provisioningAdapter = adapters.provisioning;
  const client = runtime.client;
  const commandJournal = new CommandJournal(process.env.GATEWAY_COMMAND_JOURNAL_PATH ?? "/var/lib/led-control/command-journal.json");
  const eventSequence = new EventSequenceStore(process.env.GATEWAY_EVENT_SEQUENCE_PATH ?? "/var/lib/led-control/event-sequence.json");

  client.on("connect", (packet) => {
    void health.healthy();
    subscribeGatewayCommands(client, assignment, packet.sessionPresent);
    void publishHeartbeat();
    void publishJournalSnapshot();
    setInterval(() => void publishHeartbeat(), heartbeatMs);
  });

  client.on("close", () => void health.unhealthy("mqtt_disconnected"));
  client.on("error", () => void health.unhealthy("mqtt_error"));

  client.on("message", (topic, payload) => {
    if (topic === mqttTopicsV2.gatewayCommand(siteId, gatewayId, "dimming")) {
      void handleDimmingPayloadV2(payload);
      return;
    }
    if (topic === mqttTopics.provisioningScanStart(siteId, gatewayId)) {
      void handleProvisioningScanPayload(payload);
      return;
    }
    if (topic === mqttTopics.identifyDevice(siteId, gatewayId)) {
      void handleIdentifyPayload(payload);
      return;
    }
    if (topic === mqttTopics.provisionDevice(siteId, gatewayId)) void handleProvisionDevicePayload(payload);
  });

  async function handleDimmingPayloadV2(payload: Buffer) {
    const command = gatewayDimmingCommandV2Schema.parse(JSON.parse(payload.toString()));
    let acceptancePublished = false;
    const result = await handleGatewayDimmingCommand(
      adapter,
      commandJournal,
      command,
      async (acceptance) => {
        await publish(mqttTopicsV2.acceptanceAck(siteId, gatewayId), acceptance);
        acceptancePublished = true;
      },
      { timeoutMs: commandTimeoutMs }
    );
    if (!acceptancePublished) await publish(mqttTopicsV2.acceptanceAck(siteId, gatewayId), result.acceptance);
    await publish(mqttTopicsV2.deviceStatusAck(siteId, gatewayId), result.deviceStatus);
    await publishDeviceStates(result.deviceStatus, command.brightness);
  }

  async function publishDeviceStates(
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
      await publish(mqttTopicsV2.fixtureState(siteId, gatewayId), state);
    }
  }

  async function publishJournalSnapshot() {
    for (const snapshot of await commandJournal.latestFixtureSnapshots()) {
      const succeeded = snapshot.status === "succeeded";
      const state = fixtureStateV2Schema.parse({
        siteId,
        gatewayId,
        eventId: randomUUID(),
        sequence: await eventSequence.next(),
        occurredAt: new Date().toISOString(),
        fixtureId: snapshot.fixtureId,
        brightness: succeeded ? snapshot.brightness ?? 0 : 0,
        powerOn: succeeded && (snapshot.brightness ?? 0) > 0,
        status: succeeded ? "online" : snapshot.status === "timed_out" ? "offline" : "fault",
        statusReason: "startup_resync",
        ...(snapshot.faultCode ? { faultCode: snapshot.faultCode } : {}),
        rssi: snapshot.rssi ?? null,
        hopCount: snapshot.hopCount ?? null
      });
      await publish(mqttTopicsV2.fixtureState(siteId, gatewayId), state);
    }
  }

  function publish(topic: string, payload: unknown) {
    return new Promise<void>((resolve, reject) => {
      client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => (error ? reject(error) : resolve()));
    });
  }

  async function handleProvisioningScanPayload(payload: Buffer) {
    const command = provisioningScanStartSchema.parse(JSON.parse(payload.toString()));
    const nodes = await applyProvisioningScan(scannerAdapter, command);
    for (const node of nodes) {
      client.publish(mqttTopics.unprovisionedDeviceFound(command.siteId, command.gatewayId), JSON.stringify(node), { qos: 1 });
    }
  }

  async function handleIdentifyPayload(payload: Buffer) {
    const command = identifyDeviceSchema.parse(JSON.parse(payload.toString()));
    await applyIdentifyDevice(provisioningAdapter, command);
  }

  async function handleProvisionDevicePayload(payload: Buffer) {
    const command = provisionDeviceSchema.parse(JSON.parse(payload.toString()));
    const result = await applyProvisionDevice(provisioningAdapter, command);
    if (result.completed) {
      client.publish(mqttTopics.provisioningCompleted(command.siteId, command.gatewayId), JSON.stringify(result.completed), { qos: 1 });
      return;
    }
    if (result.failed) {
      client.publish(mqttTopics.provisioningFailed(command.siteId, command.gatewayId), JSON.stringify(result.failed), { qos: 1 });
    }
  }

  async function publishHeartbeat() {
    await health.healthy();
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
    await publish(mqttTopicsV2.heartbeat(siteId, gatewayId), heartbeat);
  }
}

export function subscribeGatewayCommands(
  client: Pick<MqttClient, "subscribe">,
  assignment: Pick<GatewayAssignment, "siteId" | "gatewayId">,
  sessionPresent: boolean
) {
  if (sessionPresent) return;
  client.subscribe(
    [
      mqttTopicsV2.gatewayCommand(assignment.siteId, assignment.gatewayId, "dimming"),
      mqttTopics.provisioningScanStart(assignment.siteId, assignment.gatewayId),
      mqttTopics.identifyDevice(assignment.siteId, assignment.gatewayId),
      mqttTopics.provisionDevice(assignment.siteId, assignment.gatewayId)
    ],
    { qos: 1 }
  );
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

function startCertificateRotation(assignment: GatewayAssignment, env: NodeJS.ProcessEnv) {
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
  createGatewayCertificateRotation({
    gatewayId: assignment.gatewayId,
    deviceStore: new KeyMaterialStore({ identityRoot: deviceIdentityRoot }),
    mqttStore: new MqttIdentityStore({ identityRoot: mqttIdentityRoot }),
    deviceClient,
    mqttClient,
    mqttProbe: (candidate) => probeMqttIdentity(assignment.mqttUrl, candidate)
  }).start();
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
