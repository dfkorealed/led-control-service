import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";

const POLL_INTERVAL_MS = 60_000;
const UPLOAD_EXPIRY_SAFETY_MS = 5_000;
const ABANDONED_SIGNING_TIMEOUT_MS = 15 * 60_000;
const CLAIM_TIMEOUT_MS = 120_000;
const BATCH_SIZE = 25;

@Injectable()
export class FloorAssetCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
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

  async processPending(now = new Date()) {
    const uploadExpiredAt = new Date(now.getTime() - UPLOAD_EXPIRY_SAFETY_MS);
    const abandonedSigningAt = new Date(now.getTime() - ABANDONED_SIGNING_TIMEOUT_MS);
    const abandonedClaimAt = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
    const expiredUploadWhere = {
      OR: [
        { uploadExpiresAt: { lte: uploadExpiredAt } },
        { uploadExpiresAt: null, createdAt: { lte: abandonedSigningAt } }
      ]
    };
    const availableClaimWhere = {
      OR: [{ cleanupStartedAt: null }, { cleanupStartedAt: { lte: abandonedClaimAt } }]
    };
    const assets = await this.prisma.floorAsset.findMany({
      where: {
        status: "pending",
        ...expiredUploadWhere,
        AND: [availableClaimWhere]
      },
      select: { id: true, objectKey: true },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE
    });

    let deleted = 0;
    for (const asset of assets) {
      const claimed = await this.prisma.floorAsset.updateMany({
        where: {
          id: asset.id,
          status: "pending",
          ...expiredUploadWhere,
          AND: [availableClaimWhere]
        },
        data: { cleanupStartedAt: now }
      });
      if (claimed.count !== 1) continue;

      try {
        await this.storage.deleteObject(asset.objectKey);
        const removed = await this.prisma.floorAsset.deleteMany({
          where: { id: asset.id, status: "pending", cleanupStartedAt: now }
        });
        deleted += removed.count;
      } catch {
        // Storage failure is recoverable. Releasing the claim lets the next poll retry it.
        await this.prisma.floorAsset.updateMany({
          where: { id: asset.id, status: "pending", cleanupStartedAt: now },
          data: { cleanupStartedAt: null }
        });
      }
    }

    return { processed: assets.length, deleted };
  }
}
