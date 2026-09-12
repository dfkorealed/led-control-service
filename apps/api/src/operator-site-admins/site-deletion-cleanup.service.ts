import { ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, type EnergyReportStatus } from "@prisma/client";
import { CertificateLifecycleService } from "../pki/certificate-lifecycle.service";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { recordReportCleanup, reportAttemptKeys, type ReportObjectIdentity } from "../energy/reports/energy-report-cleanup.service";

const POLL_INTERVAL_MS = 30_000;
const LEASE_DURATION_MS = 120_000;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;
const UPLOAD_URL_MAX_AGE_MS = 5 * 60 * 1_000;
const UPLOAD_EXPIRY_SAFETY_MS = 5_000;
const REPORTS_BEFORE_SITE_DELETE = "REPORTS_BEFORE_SITE_DELETE";

@Injectable()
export class SiteDeletionCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly certificates: CertificateLifecycleService,
    private readonly storage: ObjectStorageService
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.processPending().catch(() => undefined), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.processPending().catch(() => undefined);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async prepareReportDeletion(siteId: string): Promise<{ id: string; objectKeys: string[] }> {
    const marker = await this.prisma.$transaction(async tx => {
      // Serialize with report INSERT's key-share lock. The committed cleanup row is a
      // durable barrier for new requests and worker claims, including after API restart.
      const sites = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`);
      if (!sites.length) throw new NotFoundException("site not found");
      const reports = await tx.$queryRaw<Array<ReportObjectIdentity & { status: EnergyReportStatus }>>(Prisma.sql`
        SELECT "id", "siteId", "format", "attemptCount", "status"
        FROM "EnergyReportJob" WHERE "siteId" = ${siteId} ORDER BY "id" FOR UPDATE
      `);
      // An expired lease does not prove a renderer/PUT has stopped. Let the worker
      // recover or retire it, then retry deletion after it reaches a terminal state.
      if (reports.some(report => report.status === "processing")) {
        throw new ConflictException("report processing must finish before site deletion; retry shortly");
      }
      const existing = await tx.siteDeletionCleanup.findUnique({ where: { siteId } });
      const objectKeys = [...new Set([...(existing ? parseStringArray(existing.objectKeys) : []), ...reports.flatMap(reportAttemptKeys)])];
      const cleanup = await tx.siteDeletionCleanup.upsert({ where: { siteId },
        create: { siteId, objectKeys, inventoryIds: [], lastError: REPORTS_BEFORE_SITE_DELETE },
        update: { objectKeys, lastError: REPORTS_BEFORE_SITE_DELETE } });
      for (const report of reports) await recordReportCleanup(tx, report);
      return { id: cleanup.id, objectKeys };
    });
    // Never hold Site/report locks over a network call. Failure keeps the marker,
    // site and report metadata intact for both operator retry and the durable sweep.
    try {
      for (const key of marker.objectKeys.filter(key => key.startsWith("reports/"))) await this.storage.deleteReportObject(key);
    } catch { throw new ServiceUnavailableException("report cleanup is pending; retry site deletion"); }
    return marker;
  }

  async processNow(cleanupId: string) {
    const job = await this.claim(cleanupId);
    if (!job) return { status: "skipped" as const };
    if (job.lastError === REPORTS_BEFORE_SITE_DELETE) {
      // The operator retry owns pre-cascade deletion. The background worker must not
      // finish this partial payload, or race the later floor/certificate inventory.
      await this.prisma.siteDeletionCleanup.updateMany({
        where: { id: job.id, lastError: REPORTS_BEFORE_SITE_DELETE },
        data: { lockedAt: null, leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + POLL_INTERVAL_MS) }
      });
      return { status: "pending" as const };
    }

    try {
      for (const inventoryId of parseStringArray(job.inventoryIds)) {
        await this.certificates.revokeInventoryCertificates(inventoryId);
      }
      const objectKeys = parseStringArray(job.objectKeys);
      const objectDeleteAfter = new Date(job.createdAt.getTime() + UPLOAD_URL_MAX_AGE_MS + UPLOAD_EXPIRY_SAFETY_MS);
      if (objectKeys.length > 0 && objectDeleteAfter > new Date()) {
        await this.prisma.siteDeletionCleanup.update({
          where: { id: job.id },
          data: {
            nextAttemptAt: objectDeleteAfter,
            lockedAt: null,
            leaseExpiresAt: null,
            lastError: "UPLOAD_URL_EXPIRY_PENDING"
          }
        });
        return { status: "pending" as const };
      }
      for (const objectKey of objectKeys) {
        if (objectKey.startsWith("reports/")) await this.storage.deleteReportObject(objectKey);
        else await this.storage.deleteObject(objectKey);
      }
      await this.prisma.siteDeletionCleanup.update({
        where: { id: job.id },
        data: { completedAt: new Date(), lockedAt: null, leaseExpiresAt: null, lastError: null }
      });
      return { status: "completed" as const };
    } catch (error) {
      const attempts = job.attempts;
      await this.prisma.siteDeletionCleanup.update({
        where: { id: job.id },
        data: {
          nextAttemptAt: new Date(Date.now() + Math.min(2 ** Math.min(attempts, 10) * 1_000, MAX_BACKOFF_MS)),
          lockedAt: null,
          leaseExpiresAt: null,
          lastError: cleanupErrorCode(error)
        }
      });
      return { status: "pending" as const };
    }
  }

  private async processPending() {
    const now = new Date();
    const jobs = await this.prisma.siteDeletionCleanup.findMany({
      where: {
        completedAt: null,
        nextAttemptAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }]
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: 10
    });
    for (const job of jobs) await this.processNow(job.id);
  }

  private async claim(cleanupId: string) {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);
    const claimed = await this.prisma.siteDeletionCleanup.updateMany({
      where: {
        id: cleanupId,
        completedAt: null,
        nextAttemptAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }]
      },
      data: { lockedAt: now, leaseExpiresAt, attempts: { increment: 1 } }
    });
    if (claimed.count !== 1) return null;
    return this.prisma.siteDeletionCleanup.findUniqueOrThrow({ where: { id: cleanupId } });
  }
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error("INVALID_CLEANUP_PAYLOAD");
  }
  return value;
}

function cleanupErrorCode(error: unknown) {
  if (error instanceof Error && error.message === "INVALID_CLEANUP_PAYLOAD") return error.message;
  return "EXTERNAL_CLEANUP_FAILED";
}
