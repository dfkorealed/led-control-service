import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { finalizeResolvedMonitoringRefresh } from "./monitoring-refresh-state";

const EXPIRY_BATCH_SIZE = 50;

type ExpiryOptions = { pollMs?: number };

@Injectable()
export class MonitoringRefreshExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitoringRefreshExpiryService.name);
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private activeBatch: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly prisma: PrismaService, @Optional() options: ExpiryOptions = {}) {
    this.pollMs = options.pollMs ?? Number(process.env.MONITORING_REFRESH_EXPIRY_POLL_MS ?? 1_000);
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
    const batch = this.expire()
      .then(() => undefined)
      .catch((error) => {
        this.logger.error(`monitoring refresh expiry batch failed (error=${errorKind(error)})`);
      })
      .finally(() => {
        this.activeBatch = null;
      });
    this.activeBatch = batch;
    return batch;
  }

  async expire(now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "MonitoringRefresh"
        WHERE "status" = 'pending'
          AND "deadlineAt" <= ${now}
        ORDER BY "deadlineAt" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${EXPIRY_BATCH_SIZE}
      `);
      let expired = 0;
      for (const { id: refreshId } of rows) {
        const refresh = await tx.monitoringRefresh.findUnique({ where: { id: refreshId } });
        if (!refresh || refresh.status !== "pending" || refresh.deadlineAt.getTime() > now.getTime()) continue;

        await tx.mqttOutbox.updateMany({
          where: {
            monitoringRefreshBatch: { refreshId },
            publishedAt: null,
            deadLetteredAt: null
          },
          data: {
            deadLetteredAt: now,
            lastError: "refresh_deadline_exceeded",
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null
          }
        });
        await tx.monitoringRefreshFixture.updateMany({
          where: { refreshId, status: "pending" },
          data: { status: "unverified", errorCode: "refresh_deadline_exceeded", observedAt: now }
        });
        await tx.monitoringRefreshBatch.updateMany({
          where: { refreshId, status: { in: ["pending", "published"] } },
          data: { status: "expired", errorCode: "refresh_deadline_exceeded", completedAt: now }
        });
        if (await finalizeResolvedMonitoringRefresh(tx, refreshId, now, "expired")) expired += 1;
      }
      return { expired };
    });
  }
}

function errorKind(error: unknown) {
  if (
    typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" && /^P\d{4}$/.test(error.code)
  ) return error.code;
  return "UNEXPECTED_ERROR";
}
