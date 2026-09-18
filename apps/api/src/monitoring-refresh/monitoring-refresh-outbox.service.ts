import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { fixturePresenceCheckCommandV1Schema, mqttTopicsV2 } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { MqttService } from "../mqtt/mqtt.service";
import { PrismaService } from "../prisma/prisma.service";
import { finalizeResolvedMonitoringRefresh } from "./monitoring-refresh-state";

const LEASE_MS = 30_000;
const MQTT_PUBLISH_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const CLAIM_LIMIT = 50;

type PublisherOptions = {
  workerId?: string;
  random?: () => number;
  pollMs?: number;
  clock?: () => Date;
};

type ClaimedRecord = {
  id: string;
  monitoringRefreshBatchId: string;
  topic: string;
  payload: Prisma.JsonValue;
  attempts: number;
  createdAt: Date;
  deliveryAttemptedAt?: Date | null;
  batch: {
    id: string;
    refreshId: string;
    siteId: string;
    gatewayId: string;
    sequence: bigint;
    idempotencyKey: string;
    targetFixtureIds: Prisma.JsonValue;
    status: string;
    refresh: {
      id: string;
      siteId: string;
      deadlineAt: Date;
      createdAt: Date;
      status: string;
    };
  };
};

@Injectable()
export class MonitoringRefreshOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitoringRefreshOutboxService.name);
  private readonly workerId: string;
  private readonly random: () => number;
  private readonly pollMs: number;
  private readonly clock: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private activeBatch: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    @Optional() options: PublisherOptions = {}
  ) {
    this.workerId = options.workerId ?? randomUUID();
    this.random = options.random ?? Math.random;
    this.pollMs = options.pollMs ?? Number(process.env.MONITORING_REFRESH_OUTBOX_POLL_MS ?? 1_000);
    this.clock = options.clock ?? (() => new Date());
  }

  onModuleInit() {
    this.stopped = false;
    void this.runScheduledBatch();
    this.timer = setInterval(() => void this.runScheduledBatch(), this.pollMs);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    return this.stopAndDrain();
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

  runScheduledBatch() {
    if (this.stopped || this.activeBatch) return this.activeBatch ?? Promise.resolve();
    const batch = this.processBatch()
      .catch((error) => {
        this.logger.error(`monitoring refresh outbox batch failed (worker=${this.workerId}, error=${errorKind(error)})`);
      })
      .finally(() => {
        this.activeBatch = null;
      });
    this.activeBatch = batch;
    return batch;
  }

  async claimBatch(now = this.clock()): Promise<ClaimedRecord[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "MqttOutbox"
        WHERE "publishedAt" IS NULL
          AND "deadLetteredAt" IS NULL
          AND "monitoringRefreshBatchId" IS NOT NULL
          AND "nextAttemptAt" <= ${now}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${CLAIM_LIMIT}
      `);
      const ids = rows.map(({ id }) => id);
      if (ids.length === 0) return [];
      await tx.mqttOutbox.updateMany({
        where: {
          id: { in: ids },
          monitoringRefreshBatchId: { not: null },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }]
        },
        data: { lockedBy: this.workerId, lockedAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }
      });
      const records = await tx.mqttOutbox.findMany({
        where: { id: { in: ids }, monitoringRefreshBatchId: { not: null }, lockedBy: this.workerId },
        include: {
          monitoringRefreshBatch: {
            select: {
              id: true,
              refreshId: true,
              siteId: true,
              gatewayId: true,
              sequence: true,
              idempotencyKey: true,
              targetFixtureIds: true,
              status: true,
              refresh: { select: { id: true, siteId: true, deadlineAt: true, createdAt: true, status: true } }
            }
          }
        },
        orderBy: { createdAt: "asc" }
      });
      return records.map((record) => {
        if (!record.monitoringRefreshBatchId || !record.monitoringRefreshBatch) {
          throw new Error("monitoring refresh outbox row is missing its batch relation");
        }
        return {
          ...record,
          monitoringRefreshBatchId: record.monitoringRefreshBatchId,
          batch: record.monitoringRefreshBatch
        };
      });
    });
  }

  async processBatch(now = this.clock()) {
    const records = await this.claimBatch(now);
    for (const record of records) {
      if (this.stopped) return;
      await this.publishClaimed(record);
    }
  }

  async publishClaimed(record: ClaimedRecord) {
    try {
      const parsed = fixturePresenceCheckCommandV1Schema.safeParse(record.payload);
      if (!parsed.success) throw new InvalidStoredRefreshCommandError();
      const payload = parsed.data;
      assertPersistedSnapshot(record, payload);

      const publishAt = this.clock();
      const messageExpiryInterval = remainingExpirySeconds(payload.expiresAt, publishAt);
      if (messageExpiryInterval === 0) {
        await this.deadLetter(record, "refresh_deadline_exceeded", publishAt);
        return;
      }
      const attempted = await this.prisma.mqttOutbox.updateMany({
        where: {
          id: record.id,
          monitoringRefreshBatchId: record.monitoringRefreshBatchId,
          lockedBy: this.workerId,
          publishedAt: null,
          deadLetteredAt: null
        },
        data: { deliveryAttemptedAt: record.deliveryAttemptedAt ?? publishAt }
      });
      if (attempted.count !== 1) return;

      await this.mqtt.publishTopic(record.topic, payload, {
        messageExpiryInterval,
        timeoutMs: MQTT_PUBLISH_TIMEOUT_MS
      });
      const publishedAt = this.clock();
      await this.prisma.$transaction(async (tx) => {
        // Completion owns Refresh → Batch and deletes Outbox. Serialize this
        // Outbox → Batch write under the same parent lock to avoid an inverse
        // wait when the Gateway result arrives before PUBACK persistence.
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "MonitoringRefresh" WHERE "id" = ${record.batch.refreshId} FOR UPDATE
        `);
        const published = await tx.mqttOutbox.updateMany({
          where: {
            id: record.id,
            monitoringRefreshBatchId: record.monitoringRefreshBatchId,
            lockedBy: this.workerId,
            publishedAt: null,
            deadLetteredAt: null
          },
          data: {
            publishedAt,
            lastError: null,
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null
          }
        });
        if (published.count !== 1) return;
        await tx.monitoringRefreshBatch.updateMany({
          where: { id: record.batch.id, status: "pending" },
          data: { status: "published", publishedAt }
        });
      });
    } catch (error) {
      if (error instanceof InvalidStoredRefreshCommandError) {
        await this.deadLetter(record, "invalid_outbox_payload", this.clock());
        return;
      }
      await this.handleFailure(record);
    }
  }

  private async handleFailure(record: ClaimedRecord) {
    const failedAt = this.clock();
    const attempts = record.attempts + 1;
    const payloadExpiry = storedExpiry(record.payload);
    if (attempts >= MAX_ATTEMPTS || payloadExpiry === null || payloadExpiry.getTime() <= failedAt.getTime()) {
      await this.deadLetter(record, payloadExpiry && payloadExpiry.getTime() <= failedAt.getTime()
        ? "refresh_deadline_exceeded"
        : "delivery_failed", failedAt, attempts);
      return;
    }

    const baseDelay = Math.min(5_000, 1_000 * 2 ** Math.max(0, attempts - 1));
    const jitter = Math.floor(baseDelay * 0.2 * this.random());
    const retryAt = new Date(Math.min(failedAt.getTime() + baseDelay + jitter, payloadExpiry.getTime()));
    await this.prisma.mqttOutbox.updateMany({
      where: {
        id: record.id,
        monitoringRefreshBatchId: record.monitoringRefreshBatchId,
        lockedBy: this.workerId,
        publishedAt: null,
        deadLetteredAt: null
      },
      data: {
        attempts,
        nextAttemptAt: retryAt,
        lastError: "mqtt_publish_failed",
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null
      }
    });
  }

  private async deadLetter(record: ClaimedRecord, errorCode: string, at: Date, attempts = record.attempts + 1) {
    const expired = errorCode === "refresh_deadline_exceeded";
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "MonitoringRefresh" WHERE "id" = ${record.batch.refreshId} FOR UPDATE
      `);
      const current = await tx.monitoringRefreshBatch.findUnique({
        where: { id: record.batch.id },
        include: {
          refresh: { select: { id: true, status: true } },
          outbox: { select: { id: true, lockedBy: true, publishedAt: true, deadLetteredAt: true } }
        }
      });
      if (
        !current ||
        current.refreshId !== record.batch.refreshId ||
        current.refresh.status !== "pending" ||
        !["pending", "published"].includes(current.status) ||
        current.outbox?.id !== record.id ||
        current.outbox.lockedBy !== this.workerId ||
        current.outbox.publishedAt !== null ||
        current.outbox.deadLetteredAt !== null
      ) return;
      const deadLettered = await tx.mqttOutbox.updateMany({
        where: {
          id: record.id,
          monitoringRefreshBatchId: record.monitoringRefreshBatchId,
          lockedBy: this.workerId,
          publishedAt: null,
          deadLetteredAt: null
        },
        data: {
          attempts,
          deadLetteredAt: at,
          lastError: errorCode,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null
        }
      });
      if (deadLettered.count !== 1) return;
      await tx.monitoringRefreshFixture.updateMany({
        where: { batchId: record.batch.id, status: "pending" },
        data: { status: "unverified", errorCode, observedAt: at }
      });
      await tx.monitoringRefreshBatch.updateMany({
        where: { id: record.batch.id, status: { in: ["pending", "published"] } },
        data: { status: expired ? "expired" : "failed", errorCode, completedAt: at }
      });
      await finalizeResolvedMonitoringRefresh(tx, record.batch.refreshId, at, expired ? "expired" : "failed");
    });
  }
}

function assertPersistedSnapshot(
  record: ClaimedRecord,
  payload: ReturnType<typeof fixturePresenceCheckCommandV1Schema.parse>
) {
  const validStoredTargets = Array.isArray(record.batch.targetFixtureIds)
    && record.batch.targetFixtureIds.every((id) => typeof id === "string");
  const targetFixtureIds = validStoredTargets ? record.batch.targetFixtureIds as string[] : [];
  const sequence = Number(record.batch.sequence);
  const expectedTopic = mqttTopicsV2.fixturePresenceCheck(record.batch.siteId, record.batch.gatewayId);
  const matches = validStoredTargets
    && record.monitoringRefreshBatchId === record.batch.id
    && record.batch.id === payload.batchId
    && record.batch.refreshId === record.batch.refresh.id
    && record.batch.refreshId === payload.refreshId
    && record.batch.siteId === record.batch.refresh.siteId
    && record.batch.siteId === payload.siteId
    && record.batch.gatewayId === payload.gatewayId
    && Number.isSafeInteger(sequence)
    && sequence === payload.sequence
    && record.batch.idempotencyKey === payload.idempotencyKey
    && record.batch.status === "pending"
    && record.batch.refresh.status === "pending"
    && record.batch.refresh.createdAt.toISOString() === payload.requestedAt
    && record.batch.refresh.deadlineAt.toISOString() === payload.expiresAt
    && targetFixtureIds.length === payload.targetFixtureIds.length
    && targetFixtureIds.every((id, index) => id === payload.targetFixtureIds[index])
    && record.topic === expectedTopic;
  if (!matches) throw new InvalidStoredRefreshCommandError();
}

class InvalidStoredRefreshCommandError extends Error {}

function remainingExpirySeconds(expiresAt: string, now: Date) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now.getTime()) / 1_000));
}

function storedExpiry(payload: Prisma.JsonValue) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const expiresAt = payload.expiresAt;
  if (typeof expiresAt !== "string") return null;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function errorKind(error: unknown) {
  if (
    typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" && /^P\d{4}$/.test(error.code)
  ) return error.code;
  return "UNEXPECTED_ERROR";
}
