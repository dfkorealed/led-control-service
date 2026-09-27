import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createGatewayCommandExpiry, gatewayStatusCheckCommandDraftV2Schema,
  gatewayStatusCheckCommandPublishedV2Schema, remainingGatewayCommandMessageExpiry } from "@led-control/shared";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "./mqtt.service";

const LEASE_MS = 30_000;
const MQTT_TIMEOUT_MS = 20_000;
const MAX_AGE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
type Options = { workerId?: string; clock?: () => Date; generation?: () => string; pollMs?: number };
type Claimed = {
  id: string; dispatchId: string; topic: string; payload: Prisma.JsonValue;
  attempts: number; createdAt: Date; deliveryAttemptedAt: Date | null;
  dispatch: { id: string; holdId: string; status: string;
    hold: { id: string; siteId: string; originalCommandId: string } };
};

/** Dedicated Get-only publisher; it never queries Command or MqttOutbox. */
@Injectable()
export class RecoveryOutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecoveryOutboxPublisherService.name);
  private readonly workerId: string;
  private readonly clock: () => Date;
  private readonly generation: () => string;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private activeBatch: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly prisma: PrismaService, private readonly mqtt: MqttService,
    private readonly snapshot: AutomationSnapshotService, @Optional() options: Options = {}) {
    this.workerId = options.workerId ?? randomUUID();
    this.clock = options.clock ?? (() => new Date());
    this.generation = options.generation ?? randomUUID;
    this.pollMs = options.pollMs ?? 1000;
  }

  onModuleInit() {
    if (process.env.COMMAND_RECOVERY_PUBLISHER_READY !== "1") return;
    this.stopped = false;
    void this.runScheduledBatch();
    this.timer = setInterval(() => void this.runScheduledBatch(), this.pollMs);
    this.timer.unref();
  }

  onModuleDestroy() { return this.stopAndDrain(); }

  stopAndDrain() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.activeBatch ?? Promise.resolve();
  }

  private runScheduledBatch() {
    if (this.stopped || this.activeBatch) return this.activeBatch ?? Promise.resolve();
    const batch = this.processBatch().catch((error) => {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        && /^P\d{4}$/.test(error.code) ? error.code : "UNEXPECTED_ERROR";
      this.logger.error(`recovery Get outbox batch failed (error=${code})`);
    }).finally(() => { this.activeBatch = null; });
    this.activeBatch = batch;
    return batch;
  }

  async claimBatch(now = this.clock()): Promise<Claimed[]> {
    if (process.env.COMMAND_RECOVERY_PUBLISHER_READY !== "1") return [];
    return this.prisma.$transaction(async (tx) => {
      await this.snapshot.lockMutation(tx);
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "RecoveryOutbox"
        WHERE "publishedAt" IS NULL AND "deadLetteredAt" IS NULL
          AND "nextAttemptAt" <= ${now}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
        ORDER BY "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT 50
      `);
      const ids = rows.map(({ id }) => id);
      if (ids.length === 0) return [];
      await tx.recoveryOutbox.updateMany({ where: { id: { in: ids },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      data: { lockedBy: this.workerId, lockedAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) } });
      const claimed = await tx.recoveryOutbox.findMany({ where: { id: { in: ids }, lockedBy: this.workerId },
        include: { dispatch: { include: { hold: { select: { id: true, siteId: true, originalCommandId: true } } } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      return claimed;
    });
  }

  async processBatch(now = this.clock()) {
    for (const record of await this.claimBatch(now)) {
      if (this.stopped) return;
      await this.publishClaimed(record);
    }
  }

  async publishClaimed(record: Claimed) {
    try {
      const current = await this.activeDispatch(record);
      if (!current) return;
      if (this.clock().getTime() - record.createdAt.getTime() >= MAX_AGE_MS) {
        await this.terminal(record, "RECOVERY_DELIVERY_EXPIRED");
        return;
      }
      const published = gatewayStatusCheckCommandPublishedV2Schema.safeParse(record.payload);
      const draft = published.success ? stripDelivery(published.data)
        : gatewayStatusCheckCommandDraftV2Schema.parse(record.payload);
      if (draft.dispatchId !== record.dispatchId || draft.commandId !== current.hold.originalCommandId
        || draft.originalCommandId !== current.hold.originalCommandId || draft.siteId !== current.hold.siteId
        || draft.gatewayId !== current.gatewayId || record.topic !==
          `sites/${draft.siteId}/gateways/${draft.gatewayId}/commands/status-check`) {
        await this.terminal(record, "RECOVERY_SCOPE_INVALID");
        return;
      }
      const prepared = await this.prisma.$transaction(async (tx) => {
        await this.snapshot.lockMutation(tx);
        const active = await tx.recoveryDispatch.findUnique({ where: { id: record.dispatchId },
          include: { hold: { select: { id: true, siteId: true, originalCommandId: true } } } });
        if (!active || active.status !== "pending" || active.hold.id !== record.dispatch.holdId) return null;
        const preparedAt = this.clock();
        const payload = published.success ? published.data : gatewayStatusCheckCommandPublishedV2Schema.parse({
          ...draft, ...withoutInterval(createGatewayCommandExpiry(preparedAt, this.generation()))
        });
        remainingGatewayCommandMessageExpiry(payload, preparedAt);
        const leaseExpiresAt = new Date(preparedAt.getTime() + LEASE_MS);
        const written = await tx.recoveryOutbox.updateMany({ where: { id: record.id, dispatchId: record.dispatchId,
          lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null,
          leaseExpiresAt: { gt: preparedAt } },
        data: { payload, leaseExpiresAt } });
        return written.count === 1 ? { payload, leaseExpiresAt } : null;
      });
      if (!prepared) {
        await this.activeDispatch(record);
        return;
      }
      const beforeSend = this.clock();
      if (prepared.leaseExpiresAt.getTime() <= beforeSend.getTime() + MQTT_TIMEOUT_MS) return;
      const attempted = await this.prisma.$transaction(async (tx) => {
        await this.snapshot.lockMutation(tx);
        const active = await tx.recoveryDispatch.findUnique({ where: { id: record.dispatchId },
          select: { status: true } });
        if (active?.status !== "pending") return { count: 0 };
        const attemptedAt = this.clock();
        remainingGatewayCommandMessageExpiry(prepared.payload, attemptedAt);
        return tx.recoveryOutbox.updateMany({ where: { id: record.id, dispatchId: record.dispatchId,
          lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null,
          leaseExpiresAt: { gt: new Date(attemptedAt.getTime() + MQTT_TIMEOUT_MS) } },
        data: { deliveryAttemptedAt: record.deliveryAttemptedAt ?? attemptedAt } });
      });
      if (attempted.count !== 1 || !await this.activeDispatch(record)) return;
      const messageExpiryInterval = remainingGatewayCommandMessageExpiry(prepared.payload, this.clock());
      await this.mqtt.publishTopic(record.topic, prepared.payload, { messageExpiryInterval, timeoutMs: MQTT_TIMEOUT_MS });
      await this.prisma.$transaction(async (tx) => {
        await this.snapshot.lockMutation(tx);
        const publishedAt = this.clock();
        const released = await tx.recoveryOutbox.updateMany({ where: { id: record.id,
          lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
        data: { publishedAt, lastError: null, lockedBy: null, lockedAt: null, leaseExpiresAt: null } });
        if (released.count === 1) await tx.recoveryDispatch.updateMany({
          where: { id: record.dispatchId, status: "pending" }, data: { status: "published", publishedAt }
        });
      });
    } catch (error) {
      const now = this.clock();
      const attempts = record.attempts + 1;
      if (attempts >= MAX_ATTEMPTS || now.getTime() - record.createdAt.getTime() >= MAX_AGE_MS
        || isExpiredDelivery(error)) {
        await this.terminal(record, "RECOVERY_DELIVERY_EXPIRED");
        return;
      }
      const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
      await this.prisma.$transaction(async (tx) => {
        await this.snapshot.lockMutation(tx);
        await tx.recoveryOutbox.updateMany({ where: { id: record.id, lockedBy: this.workerId,
          publishedAt: null, deadLetteredAt: null }, data: { attempts,
          nextAttemptAt: new Date(now.getTime() + delay), lastError: "RECOVERY_PUBLISH_RETRY",
          lockedBy: null, lockedAt: null, leaseExpiresAt: null } });
      });
    }
  }

  private async activeDispatch(record: Claimed) {
    const current = await this.prisma.recoveryDispatch.findUnique({ where: { id: record.dispatchId },
      include: { hold: { select: { id: true, siteId: true, originalCommandId: true } } } });
    if (current?.status === "pending" && current.hold.id === record.dispatch.holdId) return current;
    // An ACK can win immediately after claim or prepare. Leaving the leased
    // unpublished row behind would cause a permanent claim/retry loop.
    await this.convergeInactiveClaim(record);
    return null;
  }

  private async convergeInactiveClaim(record: Claimed) {
    await this.prisma.$transaction(async (tx) => {
      await this.snapshot.lockMutation(tx);
      const dispatch = await tx.recoveryDispatch.findUnique({ where: { id: record.dispatchId },
        select: { status: true } });
      if (dispatch?.status === "pending") return;
      const now = this.clock();
      const delivered = dispatch?.status === "published" || dispatch?.status === "accepted"
        || dispatch?.status === "completed";
      await tx.recoveryOutbox.updateMany({ where: { id: record.id, dispatchId: record.dispatchId,
        lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
      data: delivered ? { publishedAt: now, lockedBy: null, lockedAt: null, leaseExpiresAt: null }
        : { deadLetteredAt: now, lastError: "RECOVERY_DISPATCH_INACTIVE",
          lockedBy: null, lockedAt: null, leaseExpiresAt: null } });
    });
  }

  private async terminal(record: Claimed, errorCode: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.snapshot.lockMutation(tx);
      const now = this.clock();
      const closed = await tx.recoveryOutbox.updateMany({ where: { id: record.id,
        lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
      data: { deadLetteredAt: now, lastError: errorCode,
        lockedBy: null, lockedAt: null, leaseExpiresAt: null } });
      if (closed.count !== 1) return;
      await tx.recoveryDispatch.updateMany({ where: { id: record.dispatchId, status: "pending" },
        data: { status: "failed", completedAt: now, errorCode } });
      await tx.unresolvedCommandHold.updateMany({ where: { id: record.dispatch.holdId },
        data: { lastCheckedAt: now } });
    });
  }
}

function stripDelivery(value: ReturnType<typeof gatewayStatusCheckCommandPublishedV2Schema.parse>) {
  const { expiresAt, deliveryGeneration, deliveryGeneratedAt, deliveryWindowMs, ...draft } = value;
  return gatewayStatusCheckCommandDraftV2Schema.parse(draft);
}

function withoutInterval(value: ReturnType<typeof createGatewayCommandExpiry>) {
  const { messageExpiryInterval, ...delivery } = value;
  return delivery;
}

function isExpiredDelivery(error: unknown) {
  return error instanceof Error && error.message === "gateway command delivery generation expired";
}
