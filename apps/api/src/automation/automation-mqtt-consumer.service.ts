import { BadRequestException, Injectable } from "@nestjs/common";
import {
  automationConfigAppliedDeliveryV1Schema,
  automationConfigAppliedReceiptV1Schema,
  automationCurrentConfigRequestV1Schema,
  automationExecutionActionResultPayloadV1Schema,
  automationExecutionEventV1Schema,
  automationExecutionIngestedAckV1Schema,
  automationSnapshotV1Schema,
  mqttTopics,
  type AutomationConfigAppliedDeliveryV1,
  type AutomationExecutionEventV1
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import { PrismaService } from "../prisma/prisma.service";
import { parseGatewayTopic, type GatewayTopicScope } from "../mqtt/topic-scope";
import { AutomationClock } from "./automation-clock";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { VehicleSensorCapabilityService } from "./vehicle-sensor-capability.service";

const CONFIG_APPLIED_CHANNEL = "events/automation/config-applied";
const CURRENT_CONFIG_REQUEST_CHANNEL = "events/automation/current-config-request";
const EXECUTION_CHANNEL = "events/automation/execution";
const CAPABILITY_CHANNEL = "events/automation/vehicle-sensor-capability";

type CurrentConfiguration = {
  gatewayId: string;
  siteId: string;
  desiredRevision: number;
  appliedRevision: number;
  syncStatus: "PENDING" | "APPLIED" | "REJECTED";
  lastErrorCode: string | null;
  lastAppliedAt: Date | null;
  payloadHash: string | null;
};

type ExecutionSource = {
  lightingScheduleId: string | null;
  vehicleEventRuleId: string | null;
  manualOverrideId: string | null;
  allowedFixtureIds: Set<string>;
};

type StoredAutomationSnapshot = ReturnType<typeof automationSnapshotV1Schema.parse>;

@Injectable()
export class AutomationMqttConsumerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capability: VehicleSensorCapabilityService,
    private readonly clock: AutomationClock
  ) {}

  async handleMessage(topic: string, payload: Buffer) {
    const scope = parseGatewayTopic(topic);
    if (!scope) return;

    if (scope.channel === CAPABILITY_CHANNEL) {
      const report = this.parseJson(payload);
      if (
        typeof report !== "object" || report === null ||
        (report as { siteId?: unknown }).siteId !== scope.siteId ||
        (report as { gatewayId?: unknown }).gatewayId !== scope.gatewayId
      ) return;
      await this.capability.applyReport(report, {
        siteId: scope.siteId,
        gatewayId: scope.gatewayId,
        requireActiveClaim: true
      });
      return;
    }

    if (scope.channel === CONFIG_APPLIED_CHANNEL) {
      await this.onConfigApplied(scope, this.parseJson(payload));
      return;
    }
    if (scope.channel === CURRENT_CONFIG_REQUEST_CHANNEL) {
      await this.onCurrentConfigRequest(scope, this.parseJson(payload));
      return;
    }
    if (scope.channel === EXECUTION_CHANNEL) {
      await this.onExecution(scope, this.parseJson(payload));
    }
  }

  async onCurrentConfigRequest(
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">,
    rawRequest: unknown
  ) {
    const parsed = automationCurrentConfigRequestV1Schema.safeParse(rawRequest);
    if (
      !parsed.success || parsed.data.siteId !== scope.siteId ||
      parsed.data.gatewayId !== scope.gatewayId
    ) return;

    return this.prisma.$transaction(async (tx) => {
      const configuration = await this.lockCurrentConfiguration(tx, scope);
      if (!configuration?.payloadHash) return;
      const stored = await this.loadStoredSnapshot(
        tx,
        scope,
        configuration.desiredRevision,
        configuration.payloadHash
      );
      if (!stored) return;
      const now = this.clock.now();
      await tx.mqttOutbox.updateMany({
        where: {
          id: stored.id,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }]
        },
        data: {
          attempts: 0,
          nextAttemptAt: now,
          publishedAt: null,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          deadLetteredAt: null,
          supersededAt: null,
          lastError: null
        }
      });
      return stored.snapshot;
    });
  }

  async onConfigApplied(scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">, rawAck: unknown) {
    const parsed = automationConfigAppliedDeliveryV1Schema.safeParse(rawAck);
    if (
      !parsed.success || parsed.data.siteId !== scope.siteId ||
      parsed.data.gatewayId !== scope.gatewayId
    ) return;
    const delivery = parsed.data as AutomationConfigAppliedDeliveryV1;
    const ack = delivery.acknowledgement;

    return this.prisma.$transaction(async (tx) => {
      const configuration = await this.lockCurrentConfiguration(tx, scope);
      if (!configuration || ack.revision > configuration.desiredRevision) return;

      const stored = await this.loadStoredSnapshot(tx, scope, ack.revision, ack.payloadHash);
      if (!stored) return;
      const storedSnapshot = stored.snapshot;

      if (ack.status === "rejected") {
        if (ack.revision === configuration.desiredRevision && ack.revision > configuration.appliedRevision) {
          await tx.gatewayAutomationConfiguration.update({
            where: { gatewayId: scope.gatewayId },
            data: {
              syncStatus: "REJECTED",
              lastErrorCode: sanitizeConfigurationErrorCode(ack.errorCode)
            }
          });
        }
      } else if (ack.revision > configuration.appliedRevision) {
        const isCurrentDesired = ack.revision === configuration.desiredRevision;
        const preserveCurrentRejection = !isCurrentDesired && configuration.syncStatus === "REJECTED";
        await tx.gatewayAutomationConfiguration.update({
          where: { gatewayId: scope.gatewayId },
          data: {
            appliedRevision: ack.revision,
            syncStatus: preserveCurrentRejection ? "REJECTED" : isCurrentDesired ? "APPLIED" : "PENDING",
            lastErrorCode: preserveCurrentRejection ? configuration.lastErrorCode : null,
            lastAppliedAt: new Date(ack.appliedAt)
          }
        });
        const scheduleIds = storedSnapshot.schedules.map(({ id }) => id);
        if (scheduleIds.length > 0) {
          await tx.lightingSchedule.updateMany({
            where: { id: { in: scheduleIds }, gatewayId: scope.gatewayId, appliedRevision: { lt: ack.revision } },
            data: { appliedRevision: ack.revision }
          });
        }
        const eventRuleIds = storedSnapshot.vehicleEventRules.map(({ id }) => id);
        if (eventRuleIds.length > 0) {
          await tx.vehicleEventRule.updateMany({
            where: { id: { in: eventRuleIds }, gatewayId: scope.gatewayId, appliedRevision: { lt: ack.revision } },
            data: { appliedRevision: ack.revision }
          });
        }
      }

      return this.createOrReviveConfigAppliedReceipt(tx, scope, delivery);
    });
  }

  private async loadStoredSnapshot(
    tx: Prisma.TransactionClient,
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">,
    revision: number,
    payloadHash: string
  ) {
    const row = await tx.mqttOutbox.findFirst({
      where: {
        gatewayId: scope.gatewayId,
        revision,
        payloadHash,
        dispatchId: null,
        applicationAckKey: null
      },
      select: { id: true, topic: true, payload: true }
    });
    const parsed = automationSnapshotV1Schema.safeParse(row?.payload);
    if (!row || !parsed.success) return null;
    const { payloadHash: storedHash, ...withoutHash } = parsed.data;
    if (
      row.topic !== mqttTopics.automationConfig(scope.siteId, scope.gatewayId) ||
      parsed.data.siteId !== scope.siteId || parsed.data.gatewayId !== scope.gatewayId ||
      parsed.data.revision !== revision || storedHash !== payloadHash ||
      canonicalPayloadHash(withoutHash) !== payloadHash
    ) return null;
    return { id: row.id, snapshot: parsed.data };
  }

  private async createOrReviveConfigAppliedReceipt(
    tx: Prisma.TransactionClient,
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">,
    delivery: AutomationConfigAppliedDeliveryV1
  ) {
    const applicationAckKey = configAppliedReceiptKey(scope.gatewayId, delivery.acknowledgementId);
    const existing = await tx.mqttOutbox.findUnique({ where: { applicationAckKey } });
    if (existing) {
      const receipt = automationConfigAppliedReceiptV1Schema.safeParse(existing.payload);
      if (
        !receipt.success || receipt.data.siteId !== scope.siteId ||
        receipt.data.gatewayId !== scope.gatewayId ||
        receipt.data.acknowledgementId !== delivery.acknowledgementId ||
        !isDeepStrictEqual(receipt.data.acknowledgement, delivery.acknowledgement)
      ) {
        throw new BadRequestException("config-applied acknowledgement identity conflict");
      }
      await this.reviveApplicationAck(tx, existing.id);
      return receipt.data;
    }

    const receipt = automationConfigAppliedReceiptV1Schema.parse({
      ...delivery,
      ingestedAt: this.clock.now().toISOString()
    });
    const stored = await tx.mqttOutbox.create({
      data: {
        gatewayId: scope.gatewayId,
        applicationAckKey,
        revision: null,
        payloadHash: canonicalPayloadHash(receipt),
        topic: mqttTopics.automationConfigAppliedReceipt(scope.siteId, scope.gatewayId),
        payload: receipt
      }
    });
    return automationConfigAppliedReceiptV1Schema.parse(stored.payload);
  }

  private reviveApplicationAck(tx: Prisma.TransactionClient, id: string) {
    const now = this.clock.now();
    return tx.mqttOutbox.updateMany({
      where: {
        id,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        AND: [{
          OR: [
            { publishedAt: { not: null } },
            { deadLetteredAt: { not: null } },
            { leaseExpiresAt: { lte: now } }
          ]
        }]
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
  }

  async onExecution(scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">, rawEvent: unknown) {
    const parsed = automationExecutionEventV1Schema.safeParse(rawEvent);
    if (!parsed.success || parsed.data.gatewayId !== scope.gatewayId) return;

    try {
      return await this.prisma.$transaction((tx) => this.ingestExecution(tx, scope, parsed.data));
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.prisma.$transaction((tx) => this.ingestExecution(tx, scope, parsed.data));
    }
  }

  private async ingestExecution(
    tx: Prisma.TransactionClient,
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">,
    event: AutomationExecutionEventV1
  ) {
    if (!await this.lockCurrentGatewayIdentity(tx, scope)) return;
    const reportPayloadHash = canonicalExecutionPayloadHash(event);
    const existing = await tx.automationExecution.findUnique({
      where: {
        gatewayId_eventId_sequence: {
          gatewayId: scope.gatewayId,
          eventId: event.eventId,
          sequence: BigInt(event.sequence)
        }
      },
      select: { payloadHash: true }
    });
    if (existing) {
      if (existing.payloadHash !== reportPayloadHash) {
        throw new BadRequestException("automation execution replay conflict");
      }
      return this.reviveExecutionAck(tx, scope, event, reportPayloadHash);
    }

    const snapshot = await this.loadExecutionSnapshot(tx, scope, event.revision);
    if (!snapshot) return;
    const source = await this.resolveExecutionSource(tx, scope, snapshot, event);
    if (!source) return;
    const actionPayload = event.kind === "action_result"
      ? automationExecutionActionResultPayloadV1Schema.parse(event.payload)
      : null;
    if (actionPayload && actionPayload.results.some((result) => !source.allowedFixtureIds.has(result.fixtureId))) {
      return;
    }

    const execution = await tx.automationExecution.create({
      data: {
        siteId: scope.siteId,
        gatewayId: scope.gatewayId,
        eventId: event.eventId,
        sequence: BigInt(event.sequence),
        revision: event.revision,
        ruleId: event.ruleId,
        lightingScheduleId: source.lightingScheduleId,
        vehicleEventRuleId: source.vehicleEventRuleId,
        manualOverrideId: source.manualOverrideId,
        occurrenceKey: event.occurrenceKey,
        kind: event.kind,
        occurredAt: new Date(event.occurredAt),
        payload: event.payload as Prisma.InputJsonValue,
        payloadHash: reportPayloadHash
      },
      select: { id: true }
    });
    if (actionPayload) {
      await tx.automationExecutionFixtureResult.createMany({
        data: actionPayload.results.map((result) => ({
          executionId: execution.id,
          fixtureSnapshotId: result.fixtureId,
          fixtureId: result.fixtureId,
          status: result.status,
          brightnessPercent: result.brightnessPercent,
          faultCode: result.faultCode,
          errorCode: result.errorCode,
          occurredAt: new Date(result.occurredAt)
        }))
      });
    }
    return this.createExecutionAck(tx, scope, event, reportPayloadHash);
  }

  private async resolveExecutionSource(
    tx: Prisma.TransactionClient,
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">,
    snapshot: StoredAutomationSnapshot,
    event: AutomationExecutionEventV1
  ): Promise<ExecutionSource | null> {
    if (event.kind === "telemetry_gap") {
      return emptyExecutionSource();
    }
    if (event.kind === "schedule_started" || event.kind === "schedule_ended") {
      return this.resolveSnapshotSchedule(tx, scope, snapshot, event.ruleId);
    }
    if (["vehicle_detected", "event_started", "event_extended", "event_ended"].includes(event.kind)) {
      return this.resolveSnapshotVehicleRule(tx, scope, snapshot, event.ruleId);
    }

    const payload = automationExecutionActionResultPayloadV1Schema.parse(event.payload);
    if (payload.sourceType === "schedule") {
      return this.resolveSnapshotSchedule(tx, scope, snapshot, payload.sourceId);
    }
    if (payload.sourceType === "vehicle_event_rule") {
      return this.resolveSnapshotVehicleRule(tx, scope, snapshot, payload.sourceId);
    }
    const manualOverride = await tx.manualOverride.findFirst({
      where: { commandId: payload.sourceId, siteId: scope.siteId, gatewayId: scope.gatewayId },
      select: { id: true, fixtures: { select: { fixtureId: true } } }
    });
    return manualOverride ? {
      ...emptyExecutionSource(),
      manualOverrideId: manualOverride.id,
      allowedFixtureIds: new Set(manualOverride.fixtures.map(({ fixtureId }) => fixtureId))
    } : null;
  }

  private async resolveSnapshotSchedule(
    tx: Prisma.TransactionClient,
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">,
    snapshot: StoredAutomationSnapshot,
    ruleId: string | null
  ): Promise<ExecutionSource | null> {
    if (!ruleId) return null;
    const snapshotSchedule = snapshot.schedules.find((schedule) => schedule.id === ruleId && schedule.status === "enabled");
    if (!snapshotSchedule) return null;
    const schedule = await tx.lightingSchedule.findFirst({
      where: { id: ruleId, siteId: scope.siteId, gatewayId: scope.gatewayId },
      select: { id: true }
    });
    return {
      ...emptyExecutionSource(),
      lightingScheduleId: schedule?.id ?? null,
      allowedFixtureIds: new Set(snapshotSchedule.fixtureIds)
    };
  }

  private async resolveSnapshotVehicleRule(
    tx: Prisma.TransactionClient,
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">,
    snapshot: StoredAutomationSnapshot,
    ruleId: string | null
  ): Promise<ExecutionSource | null> {
    if (!ruleId) return null;
    const snapshotRule = snapshot.vehicleEventRules.find((rule) => rule.id === ruleId && rule.status === "enabled");
    if (!snapshotRule) return null;
    const rule = await tx.vehicleEventRule.findFirst({
      where: { id: ruleId, siteId: scope.siteId, gatewayId: scope.gatewayId },
      select: { id: true }
    });
    return {
      ...emptyExecutionSource(),
      vehicleEventRuleId: rule?.id ?? null,
      allowedFixtureIds: new Set(snapshotRule.targetFixtureIds)
    };
  }

  private async loadExecutionSnapshot(
    tx: Prisma.TransactionClient,
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">,
    revision: number
  ): Promise<StoredAutomationSnapshot | null> {
    const rows = await tx.mqttOutbox.findMany({
      where: {
        gatewayId: scope.gatewayId,
        revision,
        dispatchId: null,
        applicationAckKey: null
      },
      select: { payloadHash: true, payload: true }
    });
    const snapshots = rows.flatMap((row) => {
      const parsed = automationSnapshotV1Schema.safeParse(row.payload);
      if (!parsed.success) return [];
      const { payloadHash, ...withoutHash } = parsed.data;
      if (
        row.payloadHash !== payloadHash || canonicalPayloadHash(withoutHash) !== payloadHash ||
        parsed.data.siteId !== scope.siteId || parsed.data.gatewayId !== scope.gatewayId ||
        parsed.data.revision !== revision
      ) return [];
      return [parsed.data];
    });
    return snapshots.length === 1 ? snapshots[0] : null;
  }

  private async createExecutionAck(
    tx: Prisma.TransactionClient,
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">,
    event: AutomationExecutionEventV1,
    reportPayloadHash: `sha256:${string}`
  ) {
    const acknowledgement = automationExecutionIngestedAckV1Schema.parse({
      schemaVersion: 1,
      gatewayId: scope.gatewayId,
      eventId: event.eventId,
      sequence: event.sequence,
      reportPayloadHash,
      ingestedAt: this.clock.now().toISOString()
    });
    const stored = await tx.mqttOutbox.create({
      data: {
        gatewayId: scope.gatewayId,
        applicationAckKey: executionAckKey(scope.gatewayId, event.eventId, event.sequence, reportPayloadHash),
        revision: null,
        payloadHash: canonicalPayloadHash(acknowledgement),
        topic: mqttTopics.automationExecutionIngested(scope.siteId, scope.gatewayId),
        payload: acknowledgement
      }
    });
    return automationExecutionIngestedAckV1Schema.parse(stored.payload);
  }

  private async reviveExecutionAck(
    tx: Prisma.TransactionClient,
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">,
    event: AutomationExecutionEventV1,
    reportPayloadHash: `sha256:${string}`
  ) {
    const applicationAckKey = executionAckKey(scope.gatewayId, event.eventId, event.sequence, reportPayloadHash);
    const existing = await tx.mqttOutbox.findUnique({ where: { applicationAckKey } });
    if (!existing) throw new Error("automation execution ACK outbox is missing");
    const acknowledgement = automationExecutionIngestedAckV1Schema.parse(existing.payload);
    const now = this.clock.now();
    await tx.mqttOutbox.updateMany({
      where: {
        id: existing.id,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        AND: [{
          OR: [
            { publishedAt: { not: null } },
            { deadLetteredAt: { not: null } },
            { leaseExpiresAt: { lte: now } }
          ]
        }]
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
    return acknowledgement;
  }

  private async lockCurrentConfiguration(
    tx: Prisma.TransactionClient,
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">
  ) {
    const [configuration] = await tx.$queryRaw<CurrentConfiguration[]>(Prisma.sql`
      SELECT configuration.*
      FROM "GatewayAutomationConfiguration" AS configuration
      INNER JOIN "Gateway" AS gateway
        ON gateway."id" = configuration."gatewayId" AND gateway."siteId" = configuration."siteId"
      INNER JOIN "GatewayInventory" AS inventory
        ON inventory."claimedGatewayId" = gateway."id"
        AND inventory."claimedAt" IS NOT NULL
        AND inventory."disabledAt" IS NULL
      WHERE configuration."gatewayId" = ${scope.gatewayId}
        AND configuration."siteId" = ${scope.siteId}
        AND EXISTS (
          SELECT 1 FROM "GatewayCertificate" AS certificate
          WHERE certificate."inventoryId" = inventory."id"
            AND certificate."gatewayId" = gateway."id"
            AND certificate."purpose" = 'mqtt'
            AND certificate."status" = 'active'
            AND certificate."revokedAt" IS NULL
        )
      FOR UPDATE OF configuration, gateway, inventory
    `);
    return configuration;
  }

  private async lockCurrentGatewayIdentity(
    tx: Prisma.TransactionClient,
    scope: Pick<GatewayTopicScope, "siteId" | "gatewayId">
  ) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT gateway."id"
      FROM "Gateway" AS gateway
      INNER JOIN "GatewayInventory" AS inventory
        ON inventory."claimedGatewayId" = gateway."id"
        AND inventory."claimedAt" IS NOT NULL
        AND inventory."disabledAt" IS NULL
      WHERE gateway."id" = ${scope.gatewayId}
        AND gateway."siteId" = ${scope.siteId}
        AND EXISTS (
          SELECT 1 FROM "GatewayCertificate" AS certificate
          WHERE certificate."inventoryId" = inventory."id"
            AND certificate."gatewayId" = gateway."id"
            AND certificate."purpose" = 'mqtt'
            AND certificate."status" = 'active'
            AND certificate."revokedAt" IS NULL
        )
      FOR UPDATE OF gateway, inventory
    `);
    return rows.length === 1;
  }

  private parseJson(payload: Buffer): unknown {
    return JSON.parse(payload.toString("utf8"));
  }
}

function emptyExecutionSource(): ExecutionSource {
  return {
    lightingScheduleId: null,
    vehicleEventRuleId: null,
    manualOverrideId: null,
    allowedFixtureIds: new Set()
  };
}

function executionAckKey(
  gatewayId: string,
  eventId: string,
  sequence: number,
  reportPayloadHash: string
) {
  return `automation-execution:${gatewayId}:${eventId}:${sequence}:${reportPayloadHash}`;
}

function configAppliedReceiptKey(gatewayId: string, acknowledgementId: string) {
  return `automation-config-applied:${gatewayId}:${acknowledgementId}`;
}

function canonicalExecutionPayloadHash(event: AutomationExecutionEventV1) {
  if (event.kind !== "action_result") return canonicalPayloadHash(event);
  const payload = automationExecutionActionResultPayloadV1Schema.parse(event.payload);
  return canonicalPayloadHash({
    ...event,
    payload: {
      ...payload,
      results: [...payload.results].sort((left, right) => {
        if (left.fixtureId < right.fixtureId) return -1;
        if (left.fixtureId > right.fixtureId) return 1;
        return 0;
      })
    }
  });
}

function sanitizeConfigurationErrorCode(errorCode: string | null) {
  if (errorCode && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(errorCode)) return errorCode;
  return "configuration_rejected";
}

function isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
