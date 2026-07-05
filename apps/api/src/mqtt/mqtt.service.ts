import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  commandAckSchema,
  DimmingCommandPayload,
  fixtureStateSchema,
  gatewayHeartbeatSchema,
  IdentifyDevicePayload,
  identifyDeviceSchema,
  mqttTopics,
  ProvisioningScanStartPayload,
  provisioningScanStartSchema,
  unprovisionedDeviceFoundSchema
} from "@led-control/shared";
import mqtt, { MqttClient } from "mqtt";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private client: MqttClient | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const client = this.getClient();
    client.on("connect", () => {
      client.subscribe(["sites/+/events/fixture-state", "sites/+/events/command-ack", "sites/+/events/gateway-heartbeat"], {
        qos: 1
      });
      client.subscribe("sites/+/gateways/+/events/unprovisioned-device-found", { qos: 1 });
    });
    client.on("message", (topic, payload) => {
      void this.handleMessage(topic, payload);
    });
  }

  async publishDimmingCommand(payload: DimmingCommandPayload) {
    const topic = mqttTopics.dimmingCommand(payload.siteId);
    await this.publishJson(topic, payload);
  }

  async publishProvisioningScanStart(input: ProvisioningScanStartPayload) {
    const payload = provisioningScanStartSchema.parse(input);
    const topic = mqttTopics.provisioningScanStart(payload.siteId, payload.gatewayId);
    await this.publishJson(topic, payload);
  }

  async publishIdentifyDevice(input: IdentifyDevicePayload) {
    const payload = identifyDeviceSchema.parse(input);
    const topic = mqttTopics.identifyDevice(payload.siteId, payload.gatewayId);
    await this.publishJson(topic, payload);
  }

  private async publishJson(topic: string, payload: unknown) {
    await new Promise<void>((resolve, reject) => {
      this.getClient().publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  onModuleDestroy() {
    this.client?.end();
  }

  private getClient() {
    if (!this.client) {
      this.client = mqtt.connect(process.env.MQTT_URL ?? "mqtt://localhost:1883");
    }
    return this.client;
  }

  async handleMessage(topic: string, payload: Buffer) {
    if (topic.endsWith("/events/fixture-state")) {
      const state = fixtureStateSchema.parse(JSON.parse(payload.toString()));
      await this.prisma.fixture.updateMany({
        where: { id: state.fixtureId },
        data: {
          brightness: state.brightness,
          status: state.status,
          rssi: state.rssi,
          hopCount: state.hopCount,
          commandSuccessRate: state.commandSuccessRate,
          lastSeenAt: new Date(state.lastSeenAt)
        }
      });
      return;
    }

    if (topic.endsWith("/events/command-ack")) {
      const ack = commandAckSchema.parse(JSON.parse(payload.toString()));
      await this.prisma.command.updateMany({
        where: { id: ack.commandId },
        data: {
          status: ack.status,
          errorMessage: ack.errorMessage ?? null
        }
      });
      return;
    }

    if (topic.endsWith("/events/gateway-heartbeat")) {
      const heartbeat = gatewayHeartbeatSchema.parse(JSON.parse(payload.toString()));
      await this.prisma.gateway.updateMany({
        where: { serialNumber: heartbeat.gatewaySerial },
        data: { lastHeartbeatAt: new Date(heartbeat.sentAt) }
      });
      return;
    }

    if (topic.endsWith("/events/unprovisioned-device-found")) {
      const node = unprovisionedDeviceFoundSchema.parse(JSON.parse(payload.toString()));
      const topicScope = parseGatewayScopedTopic(topic);
      if (!topicScope) return;

      const session = await this.prisma.provisioningSession.findFirst({
        where: {
          id: node.sessionId,
          siteId: topicScope.siteId,
          gatewayId: topicScope.gatewayId,
          status: "active"
        }
      });
      if (!session) return;

      await this.prisma.discoveredMeshNode.upsert({
        where: {
          sessionId_deviceUuid: {
            sessionId: node.sessionId,
            deviceUuid: node.deviceUuid
          }
        },
        create: {
          sessionId: node.sessionId,
          deviceUuid: node.deviceUuid,
          serialNumber: node.serialNumber,
          rssi: node.rssi,
          oobCapability: node.oobCapability,
          firmwareVersion: node.firmwareVersion,
          discoveredAt: new Date(node.discoveredAt)
        },
        update: {
          rssi: node.rssi,
          oobCapability: node.oobCapability,
          firmwareVersion: node.firmwareVersion,
          discoveredAt: new Date(node.discoveredAt),
          errorMessage: null
        }
      });
    }
  }
}

function parseGatewayScopedTopic(topic: string) {
  const match = /^sites\/([^/]+)\/gateways\/([^/]+)\//.exec(topic);
  if (!match) return null;
  return { siteId: match[1], gatewayId: match[2] };
}
