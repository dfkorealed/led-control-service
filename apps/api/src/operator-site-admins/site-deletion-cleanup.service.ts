import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { CertificateLifecycleService } from "../pki/certificate-lifecycle.service";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";

const POLL_INTERVAL_MS = 30_000;
const LEASE_DURATION_MS = 120_000;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;
const UPLOAD_URL_MAX_AGE_MS = 5 * 60 * 1_000;
const UPLOAD_EXPIRY_SAFETY_MS = 5_000;

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

  async processNow(cleanupId: string) {
    const job = await this.claim(cleanupId);
    if (!job) return { status: "skipped" as const };

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
      for (const objectKey of objectKeys) await this.storage.deleteObject(objectKey);
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
