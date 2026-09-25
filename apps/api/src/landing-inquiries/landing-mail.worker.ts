import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { LandingInquiry, LandingInquiryDeliveryStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { LandingMailTransport, LandingMailDeliveryError } from "./landing-mail.transport";
import { renderLandingMail } from "./landing-mail-renderer";

const deliveryBatchSize = 10;
const maintenanceBatchSize = 100;
const maxAttempts = 5;
const leaseDurationMs = 120_000;

@Injectable()
export class LandingMailWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LandingMailWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private ticking = false;
  private readonly active = new Set<Promise<number>>();

  constructor(private readonly prisma: PrismaService, private readonly transport: LandingMailTransport) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => { void this.tick(); }, 30_000);
    this.timer.unref();
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.active]);
  }

  deliverDue(now?: Date): Promise<number> {
    return this.track(() => this.deliverBatch(now));
  }

  pruneExpired(now = new Date()): Promise<number> {
    return this.track(async () => {
      const count = await this.prisma.$executeRaw`
        DELETE FROM "LandingInquiry" WHERE "id" IN (
          SELECT "id" FROM "LandingInquiry" WHERE "expiresAt" <= ${now.toISOString()}::timestamp
          ORDER BY "expiresAt", "id" LIMIT ${maintenanceBatchSize} FOR UPDATE SKIP LOCKED
        )`;
      if (count) this.logger.log(`Pruned expired landing inquiries: ${count}`);
      return count;
    });
  }

  private track(run: () => Promise<number>): Promise<number> {
    if (this.stopping) return Promise.resolve(0);
    const promise = run();
    this.active.add(promise);
    void promise.then(() => this.active.delete(promise), () => this.active.delete(promise));
    return promise;
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      await this.deliverDue();
      await this.pruneExpired();
    } catch { this.logger.warn("Landing mail maintenance failed"); }
    finally { this.ticking = false; }
  }

  private async deliverBatch(referenceTime?: Date): Promise<number> {
    let now = referenceTime ?? new Date();
    // A crashed worker may have sent the mail before persisting its result. Expired
    // leases therefore close as uncertain; they are never reclaimed for another send.
    await this.prisma.$executeRaw`
      UPDATE "LandingInquiry" SET "deliveryStatus" = 'delivery_uncertain', "lastErrorCode" = 'MAIL_LEASE_EXPIRED',
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL, "updatedAt" = ${now.toISOString()}::timestamp
      WHERE "id" IN (SELECT "id" FROM "LandingInquiry"
        WHERE "deliveryStatus" IN ('queued', 'retry_wait') AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" <= ${now.toISOString()}::timestamp
        ORDER BY "leaseExpiresAt", "id" LIMIT ${maintenanceBatchSize} FOR UPDATE SKIP LOCKED)`;
    let processed = 0;
    for (; processed < deliveryBatchSize && !this.stopping; processed++) {
      now = referenceTime ?? new Date();
      const owner = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
      // Prisma stores UTC in TIMESTAMP WITHOUT TIME ZONE. Bind ISO text explicitly
      // as timestamp so a non-UTC PostgreSQL session cannot shift comparisons.
      // Claim a single row immediately before sending. A batch lease could expire
      // while earlier provider requests are still running. SQL commits before I/O.
      const rows = await this.prisma.$queryRaw<LandingInquiry[]>`
        UPDATE "LandingInquiry" SET "leaseOwner" = ${owner}, "leaseExpiresAt" = ${leaseExpiresAt.toISOString()}::timestamp,
          "attemptCount" = "attemptCount" + 1, "lastAttemptAt" = ${now.toISOString()}::timestamp, "updatedAt" = ${now.toISOString()}::timestamp
        WHERE "id" IN (SELECT "id" FROM "LandingInquiry"
          WHERE "deliveryStatus" IN ('queued', 'retry_wait') AND "leaseOwner" IS NULL
            AND "nextAttemptAt" <= ${now.toISOString()}::timestamp AND "expiresAt" > ${now.toISOString()}::timestamp AND "attemptCount" < ${maxAttempts}
          ORDER BY "nextAttemptAt", "id" LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`;
      const inquiry = rows[0];
      if (!inquiry) break;
      let deliveryStatus: LandingInquiryDeliveryStatus = "provider_accepted";
      let lastErrorCode: string | null = null;
      let nextAttemptAt: Date | null = null;
      try { await this.transport.send(renderLandingMail(inquiry)); }
      catch (error) {
        const outcome = error instanceof LandingMailDeliveryError ? error.outcome : "uncertain";
        lastErrorCode = error instanceof LandingMailDeliveryError ? error.code : "MAIL_ACCEPTANCE_UNKNOWN";
        if (outcome === "retryable" && inquiry.attemptCount < maxAttempts) {
          deliveryStatus = "retry_wait";
          nextAttemptAt = new Date(now.getTime() + 60_000 * 2 ** (inquiry.attemptCount - 1));
        } else deliveryStatus = outcome === "uncertain" ? "delivery_uncertain" : "failed";
      }
      // DB failures must leave the lease intact. Treating persistence failure as a
      // send failure could incorrectly turn an accepted email into a retry.
      await this.prisma.landingInquiry.updateMany({ where: { id: inquiry.id, leaseOwner: owner,
        deliveryStatus: { in: ["queued", "retry_wait"] } }, data: {
        deliveryStatus, lastErrorCode, nextAttemptAt, leaseOwner: null, leaseExpiresAt: null,
        providerAcceptedAt: deliveryStatus === "provider_accepted" ? now : null
      } });
    }
    return processed;
  }
}
