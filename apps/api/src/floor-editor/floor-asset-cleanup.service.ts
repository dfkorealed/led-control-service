import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";

const POLL_INTERVAL_MS = 60_000;
const UPLOAD_EXPIRY_SAFETY_MS = 5_000;
const ABANDONED_SIGNING_TIMEOUT_MS = 15 * 60_000;
const CLAIM_RETRY_BACKOFF_MS = 120_000;
const READY_ORPHAN_GRACE_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 25;

interface CleanupCandidate {
  id: string;
  floorId: string;
  objectKey: string;
  cleanupStartedAt: Date | null;
}

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
    const retryableClaimAt = new Date(now.getTime() - CLAIM_RETRY_BACKOFF_MS);
    const readyOrphanAt = new Date(now.getTime() - READY_ORPHAN_GRACE_MS);
    const expiredUploadWhere = {
      OR: [
        { uploadExpiresAt: { lte: uploadExpiredAt } },
        { uploadExpiresAt: null, createdAt: { lte: abandonedSigningAt } }
      ]
    };
    const availableClaimWhere = {
      OR: [{ cleanupStartedAt: null }, { cleanupStartedAt: { lte: retryableClaimAt } }]
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
    // UUID-backed access paths can be reconstructed in SQL. Excluding known references
    // before LIMIT prevents old saved assets from starving later orphan candidates.
    const readyAssets = await this.prisma.$queryRaw<CleanupCandidate[]>(Prisma.sql`
      SELECT asset."id", asset."floorId", asset."objectKey", asset."cleanupStartedAt"
      FROM "FloorAsset" AS asset
      CROSS JOIN LATERAL (
        SELECT '/api/floors/' || asset."floorId" || '/assets/' || asset."id" || '/content' AS "accessPath"
      ) AS path
      WHERE asset."status" = 'ready'
        AND COALESCE(asset."readyAt", asset."createdAt") <= ${readyOrphanAt}
        AND (asset."cleanupStartedAt" IS NULL OR asset."cleanupStartedAt" <= ${retryableClaimAt})
        AND NOT EXISTS (
          SELECT 1
          FROM "FloorPlan" AS plan
          WHERE plan."floorId" = asset."floorId"
            AND path."accessPath" IN (plan."imageUrl", plan."originalFileUrl", plan."renderedImageUrl")
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "FloorMapRevision" AS revision
          WHERE revision."floorId" = asset."floorId"
            AND path."accessPath" IN (
              revision."snapshot" #>> '{floorPlan,imageUrl}',
              revision."snapshot" #>> '{floorPlan,originalFileUrl}',
              revision."snapshot" #>> '{floorPlan,renderedImageUrl}'
            )
        )
      ORDER BY asset."createdAt" ASC
      LIMIT ${BATCH_SIZE}
    `);

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

    for (const asset of readyAssets) {
      const claimed = await this.claimReadyOrphan(asset.id, readyOrphanAt, retryableClaimAt, now);
      if (!claimed) continue;

      try {
        await this.storage.deleteObject(claimed.objectKey);
      } catch {
        // Ready orphans keep their claim as a retry backoff. Releasing it here lets a full
        // failed batch occupy every poll and starve later candidates behind the LIMIT.
        continue;
      }

      const removed = await this.prisma.floorAsset.deleteMany({
        where: { id: claimed.id, status: "ready", cleanupStartedAt: now }
      });
      deleted += removed.count;
    }

    return { processed: assets.length + readyAssets.length, deleted };
  }

  private claimReadyOrphan(assetId: string, readyOrphanAt: Date, retryableClaimAt: Date, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      // Editor save/restore locks Floor before validating assets. Taking the same lock
      // makes either the committed reference or the cleanup claim visible to the loser.
      const lockedAssets = await tx.$queryRaw<CleanupCandidate[]>(Prisma.sql`
        SELECT asset."id", asset."floorId", asset."objectKey", asset."cleanupStartedAt"
        FROM "FloorAsset" AS asset
        JOIN "Floor" AS floor ON floor."id" = asset."floorId"
        WHERE asset."id" = ${assetId}
          AND asset."status" = 'ready'
          AND COALESCE(asset."readyAt", asset."createdAt") <= ${readyOrphanAt}
          AND (asset."cleanupStartedAt" IS NULL OR asset."cleanupStartedAt" <= ${retryableClaimAt})
        FOR UPDATE OF floor, asset
      `);
      const locked = lockedAssets[0];
      if (!locked) return null;

      const accessPath = `/api/floors/${encodeURIComponent(locked.floorId)}/assets/${encodeURIComponent(locked.id)}/content`;
      const referenceRows = await tx.$queryRaw<Array<{ referenced: boolean }>>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1
          FROM "FloorPlan" AS plan
          WHERE plan."floorId" = ${locked.floorId}
            AND (
              plan."imageUrl" = ${accessPath}
              OR plan."originalFileUrl" = ${accessPath}
              OR plan."renderedImageUrl" = ${accessPath}
            )
          UNION ALL
          SELECT 1
          FROM "FloorMapRevision" AS revision
          WHERE revision."floorId" = ${locked.floorId}
            AND (
              revision."snapshot" #>> '{floorPlan,imageUrl}' = ${accessPath}
              OR revision."snapshot" #>> '{floorPlan,originalFileUrl}' = ${accessPath}
              OR revision."snapshot" #>> '{floorPlan,renderedImageUrl}' = ${accessPath}
            )
        ) AS "referenced"
      `);
      if (referenceRows[0]?.referenced) {
        if (locked.cleanupStartedAt) {
          await tx.floorAsset.updateMany({
            where: { id: locked.id, status: "ready", cleanupStartedAt: locked.cleanupStartedAt },
            data: { cleanupStartedAt: null }
          });
        }
        return null;
      }

      const claimed = await tx.floorAsset.updateMany({
        where: {
          id: locked.id,
          status: "ready",
          OR: [
            { readyAt: { lte: readyOrphanAt } },
            { readyAt: null, createdAt: { lte: readyOrphanAt } }
          ],
          AND: [{
            OR: [{ cleanupStartedAt: null }, { cleanupStartedAt: { lte: retryableClaimAt } }]
          }]
        },
        data: { cleanupStartedAt: now }
      });
      return claimed.count === 1 ? locked : null;
    });
  }
}
