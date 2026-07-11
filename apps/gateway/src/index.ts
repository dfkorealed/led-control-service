import { resolve } from "node:path";
import { config } from "dotenv";
import {
  dimmingCommandSchema,
  deviceStatusAckV2Schema,
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
import {
  applyIdentifyDevice,
  applyManualDimmingCommand,
  applyProvisionDevice,
  applyProvisioningScan,
  createHeartbeatPayload
} from "./gateway";
import { createAssignmentStore, resolveGatewayAssignment } from "./config/resolve-assignment";
import { createMqttClient } from "./mqtt/create-mqtt-client";
import { CommandJournal } from "./commands/command-journal";
import { handleGatewayDimmingCommand } from "./commands/gateway-command-handler";
import { EventSequenceStore } from "./state/event-sequence-store";
import { createProductionAdapters } from "./adapters/adapter-factory";

config({ path: resolve(process.cwd(), "../../.env") });
config();

async function main() {
  const assignment = await resolveGatewayAssignment({ env: process.env, store: createAssignmentStore(process.env) });
  const { siteId, gatewayId, serialNumber: gatewaySerial, mqttUrl } = assignment;
  const gatewayFirmwareVersion = process.env.GATEWAY_FIRMWARE_VERSION || "gateway-dev-local";
  const heartbeatMs = Number(process.env.GATEWAY_HEARTBEAT_MS ?? 5000);
  const adapters = await createProductionAdapters(process.env);
  const adapter = adapters.dimming;
  const scannerAdapter = adapters.scanner;
  const provisioningAdapter = adapters.provisioning;
  const client = createMqttClient({ ...process.env, MQTT_URL: mqttUrl });
  const commandJournal = new CommandJournal(process.env.GATEWAY_COMMAND_JOURNAL_PATH ?? "/var/lib/led-control/command-journal.json");
  const eventSequence = new EventSequenceStore(process.env.GATEWAY_EVENT_SEQUENCE_PATH ?? "/var/lib/led-control/event-sequence.json");

  client.on("connect", () => {
    client.subscribe(
      [
        mqttTopics.dimmingCommand(siteId),
        mqttTopicsV2.gatewayCommand(siteId, gatewayId, "dimming"),
        mqttTopics.provisioningScanStart(siteId, gatewayId),
        mqttTopics.identifyDevice(siteId, gatewayId),
        mqttTopics.provisionDevice(siteId, gatewayId)
      ],
      { qos: 1 }
    );
    void publishHeartbeat();
    void publishJournalSnapshot();
    setInterval(() => void publishHeartbeat(), heartbeatMs);
  });

  client.on("message", (topic, payload) => {
    if (topic === mqttTopics.dimmingCommand(siteId)) {
      void handleDimmingPayload(payload);
      return;
    }
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

  async function handleDimmingPayload(payload: Buffer) {
    const command = dimmingCommandSchema.parse(JSON.parse(payload.toString()));
    const result = await applyManualDimmingCommand(adapter, command);
    client.publish(mqttTopics.commandAck(siteId), JSON.stringify(result.ack), { qos: 1 });
    for (const state of result.fixtureStates) {
      client.publish(mqttTopics.fixtureState(siteId), JSON.stringify(state), { qos: 1 });
    }
  }

  async function handleDimmingPayloadV2(payload: Buffer) {
    const command = gatewayDimmingCommandV2Schema.parse(JSON.parse(payload.toString()));
    let acceptancePublished = false;
    const result = await handleGatewayDimmingCommand(adapter, commandJournal, command, async (acceptance) => {
      await publish(mqttTopicsV2.acceptanceAck(siteId, gatewayId), acceptance);
      acceptancePublished = true;
    });
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
    for (const stored of await commandJournal.completedResults()) {
      if (!stored || typeof stored !== "object" || !("deviceStatus" in stored)) continue;
      const deviceStatus = deviceStatusAckV2Schema.parse((stored as { deviceStatus: unknown }).deviceStatus);
      await publishDeviceStates(deviceStatus, 0);
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
    client.publish(
      mqttTopics.gatewayHeartbeat(siteId),
      JSON.stringify(createHeartbeatPayload(siteId, gatewaySerial, new Date(), gatewayFirmwareVersion)),
      { qos: 1 }
    );
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

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
