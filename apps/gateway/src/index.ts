import { resolve } from "node:path";
import { config } from "dotenv";
import { dimmingCommandSchema, identifyDeviceSchema, mqttTopics, provisionDeviceSchema, provisioningScanStartSchema } from "@led-control/shared";
import {
  applyIdentifyDevice,
  applyManualDimmingCommand,
  applyProvisionDevice,
  applyProvisioningScan,
  CommandProvisioningAdapter,
  CommandProvisioningScannerAdapter,
  createHeartbeatPayload,
  StubBleMeshAdapter,
  StubProvisioningAdapter,
  StubProvisioningScannerAdapter
} from "./gateway";
import { createAssignmentStore, resolveGatewayAssignment } from "./config/resolve-assignment";
import { createMqttClient } from "./mqtt/create-mqtt-client";

config({ path: resolve(process.cwd(), "../../.env") });
config();

async function main() {
  const assignment = await resolveGatewayAssignment({ env: process.env, store: createAssignmentStore(process.env) });
  const { siteId, gatewayId, serialNumber: gatewaySerial, mqttUrl } = assignment;
  const gatewayFirmwareVersion = process.env.GATEWAY_FIRMWARE_VERSION || "gateway-dev-local";
  const heartbeatMs = Number(process.env.GATEWAY_HEARTBEAT_MS ?? 5000);
  const adapter = new StubBleMeshAdapter();
  const scannerAdapter = createScannerAdapter();
  const provisioningAdapter = createProvisioningAdapter();
  const client = createMqttClient({ ...process.env, MQTT_URL: mqttUrl });

  client.on("connect", () => {
    client.subscribe(
      [
        mqttTopics.dimmingCommand(siteId),
        mqttTopics.provisioningScanStart(siteId, gatewayId),
        mqttTopics.identifyDevice(siteId, gatewayId),
        mqttTopics.provisionDevice(siteId, gatewayId)
      ],
      { qos: 1 }
    );
    publishHeartbeat();
    setInterval(publishHeartbeat, heartbeatMs);
  });

  client.on("message", (topic, payload) => {
    if (topic === mqttTopics.dimmingCommand(siteId)) {
      void handleDimmingPayload(payload);
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

  async function handleDimmingPayload(payload: Buffer) {
    const command = dimmingCommandSchema.parse(JSON.parse(payload.toString()));
    const result = await applyManualDimmingCommand(adapter, command);
    client.publish(mqttTopics.commandAck(siteId), JSON.stringify(result.ack), { qos: 1 });
    for (const state of result.fixtureStates) {
      client.publish(mqttTopics.fixtureState(siteId), JSON.stringify(state), { qos: 1 });
    }
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

  function publishHeartbeat() {
    client.publish(
      mqttTopics.gatewayHeartbeat(siteId),
      JSON.stringify(createHeartbeatPayload(siteId, gatewaySerial, new Date(), gatewayFirmwareVersion)),
      { qos: 1 }
    );
  }
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createScannerAdapter() {
  const mode = process.env.GATEWAY_PROVISIONING_ADAPTER ?? "stub";
  if (mode === "command") return new CommandProvisioningScannerAdapter(requiredEnv("GATEWAY_SCAN_COMMAND"));
  return new StubProvisioningScannerAdapter();
}

function createProvisioningAdapter() {
  const mode = process.env.GATEWAY_PROVISIONING_ADAPTER ?? "stub";
  if (mode === "command") {
    return new CommandProvisioningAdapter(requiredEnv("GATEWAY_PROVISION_COMMAND"), process.env.GATEWAY_IDENTIFY_COMMAND);
  }
  return new StubProvisioningAdapter();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
