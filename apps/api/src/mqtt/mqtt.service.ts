import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import {
  acceptanceAckV2Schema,
  commandClockRequestSchema,
  applicationStateIngestedAckV2Schema,
  applicationProvisioningScanTerminalIngestedAckV2Schema,
  deriveDeviceStatusAckStatus,
  deviceStatusAckV2Schema,
  fixturePresenceV2Schema,
  fixtureStateV2Schema,
  fixtureIdentifyResultSchema,
  fixtureIdentifyTopics,
  type FixtureIdentifyResult,
  GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS,
  gatewayHeartbeatV2Schema,
  IdentifyDevicePayload,
  identifyDeviceSchema,
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
  provisioningDeviceTerminalV2Schema,
  ProvisioningScanStartPayload,
  provisioningScanStartSchema,
  provisioningScanFoundSchema,
  provisioningScanCompletedSchema,
  provisioningScanFailedSchema,
  type ApplicationStateIngestedAckV2,
  type MeshGroupResyncAckV2
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import mqtt, { IClientOptions, IPublishPacket, MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { AutomationMqttConsumerService } from "../automation/automation-mqtt-consumer.service";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { AutomationClock } from "../automation/automation-clock";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { reconcileLegacyGatewayEventReplay } from "./legacy-gateway-event-replay";
import { FixtureStateIngestionService } from "../energy/fixture-state-ingestion.service";
import { FixturePresenceIngestionService } from "../fixtures/fixture-presence-ingestion.service";
import { MonitoringRefreshIngestionService } from "../monitoring-refresh/monitoring-refresh-ingestion.service";
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";
import { PrismaService } from "../prisma/prisma.service";
import { compareAndAdvanceGatewayEvent } from "../retention/gateway-event-watermark";
import { parseGatewayTopic } from "./topic-scope";
import { gatewayEventIsTooFarInFuture, gatewayEventMaxFutureSkewMs } from "./gateway-event-time";
import { ProvisioningDeviceTerminalService } from "./provisioning-device-terminal.service";
import { CommandClockResponderService } from "./command-clock-responder.service";

const MQTT_BACKGROUND_PUBLISH_TIMEOUT_MS = 10_000;
const MQTT_CLOSE_TIMEOUT_MS = 5_000;
const MQTT_FORCE_CLOSE_TIMEOUT_MS = 1_000;
const MQTT_GATEWAY_INBOUND_QUEUE_CAPACITY = 256;

function isDurableFixtureObservationTopic(topic: string) {
  const scope = parseGatewayTopic(topic);
  return topic.endsWith("/state/fixtures") || topic.endsWith("/state/fixture-presence") ||
    Boolean(scope && topic === mqttTopicsV2.fixtureUnreachable(scope.siteId, scope.gatewayId));
}

interface LockedCommandDispatch {
  id: string;
  commandId: string;
  kind: "dimming" | "status_check";
  verificationAttempt: number | null;
  status: "pending" | "published" | "accepted" | "completed" | "failed" | "timed_out";
  errorCode: string | null;
  outcome: "pending" | "applied" | "not_applied" | "partially_applied" | "unknown" | null;
  brightness: number;
}

const ACTIVE_DISPATCH_STATUSES = ["pending", "published", "accepted"];
const RECONCILABLE_TIMEOUT_CODES = ["ACCEPTANCE_TIMEOUT", "STATUS_TIMEOUT"];
const RECONCILABLE_PUBLISH_CODES = ["MQTT_DEAD_LETTER", "COMMAND_DELIVERY_EXPIRED", "MESH_GROUP_STALE", "MANUAL_OVERRIDE_EXPIRED"];
const DEVICE_STATUS_ACK_EVENT_TYPE = "device_status_ack";

interface GatewayInboundQueue {
  pending: number;
  tail: Promise<void>;
  waiters: GatewayInboundWaiter[];
}

interface GatewayInboundWaiter {
  resolve: (permit: GatewayInboundPermit) => void;
  reject: (error: Error) => void;
}

interface GatewayInboundPermit {
  key: string;
  queue: GatewayInboundQueue;
  released: boolean;
}

interface InboundPacketPermit {
  topic: string;
  consumed: boolean;
  aborted: boolean;
}

interface PendingMeshGroupResyncAck {
  topic: string;
  payload: MeshGroupResyncAckV2;
}

class InboundQueueAbortedError extends Error {}

@Injectable()
export class MqttService implements OnModuleInit {
  private readonly identifyListeners = new Set<(result: FixtureIdentifyResult) => Promise<void>>();

  onFixtureIdentifyResult(listener: (result: FixtureIdentifyResult) => Promise<void>) {
    this.identifyListeners.add(listener);
    return () => { this.identifyListeners.delete(listener); };
  }
  private readonly logger = new Logger(MqttService.name);
  private client: MqttClient | null = null;
  private closePromise: Promise<void> | null = null;
  private inboundStopPromise: Promise<void> | null = null;
  private readonly activeInboundHandlers = new Set<Promise<void>>();
  private readonly gatewayInboundQueues = new Map<string, GatewayInboundQueue>();
  private readonly inboundPacketPermits = new Map<IPublishPacket, InboundPacketPermit>();
  private readonly seenInboundPackets = new WeakSet<IPublishPacket>();
  private connectListener: (() => void) | null = null;
  private messageListener: ((topic: string, payload: Buffer, packet?: IPublishPacket) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private inboundStopped = false;
  private closing = false;
  private readonly fixtureStateIngestion: Pick<FixtureStateIngestionService, "ingest">;
  private readonly fixturePresenceIngestion: Pick<FixturePresenceIngestionService, "ingest">;
  private readonly monitoringRefreshIngestion: Pick<MonitoringRefreshIngestionService, "ingestUnreachable" | "completeBatch">;
  private readonly provisioningDeviceTerminal: Pick<ProvisioningDeviceTerminalService, "ingest" | "completeLegacy">;

  constructor(
    private readonly prisma: PrismaService,
    private readonly meshControlGroups: MeshControlGroupService,
    fixtureStateIngestion?: FixtureStateIngestionService,
    @Optional() private readonly automationConsumer?: AutomationMqttConsumerService,
    @Optional() private readonly energyDimensions?: EnergyDimensionHistoryService,
    @Optional() private readonly automationSnapshot: AutomationSnapshotService = new AutomationSnapshotService(new AutomationClock()),
    @Optional() provisioningDeviceTerminal?: ProvisioningDeviceTerminalService,
    fixturePresenceIngestion?: FixturePresenceIngestionService,
    @Optional() monitoringRefreshIngestion?: MonitoringRefreshIngestionService,
    @Optional() private readonly commandClockResponder?: CommandClockResponderService
  ) {
    this.fixtureStateIngestion = fixtureStateIngestion ?? new FixtureStateIngestionService(prisma);
    this.fixturePresenceIngestion = fixturePresenceIngestion ?? new FixturePresenceIngestionService(prisma);
    this.monitoringRefreshIngestion = monitoringRefreshIngestion ?? new MonitoringRefreshIngestionService(prisma);
    this.provisioningDeviceTerminal = provisioningDeviceTerminal
      ?? new ProvisioningDeviceTerminalService(prisma, meshControlGroups, energyDimensions);
  }

  onModuleInit() {
    const client = this.getClient();
    this.connectListener = () => {
      client.subscribe(
        [
          "sites/+/gateways/+/events/provisioning/scan-found",
          "sites/+/gateways/+/events/identify-result",
          "sites/+/gateways/+/events/fixture-presence-check-completed",
          mqttTopicsV2.fixtureUnreachable("+", "+"),
          "sites/+/gateways/+/events/provisioning/scan-completed",
          "sites/+/gateways/+/events/provisioning/scan-failed",
          "sites/+/gateways/+/events/provisioning/device-terminal",
          "sites/+/gateways/+/events/provisioning-completed",
          "sites/+/gateways/+/events/provisioning-failed",
          "sites/+/gateways/+/events/mesh-group/resync-request",
          "sites/+/gateways/+/events/mesh-group/subscription-result",
          mqttTopicsV2.commandClockRequest("+", "+")
        ],
        { qos: 1 }
      );
      client.subscribe(["sites/+/gateways/+/acks/acceptance", "sites/+/gateways/+/acks/device-status"], { qos: 1 });
      client.subscribe([
        "sites/+/gateways/+/state/fixtures",
        "sites/+/gateways/+/state/fixture-presence",
        "sites/+/gateways/+/state/heartbeat"
      ], { qos: 1 });
      client.subscribe([
        "sites/+/gateways/+/events/automation/config-applied",
        "sites/+/gateways/+/events/automation/current-config-request",
        "sites/+/gateways/+/events/automation/execution",
        "sites/+/gateways/+/events/automation/vehicle-sensor-capability"
      ], { qos: 1 });
    };
    this.messageListener = (topic, payload, packet) => this.acceptInboundMessage(topic, payload, packet);
    this.closeListener = () => this.abortPendingInboundReservations();
    client.on("connect", this.connectListener);
    client.on("message", this.messageListener);
    client.on("close", this.closeListener);
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
    options: { messageExpiryInterval?: number | null; timeoutMs?: number; retain?: false } = {}
  ) {
    if (process.env.COMMAND_SET_EGRESS_ENABLED === "1" && /\/commands\/dimming(?:\/|$)/.test(topic)) {
      throw new Error("Set must use generation-scoped MQTT egress");
    }
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

      const publishOptions = options.messageExpiryInterval === null
        ? { qos: 1 as const, ...(options.retain === false ? { retain: false as const } : {}) }
        : {
            qos: 1 as const,
            ...(options.retain === false ? { retain: false as const } : {}),
            properties: {
              messageExpiryInterval: options.messageExpiryInterval ?? GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS / 1000
            }
          };
      client.publish(topic, JSON.stringify(payload), publishOptions, (error) => {
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

  async probeReadiness() {
    if (!this.client?.connected || this.closing || this.inboundStopped) {
      throw new Error("MQTT client unavailable");
    }
  }

  stopInboundAndDrain() {
    if (!this.inboundStopPromise) {
      this.inboundStopped = true;
      this.identifyListeners.clear();
      const client = this.client;
      if (client && this.connectListener) client.removeListener("connect", this.connectListener);
      if (client && this.messageListener) client.removeListener("message", this.messageListener);
      if (client && this.closeListener) client.removeListener("close", this.closeListener);
      this.connectListener = null;
      this.messageListener = null;
      this.closeListener = null;
      this.abortPendingInboundReservations();
      this.inboundStopPromise = Promise.all([...this.activeInboundHandlers]).then(() => undefined);
    }
    return this.inboundStopPromise;
  }

  private acceptInboundMessage(topic: string, payload: Buffer, packet?: IPublishPacket) {
    if (isDurableFixtureObservationTopic(topic)) return;

    if (!packet || packet.qos !== 1) {
      this.startInboundHandler(topic, payload);
      return;
    }

    const reservation = this.inboundPacketPermits.get(packet);
    if (!reservation) {
      throw new Error("MQTT QoS 1 message listener received an unreserved packet identity");
    }
    if (reservation.topic !== topic) {
      this.releaseInboundPacketReservation(packet, reservation);
      throw new Error("MQTT QoS 1 packet reservation topic mismatch");
    }
    if (!reservation.consumed || reservation.aborted || this.inboundStopped) {
      this.releaseInboundPacketReservation(packet, reservation);
      throw new Error("MQTT QoS 1 packet was emitted before durable handling completed");
    }

    // customHandleAcks already completed the durable handler. MQTT.js emits the
    // message listener from done(0), so consuming the exact packet here avoids
    // executing the application handler twice.
    this.releaseInboundPacketReservation(packet, reservation);
  }

  private startInboundHandler(
    topic: string,
    payload: Buffer,
    permit?: GatewayInboundPermit,
    onComplete?: () => void
  ) {
    if (this.inboundStopped) {
      if (permit) this.releaseGatewayInboundPermit(permit);
      onComplete?.();
      return;
    }

    let handler!: Promise<void>;
    const receivedAt = new Date();
    const operation = () => this.handleMessage(topic, payload, receivedAt);
    handler = (permit
      ? this.runWithGatewayInboundPermit(permit, operation)
      : this.runInGatewayInboundQueue(topic, operation))
      .catch((error) => {
        if (error instanceof InboundQueueAbortedError) return;
        this.logger.error(`mqtt inbound message handling failed (error=${this.errorKind(error)})`);
      })
      .finally(() => {
        onComplete?.();
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
      this.client = mqtt.connect(connection.url, {
        ...connection.options,
        customHandleAcks: this.createCustomHandleAcks()
      });
    }
    return this.client;
  }

  private createCustomHandleAcks(): NonNullable<IClientOptions["customHandleAcks"]> {
    return (topic, payload, packet, done) => {
      if (packet.qos !== 1) {
        done(0);
        return;
      }
      if (!isDurableFixtureObservationTopic(topic)) {
        this.handleInboundPacketBeforeAck(topic, payload, packet, done);
        return;
      }
      if (this.inboundStopped) {
        this.client?.stream.destroy();
        return;
      }
      // MQTT PUBACK(done(0))은 broker가 이 PUBLISH를 API client에게 전달한 것의 수신 확인이다.
      // 반대 방향의 state-ingested application ACK는 Gateway가 자신의 durable outbox record를 지워도 되는
      // 도메인 확인이므로, PUBACK과 같은 성공 의미로 합치거나 그 publish 완료를 여기서 기다리면 안 된다.
      // state와 presence는 schema·저장 의미가 서로 다르지만, 둘 다 같은 Gateway의 Fixture row/receipt를
      // 갱신한다. 따라서 하나의 bounded per-Gateway queue에서 직렬화해 commit 순서와 backpressure를 함께
      // 보존한다. Queue delay must not turn a future packet into an accepted event or advance freshness.
      const receivedAt = new Date();
      let handler!: Promise<void>;
      handler = this.runInGatewayInboundQueue(topic, () => this.ingestFixtureObservationPacket(topic, payload, receivedAt))
        .then(({ scope, acknowledgement }) => {
          done(0);
          return this.publishFixtureStateAcknowledgement(scope.siteId, scope.gatewayId, acknowledgement).catch((error) => {
            this.logger.error(`fixture observation application ACK publish failed after DB commit (error=${this.errorKind(error)})`);
          });
        })
        .catch((error) => this.rejectFixtureObservationDelivery(error))
        .finally(() => this.activeInboundHandlers.delete(handler));
      this.activeInboundHandlers.add(handler);
    };
  }

  private handleInboundPacketBeforeAck(
    topic: string,
    payload: Buffer,
    packet: IPublishPacket,
    done: Parameters<NonNullable<IClientOptions["customHandleAcks"]>>[3]
  ) {
    if (this.seenInboundPackets.has(packet)) return;
    this.seenInboundPackets.add(packet);
    // Queue backpressure must not move the trust boundary forward while a packet waits.
    const receivedAt = new Date();

    if (this.inboundStopped || !this.hasActiveMessageListener()) {
      this.client?.stream.destroy();
      return;
    }

    const reservation: InboundPacketPermit = {
      topic,
      consumed: false,
      aborted: false
    };
    this.inboundPacketPermits.set(packet, reservation);

    let handler!: Promise<void>;
    handler = this.runInGatewayInboundQueue(topic, () => this.handleMessageBeforeAck(topic, payload, receivedAt))
      .then((publishAfterAck) => {
        if (reservation.aborted || this.inboundStopped || this.inboundPacketPermits.get(packet) !== reservation) {
          return;
        }

        reservation.consumed = true;
        try {
          done(0);
        } catch (error) {
          this.releaseInboundPacketReservation(packet, reservation);
          this.rejectInboundDelivery(error);
          return;
        }

        if (this.inboundPacketPermits.get(packet) === reservation) {
          this.releaseInboundPacketReservation(packet, reservation);
          this.rejectInboundDelivery(new Error("MQTT QoS 1 packet was not emitted to the message listener"));
          return;
        }

        return publishAfterAck?.().catch((error) => {
          this.logger.error(`mesh group resync ACK publish failed after DB commit and PUBACK (error=${this.errorKind(error)})`);
        });
      })
      .catch((error) => {
        const failClosed = !reservation.aborted && !this.inboundStopped &&
          !(error instanceof InboundQueueAbortedError);
        this.releaseInboundPacketReservation(packet, reservation);
        if (failClosed) {
          this.logger.error(`mqtt inbound transaction failed before PUBACK (error=${this.errorKind(error)})`);
          this.rejectInboundDelivery(error);
        }
      })
      .finally(() => this.activeInboundHandlers.delete(handler));
    this.activeInboundHandlers.add(handler);
  }

  private async handleMessageBeforeAck(topic: string, payload: Buffer, receivedAt: Date): Promise<(() => Promise<void>) | undefined> {
    if (parseGatewayTopic(topic)?.channel === "commands/clock/request") {
      const response = await this.prepareCommandClockResponse(topic, payload);
      // Publish after inbound PUBACK: MQTT.js cannot receive the outgoing
      // PUBACK while customHandleAcks still holds its inbound parser.
      return response ? () => this.publishCommandClockResponse(response) : undefined;
    }
    if (topic.endsWith("/events/fixture-presence-check-completed")) {
      const { ack } = await this.monitoringRefreshIngestion.completeBatch(topic, JSON.parse(payload.toString()), receivedAt);
      if (!ack) return;
      // Start QoS 1 application ACK only after PUBACK releases MQTT.js' parser.
      return () => this.publishTopic(mqttTopicsV2.fixturePresenceCheckCompletedAck(ack.siteId, ack.gatewayId), ack,
        { timeoutMs: MQTT_BACKGROUND_PUBLISH_TIMEOUT_MS });
    }
    if (!topic.endsWith("/events/mesh-group/resync-request")) {
      await this.handleMessage(topic, payload, receivedAt);
      return;
    }

    const acknowledgement = await this.prepareMeshGroupResyncAcknowledgement(topic, payload);
    if (!acknowledgement) return;

    // MQTT.js pauses its parser until customHandleAcks calls done(). Waiting for
    // this QoS 1 publish first would prevent the same parser from receiving its
    // broker PUBACK. Keep the publish in the tracked handler, but start it only
    // after the inbound database transaction has been acknowledged.
    return () => this.publishMeshGroupResyncAcknowledgement(acknowledgement);
  }

  private async prepareCommandClockResponse(topic: string, payload: Buffer) {
    const scope = parseGatewayTopic(topic);
    if (!scope || scope.channel !== "commands/clock/request" || !this.commandClockResponder) return null;
    let body: unknown;
    try {
      body = JSON.parse(payload.toString());
    } catch {
      return null;
    }
    const request = commandClockRequestSchema.safeParse(body);
    if (!request.success) return null;
    return this.commandClockResponder.respond(scope, request.data);
  }

  private publishCommandClockResponse(response: { siteId: string; gatewayId: string; nonce: string; dbNow: string; publishEpoch: number }) {
    return this.publishTopic(mqttTopicsV2.commandClockResponse(response.siteId, response.gatewayId), response,
      { retain: false, timeoutMs: MQTT_BACKGROUND_PUBLISH_TIMEOUT_MS });
  }

  private hasActiveMessageListener() {
    const client = this.client;
    return Boolean(client && this.messageListener && client.listeners("message").includes(this.messageListener));
  }

  private gatewayInboundQueueKey(topic: string) {
    const scope = parseGatewayTopic(topic);
    return scope ? `${scope.siteId}:${scope.gatewayId}` : `unscoped:${topic}`;
  }

  private reserveGatewayInboundPermit(topic: string): Promise<GatewayInboundPermit> {
    if (this.inboundStopped) return Promise.reject(new InboundQueueAbortedError("MQTT inbound is stopped"));

    const key = this.gatewayInboundQueueKey(topic);
    let queue = this.gatewayInboundQueues.get(key);
    if (!queue) {
      queue = { pending: 0, tail: Promise.resolve(), waiters: [] };
      this.gatewayInboundQueues.set(key, queue);
    }
    if (queue.pending < MQTT_GATEWAY_INBOUND_QUEUE_CAPACITY) {
      queue.pending += 1;
      return Promise.resolve({ key, queue, released: false });
    }

    return new Promise<GatewayInboundPermit>((resolve, reject) => {
      queue!.waiters.push({ resolve, reject });
    });
  }

  private async runInGatewayInboundQueue<T>(topic: string, operation: () => Promise<T>): Promise<T> {
    const permit = await this.reserveGatewayInboundPermit(topic);
    return this.runWithGatewayInboundPermit(permit, operation);
  }

  private runWithGatewayInboundPermit<T>(permit: GatewayInboundPermit, operation: () => Promise<T>): Promise<T> {
    const { queue } = permit;
    const result = queue.tail.then(operation);
    queue.tail = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.releaseGatewayInboundPermit(permit);
    });
  }

  private releaseGatewayInboundPermit(permit: GatewayInboundPermit) {
    if (permit.released) return;
    permit.released = true;

    const { key, queue } = permit;
    const waiter = queue.waiters.shift();
    if (waiter) {
      waiter.resolve({ key, queue, released: false });
      return;
    }

    queue.pending -= 1;
    if (queue.pending === 0 && this.gatewayInboundQueues.get(key) === queue) {
      this.gatewayInboundQueues.delete(key);
    }
  }

  private releaseInboundPacketReservation(packet: IPublishPacket, reservation: InboundPacketPermit) {
    if (this.inboundPacketPermits.get(packet) === reservation) this.inboundPacketPermits.delete(packet);
    reservation.aborted = true;
  }

  private abortPendingInboundReservations() {
    const error = new InboundQueueAbortedError("MQTT inbound transport stopped before capacity was available");
    for (const queue of this.gatewayInboundQueues.values()) {
      const waiters = queue.waiters.splice(0);
      for (const waiter of waiters) waiter.reject(error);
    }
    for (const [packet, reservation] of this.inboundPacketPermits) {
      if (reservation.consumed) continue;
      this.releaseInboundPacketReservation(packet, reservation);
    }
  }

  private rejectInboundDelivery(_error: unknown) {
    const client = this.client;
    if (!client) return;
    // Identity failures throw through MQTT.js' synchronous message emit before
    // _sendPacket; closing the transport preserves broker redelivery.
    client.stream.destroy();
  }

  private rejectFixtureObservationDelivery(error: unknown) {
    this.logger.error(`fixture observation transaction failed before PUBACK (error=${this.errorKind(error)})`);
    const client = this.client;
    if (!client) return;
    // MQTT PUBACK 없이 transport를 닫아 broker QoS 1 session의 재전달을 보존한다.
    // Do not pass the database error to the stream: that can become an unhandled EventEmitter error.
    client.stream.destroy();
  }

  async handleFixtureStatePacket(topic: string, payload: Buffer, receivedAt = new Date()) {
    const { scope, acknowledgement } = await this.ingestFixtureStatePacket(topic, payload, receivedAt);
    await this.publishFixtureStateAcknowledgement(scope.siteId, scope.gatewayId, acknowledgement);
    return acknowledgement;
  }

  private async ingestFixtureStatePacket(topic: string, payload: Buffer, receivedAt: Date) {
    const scope = parseGatewayTopic(topic);
    const state = fixtureStateV2Schema.parse(JSON.parse(payload.toString()));
    if (!scope || scope.channel !== "state/fixtures" || scope.siteId !== state.siteId || scope.gatewayId !== state.gatewayId) {
      throw new Error("fixture state topic scope rejected");
    }
    const ingested = await this.fixtureStateIngestion.ingest(scope.gatewayId, state, receivedAt);
    const acknowledgement = applicationStateIngestedAckV2Schema.parse({
      ...ingested,
      ingestedAt: new Date().toISOString()
    });
    return { scope, acknowledgement };
  }

  async handleFixturePresencePacket(topic: string, payload: Buffer, receivedAt = new Date()) {
    const { scope, acknowledgement } = await this.ingestFixturePresencePacket(topic, payload, receivedAt);
    await this.publishFixtureStateAcknowledgement(scope.siteId, scope.gatewayId, acknowledgement);
    return acknowledgement;
  }

  private async ingestFixturePresencePacket(topic: string, payload: Buffer, receivedAt: Date) {
    const scope = parseGatewayTopic(topic);
    const presence = fixturePresenceV2Schema.parse(JSON.parse(payload.toString()));
    if (!scope || scope.channel !== "state/fixture-presence" ||
      scope.siteId !== presence.siteId || scope.gatewayId !== presence.gatewayId) {
      throw new Error("fixture presence topic scope rejected");
    }
    const ingested = await this.fixturePresenceIngestion.ingest(scope.gatewayId, presence, receivedAt);
    const acknowledgement = applicationStateIngestedAckV2Schema.parse({
      ...ingested,
      ingestedAt: new Date().toISOString()
    });
    return { scope, acknowledgement };
  }

  private async ingestFixtureObservationPacket(topic: string, payload: Buffer, receivedAt: Date) {
    const scope = parseGatewayTopic(topic);
    if (scope?.channel === "state/fixtures") return this.ingestFixtureStatePacket(topic, payload, receivedAt);
    if (scope?.channel === "state/fixture-presence") return this.ingestFixturePresencePacket(topic, payload, receivedAt);
    if (scope && topic === mqttTopicsV2.fixtureUnreachable(scope.siteId, scope.gatewayId)) {
      const result = await this.monitoringRefreshIngestion.ingestUnreachable(topic, JSON.parse(payload.toString()), receivedAt);
      return { scope, acknowledgement: applicationStateIngestedAckV2Schema.parse({ ...result, ingestedAt: new Date().toISOString() }) };
    }
    throw new Error("fixture observation topic scope rejected");
  }

  private publishFixtureStateAcknowledgement(
    siteId: string,
    gatewayId: string,
    acknowledgement: ApplicationStateIngestedAckV2
  ) {
    return this.publishTopic(
      mqttTopicsV2.stateIngestedAck(siteId, gatewayId),
      acknowledgement,
      { timeoutMs: MQTT_BACKGROUND_PUBLISH_TIMEOUT_MS }
    );
  }

  async handleMessage(topic: string, payload: Buffer, receivedAt = new Date()) {
    const frozenReceivedAt = new Date(receivedAt.getTime());
    if (parseGatewayTopic(topic)?.channel === "commands/clock/request") {
      const response = await this.prepareCommandClockResponse(topic, payload);
      if (response) await this.publishCommandClockResponse(response);
      return;
    }
    if (topic.endsWith("/events/fixture-presence-check-completed")) {
      const publish = await this.handleMessageBeforeAck(topic, payload, frozenReceivedAt);
      await publish?.();
      return;
    }
    if (topic.endsWith("/events/identify-result")) {
      const result = fixtureIdentifyResultSchema.parse(JSON.parse(payload.toString()));
      if (topic !== fixtureIdentifyTopics.result(result.siteId, result.gatewayId)) throw new Error("identify_scope_mismatch");
      const now = new Date();
      // The broker binds certificate CN to gateway topics. Recheck the active
      // claim/certificate ledger here because ACL site wildcards alone are insufficient.
      const gateway = await this.prisma.gateway.findFirst({ where: { id: result.gatewayId, siteId: result.siteId,
        claimedAt: { not: null }, inventory: { disabledAt: null, claimedAt: { not: null },
          certificates: { some: { gatewayId: result.gatewayId, purpose: "mqtt", status: "active", revokedAt: null, notBefore: { lte: now }, notAfter: { gt: now } } }
        }
      }, select: { id: true } });
      if (!gateway) throw new Error("identify_gateway_unregistered");
      for (const listener of this.identifyListeners) await listener(result);
      return;
    }
    const gatewayScope = parseGatewayTopic(topic);
    if (gatewayScope && [
      "events/automation/config-applied",
      "events/automation/current-config-request",
      "events/automation/execution",
      "events/automation/vehicle-sensor-capability"
    ].includes(gatewayScope.channel)) {
      await this.automationConsumer?.handleMessage(topic, payload);
      return;
    }

    if (isDurableFixtureObservationTopic(topic)) {
      // MQTT 5 customHandleAcks owns this path so broker PUBACK follows the database commit.
      return;
    }

    if (topic.endsWith("/state/heartbeat")) {
      const scope = parseGatewayTopic(topic);
      const heartbeat = gatewayHeartbeatV2Schema.parse(JSON.parse(payload.toString()));
      if (!scope || scope.channel !== "state/heartbeat" || scope.siteId !== heartbeat.siteId || scope.gatewayId !== heartbeat.gatewayId) {
        throw new Error("gateway heartbeat topic scope rejected");
      }
      await this.storeHeartbeatV2(heartbeat, frozenReceivedAt);
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
              status: "discovered",
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
      const acknowledgement = applicationProvisioningScanTerminalIngestedAckV2Schema.parse({
        eventId: event.eventId,
        sequence: event.sequence,
        sessionId: event.sessionId,
        scanCorrelationId: event.scanCorrelationId,
        scanAttempt: event.scanAttempt,
        ingestedAt: new Date().toISOString()
      });
      const applyTerminal = async (tx: Prisma.TransactionClient) => {
        const committed = await this.applyProvisioningScanTerminal(tx, event, topicScope, eventType, acknowledgement);
        if (!committed) return false;
        await this.persistProvisioningScanTerminalAcknowledgement(tx, event.siteId, event.gatewayId, acknowledgement);
        return true;
      };
      let committed: boolean;
      try {
        committed = await this.prisma.$transaction(applyTerminal);
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        committed = await this.prisma.$transaction(applyTerminal);
      }
      if (!committed) return;
      return;
    }

    if (topic.endsWith("/events/provisioning-completed")) {
      const event = provisioningCompletedSchema.parse(JSON.parse(payload.toString()));
      const topicScope = parseGatewayScopedTopic(topic);
      if (!topicScope) return;

      await this.completeProvisioning(topicScope, event);
      return;
    }

    if (gatewayScope?.channel === "events/provisioning/device-terminal") {
      const event = provisioningDeviceTerminalV2Schema.parse(JSON.parse(payload.toString()));
      if (gatewayScope.siteId !== event.siteId || gatewayScope.gatewayId !== event.gatewayId) {
        throw new Error("provisioning device terminal topic scope rejected");
      }
      await this.provisioningDeviceTerminal.ingest(
        { siteId: gatewayScope.siteId, gatewayId: gatewayScope.gatewayId },
        event,
        frozenReceivedAt
      );
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
      const acknowledgement = await this.prepareMeshGroupResyncAcknowledgement(topic, payload);
      if (acknowledgement) await this.publishMeshGroupResyncAcknowledgement(acknowledgement);
    }
  }

  private async prepareMeshGroupResyncAcknowledgement(
    topic: string,
    payload: Buffer
  ): Promise<PendingMeshGroupResyncAck | null> {
    const event = meshGroupResyncRequestV2Schema.parse(JSON.parse(payload.toString()));
    const topicScope = parseGatewayScopedTopic(topic);
    if (!topicScope || topicScope.siteId !== event.siteId || topicScope.gatewayId !== event.gatewayId) return null;

    await this.prisma.$transaction((tx) => this.meshControlGroups.resetGatewayGroupsForResync(tx, {
      siteId: event.siteId,
      gatewayId: event.gatewayId,
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      reason: event.reason
    }));
    return {
      topic: mqttTopicsV2.meshGroupResyncAck(event.siteId, event.gatewayId),
      payload: meshGroupResyncAckV2Schema.parse({
        siteId: event.siteId,
        gatewayId: event.gatewayId,
        eventId: randomUUID(),
        requestEventId: event.eventId,
        occurredAt: new Date().toISOString()
      })
    };
  }

  private publishMeshGroupResyncAcknowledgement(acknowledgement: PendingMeshGroupResyncAck) {
    return this.publishTopic(
      acknowledgement.topic,
      acknowledgement.payload,
      { timeoutMs: MQTT_BACKGROUND_PUBLISH_TIMEOUT_MS }
    );
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
    const payloadHash = canonicalPayloadHash(event);
    const ordering = await compareAndAdvanceGatewayEvent(tx, {
      gatewayId: event.gatewayId, eventType, scopeKey: "", sequence: BigInt(event.sequence),
      eventId: event.eventId, payloadHash, occurredAt: new Date(event.occurredAt)
    });
    if (ordering !== "advanced") return null;
    await tx.processedGatewayEvent.create({
      data: {
        eventId: event.eventId,
        gatewayId: event.gatewayId,
        sequence: BigInt(event.sequence),
        eventType,
        scopeKey: event.sessionId,
        payloadHash,
        occurredAt: new Date(event.occurredAt)
      }
    });
    return session;
  }

  private async applyProvisioningScanTerminal(
    tx: Prisma.TransactionClient,
    event: ReturnType<typeof provisioningScanCompletedSchema.parse> | ReturnType<typeof provisioningScanFailedSchema.parse>,
    topicScope: { siteId: string; gatewayId: string },
    eventType: "provisioning_scan_completed" | "provisioning_scan_failed",
    acknowledgement: ReturnType<typeof applicationProvisioningScanTerminalIngestedAckV2Schema.parse>
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
    const payloadHash = canonicalPayloadHash(event);
    if (session.scanStatus === expectedStatus) {
      const matchesTerminalSnapshot = session.scanCompletedAt?.getTime() === new Date(event.occurredAt).getTime() &&
        ("acceptedNodeCount" in event
          ? session.scanFailureCode === null && session.scanFailureMessage === null
          : session.scanFailureCode === event.code && session.scanFailureMessage === event.message);
      if (!matchesTerminalSnapshot) return false;
      if (session.scanTerminalEventId !== null && session.scanTerminalEventId !== undefined) {
        if (session.scanTerminalEventId !== event.eventId || session.scanTerminalSequence !== BigInt(event.sequence) ||
          session.scanTerminalEventType !== eventType || session.scanTerminalPayloadHash !== payloadHash ||
          !session.scanTerminalIngestedAt) return false;
        acknowledgement.ingestedAt = session.scanTerminalIngestedAt.toISOString();
        return true;
      }
      // Legacy terminals have no recoverable complete payload identity. Keep
      // their old replay contract dependent on retained raw rows and ACK outbox.
      const processed = await tx.processedGatewayEvent.findFirst({
        where: {
          eventId: event.eventId,
          gatewayId: event.gatewayId,
          sequence: BigInt(event.sequence),
          eventType,
          occurredAt: new Date(event.occurredAt)
        },
        select: { eventId: true, payloadHash: true }
      });
      return Boolean(processed && (processed.payloadHash == null || processed.payloadHash === payloadHash));
    }
    if (session.status !== "active" || session.scanStatus !== "scanning") return false;

    const previous = await tx.processedGatewayEvent.findFirst({
      where: { gatewayId: event.gatewayId, eventType, sequence: { gte: BigInt(event.sequence) } },
      select: { eventId: true }
    });
    if (previous) return false;
    const ordering = await compareAndAdvanceGatewayEvent(tx, {
      gatewayId: event.gatewayId, eventType, scopeKey: "", sequence: BigInt(event.sequence),
      eventId: event.eventId, payloadHash, occurredAt: new Date(event.occurredAt)
    });
    if (ordering !== "advanced") return false;
    await tx.processedGatewayEvent.create({
      data: {
        eventId: event.eventId,
        gatewayId: event.gatewayId,
        sequence: BigInt(event.sequence),
        eventType,
        scopeKey: event.sessionId,
        payloadHash,
        occurredAt: new Date(event.occurredAt)
      }
    });
    await tx.provisioningSession.update({
      where: { id: session.id },
      data: {
        scanTerminalEventId: event.eventId,
        scanTerminalSequence: BigInt(event.sequence),
        scanTerminalEventType: eventType,
        scanTerminalPayloadHash: payloadHash,
        scanTerminalIngestedAt: new Date(acknowledgement.ingestedAt),
        ...("acceptedNodeCount" in event
        ? { scanStatus: "completed", scanCompletedAt: new Date(event.occurredAt), scanFailureCode: null, scanFailureMessage: null }
        : {
            scanStatus: "failed",
            scanCompletedAt: new Date(event.occurredAt),
            scanFailureCode: event.code,
            scanFailureMessage: event.message
          })
      }
    });
    return true;
  }

  private async persistProvisioningScanTerminalAcknowledgement(
    tx: Prisma.TransactionClient,
    siteId: string,
    gatewayId: string,
    acknowledgement: ReturnType<typeof applicationProvisioningScanTerminalIngestedAckV2Schema.parse>
  ) {
    const applicationAckKey = `provisioning-scan-terminal:${gatewayId}:${acknowledgement.eventId}:${acknowledgement.sequence}`;
    const existing = await tx.mqttOutbox.findUnique({ where: { applicationAckKey } });
    const now = new Date();
    if (existing) {
      const stored = applicationProvisioningScanTerminalIngestedAckV2Schema.parse(existing.payload);
      if (
        stored.eventId !== acknowledgement.eventId || stored.sequence !== acknowledgement.sequence ||
        stored.sessionId !== acknowledgement.sessionId || stored.scanCorrelationId !== acknowledgement.scanCorrelationId ||
        stored.scanAttempt !== acknowledgement.scanAttempt ||
        existing.gatewayId !== gatewayId ||
        existing.topic !== mqttTopicsV2.provisioningScanTerminalIngestedAck(siteId, gatewayId)
      ) throw new Error("provisioning scan terminal acknowledgement identity conflict");
      await tx.mqttOutbox.updateMany({
        where: {
          id: existing.id,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          AND: [{ OR: [
            { publishedAt: { not: null } },
            { deadLetteredAt: { not: null } },
            { leaseExpiresAt: { lte: now } }
          ] }]
        },
        data: {
          attempts: 0,
          nextAttemptAt: now,
          publishedAt: null,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          deadLetteredAt: null,
          lastError: null
        }
      });
      return;
    }
    await tx.mqttOutbox.create({
      data: {
        gatewayId,
        applicationAckKey,
        revision: null,
        payloadHash: canonicalPayloadHash(acknowledgement),
        topic: mqttTopicsV2.provisioningScanTerminalIngestedAck(siteId, gatewayId),
        payload: acknowledgement
      }
    });
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
      await this.automationSnapshot.lockMutation(tx);
      const dispatch = await this.lockCommandDispatch(tx, ack);
      if (!dispatch || !ACTIVE_DISPATCH_STATUSES.includes(dispatch.status)) return;
      const failed = await tx.commandDispatch.updateMany({ where, data });
      if (failed.count !== 1) return;
      const errorMessage = ack.errorMessage ?? "gateway rejected command";
      await tx.commandFixtureResult.updateMany({
        where: { dispatchId: ack.dispatchId, status: "pending" },
        data: { status: "failed", occurredAt: acceptedAt, errorMessage }
      });
      await this.finishParentCommand(tx, dispatch);
    });
  }

  private async storeHeartbeatV2(heartbeat: ReturnType<typeof gatewayHeartbeatV2Schema.parse>, receivedAt: Date) {
    const maxFutureSkewMs = gatewayEventMaxFutureSkewMs();
    const occurredAt = new Date(heartbeat.occurredAt);
    const payloadHash = canonicalPayloadHash(heartbeat);
    const sequence = BigInt(heartbeat.sequence);
    try {
      await this.prisma.$transaction(async (tx) => {
        // Scope validation and ordering share the Gateway row lock. A heartbeat that
        // waited for another writer must inspect the committed ledger and sequence again.
        const [gateway] = await tx.$queryRaw<Array<{ id: string; lastHeartbeatSequence: bigint | null }>>`
          SELECT "id", "lastHeartbeatSequence" FROM "Gateway"
          WHERE "id" = ${heartbeat.gatewayId}
            AND "siteId" = ${heartbeat.siteId}
            AND "serialNumber" = ${heartbeat.gatewaySerial}
          FOR UPDATE
        `;
        if (!gateway) throw new Error("gateway heartbeat scope rejected");
        const existing = await tx.processedGatewayEvent.findUnique({ where: { eventId: heartbeat.eventId } });
        if (existing) {
          const replay = await reconcileLegacyGatewayEventReplay(
            tx, existing, payloadHash, (event) => sameHeartbeatEventIdentity(event, heartbeat)
          );
          if (!replay) throw new Error("gateway heartbeat event identity conflict");
          return;
        }
        const ingestionStatus = gatewayEventIsTooFarInFuture(occurredAt, receivedAt, maxFutureSkewMs)
          ? "rejected_future_timestamp" : "accepted";
        if (ingestionStatus === "accepted") {
          const ordering = await compareAndAdvanceGatewayEvent(tx, {
          gatewayId: heartbeat.gatewayId, eventType: "gateway_heartbeat", scopeKey: "",
            sequence, eventId: heartbeat.eventId, payloadHash, occurredAt
          });
          if (ordering !== "advanced") return;
        }
        await tx.processedGatewayEvent.create({
          data: {
            eventId: heartbeat.eventId,
            gatewayId: heartbeat.gatewayId,
            sequence,
            eventType: "gateway_heartbeat",
            scopeKey: "",
            occurredAt,
            receivedAt,
            payloadHash,
            ingestionStatus
          }
        });
        // Terminal rejection commits only the ledger, so MQTT can PUBACK poison packets.
        if (ingestionStatus === "rejected_future_timestamp") return;
        const updated = await tx.gateway.updateMany({
          where: {
            id: heartbeat.gatewayId,
            siteId: heartbeat.siteId,
            serialNumber: heartbeat.gatewaySerial,
            OR: [{ lastHeartbeatSequence: null }, { lastHeartbeatSequence: { lt: sequence } }]
          },
          data: {
            lastHeartbeatAt: receivedAt,
            lastHeartbeatEventId: heartbeat.eventId,
            lastHeartbeatSequence: sequence,
            lastHeartbeatOccurredAt: occurredAt,
            firmwareVersion: heartbeat.firmwareVersion
          }
        });
        if (updated.count !== 1) throw new Error("gateway heartbeat scope or sequence rejected");
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      // A partial unique sequence collision is not proof of a replay. Only an exact
      // committed identity and canonical payload may complete successfully after P2002.
      const existing = await this.prisma.processedGatewayEvent.findUnique({ where: { eventId: heartbeat.eventId } });
      if (!existing || !sameHeartbeatEvent(existing, heartbeat, payloadHash)) throw new Error("gateway heartbeat sequence conflict");
    }
  }

  private async storeDeviceStatusAck(
    ack: ReturnType<typeof deviceStatusAckV2Schema.parse>
  ) {
    await this.prisma.$transaction(async (tx) => {
      // Serialize every uncertainty transition with dimming overlap scans before
      // acquiring dispatch/command rows, matching verification and timeout writers.
      await this.automationSnapshot.lockMutation(tx);
      const dispatch = await this.lockCommandDispatch(tx, ack);
      if (!dispatch) return;
      const late = dispatch.kind === "dimming" && dispatch.outcome === "unknown"
        && ["failed", "timed_out"].includes(dispatch.status)
        && [...RECONCILABLE_TIMEOUT_CODES, ...RECONCILABLE_PUBLISH_CODES].includes(dispatch.errorCode ?? "");
      if (!ACTIVE_DISPATCH_STATUSES.includes(dispatch.status) && !late) return;
      if (!await this.claimDeviceStatusEvent(tx, ack)) return;

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
        // Malformed late evidence cannot consume the one permitted reconciliation.
        if (late) return;
        await this.failInvalidDeviceStatusAck(tx, dispatch, ack.occurredAt, "ack_fixture_set_mismatch", "device status ACK fixture set mismatch");
        return;
      }

      const derivedStatus = deriveDeviceStatusAckStatus(ack.results);
      if (derivedStatus !== ack.status) {
        if (late) return;
        await this.failInvalidDeviceStatusAck(tx, dispatch, ack.occurredAt, "ack_status_mismatch", "device status ACK aggregate status mismatch");
        return;
      }

      // Older BlueZ producers encoded lost Lightness Status as failed + STATUS_TIMEOUT.
      // Validate the original aggregate/hash first, then persist absence of evidence as
      // timed_out. A compatibility conversion must not legitimize a malformed wire ACK.
      const results = ack.results.map((result) => result.status === "failed" && result.faultCode === "STATUS_TIMEOUT"
        ? { ...result, status: "timed_out" as const, brightness: undefined } : result);
      const normalizedStatus = deriveDeviceStatusAckStatus(results);
      const dispatchStatus = normalizedStatus === "succeeded" ? "completed" : normalizedStatus === "timed_out" ? "timed_out" : "failed";
      const completed = await tx.commandDispatch.updateMany({
        where: { id: dispatch.id, status: dispatch.status },
        data: {
          status: dispatchStatus,
          completedAt: new Date(ack.occurredAt),
          errorCode: results.some((result) => result.status === "timed_out") ? "STATUS_TIMEOUT" : null,
          errorMessage: null
        }
      });
      if (completed.count !== 1) return;

      for (const result of results) {
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

      await this.finishParentCommand(tx, dispatch);
    });
  }

  private async claimDeviceStatusEvent(
    tx: Prisma.TransactionClient,
    ack: ReturnType<typeof deviceStatusAckV2Schema.parse>
  ) {
    const payloadHash = canonicalPayloadHash(ack);
    // ACK sequence identifies the command, not the event: a distinct late ACK
    // shares it. Allocate a ledger sequence under the already-held mutation lock,
    // matching resync ingestion, so the legacy unique sequence index permits both.
    // ON CONFLICT also handles an eventId claimed by another ingestion path without
    // aborting PostgreSQL's transaction before we can validate the durable identity.
    const inserted = await tx.$queryRaw<Array<{ eventId: string }>>`
      INSERT INTO "ProcessedGatewayEvent" ("eventId", "gatewayId", "sequence", "eventType", "payloadHash", "occurredAt")
      SELECT ${ack.eventId}, ${ack.gatewayId}, COALESCE(MAX("sequence"), -1::bigint) + 1::bigint,
        ${DEVICE_STATUS_ACK_EVENT_TYPE}, ${payloadHash}, ${new Date(ack.occurredAt)}
      FROM "ProcessedGatewayEvent"
      WHERE "gatewayId" = ${ack.gatewayId} AND "eventType" = ${DEVICE_STATUS_ACK_EVENT_TYPE}
      ON CONFLICT DO NOTHING
      RETURNING "eventId"
    `;
    if (inserted.length === 1) return true;
    const existing = await tx.processedGatewayEvent.findUnique({ where: { eventId: ack.eventId } });
    if (existing?.gatewayId !== ack.gatewayId || existing.eventType !== DEVICE_STATUS_ACK_EVENT_TYPE
      || existing.payloadHash !== payloadHash) {
      // Keep untrusted payloads, identifiers and database details out of logs.
      this.logger.warn("device status ACK event identity conflict");
    }
    return false;
  }

  private async failInvalidDeviceStatusAck(
    tx: Prisma.TransactionClient,
    dispatch: LockedCommandDispatch,
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
    await this.finishParentCommand(tx, dispatch);
  }

  private async lockCommandDispatch(
    tx: Prisma.TransactionClient,
    ack: { dispatchId: string; commandId: string; gatewayId: string; idempotencyKey: string; sequence: number; siteId: string }
  ) {
    const rows = await tx.$queryRaw<LockedCommandDispatch[]>`
      SELECT d."id", d."commandId", d."kind", d."verificationAttempt", d."status", d."errorCode", c."outcome", c."brightness"
      FROM "CommandDispatch" d INNER JOIN "Command" c ON c."id" = d."commandId"
      WHERE d."id" = ${ack.dispatchId} AND d."commandId" = ${ack.commandId}
        AND d."gatewayId" = ${ack.gatewayId} AND d."idempotencyKey" = ${ack.idempotencyKey}
        AND d."sequence" = ${BigInt(ack.sequence)} AND c."siteId" = ${ack.siteId}
      FOR UPDATE OF d, c
    `;
    return rows[0];
  }

  private async finishParentCommand(tx: Prisma.TransactionClient, dispatch: LockedCommandDispatch) {
    const verification = dispatch.kind === "status_check";
    const dispatches = await tx.commandDispatch.findMany({
      where: { commandId: dispatch.commandId, kind: dispatch.kind,
        ...(verification ? { verificationAttempt: dispatch.verificationAttempt } : {}) },
      include: { fixtureResults: true }
    });
    // A logical verification can span multiple wire-sized chunks. Never conclude
    // from only the ACK's chunk or mix observations from earlier attempts.
    if (!dispatches.length || dispatches.some((item) => ACTIVE_DISPATCH_STATUSES.includes(item.status))) return;
    if (verification && dispatch.outcome !== "unknown") return;
    const results = dispatches.flatMap((item) => item.fixtureResults);
    const outcome = verification
      ? this.verificationOutcome(results, dispatch.brightness)
      : this.dimmingOutcome(dispatches, results);
    await tx.command.updateMany({
      where: { id: dispatch.commandId, ...(verification ? { outcome: "unknown" } : { outcome: dispatch.outcome }) },
      data: {
        status: outcome === "applied" ? "acknowledged" : "failed",
        ...(dispatch.outcome === null ? {} : { outcome }),
        errorMessage: outcome === "applied" ? null : "one or more gateway dispatches failed"
      }
    });
  }

  private verificationOutcome(results: Array<{ status: string; brightness: number | null }>, expectedBrightness: number) {
    if (!results.length || results.some((item) => item.status !== "succeeded" || item.brightness === null)) return "unknown" as const;
    const matches = results.filter((item) => item.brightness === expectedBrightness).length;
    return matches === results.length ? "applied" as const : matches === 0 ? "not_applied" as const : "partially_applied" as const;
  }

  private dimmingOutcome(dispatches: Array<{ status: string; errorCode: string | null }>, results: Array<{ status: string }>) {
    // A timed-out or malformed response cannot establish the physical result,
    // even if another fixture succeeded. Pending-delivery timeout is excluded:
    // the outbox was closed before publish, so that dispatch was never applied.
    if (!results.length || dispatches.some((item) => RECONCILABLE_TIMEOUT_CODES.includes(item.errorCode ?? "")
      || (item.status === "timed_out" && RECONCILABLE_PUBLISH_CODES.includes(item.errorCode ?? ""))
      || item.errorCode?.startsWith("ack_"))) return "unknown" as const;
    const succeeded = results.filter((item) => item.status === "succeeded").length;
    return succeeded === results.length ? "applied" as const : succeeded > 0 ? "partially_applied" as const : "not_applied" as const;
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
    await this.provisioningDeviceTerminal.completeLegacy(topicScope, event);
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

function sameHeartbeatEvent(
  existing: { gatewayId: string; fixtureId: string | null; sequence: bigint; eventType: string; occurredAt: Date; payloadHash: string | null },
  heartbeat: ReturnType<typeof gatewayHeartbeatV2Schema.parse>,
  payloadHash: string
) {
  return sameHeartbeatEventIdentity(existing, heartbeat) && existing.payloadHash === payloadHash;
}

function sameHeartbeatEventIdentity(
  existing: { gatewayId: string; fixtureId: string | null; sequence: bigint; eventType: string; occurredAt: Date },
  heartbeat: ReturnType<typeof gatewayHeartbeatV2Schema.parse>
) {
  return existing.gatewayId === heartbeat.gatewayId && existing.sequence === BigInt(heartbeat.sequence) &&
    existing.fixtureId === null && existing.eventType === "gateway_heartbeat" &&
    existing.occurredAt.getTime() === new Date(heartbeat.occurredAt).getTime();
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
      clean: false,
      protocolVersion: 5,
      properties: { sessionExpiryInterval: 86_400 }
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

function isUniqueConstraintError(error: unknown): error is { code: "P2002"; meta?: unknown } {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function parseGatewayScopedTopic(topic: string) {
  const match = /^sites\/([^/]+)\/gateways\/([^/]+)\//.exec(topic);
  if (!match) return null;
  return { siteId: match[1], gatewayId: match[2] };
}
