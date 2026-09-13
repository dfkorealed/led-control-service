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
      void this.prune().catch(() => this.logger.warn({ event: "report_object_cleanup_sweep_failed", code: "REPORT_CLEANUP_SWEEP_FAILED" }))
        .finally(() => { this.running = false; });
    }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { clearInterval(this.timer); this.timer = undefined; }

  async prune(now = new Date()) {
    const result = { processed: 0, purged: 0, failed: 0, retried: 0, ownershipLost: 0 };
    const seen: string[] = [];
    const cutoff = new Date(now.getTime() - 90 * 86_400_000);
    // Prisma binds Date as timestamptz, but these columns store naive UTC. Explicit
    // conversion prevents the PostgreSQL session timezone from shifting a cutoff.
    const utcNow = Prisma.sql`(${now}::timestamptz AT TIME ZONE 'UTC')`;
    // Inventory and claim are short DB-only transactions. The key-only ledger never
    // expires: an arbitrarily paused process can PUT after any finite grace period.
    await this.prisma.$transaction(async tx => {
      const jobs = await tx.$queryRaw<ReportObjectIdentity[]>(Prisma.sql`
        SELECT job."id", job."siteId", job."format", job."attemptCount" FROM "EnergyReportJob" job
        WHERE ${cleanupEligibleReport(now)}
          AND NOT EXISTS (SELECT 1 FROM "EnergyReportObjectCleanup" cleanup WHERE cleanup."reportId" = job."id")
        ORDER BY job."updatedAt", job."id" LIMIT 50 FOR UPDATE OF job SKIP LOCKED
      `);
      for (const job of jobs) await recordReportCleanup(tx, job, now);
    });
    for (let index = 0; index < 50; index++) {
      const owner = randomUUID();
      const rows = await this.prisma.$queryRaw<EnergyReportObjectCleanup[]>(Prisma.sql`
        WITH candidate AS (
          SELECT "reportId" FROM "EnergyReportObjectCleanup"
          WHERE "nextAttemptAt" <= ${utcNow}
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
      const pass = { observedCount: 0, observedBytes: 0n, deletedCount: 0, deletedBytes: 0n };
      try {
        for (const key of cleanup.objectKeys as string[]) {
          const object = await this.storage.inspectReportObject(key);
          if (object.exists) { pass.observedCount++; pass.observedBytes += BigInt(object.sizeBytes); }
          // DELETE even after HEAD 404 to also catch a PUT between those calls.
          // Only observed objects with an acknowledged DELETE contribute bytes;
          // response loss/concurrent replacement mean this is observed cleanup
          // activity, not exact physical storage or billing accounting.
          await this.storage.deleteReportObject(key);
          if (object.exists) { pass.deletedCount++; pass.deletedBytes += BigInt(object.sizeBytes); }
        }
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
          deleteAttemptCount: { increment: 1 }, deleteRetryCount: { increment: cleanup.lastError ? 1 : 0 },
          deleteFailureCount: { increment: deleted ? 0 : 1 }, lastAttemptAt: now,
          lastObservedObjectCount: pass.observedCount, lastObservedBytes: pass.observedBytes,
          deletedObjectCount: { increment: pass.deletedCount }, deletedBytes: { increment: pass.deletedBytes },
          // Failed DELETEs are counted when they eventually succeed, so observing
          // the same late object again during retries cannot inflate late PUTs.
          latePutObjectCount: { increment: cleanup.lastCleanedAt ? pass.deletedCount : 0 },
          latePutBytes: { increment: cleanup.lastCleanedAt ? pass.deletedBytes : 0n },
          ...(deleted ? { lastCleanedAt: now, lastError: null } : { lastError: "REPORT_OBJECT_CLEANUP_FAILED" })
        } });
        return deleted ? purged ? "purged" : "retained" : "failed";
      });
      if (outcome === "purged") result.purged++;
      if (outcome === "failed") result.failed++;
      if (outcome === "ownership-lost") result.ownershipLost++;
      else if (cleanup.lastError) result.retried++;
    }
    const summary = { ...result, metrics: await this.metrics(now) };
    this.logger.log({ event: "report_object_cleanup_sweep", ...summary });
    return summary;
  }

  private async metrics(now: Date) {
    const rows = await this.prisma.$queryRaw<Array<{
      ledgerCount: number; backlogCount: number; uninventoriedCount: number; dueCount: number; retryPendingCount: number; oldestDueAt: Date | null;
      deleteAttemptCount: string; deleteRetryCount: string; deleteFailureCount: string;
      lastObservedObjectCount: string; lastObservedBytes: string; deletedObjectCount: string; deletedBytes: string;
      latePutObjectCount: string; latePutBytes: string;
    }>>(Prisma.sql`
      WITH uninventoried AS (
        SELECT count(*)::integer AS count FROM "EnergyReportJob" job
        WHERE ${cleanupEligibleReport(now)}
          AND NOT EXISTS (SELECT 1 FROM "EnergyReportObjectCleanup" cleanup WHERE cleanup."reportId" = job."id")
      )
      SELECT count(*)::integer AS "ledgerCount",
        (count(*) FILTER (WHERE "lastCleanedAt" IS NULL OR "lastError" IS NOT NULL) + (SELECT count FROM uninventoried))::integer AS "backlogCount",
        (SELECT count FROM uninventoried) AS "uninventoriedCount",
        count(*) FILTER (WHERE "nextAttemptAt" <= (${now}::timestamptz AT TIME ZONE 'UTC'))::integer AS "dueCount",
        count(*) FILTER (WHERE "lastError" IS NOT NULL)::integer AS "retryPendingCount",
        min("nextAttemptAt") FILTER (WHERE "nextAttemptAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')) AS "oldestDueAt",
        COALESCE(sum("deleteAttemptCount"), 0)::text AS "deleteAttemptCount",
        COALESCE(sum("deleteRetryCount"), 0)::text AS "deleteRetryCount",
        COALESCE(sum("deleteFailureCount"), 0)::text AS "deleteFailureCount",
        COALESCE(sum("lastObservedObjectCount"), 0)::text AS "lastObservedObjectCount",
        COALESCE(sum("lastObservedBytes"), 0)::text AS "lastObservedBytes",
        COALESCE(sum("deletedObjectCount"), 0)::text AS "deletedObjectCount",
        COALESCE(sum("deletedBytes"), 0)::text AS "deletedBytes",
        COALESCE(sum("latePutObjectCount"), 0)::text AS "latePutObjectCount",
        COALESCE(sum("latePutBytes"), 0)::text AS "latePutBytes"
      FROM "EnergyReportObjectCleanup"
    `);
    const { oldestDueAt, ...counts } = rows[0];
    // Aggregate bigint/numeric counters are decimal strings for exact, JSON-safe logs.
    return { ...counts, oldestDueAgeMs: oldestDueAt ? Math.max(0, now.getTime() - oldestDueAt.getTime()) : 0 };
  }
}

function cleanupEligibleReport(now: Date) {
  return Prisma.sql`(job."status" IN ('failed', 'expired')
    OR (job."status" = 'completed' AND job."expiresAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')))`;
}

export async function recordReportCleanup(tx: Prisma.TransactionClient, job: ReportObjectIdentity, now = new Date()) {
  // Reserve every permitted attempt, even before attempt 1: an old-version worker
  // paused during a rolling upgrade may have missed the new claim barrier. Format
  // and identity come only from the immutable job, never from bucket listing input.
  const objectKeys = reportAttemptKeys({ ...job, attemptCount: 3 });
  // A preparation retry can refresh older inventory. Fence any prior cleanup owner
  // so it cannot finalize using a shorter legacy payload.
  await tx.energyReportObjectCleanup.upsert({ where: { reportId: job.id },
    create: { reportId: job.id, siteId: job.siteId, objectKeys, nextAttemptAt: now, createdAt: now },
    update: { objectKeys, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now } });
}

export function reportAttemptKeys(job: ReportObjectIdentity) {
  return Array.from({ length: Math.min(3, job.attemptCount) }, (_, index) =>
    `reports/${job.siteId}/${job.id}/attempt-${index + 1}.${job.format}`);
}
