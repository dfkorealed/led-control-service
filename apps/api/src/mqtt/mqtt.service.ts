import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  acceptanceAckV2Schema,
  applicationProvisioningScanTerminalIngestedAckV2Schema,
  deviceStatusAckV2Schema,
  fixtureStateV2Schema,
  GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS,
  gatewayHeartbeatV2Schema,
  IdentifyDevicePayload,
  identifyDeviceSchema,
  mapHealthFaults,
  meshGroupResyncAckV2Schema,
  meshGroupResyncRequestV2Schema,
  meshGroupSubscriptionResultSchema,
  meshGroupSubscriptionSyncSchema,
  mqttTopics,
  mqttTopicsV2,
  ProvisionDevicePayload,
  provisionDeviceSchema,
  provisioningCompletedSchema,
  provisioningFailedSchema,
  ProvisioningScanStartPayload,
  provisioningScanStartSchema,
  statusFromHealth,
  provisioningScanFoundSchema,
  provisioningScanCompletedSchema,
  provisioningScanFailedSchema
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import mqtt, { IClientOptions, MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { PrismaService } from "../prisma/prisma.service";
import { parseGatewayTopic } from "./topic-scope";

const DEVICE_UUID_CONFLICT_ERROR = "device UUID is already registered by another site";
const FIXTURE_FLOOR_CONFLICT_ERROR = "fixture is already assigned to another floor";
const PROVISIONING_WAITING_STATE = "provisioning_waiting_state";
const MQTT_BACKGROUND_PUBLISH_TIMEOUT_MS = 10_000;
const MQTT_CLOSE_TIMEOUT_MS = 5_000;
const MQTT_FORCE_CLOSE_TIMEOUT_MS = 1_000;

@Injectable()
export class MqttService implements OnModuleInit {
  private readonly logger = new Logger(MqttService.name);
  private client: MqttClient | null = null;
  private closePromise: Promise<void> | null = null;
  private inboundStopPromise: Promise<void> | null = null;
  private readonly activeInboundHandlers = new Set<Promise<void>>();
  private connectListener: (() => void) | null = null;
  private messageListener: ((topic: string, payload: Buffer) => void) | null = null;
  private inboundStopped = false;
  private closing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly meshControlGroups: MeshControlGroupService
  ) {}

  onModuleInit() {
    const client = this.getClient();
    this.connectListener = () => {
      client.subscribe(
        [
          "sites/+/gateways/+/events/provisioning/scan-found",
          "sites/+/gateways/+/events/provisioning/scan-completed",
          "sites/+/gateways/+/events/provisioning/scan-failed",
          "sites/+/gateways/+/events/provisioning-completed",
          "sites/+/gateways/+/events/provisioning-failed",
          "sites/+/gateways/+/events/mesh-group/resync-request",
          "sites/+/gateways/+/events/mesh-group/subscription-result"
        ],
        { qos: 1 }
      );
      client.subscribe(["sites/+/gateways/+/acks/acceptance", "sites/+/gateways/+/acks/device-status"], { qos: 1 });
      client.subscribe(["sites/+/gateways/+/state/fixtures", "sites/+/gateways/+/state/heartbeat"], { qos: 1 });
    };
    this.messageListener = (topic, payload) => this.startInboundHandler(topic, payload);
    client.on("connect", this.connectListener);
    client.on("message", this.messageListener);
  }

  async publishProvisioningScanStart(input: ProvisioningScanStartPayload) {
    const payload = provisioningScanStartSchema.parse(input);
    const topic = mqttTopicsV2.gatewayCommand(payload.siteId, payload.gatewayId, "provisioning/scan-start");
    await this.publishTopic(topic, payload);
  }

  async publishIdentifyDevice(input: IdentifyDevicePayload) {
    const payload = identifyDeviceSchema.parse(input);
    const topic = mqttTopicsV2.gatewayCommand(payload.siteId, payload.gatewayId, "provisioning/identify-device");
    await this.publishTopic(topic, payload);
  }

  async publishProvisionDevice(input: ProvisionDevicePayload) {
    const payload = provisionDeviceSchema.parse(input);
    const topic = mqttTopicsV2.gatewayCommand(payload.siteId, payload.gatewayId, "provisioning/provision-device");
    await this.publishTopic(topic, payload);
  }

  async publishMeshGroupSubscriptionSync(input: ReturnType<typeof meshGroupSubscriptionSyncSchema.parse>) {
    const payload = meshGroupSubscriptionSyncSchema.parse(input);
    const topic = mqttTopics.meshGroupSubscriptionSync(payload.siteId, payload.gatewayId);
    await this.publishTopic(topic, payload, { timeoutMs: MQTT_BACKGROUND_PUBLISH_TIMEOUT_MS });
  }

  async publishTopic(
    topic: string,
    payload: unknown,
    options: { messageExpiryInterval?: number; timeoutMs?: number } = {}
  ) {
    await new Promise<void>((resolve, reject) => {
      const client = this.getClient();
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      client.publish(topic, JSON.stringify(payload), {
        qos: 1,
        properties: {
          messageExpiryInterval: options.messageExpiryInterval ?? GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS / 1000
        }
      }, (error) => {
        finish(error ?? undefined);
      });

      if (settled || options.timeoutMs === undefined) return;
      const messageId = client.getLastMessageId();
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        timeout = null;
        client.removeOutgoingMessage(messageId);
        reject(new Error(`MQTT publish timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    });
  }

  close() {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = this.closeClient();
    }
    return this.closePromise;
  }

  stopInboundAndDrain() {
    if (!this.inboundStopPromise) {
      this.inboundStopped = true;
      const client = this.client;
      if (client && this.connectListener) client.removeListener("connect", this.connectListener);
      if (client && this.messageListener) client.removeListener("message", this.messageListener);
      this.connectListener = null;
      this.messageListener = null;
      this.inboundStopPromise = Promise.all([...this.activeInboundHandlers]).then(() => undefined);
    }
    return this.inboundStopPromise;
  }

  private startInboundHandler(topic: string, payload: Buffer) {
    if (this.inboundStopped) return;

    let handler!: Promise<void>;
    handler = Promise.resolve()
      .then(() => this.handleMessage(topic, payload))
      .catch((error) => {
        this.logger.error(`mqtt inbound message handling failed (error=${this.errorKind(error)})`);
      })
      .finally(() => {
        this.activeInboundHandlers.delete(handler);
      });
    this.activeInboundHandlers.add(handler);
  }

  private errorKind(error: unknown) {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^P\d{4}$/.test(error.code)
    ) return error.code;
    return "UNEXPECTED_ERROR";
  }

  private closeClient() {
    const client = this.client;
    if (!client) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        timeout = null;
        if (this.client === client) this.client = null;
        if (error) reject(error);
        else resolve();
      };
      const forceClose = () => {
        if (settled) return;
        this.logger.warn("MQTT client graceful close timed out; forcing close");
        timeout = setTimeout(() => {
          if (settled) return;
          this.logger.warn("MQTT client forced close callback timed out; continuing shutdown");
          finish();
        }, MQTT_FORCE_CLOSE_TIMEOUT_MS);
        try {
          client.end(true, finish);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("MQTT client forced close failed"));
        }
      };

      timeout = setTimeout(forceClose, MQTT_CLOSE_TIMEOUT_MS);
      try {
        client.end(false, finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("MQTT client graceful close failed"));
      }
    });
  }

  private getClient() {
    if (this.closing) throw new Error("MQTT client is closing");
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
      await this.storeAcceptanceAck(ack);
      return;
    }

    if (topic.endsWith("/acks/device-status")) {
      const scope = parseGatewayScopedTopic(topic);
      const ack = deviceStatusAckV2Schema.parse(JSON.parse(payload.toString()));
      if (!scope || scope.siteId !== ack.siteId || scope.gatewayId !== ack.gatewayId) return;
      await this.storeDeviceStatusAck(ack);
      return;
    }

    if (topic.endsWith("/events/provisioning/scan-found")) {
      const node = provisioningScanFoundSchema.parse(JSON.parse(payload.toString()));
      const topicScope = parseGatewayScopedTopic(topic);
      if (!topicScope || topicScope.siteId !== node.siteId || topicScope.gatewayId !== node.gatewayId) return;
      try {
        await this.prisma.$transaction(async (tx) => {
          const session = await this.acceptCurrentScanEvent(tx, node, topicScope, "provisioning_scan_found");
          if (!session) return;
          await tx.discoveredMeshNode.upsert({
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
              scanCorrelationId: node.scanCorrelationId,
              scanAttempt: node.scanAttempt,
              discoveredAt: new Date(node.occurredAt)
            },
            update: {
              rssi: node.rssi,
              oobCapability: node.oobCapability,
              firmwareVersion: node.firmwareVersion,
              scanCorrelationId: node.scanCorrelationId,
              scanAttempt: node.scanAttempt,
              discoveredAt: new Date(node.occurredAt),
              errorMessage: null
            }
          });
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) return;
        throw error;
      }
      return;
    }

    if (topic.endsWith("/events/provisioning/scan-completed") || topic.endsWith("/events/provisioning/scan-failed")) {
      const topicScope = parseGatewayScopedTopic(topic);
      if (!topicScope) return;
      const event = topic.endsWith("/scan-completed")
        ? provisioningScanCompletedSchema.parse(JSON.parse(payload.toString()))
        : provisioningScanFailedSchema.parse(JSON.parse(payload.toString()));
      if (event.siteId !== topicScope.siteId || event.gatewayId !== topicScope.gatewayId) return;
      const eventType = "acceptedNodeCount" in event
        ? "provisioning_scan_completed" as const
        : "provisioning_scan_failed" as const;
      let committed: boolean;
      try {
        committed = await this.prisma.$transaction((tx) =>
          this.applyProvisioningScanTerminal(tx, event, topicScope, eventType)
        );
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        committed = await this.prisma.$transaction((tx) =>
          this.applyProvisioningScanTerminal(tx, event, topicScope, eventType)
        );
      }
      if (!committed) return;
      const acknowledgement = applicationProvisioningScanTerminalIngestedAckV2Schema.parse({
        eventId: event.eventId,
        sequence: event.sequence,
        sessionId: event.sessionId,
        scanCorrelationId: event.scanCorrelationId,
        scanAttempt: event.scanAttempt,
        ingestedAt: new Date().toISOString()
      });
      await this.publishTopic(
        mqttTopicsV2.provisioningScanTerminalIngestedAck(event.siteId, event.gatewayId),
        acknowledgement,
        { timeoutMs: MQTT_BACKGROUND_PUBLISH_TIMEOUT_MS }
      );
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
          },
          status: "provisioning"
        },
        data: {
          status: "reconcile_required",
          errorMessage: event.errorMessage
        }
      });
      return;
    }

    if (topic.endsWith("/events/mesh-group/subscription-result")) {
      const event = meshGroupSubscriptionResultSchema.parse(JSON.parse(payload.toString()));
      const topicScope = parseGatewayScopedTopic(topic);
      if (!topicScope || topicScope.siteId !== event.siteId || topicScope.gatewayId !== event.gatewayId) return;
      await this.storeMeshGroupSubscriptionResult(event);
      return;
    }

    if (topic.endsWith("/events/mesh-group/resync-request")) {
      const event = meshGroupResyncRequestV2Schema.parse(JSON.parse(payload.toString()));
      const topicScope = parseGatewayScopedTopic(topic);
      if (!topicScope || topicScope.siteId !== event.siteId || topicScope.gatewayId !== event.gatewayId) return;
      await this.prisma.$transaction((tx) => this.meshControlGroups.resetGatewayGroupsForResync(tx, {
        siteId: event.siteId,
        gatewayId: event.gatewayId,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        reason: event.reason
      }));
      const ack = meshGroupResyncAckV2Schema.parse({
        siteId: event.siteId,
        gatewayId: event.gatewayId,
        eventId: randomUUID(),
        requestEventId: event.eventId,
        occurredAt: new Date().toISOString()
      });
      await this.publishTopic(
        mqttTopicsV2.meshGroupResyncAck(event.siteId, event.gatewayId),
        ack,
        { timeoutMs: MQTT_BACKGROUND_PUBLISH_TIMEOUT_MS }
      );
    }
  }

  private async acceptCurrentScanEvent(
    tx: Prisma.TransactionClient,
    event: {
      sessionId: string;
      siteId: string;
      gatewayId: string;
      scanCorrelationId: string;
      scanAttempt: number;
      eventId: string;
      sequence: number;
      occurredAt: string;
    },
    topicScope: { siteId: string; gatewayId: string },
    eventType: "provisioning_scan_found" | "provisioning_scan_completed" | "provisioning_scan_failed"
  ) {
    await tx.$queryRaw`SELECT "id" FROM "ProvisioningSession" WHERE "id" = ${event.sessionId} FOR UPDATE`;
    const session = await tx.provisioningSession.findUnique({ where: { id: event.sessionId } });
    if (!session) return null;
    if (
      event.siteId !== topicScope.siteId ||
      event.gatewayId !== topicScope.gatewayId ||
      session.siteId !== event.siteId ||
      session.gatewayId !== event.gatewayId ||
      session.status !== "active" ||
      session.scanStatus !== "scanning" ||
      session.scanCorrelationId !== event.scanCorrelationId ||
      session.scanAttempt !== event.scanAttempt
    ) return null;
    const previous = await tx.processedGatewayEvent.findFirst({
      where: { gatewayId: event.gatewayId, eventType, sequence: { gte: BigInt(event.sequence) } },
      select: { eventId: true }
    });
    if (previous) return null;
    await tx.processedGatewayEvent.create({
      data: {
        eventId: event.eventId,
        gatewayId: event.gatewayId,
        sequence: BigInt(event.sequence),
        eventType,
        occurredAt: new Date(event.occurredAt)
      }
    });
    return session;
  }

  private async applyProvisioningScanTerminal(
    tx: Prisma.TransactionClient,
    event: ReturnType<typeof provisioningScanCompletedSchema.parse> | ReturnType<typeof provisioningScanFailedSchema.parse>,
    topicScope: { siteId: string; gatewayId: string },
    eventType: "provisioning_scan_completed" | "provisioning_scan_failed"
  ) {
    await tx.$queryRaw`SELECT "id" FROM "ProvisioningSession" WHERE "id" = ${event.sessionId} FOR UPDATE`;
    const session = await tx.provisioningSession.findUnique({ where: { id: event.sessionId } });
    if (!session ||
      event.siteId !== topicScope.siteId ||
      event.gatewayId !== topicScope.gatewayId ||
      session.siteId !== event.siteId ||
      session.gatewayId !== event.gatewayId ||
      session.scanCorrelationId !== event.scanCorrelationId ||
      session.scanAttempt !== event.scanAttempt
    ) return false;

    const expectedStatus = "acceptedNodeCount" in event ? "completed" : "failed";
    if (session.scanStatus === expectedStatus) {
      const matchesTerminalSnapshot = session.scanCompletedAt?.getTime() === new Date(event.occurredAt).getTime() &&
        ("acceptedNodeCount" in event
          ? session.scanFailureCode === null && session.scanFailureMessage === null
          : session.scanFailureCode === event.code && session.scanFailureMessage === event.message);
      if (!matchesTerminalSnapshot) return false;
      const processed = await tx.processedGatewayEvent.findFirst({
        where: {
          eventId: event.eventId,
          gatewayId: event.gatewayId,
          sequence: BigInt(event.sequence),
          eventType,
          occurredAt: new Date(event.occurredAt)
        },
        select: { eventId: true }
      });
      return Boolean(processed);
    }
    if (session.status !== "active" || session.scanStatus !== "scanning") return false;

    const previous = await tx.processedGatewayEvent.findFirst({
      where: { gatewayId: event.gatewayId, eventType, sequence: { gte: BigInt(event.sequence) } },
      select: { eventId: true }
    });
    if (previous) return false;
    await tx.processedGatewayEvent.create({
      data: {
        eventId: event.eventId,
        gatewayId: event.gatewayId,
        sequence: BigInt(event.sequence),
        eventType,
        occurredAt: new Date(event.occurredAt)
      }
    });
    await tx.provisioningSession.update({
      where: { id: session.id },
      data: "acceptedNodeCount" in event
        ? { scanStatus: "completed", scanCompletedAt: new Date(event.occurredAt), scanFailureCode: null, scanFailureMessage: null }
        : {
            scanStatus: "failed",
            scanCompletedAt: new Date(event.occurredAt),
            scanFailureCode: event.code,
            scanFailureMessage: event.message
          }
    });
    return true;
  }

  private async storeAcceptanceAck(ack: ReturnType<typeof acceptanceAckV2Schema.parse>) {
    const where: Prisma.CommandDispatchWhereInput = {
      id: ack.dispatchId,
      commandId: ack.commandId,
      gatewayId: ack.gatewayId,
      idempotencyKey: ack.idempotencyKey,
      sequence: BigInt(ack.sequence),
      status: ack.status === "rejected"
        ? { in: ["pending", "published", "accepted"] }
        : { in: ["pending", "published"] },
      command: { siteId: ack.siteId }
    };
    const acceptedAt = new Date(ack.acceptedAt);
    const data: Prisma.CommandDispatchUpdateManyMutationInput = {
      status: ack.status === "accepted" ? ("accepted" as const) : ("failed" as const),
      acceptedAt,
      errorCode: ack.errorCode ?? null,
      errorMessage: ack.errorMessage ?? null
    };
    if (ack.status === "accepted") {
      await this.prisma.commandDispatch.updateMany({ where, data });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const failed = await tx.commandDispatch.updateMany({ where, data });
      if (failed.count !== 1) return;
      const errorMessage = ack.errorMessage ?? "gateway rejected command";
      await tx.commandFixtureResult.updateMany({
        where: { dispatchId: ack.dispatchId, status: "pending" },
        data: { status: "failed", occurredAt: acceptedAt, errorMessage }
      });
      await tx.command.updateMany({
        where: { id: ack.commandId, status: "pending" },
        data: { status: "failed", errorMessage }
      });
    });
  }

  private async storeFixtureStateV2(gatewayId: string, state: ReturnType<typeof fixtureStateV2Schema.parse>) {
    const health = state.health
      ? { faultCodes: mapHealthFaults(state.health.faultCodes), observedAt: new Date(state.health.observedAt) }
      : null;
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
            status: health ? statusFromHealth(health.faultCodes) : state.status,
            statusReason: state.statusReason ?? "reported",
            ...(health ? {
              healthFaultCodes: health.faultCodes,
              healthLastSeenAt: health.observedAt
            } : {}),
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
    ack: ReturnType<typeof deviceStatusAckV2Schema.parse>
  ) {
    await this.prisma.$transaction(async (tx) => {
      const lockedDispatches = await tx.$queryRaw<Array<{ id: string; commandId: string }>>`
        SELECT d."id", d."commandId"
        FROM "CommandDispatch" d
        INNER JOIN "Command" c ON c."id" = d."commandId"
        WHERE d."id" = ${ack.dispatchId}
          AND d."commandId" = ${ack.commandId}
          AND d."gatewayId" = ${ack.gatewayId}
          AND d."idempotencyKey" = ${ack.idempotencyKey}
          AND d."sequence" = ${BigInt(ack.sequence)}
          AND d."status" IN ('pending', 'published', 'accepted')
          AND c."siteId" = ${ack.siteId}
        FOR UPDATE OF d
      `;
      const dispatch = lockedDispatches[0];
      if (!dispatch) return;

      const expectedResults = await tx.$queryRaw<Array<{ fixtureId: string }>>`
        SELECT r."fixtureId"
        FROM "CommandFixtureResult" r
        WHERE r."dispatchId" = ${dispatch.id}
        ORDER BY r."fixtureId"
        FOR UPDATE OF r
      `;
      const expectedFixtureIds = new Set(expectedResults.map((result) => result.fixtureId));
      const actualFixtureIds = new Set(ack.results.map((result) => result.fixtureId));
      const fixtureSetMatches =
        expectedFixtureIds.size === expectedResults.length &&
        actualFixtureIds.size === ack.results.length &&
        expectedFixtureIds.size === actualFixtureIds.size &&
        [...expectedFixtureIds].every((fixtureId) => actualFixtureIds.has(fixtureId));
      if (!fixtureSetMatches) {
        await this.failInvalidDeviceStatusAck(tx, dispatch, ack.occurredAt, "ack_fixture_set_mismatch", "device status ACK fixture set mismatch");
        return;
      }

      const derivedStatus = deriveDeviceStatusAckStatus(ack.results);
      if (derivedStatus !== ack.status) {
        await this.failInvalidDeviceStatusAck(tx, dispatch, ack.occurredAt, "ack_status_mismatch", "device status ACK aggregate status mismatch");
        return;
      }

      const dispatchStatus =
        ack.status === "succeeded" ? "completed" : ack.status === "timed_out" ? "timed_out" : "failed";
      const completed = await tx.commandDispatch.updateMany({
        where: { id: dispatch.id, status: { in: ["pending", "published", "accepted"] } },
        data: {
          status: dispatchStatus,
          completedAt: new Date(ack.occurredAt),
          errorCode: null,
          errorMessage: null
        }
      });
      if (completed.count !== 1) return;

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

      await this.finishParentCommand(tx, dispatch.commandId);
    });
  }

  private async failInvalidDeviceStatusAck(
    tx: Prisma.TransactionClient,
    dispatch: { id: string; commandId: string },
    occurredAt: string,
    errorCode: "ack_fixture_set_mismatch" | "ack_status_mismatch",
    errorMessage: string
  ) {
    const completedAt = new Date(occurredAt);
    const failed = await tx.commandDispatch.updateMany({
      where: { id: dispatch.id, status: { in: ["pending", "published", "accepted"] } },
      data: { status: "failed", completedAt, errorCode, errorMessage }
    });
    if (failed.count !== 1) return;
    await tx.commandFixtureResult.updateMany({
      where: { dispatchId: dispatch.id },
      data: { status: "failed", errorMessage, occurredAt: completedAt }
    });
    await this.finishParentCommand(tx, dispatch.commandId);
  }

  private async finishParentCommand(tx: Prisma.TransactionClient, commandId: string) {
    const remaining = await tx.commandDispatch.count({
      where: { commandId, status: { notIn: ["completed", "failed", "timed_out"] } }
    });
    if (remaining !== 0) return;
    const dispatches = await tx.commandDispatch.findMany({ where: { commandId }, select: { status: true } });
    const succeeded = dispatches.every((item) => item.status === "completed");
    await tx.command.updateMany({
      where: { id: commandId, status: "pending" },
      data: {
        status: succeeded ? "acknowledged" : "failed",
        errorMessage: succeeded ? null : "one or more gateway dispatches failed"
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
    try {
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

        const existingMeshNode = await tx.meshNode.findUnique({ where: { deviceUuid: event.deviceUuid } });
        if (existingMeshNode && existingMeshNode.gatewayId !== node.session.gatewayId) {
          await tx.discoveredMeshNode.update({
            where: { id: node.id },
            data: { status: "failed", errorMessage: DEVICE_UUID_CONFLICT_ERROR }
          });
          return;
        }

        const meshNode = existingMeshNode ?? await tx.meshNode.create({
          data: {
            gatewayId: node.session.gatewayId,
            deviceUuid: event.deviceUuid,
            serialNumber: node.serialNumber,
            meshAddress: event.meshAddress,
            firmwareVersion: event.firmwareVersion ?? node.firmwareVersion
          }
        });

        const existingFixture = await tx.fixture.findFirst({
          where: { meshNodeId: meshNode.id },
          select: { id: true, floorId: true }
        });
        if (existingFixture && existingFixture.floorId !== node.session.floorId) {
          await tx.discoveredMeshNode.update({
            where: { id: node.id },
            data: { status: "failed", errorMessage: FIXTURE_FLOOR_CONFLICT_ERROR }
          });
          return;
        }

        const fixture = existingFixture ?? await tx.fixture.create({
            data: {
              id: node.id,
              floorId: node.session.floorId,
              meshNodeId: meshNode.id,
              name: node.pendingFixtureName,
              ratedWatt: node.pendingRatedWatt ?? "40.00",
              x: node.pendingFixtureX,
              y: node.pendingFixtureY,
              size: node.pendingFixtureSize ?? 20,
              status: "offline",
              statusReason: PROVISIONING_WAITING_STATE,
              brightness: 0,
              rssi: null,
              hopCount: null,
              commandSuccessRate: null,
              lastSeenAt: null
            }
          });
        const fixtureGroups = await tx.groupFixture.findMany({
          where: { fixtureId: fixture.id },
          select: { groupId: true },
          orderBy: { groupId: "asc" }
        });
        await this.meshControlGroups.attachProvisionedNode(tx, {
          meshNodeId: meshNode.id,
          gatewayId: node.session.gatewayId,
          floorId: node.session.floorId,
          fixtureGroupIds: fixtureGroups.map((membership) => membership.groupId)
        });

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
    } catch (error) {
      if (!isDeviceUuidUniqueConstraintError(error)) throw error;
      await this.markDeviceUuidConflict(topicScope, event);
    }
  }

  private async markDeviceUuidConflict(
    topicScope: { siteId: string; gatewayId: string },
    event: { sessionId: string; nodeId: string; deviceUuid: string }
  ) {
    await this.prisma.discoveredMeshNode.updateMany({
      where: {
        id: event.nodeId,
        sessionId: event.sessionId,
        deviceUuid: event.deviceUuid,
        status: { in: ["discovered", "identifying", "provisioning"] },
        session: {
          siteId: topicScope.siteId,
          gatewayId: topicScope.gatewayId,
          status: "active"
        }
      },
      data: { status: "failed", errorMessage: DEVICE_UUID_CONFLICT_ERROR }
    });
  }

  private async storeMeshGroupSubscriptionResult(
    event: ReturnType<typeof meshGroupSubscriptionResultSchema.parse>
  ) {
    await this.prisma.$transaction(async (tx) => {
      const lockedGroups = await tx.$queryRaw<Array<{
        id: string;
        gatewayId: string;
        groupAddress: string;
        configurationVersion: number;
        targetType: "floor" | "fixture_group";
        targetId: string;
        fullReconciliationRequired: boolean;
        status: "configuring" | "ready" | "failed" | "retiring" | "retired";
      }>>`
        SELECT g."id", g."gatewayId", g."groupAddress", g."configurationVersion", g."targetType", g."targetId",
          g."fullReconciliationRequired", g."status"
        FROM "MeshControlGroup" g
        INNER JOIN "Gateway" gw ON gw."id" = g."gatewayId"
        WHERE g."id" = ${event.groupId}
          AND g."gatewayId" = ${event.gatewayId}
          AND LOWER(g."groupAddress") = ${event.groupAddress.toLowerCase()}
          AND g."configurationVersion" = ${event.version}
          AND g."status" <> 'retired'
          AND gw."siteId" = ${event.siteId}
        FOR UPDATE OF g
      `;
      const group = lockedGroups[0];
      if (!group) return;

      const expectedOperations = await tx.meshControlGroupExpectedOperation.findMany({
        where: {
          groupId: group.id,
          gatewayId: group.gatewayId,
          configurationVersion: event.version
        },
        select: {
          operationId: true,
          action: true,
          meshNodeId: true,
          meshAddress: true
        }
      });
      const expectedSet = new Set(expectedOperations.map(meshSubscriptionOperationKey));
      const actualSet = new Set(event.operations.map(meshSubscriptionOperationKey));
      const operationSetMatches =
        expectedSet.size === expectedOperations.length &&
        actualSet.size === event.operations.length &&
        expectedSet.size === actualSet.size &&
        [...expectedSet].every((operation) => actualSet.has(operation));
      if (!operationSetMatches) {
        await tx.meshControlGroup.updateMany({
          where: {
            id: group.id,
            gatewayId: group.gatewayId,
            configurationVersion: event.version
          },
          data: {
            status: group.status === "retiring" ? "retiring" : "failed",
            lastError: "mesh group subscription operation set mismatch"
          }
        });
        return;
      }

      const failedOperation = event.operations.find((operation) => operation.status === "failed");
      for (const operation of event.operations) {
        await tx.meshControlGroupExpectedOperation.updateMany({
          where: {
            groupId: group.id,
            gatewayId: group.gatewayId,
            configurationVersion: event.version,
            operationId: operation.operationId,
            action: operation.action,
            meshNodeId: operation.meshNodeId,
            meshAddress: operation.meshAddress.toLowerCase()
          },
          data: operation.status === "ready"
            ? {
                status: "applied",
                lastError: null
              }
            : {
                status: "failed",
                lastError: operation.error ?? "mesh group subscription failed"
              }
        });
        if (operation.status !== "ready") continue;
        const memberIdentity = {
          groupId: group.id,
          gatewayId: group.gatewayId,
          meshNodeId: operation.meshNodeId,
          meshAddress: operation.meshAddress.toLowerCase()
        };
        if (operation.action === "delete") {
          await tx.meshControlGroupAppliedMember.deleteMany({ where: memberIdentity });
        } else {
          await tx.meshControlGroupAppliedMember.createMany({
            data: [memberIdentity],
            skipDuplicates: true
          });
        }
      }

      const members = await tx.meshControlGroupMember.findMany({
        where: { groupId: group.id, gatewayId: group.gatewayId },
        select: {
          meshNodeId: true,
          desired: true,
          meshNode: { select: { meshAddress: true } }
        }
      });
      const appliedMembers = await tx.meshControlGroupAppliedMember.findMany({
        where: { groupId: group.id, gatewayId: group.gatewayId },
        select: { meshNodeId: true, meshAddress: true }
      });
      const appliedByNode = new Map<string, Set<string>>();
      for (const member of appliedMembers) {
        const addresses = appliedByNode.get(member.meshNodeId) ?? new Set<string>();
        addresses.add(member.meshAddress.toLowerCase());
        appliedByNode.set(member.meshNodeId, addresses);
      }
      const failedByNode = new Map(event.operations
        .filter((operation) => operation.status === "failed")
        .map((operation) => [operation.meshNodeId, operation.error ?? "mesh group subscription failed"]));
      for (const member of members) {
        const addresses = appliedByNode.get(member.meshNodeId) ?? new Set<string>();
        const desiredAddress = member.meshNode.meshAddress.toLowerCase();
        const converged = member.desired
          ? addresses.size === 1 && addresses.has(desiredAddress)
          : addresses.size === 0;
        const memberError = failedByNode.get(member.meshNodeId);
        await tx.meshControlGroupMember.updateMany({
          where: { groupId: group.id, gatewayId: group.gatewayId, meshNodeId: member.meshNodeId },
          data: memberError
            ? {
                subscriptionStatus: "failed",
                statusVersion: event.version,
                operationId: null,
                operation: null,
                lastError: memberError
              }
            : converged
              ? {
                  subscriptionStatus: "applied",
                  appliedVersion: event.version,
                  statusVersion: event.version,
                  operationId: null,
                  operation: null,
                  lastError: null
                }
              : {
                  subscriptionStatus: "pending",
                  statusVersion: event.version,
                  operationId: null,
                  operation: null,
                  lastError: null
                }
        });
      }

      const desiredSet = new Set(members
        .filter((member) => member.desired)
        .map((member) => `${member.meshNodeId}:${member.meshNode.meshAddress.toLowerCase()}`));
      const appliedSet = new Set(appliedMembers.map((member) =>
        `${member.meshNodeId}:${member.meshAddress.toLowerCase()}`
      ));
      const membershipsConverged = desiredSet.size === appliedSet.size &&
        [...desiredSet].every((member) => appliedSet.has(member));
      const isReady = desiredSet.size > 0 && membershipsConverged && !failedOperation;
      const retirementSucceeded =
        group.status === "retiring" &&
        group.targetType === "fixture_group" &&
        desiredSet.size === 0 &&
        appliedSet.size === 0 &&
        !failedOperation;
      const nextStatus = failedOperation
        ? group.status === "retiring" ? "retiring" : "failed"
        : retirementSucceeded
            ? "retired"
            : isReady
              ? "ready"
              : group.status === "retiring"
                ? "retiring"
                : "configuring";
      const nextError = failedOperation
        ? failedOperation.error ?? "mesh group subscription failed"
        : null;
      await tx.meshControlGroup.updateMany({
        where: {
          id: group.id,
          gatewayId: group.gatewayId,
          configurationVersion: event.version
        },
        data: {
          status: nextStatus,
          lastError: nextError,
          ...(group.fullReconciliationRequired && (isReady || retirementSucceeded)
            ? { fullReconciliationRequired: false }
            : {})
        }
      });
      if (retirementSucceeded) {
        await tx.fixtureGroup.updateMany({
          where: { id: group.targetId, gatewayId: group.gatewayId, lifecycleStatus: "retiring" },
          data: { lifecycleStatus: "retired" }
        });
      }
    });
  }
}

function deriveDeviceStatusAckStatus(
  results: Array<{ status: "succeeded" | "failed" | "timed_out" }>
): "succeeded" | "partially_succeeded" | "failed" | "timed_out" {
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  if (succeeded === results.length) return "succeeded";
  if (succeeded > 0) return "partially_succeeded";
  if (results.every((result) => result.status === "timed_out")) return "timed_out";
  return "failed";
}

function meshSubscriptionOperationKey(operation: {
  operationId: string;
  action: "add" | "delete";
  meshNodeId: string;
  meshAddress: string;
}) {
  return `${operation.operationId}:${operation.action}:${operation.meshNodeId}:${operation.meshAddress.toLowerCase()}`;
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
      clean: true,
      protocolVersion: 5
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
  if (!instanceId) throw new Error("MQTT_API_INSTANCE_ID is required for the API MQTT client");
  return instanceId;
}

function isDeviceUuidUniqueConstraintError(error: unknown) {
  if (!isUniqueConstraintError(error)) return false;
  if (!error.meta || typeof error.meta !== "object" || !("target" in error.meta)) return false;

  const target = error.meta.target;
  const targets = Array.isArray(target) ? target : [target];
  return targets.some((value) => value === "deviceUuid" || value === "MeshNode_deviceUuid_key");
}

function isUniqueConstraintError(error: unknown): error is { code: "P2002"; meta?: unknown } {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function parseGatewayScopedTopic(topic: string) {
  const match = /^sites\/([^/]+)\/gateways\/([^/]+)\//.exec(topic);
  if (!match) return null;
  return { siteId: match[1], gatewayId: match[2] };
}
