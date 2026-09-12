import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, type EnergyReportJob, type EnergyReportObjectCleanup } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { ObjectStorageService } from "../../storage/object-storage.service";

export type ReportObjectIdentity = Pick<EnergyReportJob, "id" | "siteId" | "format" | "attemptCount">;

@Injectable()
export class EnergyReportCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnergyReportCleanupService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService) {}

  onModuleInit() {
    if (this.timer || process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.prune().catch(() => this.logger.warn("Report cleanup sweep failed"))
        .finally(() => { this.running = false; });
    }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { clearInterval(this.timer); this.timer = undefined; }

  async prune(now = new Date()) {
    const result = { processed: 0, purged: 0, failed: 0 };
    const seen: string[] = [];
    const cutoff = new Date(now.getTime() - 90 * 86_400_000);
    // Inventory and claim are short DB-only transactions. The key-only ledger never
    // expires: an arbitrarily paused process can PUT after any finite grace period.
    await this.prisma.$transaction(async tx => {
      const jobs = await tx.$queryRaw<ReportObjectIdentity[]>(Prisma.sql`
        SELECT job."id", job."siteId", job."format", job."attemptCount" FROM "EnergyReportJob" job
        WHERE (job."status" IN ('failed', 'expired') OR (job."status" = 'completed' AND job."expiresAt" <= ${now}))
          AND NOT EXISTS (SELECT 1 FROM "EnergyReportObjectCleanup" cleanup WHERE cleanup."reportId" = job."id")
        ORDER BY job."updatedAt", job."id" LIMIT 50 FOR UPDATE OF job SKIP LOCKED
      `);
      for (const job of jobs) await recordReportCleanup(tx, job);
    });
    for (let index = 0; index < 50; index++) {
      const owner = randomUUID();
      const rows = await this.prisma.$queryRaw<EnergyReportObjectCleanup[]>(Prisma.sql`
        WITH candidate AS (
          SELECT "reportId" FROM "EnergyReportObjectCleanup"
          WHERE "nextAttemptAt" <= ${now}
            AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC'))
            ${seen.length ? Prisma.sql`AND "reportId" NOT IN (${Prisma.join(seen)})` : Prisma.empty}
          ORDER BY "nextAttemptAt", "reportId" LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE "EnergyReportObjectCleanup" cleanup SET "leaseOwner" = ${owner},
          "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '30 seconds',
          "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
        FROM candidate WHERE cleanup."reportId" = candidate."reportId" RETURNING cleanup.*
      `);
      const cleanup = rows[0];
      if (!cleanup) break;
      seen.push(cleanup.reportId);
      result.processed++;
      let deleted = true;
      try {
        for (const key of cleanup.objectKeys as string[]) await this.storage.deleteReportObject(key);
      } catch { deleted = false; }
      const outcome = await this.prisma.$transaction(async tx => {
        // Match deletion preparation's job -> cleanup lock order, even when it is
        // retrying and refreshing the inventory while this pass is finalizing.
        const jobs = await tx.$queryRaw<Array<Pick<EnergyReportJob, "id" | "status" | "createdAt" | "expiresAt" | "objectDeletedAt">>>(Prisma.sql`
          SELECT "id", "status", "createdAt", "expiresAt", "objectDeletedAt"
          FROM "EnergyReportJob" WHERE "id" = ${cleanup.reportId} FOR UPDATE
        `);
        const owned = await tx.$queryRaw<Array<{ reportId: string }>>(Prisma.sql`
          SELECT "reportId" FROM "EnergyReportObjectCleanup"
          WHERE "reportId" = ${cleanup.reportId} AND "leaseOwner" = ${owner}
            AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') FOR UPDATE
        `);
        if (!owned.length) return "ownership-lost";
        let purged = false;
        if (deleted) {
          const job = jobs[0];
          if (job && (job.status === "failed" || job.status === "expired" || (job.status === "completed" && job.expiresAt! <= now))) {
            if (job.createdAt <= cutoff) {
              await tx.energyReportJob.delete({ where: { id: job.id } });
              purged = true;
            } else if (job.status !== "failed") {
              await tx.energyReportJob.update({ where: { id: job.id }, data: { status: "expired", objectDeletedAt: job.objectDeletedAt ?? now } });
            }
          }
        }
        await tx.energyReportObjectCleanup.update({ where: { reportId: cleanup.reportId }, data: {
          leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date(now.getTime() + 60_000),
          ...(deleted ? { lastCleanedAt: now, lastError: null } : { lastError: "REPORT_OBJECT_CLEANUP_FAILED" })
        } });
        return deleted ? purged ? "purged" : "retained" : "failed";
      });
      if (outcome === "purged") result.purged++;
      if (outcome === "failed") result.failed++;
    }
    return result;
  }
}

export async function recordReportCleanup(tx: Prisma.TransactionClient, job: ReportObjectIdentity) {
  // Reserve every permitted attempt, even before attempt 1: an old-version worker
  // paused during a rolling upgrade may have missed the new claim barrier. Format
  // and identity come only from the immutable job, never from bucket listing input.
  const objectKeys = reportAttemptKeys({ ...job, attemptCount: 3 });
  // A preparation retry can refresh older inventory. Fence any prior cleanup owner
  // so it cannot finalize using a shorter legacy payload.
  await tx.energyReportObjectCleanup.upsert({ where: { reportId: job.id },
    create: { reportId: job.id, siteId: job.siteId, objectKeys },
    update: { objectKeys, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date() } });
}

export function reportAttemptKeys(job: ReportObjectIdentity) {
  return Array.from({ length: Math.min(3, job.attemptCount) }, (_, index) =>
    `reports/${job.siteId}/${job.id}/attempt-${index + 1}.${job.format}`);
}
