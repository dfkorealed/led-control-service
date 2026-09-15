import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { CommandDispatchKind, Prisma } from "@prisma/client";
import {
  createGatewayCommandExpiry,
  GatewayDimmingCommandDraftV2,
  GatewayDimmingCommandPublishedV2,
  gatewayDimmingCommandDraftV2CompatibilitySchema,
  gatewayDimmingCommandDraftV2Schema,
  gatewayDimmingCommandPublishedV2Schema,
  gatewayDimmingCommandV2CompatibilitySchema,
  GatewayStatusCheckCommandDraftV2,
  GatewayStatusCheckCommandPublishedV2,
  gatewayStatusCheckCommandDraftV2Schema,
  gatewayStatusCheckCommandPublishedV2Schema,
  remainingGatewayCommandMessageExpiry
} from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AutomationClock } from "../automation/automation-clock";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { MqttService } from "./mqtt.service";

const LEASE_MS = 30_000;
const MQTT_PUBLISH_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 10;
const MAX_AGE_MS = 15 * 60_000;

type PublisherOptions = {
  workerId?: string;
  random?: () => number;
  pollMs?: number;
  clock?: () => Date;
  deliveryGeneration?: () => string;
};

@Injectable()
export class OutboxPublisherService implements OnModuleInit {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly workerId: string;
  private readonly random: () => number;
  private readonly pollMs: number;
  private readonly clock: () => Date;
  private readonly deliveryGeneration: () => string;
  private timer: NodeJS.Timeout | null = null;
  private activeBatch: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    @Optional() options: PublisherOptions = {},
    @Optional() private readonly automationSnapshot: AutomationSnapshotService = new AutomationSnapshotService(new AutomationClock())
  ) {
    this.workerId = options.workerId ?? randomUUID();
    this.random = options.random ?? Math.random;
    this.pollMs = options.pollMs ?? Number(process.env.MQTT_OUTBOX_POLL_MS ?? 1000);
    this.clock = options.clock ?? (() => new Date());
    this.deliveryGeneration = options.deliveryGeneration ?? randomUUID;
  }

  onModuleInit() {
    this.stopped = false;
    void this.runScheduledBatch();
    this.timer = setInterval(() => void this.runScheduledBatch(), this.pollMs);
  }

  stopAndDrain() {
    if (!this.stopPromise) {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.stopPromise = this.activeBatch ?? Promise.resolve();
    }
    return this.stopPromise;
  }

  private runScheduledBatch() {
    // setInterval does not await asynchronous callbacks, so one stalled DB transaction must retain the worker slot.
    if (this.stopped || this.activeBatch) return this.activeBatch ?? Promise.resolve();

    const batch = this.processBatch()
      .catch((error) => {
        this.logger.error(`mqtt command outbox batch failed (worker=${this.workerId}, error=${this.errorKind(error)})`);
      })
      .finally(() => {
        this.activeBatch = null;
      });
    this.activeBatch = batch;
    return batch;
  }

  private errorKind(error: unknown) {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^P\d{4}$/.test(error.code)
    ) return error.code;
    return "UNEXPECTED_ERROR";
  }

  async claimBatch(now = this.clock()) {
    return this.prisma.$transaction(async (tx) => {
      await this.automationSnapshot.lockMutation(tx);
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "MqttOutbox"
        WHERE "publishedAt" IS NULL
          AND "deadLetteredAt" IS NULL
          AND "dispatchId" IS NOT NULL
          AND "nextAttemptAt" <= ${now}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 50
      `);
      const ids = rows.map((row) => row.id);
      if (ids.length === 0) return [];

      await tx.mqttOutbox.updateMany({
        where: { id: { in: ids }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        data: { lockedBy: this.workerId, lockedAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }
      });
      const records = await tx.mqttOutbox.findMany({
        where: { id: { in: ids }, dispatchId: { not: null }, lockedBy: this.workerId },
        include: {
          dispatch: {
            select: {
              commandId: true,
              kind: true,
              gatewayId: true,
              deliveryMode: true,
              destinationAddress: true,
              meshControlGroupId: true,
              meshControlGroupVersion: true
            }
          }
        },
        orderBy: { createdAt: "asc" }
      });
      return records.map((record) => {
        // The command publisher owns only the dispatch-backed MqttOutbox variant; keep the lease update transactional if DB integrity is broken.
        if (record.dispatchId === null || record.dispatch === null) {
          throw new Error("command outbox row is missing its dispatch relation");
        }
        return { ...record, dispatchId: record.dispatchId, dispatch: record.dispatch };
      });
    });
  }

  async processBatch(now = this.clock()) {
    const records = await this.claimBatch(now);
    for (const record of records) {
      // Shutdown waits for a publish already in progress but must not start later records while dependencies are closing.
      if (this.stopped) return;
      await this.publishClaimed(record);
    }
  }

  async publishClaimed(
    record: {
      id: string;
      dispatchId: string;
      topic: string;
      payload: Prisma.JsonValue;
      attempts: number;
      createdAt: Date;
      deliveryAttemptedAt?: Date | null;
      dispatch: {
        commandId: string;
        kind?: CommandDispatchKind;
        gatewayId: string;
        deliveryMode: string;
        destinationAddress: string | null;
        meshControlGroupId: string | null;
        meshControlGroupVersion: number | null;
      };
    }
  ) {
    try {
      const stored = parseStoredCommand(record.payload, record.dispatch.kind);
      const prepared = await this.prisma.$transaction(async (tx) => {
        await this.automationSnapshot.lockMutation(tx);
        if (stored.kind === "dimming") await this.assertMeshGroupSnapshot(tx, record, stored.draft);
        const preparedAt = this.clock();
        const leaseExpiresAt = new Date(preparedAt.getTime() + LEASE_MS);
        const payload = stored.payload ?? (stored.kind === "status_check"
          ? createPublishedStatusCheckCommand(stored.draft, preparedAt, this.deliveryGeneration())
          : createPublishedDimmingCommand(stored.draft, preparedAt, this.deliveryGeneration()));
        const updated = await tx.mqttOutbox.updateMany({
          where: {
            id: record.id,
            lockedBy: this.workerId,
            publishedAt: null,
            deadLetteredAt: null,
            leaseExpiresAt: { gt: preparedAt }
          },
          data: {
            leaseExpiresAt,
            // Compatibility normalization must be durable even if an existing
            // delivery generation is already expired and will never be published.
            payload
          }
        });
        return updated.count === 1 ? { payload, leaseExpiresAt } : null;
      });
      if (!prepared) return;

      const publishable = await this.prisma.mqttOutbox.count({
        where: {
          id: record.id,
          lockedBy: this.workerId,
          publishedAt: null,
          deadLetteredAt: null
        }
      });
      if (publishable !== 1) return;

      const publishAt = this.clock();
      if (prepared.leaseExpiresAt.getTime() <= publishAt.getTime() + MQTT_PUBLISH_TIMEOUT_MS) return;
      currentMessageExpiry(prepared.payload, publishAt);

      const attempted = await this.prisma.$transaction(async (tx) => {
        await this.automationSnapshot.lockMutation(tx);
        const attemptedAt = this.clock();
        currentMessageExpiry(prepared.payload, attemptedAt);
        // Persist before calling MQTT: a lost PUBACK cannot tell whether the broker
        // accepted the Set. A crash after this commit but before the call deliberately
        // remains unknown. Keep the first attempt across reclaims of this generation.
        return tx.mqttOutbox.updateMany({
          where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null,
            leaseExpiresAt: { gt: new Date(attemptedAt.getTime() + MQTT_PUBLISH_TIMEOUT_MS) } },
          data: { deliveryAttemptedAt: record.deliveryAttemptedAt ?? attemptedAt }
        });
      });
      if (attempted.count !== 1) return;
      const messageExpiryInterval = currentMessageExpiry(prepared.payload, this.clock());

      await this.mqtt.publishTopic(record.topic, prepared.payload, {
        messageExpiryInterval,
        timeoutMs: MQTT_PUBLISH_TIMEOUT_MS
      });
      const publishedAt = this.clock();
      await this.prisma.$transaction(async (tx) => {
        await this.automationSnapshot.lockMutation(tx);
        const released = await tx.mqttOutbox.updateMany({
          where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
          data: {
            payload: prepared.payload,
            publishedAt,
            lastError: null,
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null
          }
        });
        if (released.count !== 1) return;
        await tx.commandDispatch.updateMany({
          where: { id: record.dispatchId, status: "pending" },
          data: { status: "published", publishedAt }
        });
      });
    } catch (error) {
      const failedAt = this.clock();
      const message = error instanceof Error ? error.message : "unknown MQTT publish error";
      const attempts = record.attempts + 1;
      if (error instanceof StaleMeshGroupError) {
        await this.moveToTerminalFailure(record, attempts, message, failedAt, "MESH_GROUP_STALE");
        return;
      }
      if (error instanceof CommandDeliveryExpiredError) {
        await this.moveToTerminalFailure(record, attempts, message, failedAt, "COMMAND_DELIVERY_EXPIRED");
        return;
      }
      const exhausted = attempts >= MAX_ATTEMPTS || failedAt.getTime() - record.createdAt.getTime() >= MAX_AGE_MS;
      if (exhausted) {
        await this.moveToDeadLetter(record, attempts, message, failedAt);
        return;
      }

      const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
      const jitter = Math.floor(delay * 0.2 * this.random());
      await this.prisma.$transaction(async (tx) => {
        await this.automationSnapshot.lockMutation(tx);
        await tx.mqttOutbox.updateMany({
          where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
          data: {
            attempts,
            nextAttemptAt: new Date(failedAt.getTime() + delay + jitter),
            lastError: message,
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null
          }
        });
      });
    }
  }

  private async assertMeshGroupSnapshot(
    tx: Prisma.TransactionClient,
    record: {
      dispatch: {
        gatewayId: string;
        deliveryMode: string;
        destinationAddress: string | null;
        meshControlGroupId: string | null;
        meshControlGroupVersion: number | null;
      };
    },
    draft: GatewayDimmingCommandDraftV2
  ) {
    if (draft.deliveryMode !== "mesh_group") return;

    const dispatch = record.dispatch;
    if (
      dispatch.deliveryMode !== draft.deliveryMode ||
      dispatch.gatewayId !== draft.gatewayId ||
      dispatch.destinationAddress !== draft.destinationAddress ||
      dispatch.meshControlGroupId !== draft.meshControlGroupId ||
      dispatch.meshControlGroupVersion !== draft.meshControlGroupVersion
    ) {
      throw new StaleMeshGroupError("dispatch snapshot mismatch");
    }

    const group = await tx.meshControlGroup.findUnique({
      where: { id: draft.meshControlGroupId },
      select: { gatewayId: true, groupAddress: true, configurationVersion: true, status: true }
    });
    if (!group) throw new StaleMeshGroupError("group missing");
    if (group.gatewayId !== draft.gatewayId) throw new StaleMeshGroupError("gateway mismatch");
    if (group.groupAddress !== draft.destinationAddress) throw new StaleMeshGroupError("address mismatch");
    if (group.configurationVersion !== draft.meshControlGroupVersion) {
      throw new StaleMeshGroupError("configuration version mismatch");
    }
    if (group.status === "configuring") throw new MeshGroupConfiguringError();
    if (group.status !== "ready") throw new StaleMeshGroupError("group is not ready");
  }

  private async moveToDeadLetter(
    record: { id: string; dispatchId: string; dispatch: { commandId: string; kind?: CommandDispatchKind } },
    attempts: number,
    message: string,
    now: Date
  ) {
    await this.moveToTerminalFailure(record, attempts, message, now, "MQTT_DEAD_LETTER");
  }

  private async moveToTerminalFailure(
    record: { id: string; dispatchId: string; dispatch: { commandId: string; kind?: CommandDispatchKind } },
    attempts: number,
    message: string,
    now: Date,
    errorCode: "MQTT_DEAD_LETTER" | "MESH_GROUP_STALE" | "COMMAND_DELIVERY_EXPIRED"
  ) {
    await this.prisma.$transaction(async (tx) => {
      // Match ACK, verification and overlap writers: the global lock always comes
      // before outbox/dispatch/command rows, including terminal delivery failures.
      await this.automationSnapshot.lockMutation(tx);
      const released = await tx.mqttOutbox.updateMany({
        where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
        data: {
          attempts,
          deadLetteredAt: now,
          lastError: message,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null
        }
      });
      if (released.count !== 1) return;
      const outbox = await tx.mqttOutbox.findUnique({ where: { id: record.id }, select: { deliveryAttemptedAt: true } });
      const uncertain = outbox?.deliveryAttemptedAt != null;
      const terminalStatus = uncertain ? "timed_out" : "failed";
      const closed = await tx.commandDispatch.updateMany({
        where: { id: record.dispatchId, status: { in: ["pending", "published", "accepted"] } },
        data: { status: terminalStatus, completedAt: now, errorCode, errorMessage: message }
      });
      // A conclusive ACK can arrive during MQTT's pending PUBACK. Closing the outbox
      // is still valid, but losing the dispatch transition forbids result/parent writes.
      if (closed.count !== 1) return;
      await tx.commandFixtureResult.updateMany({
        where: { dispatchId: record.dispatchId, status: "pending" },
        data: { status: terminalStatus, occurredAt: now, errorMessage: message }
      });
      // A failed observation closes only its dispatch; it cannot establish the original Set outcome.
      if (record.dispatch.kind === "status_check") return;
      const command = await tx.command.findUnique({ where: { id: record.dispatch.commandId }, select: { outcome: true } });
      const legacy = command?.outcome === null;
      await tx.command.updateMany({
        where: { id: record.dispatch.commandId, status: "pending", outcome: legacy ? null : "pending" },
        data: { status: "failed", errorMessage: message,
          ...(legacy ? {} : { outcome: uncertain ? "unknown" : "not_applied" }) }
      });
    });
  }
}

function parseStoredCommand(payload: Prisma.JsonValue, kind: CommandDispatchKind = "dimming") {
  if (kind === "status_check") {
    return { kind, ...parseStoredStatusCheckCommand(payload) } as const;
  }
  return { kind, ...parseStoredDimmingCommand(payload) } as const;
}

function parseStoredStatusCheckCommand(payload: Prisma.JsonValue): {
  draft: GatewayStatusCheckCommandDraftV2;
  payload?: GatewayStatusCheckCommandPublishedV2;
} {
  const published = gatewayStatusCheckCommandPublishedV2Schema.safeParse(payload);
  if (published.success) {
    const { expiresAt, deliveryGeneration, deliveryGeneratedAt, deliveryWindowMs, ...draft } = published.data;
    return { draft, payload: published.data };
  }
  return { draft: gatewayStatusCheckCommandDraftV2Schema.parse(payload) };
}

function createPublishedStatusCheckCommand(
  draft: GatewayStatusCheckCommandDraftV2,
  generatedAt: Date,
  deliveryGeneration: string
) {
  const { messageExpiryInterval: _messageExpiryInterval, ...delivery } =
    createGatewayCommandExpiry(generatedAt, deliveryGeneration);
  return gatewayStatusCheckCommandPublishedV2Schema.parse({ ...draft, ...delivery });
}

function parseStoredDimmingCommand(payload: Prisma.JsonValue): {
  draft: GatewayDimmingCommandDraftV2;
  payload?: GatewayDimmingCommandPublishedV2;
} {
  const published = gatewayDimmingCommandPublishedV2Schema.safeParse(payload);
  if (published.success) return { draft: toDimmingDraft(published.data), payload: published.data };

  const draft = gatewayDimmingCommandDraftV2CompatibilitySchema.safeParse(payload);
  if (draft.success) return { draft: toDimmingDraft(draft.data) };

  const compatible = gatewayDimmingCommandV2CompatibilitySchema.safeParse(payload);
  if (!compatible.success) throw draft.error;
  if ("deliveryGeneration" in compatible.data) {
    // A lost PUBACK can leave an already-published legacy wire in the outbox.
    // Scrub only compatibility fields: recreating delivery metadata renews freshness.
    const normalized = { ...compatible.data } as Record<string, unknown>;
    delete normalized.overrideUntil;
    delete normalized.overrideRemainingMs;
    delete normalized.requestedBy;
    return {
      draft: toDimmingDraft(compatible.data),
      payload: gatewayDimmingCommandPublishedV2Schema.parse(normalized)
    };
  }
  return { draft: toDimmingDraft(compatible.data) };
}

function toDimmingDraft(payload: Record<string, unknown>): GatewayDimmingCommandDraftV2 {
  const draft = { ...payload };
  delete draft.expiresAt;
  delete draft.deliveryGeneration;
  delete draft.deliveryGeneratedAt;
  delete draft.deliveryWindowMs;
  delete draft.overrideUntil;
  delete draft.overrideRemainingMs;
  // Historical rows can contain requester PII. Compatibility parsing accepts
  // the old wire, but every newly persisted/published generation omits it.
  delete draft.requestedBy;
  return gatewayDimmingCommandDraftV2Schema.parse(draft);
}

function createPublishedDimmingCommand(
  draft: GatewayDimmingCommandDraftV2,
  generatedAt: Date,
  deliveryGeneration: string
) {
  const { messageExpiryInterval: _messageExpiryInterval, ...delivery } =
    createGatewayCommandExpiry(generatedAt, deliveryGeneration);
  return gatewayDimmingCommandPublishedV2Schema.parse({ ...draft, ...delivery });
}

function currentMessageExpiry(payload: { expiresAt: string }, now: Date) {
  try {
    return remainingGatewayCommandMessageExpiry(payload, now);
  } catch (error) {
    throw new CommandDeliveryExpiredError(error);
  }
}

class MeshGroupConfiguringError extends Error {
  constructor() {
    super("mesh control group configuration is not ready");
  }
}

class StaleMeshGroupError extends Error {
  constructor(reason: string) {
    super(`Mesh 그룹 명령 스냅샷이 만료되었습니다: ${reason}`);
  }
}

class CommandDeliveryExpiredError extends Error {
  constructor(cause: unknown) {
    super("gateway command delivery generation expired before MQTT publish", { cause });
    this.name = "CommandDeliveryExpiredError";
  }
}
