import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { provisioningScanStartSchema } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "./mqtt.service";

const LEASE_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 5 * 60_000;
const PUBLISH_FAILURE_MESSAGE = "조명 검색 명령을 전송하지 못했습니다. 다시 시도해 주세요.";

type PublisherOptions = {
  workerId?: string;
  random?: () => number;
  pollMs?: number;
  clock?: () => Date;
  publishTimeoutMs?: number;
};

@Injectable()
export class ProvisioningScanOutboxPublisherService implements OnModuleInit {
  private readonly logger = new Logger(ProvisioningScanOutboxPublisherService.name);
  private readonly workerId: string;
  private readonly random: () => number;
  private readonly pollMs: number;
  private readonly clock: () => Date;
  private readonly publishTimeoutMs: number;
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
    this.pollMs = options.pollMs ?? Number(process.env.PROVISIONING_SCAN_OUTBOX_POLL_MS ?? 1000);
    this.clock = options.clock ?? (() => new Date());
    this.publishTimeoutMs = options.publishTimeoutMs ?? Number(process.env.PROVISIONING_SCAN_OUTBOX_PUBLISH_TIMEOUT_MS ?? PUBLISH_TIMEOUT_MS);
    if (!Number.isInteger(this.publishTimeoutMs) || this.publishTimeoutMs <= 0 || this.publishTimeoutMs >= LEASE_MS) {
      throw new Error(`PROVISIONING_SCAN_OUTBOX_PUBLISH_TIMEOUT_MS must be a positive integer below ${LEASE_MS}`);
    }
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
        this.logger.error(`mqtt provisioning scan outbox batch failed (worker=${this.workerId}, error=${this.errorKind(error)})`);
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
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "ProvisioningScanOutbox"
        WHERE "publishedAt" IS NULL
          AND "deadLetteredAt" IS NULL
          AND "nextAttemptAt" <= ${now}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 50
      `);
      const ids = rows.map((row) => row.id);
      if (ids.length === 0) return [];
      await tx.provisioningScanOutbox.updateMany({
        where: { id: { in: ids }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        data: { lockedBy: this.workerId, lockedAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }
      });
      return tx.provisioningScanOutbox.findMany({
        where: { id: { in: ids }, lockedBy: this.workerId },
        orderBy: { createdAt: "asc" }
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

  async publishClaimed(record: {
    id: string;
    sessionId: string;
    scanAttempt: number;
    topic: string;
    payload: Prisma.JsonValue;
    attempts: number;
    createdAt: Date;
  }) {
    try {
      const payload = provisioningScanStartSchema.parse(record.payload);
      const prepared = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ProvisioningSession" WHERE "id" = ${record.sessionId} FOR UPDATE`;
        const session = await tx.provisioningSession.findUnique({ where: { id: record.sessionId } });
        const now = this.clock();
        if (
          !session ||
          session.status !== "active" ||
          (session.scanStatus !== "pending" && session.scanStatus !== "scanning") ||
          session.scanCorrelationId !== payload.scanCorrelationId ||
          session.scanAttempt !== payload.scanAttempt
        ) {
          await tx.provisioningScanOutbox.updateMany({
            where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
            data: { deadLetteredAt: now, lastError: "scan is no longer active", lockedBy: null, lockedAt: null, leaseExpiresAt: null }
          });
          return null;
        }
        if (session.scanStatus === "pending") {
          // A crash before MQTT acknowledgement intentionally replays this correlation and attempt after lease expiry.
          const started = await tx.provisioningSession.updateMany({
            where: {
              id: session.id,
              status: "active",
              scanStatus: "pending",
              scanCorrelationId: payload.scanCorrelationId,
              scanAttempt: payload.scanAttempt
            },
            data: { scanStatus: "scanning", scanStartedAt: now }
          });
          if (started.count !== 1) return null;
        }
        const renewed = await tx.provisioningScanOutbox.updateMany({
          where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
          data: { leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }
        });
        return renewed.count === 1;
      });
      if (!prepared) return;

      const publishable = await this.prisma.provisioningScanOutbox.count({
        where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null }
      });
      if (publishable !== 1) return;

      await this.publishWithTimeout(record.topic, payload);
      await this.prisma.provisioningScanOutbox.updateMany({
        where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
        data: { publishedAt: this.clock(), lastError: null, lockedBy: null, lockedAt: null, leaseExpiresAt: null }
      });
    } catch (error) {
      await this.handleFailure(record, error);
    }
  }

  private async publishWithTimeout(topic: string, payload: ReturnType<typeof provisioningScanStartSchema.parse>) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(
        () => finish(new Error(`provisioning scan publish timed out after ${this.publishTimeoutMs}ms`)),
        this.publishTimeoutMs
      );
      void this.mqtt.publishTopic(topic, payload, { timeoutMs: this.publishTimeoutMs }).then(
        () => finish(),
        (error) => finish(error)
      );
    });
  }

  private async handleFailure(record: { id: string; sessionId: string; scanAttempt: number; attempts: number; createdAt: Date }, error: unknown) {
    const now = this.clock();
    const attempts = record.attempts + 1;
    const message = error instanceof Error ? error.message : "unknown MQTT publish error";
    const exhausted = attempts >= MAX_ATTEMPTS || now.getTime() - record.createdAt.getTime() >= MAX_AGE_MS;
    if (exhausted) {
      await this.prisma.$transaction(async (tx) => {
        const deadLettered = await tx.provisioningScanOutbox.updateMany({
          where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
          data: { attempts, deadLetteredAt: now, lastError: message, lockedBy: null, lockedAt: null, leaseExpiresAt: null }
        });
        if (deadLettered.count !== 1) return;
        await tx.provisioningSession.updateMany({
          where: { id: record.sessionId, status: "active", scanStatus: { in: ["pending", "scanning"] }, scanAttempt: record.scanAttempt },
          data: {
            scanStatus: "failed",
            scanCompletedAt: now,
            scanFailureCode: "scan_start_publish_failed",
            scanFailureMessage: PUBLISH_FAILURE_MESSAGE
          }
        });
      });
      return;
    }

    const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
    const jitter = Math.floor(delay * 0.2 * this.random());
    await this.prisma.provisioningScanOutbox.updateMany({
      where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
      data: {
        attempts,
        nextAttemptAt: new Date(now.getTime() + delay + jitter),
        lastError: message,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null
      }
    });
  }
}
