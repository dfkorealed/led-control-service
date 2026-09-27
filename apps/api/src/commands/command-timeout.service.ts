import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS } from "@led-control/shared";
import { PrismaService } from "../prisma/prisma.service";
import { recordCommandOutcomeActivity } from "../monitoring-activity/command-outcome-activity";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";

const DEVICE_STATUS_TIMEOUT_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 15 * 60_000;

@Injectable()
export class CommandTimeoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommandTimeoutService.name);
  private timer: NodeJS.Timeout | null = null;
  private activeBatch: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly automationSnapshot: AutomationSnapshotService
  ) {}

  onModuleInit() {
    this.stopped = false;
    void this.runScheduledBatch();
    this.timer = setInterval(() => void this.runScheduledBatch(), 1000);
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

  private runScheduledBatch() {
    // setInterval does not await asynchronous callbacks, so one stalled DB query must retain the worker slot.
    if (this.stopped || this.activeBatch) return this.activeBatch ?? Promise.resolve();

    const batch = this.closeExpired()
      .then(() => undefined)
      .catch((error) => {
        this.logger.error(`command timeout batch failed (error=${this.errorKind(error)})`);
      })
      .finally(() => {
        this.activeBatch = null;
      });
    this.activeBatch = batch;
    return batch;
  }

  private errorKind(error: unknown) {
    if (
      typeof error === "object" && error !== null && "code" in error
      && typeof error.code === "string" && /^P\d{4}$/.test(error.code)
    ) return error.code;
    return "UNEXPECTED_ERROR";
  }

  async closeExpired(now = new Date()) {
    const dispatches = await this.prisma.commandDispatch.findMany({
      where: {
        OR: [
          { status: "pending", createdAt: { lt: new Date(now.getTime() - DELIVERY_TIMEOUT_MS) } },
          { status: "published", publishedAt: { lt: new Date(now.getTime() - GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS) } },
          { status: "accepted", acceptedAt: { lt: new Date(now.getTime() - DEVICE_STATUS_TIMEOUT_MS) } }
        ]
      },
      select: { id: true, commandId: true, status: true, kind: true, command: { select: { outcome: true } } }
    });

    let timedOut = 0;
    for (const dispatch of dispatches) {
      let closed = false;
      try {
        closed = await this.prisma.$transaction(async (tx) => {
          // Unknown-outcome transitions must serialize with dimming's overlap scan and
          // creation. Take the shared lock before any outbox/dispatch/command row lock.
          await this.automationSnapshot.lockMutation(tx);
          let deliveryAttempted = dispatch.status !== "pending";
          if (dispatch.status === "pending") {
            const claimed = await tx.mqttOutbox.updateMany({
              where: {
                dispatchId: dispatch.id,
                publishedAt: null,
                deadLetteredAt: null,
                OR: [{ lockedBy: null }, { leaseExpiresAt: { lte: now } }]
              },
              data: {
                deadLetteredAt: now,
                lastError: "command timed out before delivery",
                lockedBy: null,
                lockedAt: null,
                leaseExpiresAt: null
              }
            });
            if (claimed.count !== 1) return false;
            // PUBACK loss leaves dispatch pending despite a possible broker delivery.
            // Read durable evidence after fencing the outbox, not the stale scan row.
            const outbox = await tx.mqttOutbox.findUnique({
              where: { dispatchId: dispatch.id }, select: { deliveryAttemptedAt: true }
            });
            deliveryAttempted = outbox?.deliveryAttemptedAt != null;
          }

          const result = await tx.commandDispatch.updateMany({
            where: { id: dispatch.id, status: dispatch.status },
            data: {
              status: "timed_out",
              completedAt: now,
              errorCode: dispatch.status === "pending" ? (deliveryAttempted ? "ACCEPTANCE_TIMEOUT" : "DELIVERY_TIMEOUT")
                : dispatch.status === "published" ? "ACCEPTANCE_TIMEOUT" : "STATUS_TIMEOUT",
              errorMessage: "gateway command deadline exceeded"
            }
          });
          if (result.count !== 1) {
            // A false return would commit the outbox claim; throwing makes Prisma roll back both row updates.
            if (dispatch.status === "pending") throw new PendingTimeoutRaceError();
            return false;
          }
          await tx.commandFixtureResult.updateMany({
            where: { dispatchId: dispatch.id, status: "pending" },
            data: { status: "timed_out", occurredAt: now, errorMessage: "gateway command deadline exceeded" }
          });
          // A failed Get says nothing new about the physical Set. Only its dispatch closes;
          // in particular, a concurrent successful verification must never be overwritten.
          if (dispatch.kind === "dimming") {
            const legacy = dispatch.command.outcome === null;
            const updated = await tx.command.updateMany({
              where: { id: dispatch.commandId, status: "pending", outcome: legacy ? null : "pending" },
              data: {
                status: "failed", errorMessage: "one or more gateway dispatches timed out",
                ...(legacy ? {} : { outcome: deliveryAttempted ? "unknown" : "not_applied" })
              }
            });
            if (updated.count === 1 && !legacy) {
              await recordCommandOutcomeActivity(tx, dispatch.commandId, "pending", deliveryAttempted ? "unknown" : "not_applied");
            }
          }
          return true;
        });
      } catch (error) {
        if (!(error instanceof PendingTimeoutRaceError)) throw error;
      }
      if (closed) timedOut += 1;
    }
    return { timedOut };
  }
}

class PendingTimeoutRaceError extends Error {
  constructor() {
    super("pending command timeout lost its dispatch race");
  }
}
