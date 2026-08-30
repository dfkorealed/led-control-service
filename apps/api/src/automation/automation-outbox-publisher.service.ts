import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { MqttService } from "../mqtt/mqtt.service";
import { PrismaService } from "../prisma/prisma.service";

const LEASE_MS = 30_000;
const MQTT_PUBLISH_TIMEOUT_MS = 10_000;
const MAX_DELIVERY_ATTEMPTS = 10;
const MAX_DELIVERY_AGE_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

type PublisherOptions = {
  workerId?: string;
  random?: () => number;
  pollMs?: number;
  clock?: () => Date;
  drainTimeoutMs?: number;
};

type AutomationOutboxRecord = {
  id: string;
  dispatchId: string | null;
  gatewayId: string | null;
  applicationAckKey: string | null;
  revision: number | null;
  payloadHash: string | null;
  topic: string;
  payload: Prisma.JsonValue;
  attempts: number;
  createdAt: Date;
};

type OutboxVariant = "config" | "application_ack";

@Injectable()
export class AutomationOutboxPublisherService implements OnModuleInit {
  private readonly logger = new Logger(AutomationOutboxPublisherService.name);
  private readonly workerId: string;
  private readonly random: () => number;
  private readonly pollMs: number;
  private readonly clock: () => Date;
  private readonly drainTimeoutMs: number;
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
    this.pollMs = options.pollMs ?? Number(process.env.AUTOMATION_MQTT_OUTBOX_POLL_MS ?? 1000);
    this.clock = options.clock ?? (() => new Date());
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
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
      this.stopPromise = this.waitForActiveBatch();
    }
    return this.stopPromise;
  }

  async claimConfigBatch(now = this.clock()) {
    return this.prisma.$transaction(async (tx) => {
      await this.supersedeUnpublishedConfigs(tx, now);
      const ids = await this.claimIds(tx, "config", now);
      return this.leaseAndLoad(tx, "config", ids, now);
    });
  }

  async claimApplicationAckBatch(now = this.clock()) {
    return this.prisma.$transaction(async (tx) => {
      const ids = await this.claimIds(tx, "application_ack", now);
      return this.leaseAndLoad(tx, "application_ack", ids, now);
    });
  }

  async processBatch(now = this.clock()) {
    const configs = await this.claimConfigBatch(now);
    for (const record of configs) {
      if (this.stopped) return;
      await this.publishClaimed(record);
    }
    const acknowledgements = await this.claimApplicationAckBatch(this.clock());
    for (const record of acknowledgements) {
      if (this.stopped) return;
      await this.publishClaimed(record);
    }
  }

  async publishClaimed(record: AutomationOutboxRecord) {
    const variant = outboxVariant(record);
    if (variant === "config" && await this.supersedeClaimedConfig(record, this.clock())) return;

    const renewedAt = this.clock();
    const renewedLeaseExpiresAt = new Date(renewedAt.getTime() + LEASE_MS);
    const renewed = await this.prisma.mqttOutbox.updateMany({
      where: {
        ...this.ownedPublishableWhere(record, variant, renewedAt),
        leaseExpiresAt: { gt: renewedAt }
      },
      data: { leaseExpiresAt: renewedLeaseExpiresAt }
    });
    if (renewed.count !== 1) return;

    const fencedAt = this.clock();
    const publishable = await this.prisma.mqttOutbox.count({
      where: {
        ...this.ownedPublishableWhere(record, variant, fencedAt),
        leaseExpiresAt: { gt: new Date(fencedAt.getTime() + MQTT_PUBLISH_TIMEOUT_MS) },
        ...(variant === "config"
          ? { gateway: { automationConfiguration: { desiredRevision: record.revision! } } }
          : {})
      }
    });
    if (publishable !== 1) return;

    try {
      await this.mqtt.publishTopic(record.topic, record.payload, {
        messageExpiryInterval: null,
        timeoutMs: MQTT_PUBLISH_TIMEOUT_MS
      });
      const publishedAt = this.clock();
      await this.prisma.mqttOutbox.updateMany({
        where: {
          ...this.ownedPublishableWhere(record, variant, publishedAt),
          leaseExpiresAt: { gt: publishedAt }
        },
        data: {
          publishedAt,
          lastError: null,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null
        }
      });
    } catch {
      await this.recordFailure(record, variant, this.clock());
    }
  }

  private runScheduledBatch() {
    if (this.stopped || this.activeBatch) return this.activeBatch ?? Promise.resolve();
    const batch = this.processBatch()
      .catch((error) => {
        this.logger.error(`automation mqtt outbox batch failed (worker=${this.workerId}, error=${errorKind(error)})`);
      })
      .finally(() => {
        this.activeBatch = null;
      });
    this.activeBatch = batch;
    return batch;
  }

  private waitForActiveBatch() {
    const active = this.activeBatch;
    if (!active) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, this.drainTimeoutMs);
      void active.finally(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private async claimIds(tx: Prisma.TransactionClient, variant: OutboxVariant, now: Date) {
    const variantPredicate = variant === "config"
      ? Prisma.sql`"applicationAckKey" IS NULL AND "revision" IS NOT NULL`
      : Prisma.sql`"applicationAckKey" IS NOT NULL AND "revision" IS NULL`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "MqttOutbox"
      WHERE "dispatchId" IS NULL
        AND "gatewayId" IS NOT NULL
        AND ${variantPredicate}
        AND "publishedAt" IS NULL
        AND "deadLetteredAt" IS NULL
        AND "supersededAt" IS NULL
        AND "nextAttemptAt" <= ${now}
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `);
    return rows.map(({ id }) => id);
  }

  private async leaseAndLoad(
    tx: Prisma.TransactionClient,
    variant: OutboxVariant,
    ids: string[],
    now: Date
  ): Promise<AutomationOutboxRecord[]> {
    if (ids.length === 0) return [];
    const variantWhere = variant === "config"
      ? { applicationAckKey: null, revision: { not: null } }
      : { applicationAckKey: { not: null }, revision: null };
    await tx.mqttOutbox.updateMany({
      where: {
        id: { in: ids },
        dispatchId: null,
        gatewayId: { not: null },
        ...variantWhere,
        publishedAt: null,
        deadLetteredAt: null,
        supersededAt: null,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }]
      },
      data: {
        lockedBy: this.workerId,
        lockedAt: now,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS)
      }
    });
    return tx.mqttOutbox.findMany({
      where: {
        id: { in: ids },
        dispatchId: null,
        gatewayId: { not: null },
        ...variantWhere,
        publishedAt: null,
        deadLetteredAt: null,
        supersededAt: null,
        lockedBy: this.workerId
      },
      orderBy: { createdAt: "asc" }
    });
  }

  private supersedeUnpublishedConfigs(tx: Prisma.TransactionClient, now: Date) {
    return tx.$executeRaw(Prisma.sql`
      UPDATE "MqttOutbox" AS outbox
      SET "supersededAt" = ${now},
          "lockedBy" = NULL,
          "lockedAt" = NULL,
          "leaseExpiresAt" = NULL,
          "lastError" = 'superseded_by_newer_revision',
          "updatedAt" = ${now}
      FROM "GatewayAutomationConfiguration" AS desired
      WHERE outbox."gatewayId" = desired."gatewayId"
        AND outbox."dispatchId" IS NULL
        AND outbox."applicationAckKey" IS NULL
        AND outbox."revision" IS NOT NULL
        AND outbox."publishedAt" IS NULL
        AND outbox."deadLetteredAt" IS NULL
        AND outbox."supersededAt" IS NULL
        AND desired."desiredRevision" > outbox."revision"
    `);
  }

  private supersedeClaimedConfig(record: AutomationOutboxRecord, now: Date) {
    return this.prisma.$executeRaw(Prisma.sql`
      UPDATE "MqttOutbox" AS outbox
      SET "supersededAt" = ${now},
          "lockedBy" = NULL,
          "lockedAt" = NULL,
          "leaseExpiresAt" = NULL,
          "lastError" = 'superseded_by_newer_revision',
          "updatedAt" = ${now}
      FROM "GatewayAutomationConfiguration" AS desired
      WHERE outbox."id" = ${record.id}
        AND outbox."lockedBy" = ${this.workerId}
        AND outbox."leaseExpiresAt" > ${now}
        AND outbox."publishedAt" IS NULL
        AND outbox."deadLetteredAt" IS NULL
        AND outbox."supersededAt" IS NULL
        AND outbox."gatewayId" = desired."gatewayId"
        AND desired."desiredRevision" > outbox."revision"
    `);
  }

  private ownedPublishableWhere(record: AutomationOutboxRecord, variant: OutboxVariant, now: Date) {
    return {
      id: record.id,
      dispatchId: null,
      gatewayId: record.gatewayId,
      applicationAckKey: variant === "config" ? null : record.applicationAckKey,
      revision: variant === "config" ? record.revision : null,
      lockedBy: this.workerId,
      publishedAt: null,
      deadLetteredAt: null,
      supersededAt: null,
      leaseExpiresAt: { gt: now }
    } satisfies Prisma.MqttOutboxWhereInput;
  }

  private async recordFailure(record: AutomationOutboxRecord, variant: OutboxVariant, failedAt: Date) {
    const attempts = record.attempts + 1;
    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS
      || failedAt.getTime() - record.createdAt.getTime() >= MAX_DELIVERY_AGE_MS;
    if (exhausted) {
      await this.prisma.mqttOutbox.updateMany({
        where: {
          ...this.ownedPublishableWhere(record, variant, failedAt),
          leaseExpiresAt: { gt: failedAt }
        },
        data: {
          attempts,
          deadLetteredAt: failedAt,
          lastError: "mqtt_publish_failed",
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null
        }
      });
      return;
    }

    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1));
    const jitter = Math.floor(delay * 0.2 * this.random());
    await this.prisma.mqttOutbox.updateMany({
      where: {
        ...this.ownedPublishableWhere(record, variant, failedAt),
        leaseExpiresAt: { gt: failedAt }
      },
      data: {
        attempts,
        nextAttemptAt: new Date(failedAt.getTime() + delay + jitter),
        lastError: "mqtt_publish_failed",
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null
      }
    });
  }
}

function outboxVariant(record: AutomationOutboxRecord): OutboxVariant {
  if (
    record.dispatchId === null && record.gatewayId !== null &&
    record.applicationAckKey === null && record.revision !== null && record.payloadHash !== null
  ) return "config";
  if (
    record.dispatchId === null && record.gatewayId !== null &&
    record.applicationAckKey !== null && record.revision === null && record.payloadHash !== null
  ) return "application_ack";
  throw new Error("invalid automation MQTT outbox row shape");
}

function errorKind(error: unknown) {
  if (
    typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" && /^P\d{4}$/.test(error.code)
  ) return error.code;
  return "UNEXPECTED_ERROR";
}
