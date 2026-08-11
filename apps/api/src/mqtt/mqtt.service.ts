import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  acceptanceAckV2Schema,
  deviceStatusAckV2Schema,
  fixtureStateV2Schema,
  gatewayHeartbeatV2Schema,
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
import mqtt, { IClientOptions, MqttClient } from "mqtt";
import { readFileSync } from "node:fs";
import { PrismaService } from "../prisma/prisma.service";
import { parseGatewayTopic } from "./topic-scope";

const SESSION_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private client: MqttClient | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const client = this.getClient();
    client.on("connect", () => {
      client.subscribe(
        [
          "sites/+/gateways/+/events/unprovisioned-device-found",
          "sites/+/gateways/+/events/provisioning-completed",
          "sites/+/gateways/+/events/provisioning-failed"
        ],
        { qos: 1 }
      );
      client.subscribe(["sites/+/gateways/+/acks/acceptance", "sites/+/gateways/+/acks/device-status"], { qos: 1 });
      client.subscribe(["sites/+/gateways/+/state/fixtures", "sites/+/gateways/+/state/heartbeat"], { qos: 1 });
    });
    client.on("message", (topic, payload) => {
      void this.handleMessage(topic, payload);
    });
  }

  async publishProvisioningScanStart(input: ProvisioningScanStartPayload) {
    const payload = provisioningScanStartSchema.parse(input);
    const topic = mqttTopics.provisioningScanStart(payload.siteId, payload.gatewayId);
    await this.publishTopic(topic, payload);
  }

  async publishIdentifyDevice(input: IdentifyDevicePayload) {
    const payload = identifyDeviceSchema.parse(input);
    const topic = mqttTopics.identifyDevice(payload.siteId, payload.gatewayId);
    await this.publishTopic(topic, payload);
  }

  async publishProvisionDevice(input: ProvisionDevicePayload) {
    const payload = provisionDeviceSchema.parse(input);
    const topic = mqttTopics.provisionDevice(payload.siteId, payload.gatewayId);
    await this.publishTopic(topic, payload);
  }

  async publishTopic(topic: string, payload: unknown) {
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
    if (topic.endsWith("/state/fixtures")) {
      const scope = parseGatewayTopic(topic);
      const state = fixtureStateV2Schema.parse(JSON.parse(payload.toString()));
      if (!scope || scope.siteId !== state.siteId || scope.gatewayId !== state.gatewayId) return;
      const fixture = await this.prisma.fixture.findFirst({
        where: {
          id: state.fixtureId,
          floor: { siteId: scope.siteId },
          meshNode: { gatewayId: scope.gatewayId }
        },
        select: { lastStateSequence: true }
      });
      if (!fixture || (fixture.lastStateSequence !== null && fixture.lastStateSequence >= BigInt(state.sequence))) return;
      await this.storeFixtureStateV2(scope.gatewayId, state);
      return;
    }

    if (topic.endsWith("/state/heartbeat")) {
      const scope = parseGatewayTopic(topic);
      const heartbeat = gatewayHeartbeatV2Schema.parse(JSON.parse(payload.toString()));
      if (!scope || scope.siteId !== heartbeat.siteId || scope.gatewayId !== heartbeat.gatewayId) return;
      const gateway = await this.prisma.gateway.findFirst({
        where: { id: scope.gatewayId, siteId: scope.siteId, serialNumber: heartbeat.gatewaySerial },
        select: { lastHeartbeatSequence: true }
      });
      if (!gateway || (gateway.lastHeartbeatSequence !== null && gateway.lastHeartbeatSequence >= BigInt(heartbeat.sequence))) return;
      await this.storeHeartbeatV2(heartbeat);
      return;
    }

    if (topic.endsWith("/acks/acceptance")) {
      const scope = parseGatewayScopedTopic(topic);
      const ack = acceptanceAckV2Schema.parse(JSON.parse(payload.toString()));
      if (!scope || scope.siteId !== ack.siteId || scope.gatewayId !== ack.gatewayId) return;
      await this.prisma.commandDispatch.updateMany({
        where: {
          id: ack.dispatchId,
          commandId: ack.commandId,
          gatewayId: ack.gatewayId,
          idempotencyKey: ack.idempotencyKey,
          sequence: BigInt(ack.sequence),
          command: { siteId: ack.siteId }
        },
        data: {
          status: ack.status === "accepted" ? "accepted" : "failed",
          acceptedAt: new Date(ack.acceptedAt),
          errorCode: ack.errorCode ?? null,
          errorMessage: ack.errorMessage ?? null
        }
      });
      return;
    }

    if (topic.endsWith("/acks/device-status")) {
      const scope = parseGatewayScopedTopic(topic);
      const ack = deviceStatusAckV2Schema.parse(JSON.parse(payload.toString()));
      if (!scope || scope.siteId !== ack.siteId || scope.gatewayId !== ack.gatewayId) return;
      const dispatch = await this.prisma.commandDispatch.findFirst({
        where: {
          id: ack.dispatchId,
          commandId: ack.commandId,
          gatewayId: ack.gatewayId,
          idempotencyKey: ack.idempotencyKey,
          sequence: BigInt(ack.sequence),
          command: { siteId: ack.siteId }
        },
        select: { id: true, commandId: true }
      });
      if (!dispatch) return;
      await this.storeDeviceStatusAck(dispatch, ack);
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

  private async storeFixtureStateV2(gatewayId: string, state: ReturnType<typeof fixtureStateV2Schema.parse>) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedGatewayEvent.create({
          data: {
            eventId: state.eventId,
            gatewayId,
            sequence: BigInt(state.sequence),
            eventType: "fixture_state",
            occurredAt: new Date(state.occurredAt)
          }
        });
        const updated = await tx.fixture.updateMany({
          where: {
            id: state.fixtureId,
            floor: { siteId: state.siteId },
            meshNode: { gatewayId: state.gatewayId },
            OR: [{ lastStateSequence: null }, { lastStateSequence: { lt: BigInt(state.sequence) } }]
          },
          data: {
            brightness: state.brightness,
            status: state.status,
            statusReason: state.statusReason ?? "reported",
            rssi: state.rssi,
            hopCount: state.hopCount,
            lastSeenAt: new Date(state.occurredAt),
            lastStateEventId: state.eventId,
            lastStateSequence: BigInt(state.sequence),
            lastStateOccurredAt: new Date(state.occurredAt)
          }
        });
        if (updated.count !== 1) throw new Error("fixture state scope or sequence rejected");
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return;
      throw error;
    }
  }

  private async storeHeartbeatV2(heartbeat: ReturnType<typeof gatewayHeartbeatV2Schema.parse>) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedGatewayEvent.create({
          data: {
            eventId: heartbeat.eventId,
            gatewayId: heartbeat.gatewayId,
            sequence: BigInt(heartbeat.sequence),
            eventType: "gateway_heartbeat",
            occurredAt: new Date(heartbeat.occurredAt)
          }
        });
        const updated = await tx.gateway.updateMany({
          where: {
            id: heartbeat.gatewayId,
            siteId: heartbeat.siteId,
            serialNumber: heartbeat.gatewaySerial,
            OR: [{ lastHeartbeatSequence: null }, { lastHeartbeatSequence: { lt: BigInt(heartbeat.sequence) } }]
          },
          data: {
            lastHeartbeatAt: new Date(heartbeat.occurredAt),
            lastHeartbeatEventId: heartbeat.eventId,
            lastHeartbeatSequence: BigInt(heartbeat.sequence),
            lastHeartbeatOccurredAt: new Date(heartbeat.occurredAt),
            firmwareVersion: heartbeat.firmwareVersion
          }
        });
        if (updated.count !== 1) throw new Error("gateway heartbeat scope or sequence rejected");
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return;
      throw error;
    }
  }

  private async storeDeviceStatusAck(
    dispatch: { id: string; commandId: string },
    ack: ReturnType<typeof deviceStatusAckV2Schema.parse>
  ) {
    await this.prisma.$transaction(async (tx) => {
      for (const result of ack.results) {
        const updated = await tx.commandFixtureResult.updateMany({
          where: { dispatchId: dispatch.id, fixtureId: result.fixtureId },
          data: {
            status: result.status,
            brightness: result.brightness ?? null,
            faultCode: result.faultCode ?? null,
            errorMessage: result.errorMessage ?? null,
            rssi: result.rssi ?? null,
            hopCount: result.hopCount ?? null,
            occurredAt: new Date(ack.occurredAt)
          }
        });
        if (updated.count !== 1) throw new Error(`fixture result is outside dispatch: ${result.fixtureId}`);
      }

      const dispatchStatus =
        ack.status === "succeeded" ? "completed" : ack.status === "timed_out" ? "timed_out" : "failed";
      await tx.commandDispatch.update({
        where: { id: dispatch.id },
        data: { status: dispatchStatus, completedAt: new Date(ack.occurredAt) }
      });
      const remaining = await tx.commandDispatch.count({
        where: { commandId: dispatch.commandId, status: { notIn: ["completed", "failed", "timed_out"] } }
      });
      if (remaining === 0) {
        const dispatches = await tx.commandDispatch.findMany({ where: { commandId: dispatch.commandId }, select: { status: true } });
        await tx.command.update({
          where: { id: dispatch.commandId },
          data: {
            status: dispatches.every((item) => item.status === "completed") ? "acknowledged" : "failed",
            errorMessage: dispatches.every((item) => item.status === "completed") ? null : "one or more gateway dispatches failed"
          }
        });
      }
    });
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
            id: node.id,
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

export function createMqttConnectionOptions(env: NodeJS.ProcessEnv): { url: string; options: IClientOptions } {
  const url = env.MQTT_URL;
  if (!url?.startsWith("mqtts://")) throw new Error("MQTT_URL is required and must use mqtts://");

  return {
    url,
    options: {
      ca: readFileSync(requiredMqttPath(env, "MQTT_CA_PATH")),
      cert: readFileSync(requiredMqttPath(env, "MQTT_CLIENT_CERT_PATH")),
      key: readFileSync(requiredMqttPath(env, "MQTT_CLIENT_KEY_PATH")),
      rejectUnauthorized: true,
      clientId: `api-service-${requiredMqttApiInstanceId(env)}`,
      clean: false,
      protocolVersion: 5,
      properties: { sessionExpiryInterval: SESSION_EXPIRY_SECONDS }
    }
  };
}

function requiredMqttPath(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for MQTT mTLS`);
  return value;
}

function requiredMqttApiInstanceId(env: NodeJS.ProcessEnv) {
  const instanceId = env.MQTT_API_INSTANCE_ID?.trim();
  if (!instanceId) throw new Error("MQTT_API_INSTANCE_ID is required for a persistent MQTT session");
  return instanceId;
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function parseGatewayScopedTopic(topic: string) {
  const match = /^sites\/([^/]+)\/gateways\/([^/]+)\//.exec(topic);
  if (!match) return null;
  return { siteId: match[1], gatewayId: match[2] };
}
