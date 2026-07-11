import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  commandAckSchema,
  DimmingCommandPayload,
  fixtureStateSchema,
  gatewayHeartbeatSchema,
  IdentifyDevicePayload,
  identifyDeviceSchema,
  mqttTopics,
  ProvisionDevicePayload,
  provisionDeviceSchema,
  provisioningCompletedSchema,
  provisioningFailedSchema,
  ProvisioningScanStartPayload,
  provisioningScanStartSchema,
  unprovisionedDeviceFoundSchema
} from "@led-control/shared";
import mqtt, { MqttClient } from "mqtt";
import { readFileSync } from "node:fs";
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
      client.subscribe(
        [
          "sites/+/gateways/+/events/unprovisioned-device-found",
          "sites/+/gateways/+/events/provisioning-completed",
          "sites/+/gateways/+/events/provisioning-failed"
        ],
        { qos: 1 }
      );
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

  async publishProvisionDevice(input: ProvisionDevicePayload) {
    const payload = provisionDeviceSchema.parse(input);
    const topic = mqttTopics.provisionDevice(payload.siteId, payload.gatewayId);
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
      const connection = createMqttConnectionOptions(process.env);
      this.client = mqtt.connect(connection.url, connection.options);
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
        data: {
          lastHeartbeatAt: new Date(heartbeat.sentAt),
          ...(heartbeat.firmwareVersion ? { firmwareVersion: heartbeat.firmwareVersion } : {})
        }
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
      return;
    }

    if (topic.endsWith("/events/provisioning-completed")) {
      const event = provisioningCompletedSchema.parse(JSON.parse(payload.toString()));
      const topicScope = parseGatewayScopedTopic(topic);
      if (!topicScope) return;

      await this.completeProvisioning(topicScope, event);
      return;
    }

    if (topic.endsWith("/events/provisioning-failed")) {
      const event = provisioningFailedSchema.parse(JSON.parse(payload.toString()));
      const topicScope = parseGatewayScopedTopic(topic);
      if (!topicScope) return;

      await this.prisma.discoveredMeshNode.updateMany({
        where: {
          id: event.nodeId,
          sessionId: event.sessionId,
          deviceUuid: event.deviceUuid,
          session: {
            siteId: topicScope.siteId,
            gatewayId: topicScope.gatewayId,
            status: "active"
          }
        },
        data: {
          status: "failed",
          errorMessage: event.errorMessage
        }
      });
    }
  }

  private async completeProvisioning(
    topicScope: { siteId: string; gatewayId: string },
    event: {
      sessionId: string;
      nodeId: string;
      deviceUuid: string;
      meshAddress: string;
      firmwareVersion?: string;
      rssi?: number | null;
      hopCount?: number | null;
      completedAt: string;
    }
  ) {
    await this.prisma.$transaction(async (tx) => {
      const node = await tx.discoveredMeshNode.findFirst({
        where: {
          id: event.nodeId,
          sessionId: event.sessionId,
          deviceUuid: event.deviceUuid,
          session: {
            siteId: topicScope.siteId,
            gatewayId: topicScope.gatewayId,
            status: "active"
          }
        },
        include: { session: true }
      });
      if (!node || !node.pendingFixtureName || node.pendingFixtureX === null || node.pendingFixtureY === null) return;

      const meshNode =
        (await tx.meshNode.findUnique({ where: { deviceUuid: event.deviceUuid } })) ??
        (await tx.meshNode.create({
          data: {
            gatewayId: node.session.gatewayId,
            deviceUuid: event.deviceUuid,
            serialNumber: node.serialNumber,
            meshAddress: event.meshAddress,
            firmwareVersion: event.firmwareVersion ?? node.firmwareVersion
          }
        }));

      const existingFixture = await tx.fixture.findFirst({ where: { meshNodeId: meshNode.id } });
      if (!existingFixture) {
        await tx.fixture.create({
          data: {
            floorId: node.session.floorId,
            meshNodeId: meshNode.id,
            name: node.pendingFixtureName,
            ratedWatt: node.pendingRatedWatt ?? "40.00",
            x: node.pendingFixtureX,
            y: node.pendingFixtureY,
            status: "online",
            brightness: 60,
            rssi: event.rssi ?? node.rssi,
            hopCount: event.hopCount ?? null,
            commandSuccessRate: 1,
            lastSeenAt: new Date(event.completedAt)
          }
        });
      }

      await tx.discoveredMeshNode.update({
        where: { id: node.id },
        data: {
          status: "provisioned",
          identifyState: "confirmed",
          meshAddress: event.meshAddress,
          firmwareVersion: event.firmwareVersion ?? node.firmwareVersion,
          rssi: event.rssi ?? node.rssi,
          errorMessage: null
        }
      });
    });
  }
}

export function createMqttConnectionOptions(env: NodeJS.ProcessEnv) {
  const url = env.MQTT_URL ?? "mqtt://localhost:1883";
  if (!url.startsWith("mqtts://")) {
    if (env.MQTT_ALLOW_INSECURE_LOCAL !== "true") {
      throw new Error("MQTT_URL must use mqtts:// unless MQTT_ALLOW_INSECURE_LOCAL=true");
    }
    return { url, options: {} };
  }

  return {
    url,
    options: {
      ca: readFileSync(requiredMqttPath(env, "MQTT_CA_PATH")),
      cert: readFileSync(requiredMqttPath(env, "MQTT_CLIENT_CERT_PATH")),
      key: readFileSync(requiredMqttPath(env, "MQTT_CLIENT_KEY_PATH")),
      rejectUnauthorized: true
    }
  };
}

function requiredMqttPath(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for MQTT mTLS`);
  return value;
}

function parseGatewayScopedTopic(topic: string) {
  const match = /^sites\/([^/]+)\/gateways\/([^/]+)\//.exec(topic);
  if (!match) return null;
  return { siteId: match[1], gatewayId: match[2] };
}
