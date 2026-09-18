import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  ServiceUnavailableException
} from "@nestjs/common";
import {
  cadImportFileTypeSchema,
  CAD_IMPORT_MAX_CANDIDATES,
  floorImportApplyInputSchema,
  floorImportAppliedOverlayResponseSchema,
  floorImportCandidateListResponseSchema,
  floorImportRenderedViewportSchema,
  type FloorImportApplyInput
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { type AuthenticatedUser } from "../auth/auth.types";
import { EDITOR_TRANSACTION_OPTIONS } from "../floor-editor/floor-editor.service";
import { buildFloorEditorSnapshot, hashFloorEditorSnapshot } from "../floor-editor/floor-editor-snapshot";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { assertActiveFloorStatus } from "../floor-editor/floor-lifecycle";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { FloorRenderedAssetReconciler } from "../storage/floor-rendered-asset-reconciler";
import { CAD_IMPORT_WORKER_OPTIONS, type FloorImportWorkerOptions } from "./floor-import.tokens";
import { FixedLightingDetectorRegistry } from "./lighting-detector-registry";

const createInputSchema = z.object({
  sourceAssetId: z.string().uuid(),
  sourceFormat: z.enum(["dwg", "dxf"])
}).strict();

const activeStatuses = ["queued", "processing", "review_required"] as const;
const cancellableStatuses = ["queued", "processing", "review_required"] as const;

interface LockedApplyRow {
  status: string;
  mapRevision: number;
  editorLeaseFence: number;
  editorLeaseTokenHash: string | null;
  editorLeaseExpiresAt: Date | null;
  dbNow: Date;
  jobStatus: string;
  sourceAssetId: string;
  renderedAssetId: string | null;
  renderedMimeType: string | null;
  renderedContentEncoding: string | null;
  renderedObjectKey: string | null;
  renderedSizeBytes: bigint | null;
  renderedSha256: string | null;
}

interface LockedSourceAssetRow {
  id: string;
  floorId: string;
  floorStatus: string;
  kind: string;
  status: string;
  mimeType: string;
  sha256: string;
  cleanupStartedAt: Date | null;
}

@Injectable()
export class FloorImportService {
  private readonly detectorRegistry = new FixedLightingDetectorRegistry();
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SiteAccessService,
    private readonly audit: AuditService,
    private readonly storage?: ObjectStorageService,
    private readonly renderedReconciler?: FloorRenderedAssetReconciler,
    @Optional() @Inject(CAD_IMPORT_WORKER_OPTIONS) private readonly workerOptions?: FloorImportWorkerOptions
  ) {}

  async create(user: AuthenticatedUser, floorId: string, rawInput: unknown) {
    const input = this.parse(createInputSchema, rawInput, "invalid floor import request");
    if (this.workerOptions?.enabled === false) {
      throw new ServiceUnavailableException("CAD import worker is unavailable; install dwgread or configure the converter");
    }
    const floor = await this.authorizeFloor(user, floorId, "manage");
    try {
      const created = await this.prisma.$transaction(async tx => {
        const authorizedSite = await this.access.assertManageInTransaction(tx, user, floor.siteId);
        const lockedSources = await tx.$queryRaw<LockedSourceAssetRow[]>(Prisma.sql`
          SELECT asset."id", asset."floorId", floor."status"::text AS "floorStatus",
            asset."kind"::text AS "kind", asset."status"::text AS "status",
            asset."mimeType", asset."sha256", asset."cleanupStartedAt"
          FROM "Floor" AS floor
          JOIN "FloorAsset" AS asset ON asset."floorId" = floor."id"
          WHERE floor."id" = ${floorId} AND asset."id" = ${input.sourceAssetId}
          FOR UPDATE OF floor, asset
        `);
        const source = lockedSources[0];
        if (!source) throw new BadRequestException("source asset must be a ready original on the requested floor");
        assertActiveFloorStatus(source.floorStatus);
        if (source.kind !== "original" || source.status !== "ready" || source.cleanupStartedAt) {
          throw new BadRequestException("source asset must be a ready original on the requested floor");
        }
        if (!cadImportFileTypeSchema.safeParse({ sourceFormat: input.sourceFormat, mimeType: source.mimeType }).success) {
          throw new BadRequestException("source asset MIME type does not match the CAD format");
        }
        const detectorProfileId = this.detectorRegistry.resolve({ sourceSha256: source.sha256, siteId: authorizedSite.id });
        const job = await tx.floorImportJob.create({
          data: { floorId, sourceAssetId: source.id, sourceFormat: input.sourceFormat, detectorProfileId },
          select: jobSelect
        });
        await this.audit.record({
          organizationId: authorizedSite.organizationId,
          siteId: authorizedSite.id,
          actorId: user.id,
          action: "floor_import.created",
          targetType: "floor_import_job",
          targetId: job.id,
          outcome: "success",
          metadata: { floorId, sourceAssetId: source.id, sourceFormat: input.sourceFormat, detectorProfileId },
          transaction: tx
        });
        return job;
      });
      return this.publicJob(created);
    } catch (error) {
      if (isUniqueConflict(error)) throw new ConflictException("an active floor import already exists");
      throw error;
    }
  }

  async get(user: AuthenticatedUser, floorId: string, jobId: string) {
    await this.authorizeFloor(user, floorId, "read");
    const job = await this.prisma.floorImportJob.findFirst({ where: { id: jobId, floorId }, select: jobSelect });
    if (!job) throw new NotFoundException("floor import job not found");
    return this.publicJob(job);
  }

  async getActive(user: AuthenticatedUser, floorId: string) {
    const job = await this.prisma.$transaction(async tx => {
      const floor = await tx.floor.findUnique({ where: { id: floorId }, select: { id: true, siteId: true } });
      if (!floor) throw new NotFoundException("floor not found");
      await this.access.assertManageInTransaction(tx, user, floor.siteId);

      // A valid apply changes applying -> completed in one transaction, so a committed
      // applying row is abnormal. The DB clock and a threshold well beyond the 15s
      // apply timeout avoid reclaiming a transaction that is still finishing.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "FloorImportJob"
        SET "status" = 'failed', "stage" = 'failed',
          "failureCode" = 'CAD_IMPORT_STALE_APPLYING',
          "failureMessage" = 'stale applying job recovered after 2 minutes',
          "failedAt" = clock_timestamp(), "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL, "updatedAt" = clock_timestamp()
        WHERE "floorId" = ${floorId}
          AND "status" = 'applying'
          AND "updatedAt" <= clock_timestamp() - INTERVAL '2 minutes'
      `);
      return tx.floorImportJob.findFirst({
        where: { floorId, status: { in: [...activeStatuses] } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: jobSelect
      });
    }, { ...EDITOR_TRANSACTION_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return { job: job ? await this.publicJob(job) : null };
  }

  async getAppliedOverlay(user: AuthenticatedUser, floorId: string) {
    return this.prisma.$transaction(async tx => {
      const floor = await tx.floor.findUnique({
        where: { id: floorId },
        select: {
          id: true,
          siteId: true,
          mapRevision: true,
          floorPlan: {
            select: { imageUrl: true, renderedImageUrl: true, width: true, height: true }
          }
        }
      });
      if (!floor) throw new NotFoundException("floor not found");
      await this.access.assertReadInTransaction(tx, user, floor.siteId);

      const renderedAssetId = currentRenderedAssetId(floorId, floor.floorPlan);
      if (!renderedAssetId) return { overlay: null };
      const applied = await tx.floorImportJob.findFirst({
        where: {
          floorId,
          renderedAssetId,
          status: "completed",
          appliedAt: { not: null },
          completedAt: { not: null },
          renderedAsset: { is: { status: "ready", cleanupStartedAt: null } }
        },
        orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          renderedAssetId: true,
          appliedAt: true,
          candidates: {
            where: { reviewStatus: "accepted" },
            orderBy: [{ confidence: "desc" }, { id: "asc" }],
            take: CAD_IMPORT_MAX_CANDIDATES,
            select: candidateSelect
          }
        }
      });
      if (!applied?.renderedAssetId || !applied.appliedAt) return { overlay: null };

      return floorImportAppliedOverlayResponseSchema.parse({
        overlay: {
          floorId,
          jobId: applied.id,
          revision: floor.mapRevision,
          renderedAssetId: applied.renderedAssetId,
          renderedAssetPath: assetAccessPath(floorId, applied.renderedAssetId),
          renderedViewport: { width: floor.floorPlan!.width, height: floor.floorPlan!.height },
          appliedAt: applied.appliedAt.toISOString(),
          candidates: applied.candidates
        }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async listCandidates(user: AuthenticatedUser, floorId: string, jobId: string) {
    await this.authorizeFloor(user, floorId, "read");
    const job = await this.prisma.floorImportJob.findFirst({ where: { id: jobId, floorId }, select: { id: true } });
    if (!job) throw new NotFoundException("floor import job not found");
    const candidates = await this.prisma.floorImportCandidate.findMany({
      where: { jobId },
      orderBy: [{ confidence: "desc" }, { id: "asc" }],
      take: CAD_IMPORT_MAX_CANDIDATES,
      select: candidateSelect
    });
    return floorImportCandidateListResponseSchema.parse({ jobId, candidates });
  }

  async cancel(user: AuthenticatedUser, floorId: string, jobId: string) {
    const floor = await this.authorizeFloor(user, floorId, "manage");
    return this.prisma.$transaction(async tx => {
      const authorizedSite = await this.access.assertManageInTransaction(tx, user, floor.siteId);
      const now = new Date();
      const changed = await tx.floorImportJob.updateMany({
        where: { id: jobId, floorId, status: { in: [...cancellableStatuses] } },
        data: {
          status: "cancelled", stage: "cancelled", leaseOwner: null, leaseExpiresAt: null,
          failureCode: null, failureMessage: null, cancelledAt: now
        }
      });
      const job = await tx.floorImportJob.findFirst({ where: { id: jobId, floorId }, select: jobSelect });
      if (!job) throw new NotFoundException("floor import job not found");
      if (changed.count === 0 && !["completed", "failed", "cancelled"].includes(job.status)) {
        throw new ConflictException("floor import job can no longer be cancelled");
      }
      if (changed.count === 1) {
        await this.audit.record({
          organizationId: authorizedSite.organizationId, siteId: authorizedSite.id, actorId: user.id,
          action: "floor_import.cancelled", targetType: "floor_import_job", targetId: jobId,
          outcome: "success", metadata: { floorId }, transaction: tx
        });
      }
      return this.publicJob(job);
    });
  }

  async apply(user: AuthenticatedUser, floorId: string, jobId: string, rawInput: unknown) {
    const floor = await this.authorizeFloor(user, floorId, "manage");
    if (!this.storage) throw new InternalServerErrorException("floor import storage is unavailable");
    const rendered = await this.prisma.floorImportJob.findFirst({
      where: { id: jobId, floorId, status: "review_required" },
      select: {
        renderedAsset: { select: {
          id: true, objectKey: true, status: true, mimeType: true, contentEncoding: true,
          sizeBytes: true, sha256: true, cleanupStartedAt: true
        } }
      }
    });
    const renderedAsset = rendered?.renderedAsset;
    if (!renderedAsset || renderedAsset.status !== "ready" ||
        renderedAsset.mimeType !== "image/svg+xml" ||
        !isSupportedRenderedEncoding(renderedAsset.contentEncoding) ||
        renderedAsset.cleanupStartedAt) {
      throw new ConflictException("floor import job is not ready to apply");
    }
    const renderedSizeBytes = Number(renderedAsset.sizeBytes);
    if (!Number.isSafeInteger(renderedSizeBytes)) throw new ConflictException("rendered floor asset ledger is invalid");
    let viewport: { width: number; height: number };
    try {
      if (renderedAsset.contentEncoding === "unknown") {
        if (!this.renderedReconciler) throw new Error("rendered floor asset reconciler is unavailable");
        const reconciled = await this.renderedReconciler.reconcile({ ...renderedAsset });
        renderedAsset.contentEncoding = reconciled.contentEncoding;
        viewport = { width: reconciled.width, height: reconciled.height };
      } else {
        const knownEncoding = renderedAsset.contentEncoding === "gzip" ? "gzip" : null;
        viewport = await this.storage.readFloorRenderedMetadata(renderedAsset.objectKey, {
          sizeBytes: renderedSizeBytes, sha256: renderedAsset.sha256,
          mimeType: "image/svg+xml", contentEncoding: knownEncoding
        });
      }
    }
    catch { throw new ServiceUnavailableException("rendered floor asset metadata is unavailable"); }
    const input = this.parse(floorImportApplyInputSchema, rawInput, "invalid floor import apply request");
    try {
      return await this.prisma.$transaction(async tx => {
        const authorizedSite = await this.access.assertManageInTransaction(tx, user, floor.siteId);
        const locked = await this.lockApplyState(tx, floorId, jobId);
        if (!locked) throw new NotFoundException("floor import job not found");
        assertActiveFloorStatus(locked.status);
        this.assertEditorAuthority(locked, input);
        if (locked.jobStatus !== "review_required" || !locked.renderedAssetId || locked.renderedMimeType !== "image/svg+xml") {
          throw new ConflictException("floor import job is not ready to apply");
        }
        if (locked.renderedAssetId !== renderedAsset.id || locked.renderedObjectKey !== renderedAsset.objectKey ||
            locked.renderedMimeType !== renderedAsset.mimeType || locked.renderedContentEncoding !== renderedAsset.contentEncoding ||
            locked.renderedSizeBytes !== renderedAsset.sizeBytes ||
            locked.renderedSha256 !== renderedAsset.sha256) {
          throw new ConflictException("rendered floor asset changed concurrently");
        }

        const candidates = await tx.floorImportCandidate.findMany({
          where: { jobId }, select: { id: true, x: true, y: true, rotation: true }, orderBy: { id: "asc" }
        });
        const allIds = new Set(candidates.map(candidate => candidate.id));
        if (input.candidateIds.some(candidateId => !allIds.has(candidateId))) {
          throw new BadRequestException("accepted candidates must belong to the requested import job");
        }

        const applying = await tx.floorImportJob.updateMany({
          where: { id: jobId, floorId, status: "review_required" },
          data: { status: "applying", stage: "applying" }
        });
        if (applying.count !== 1) throw new ConflictException("floor import job changed concurrently");

        const accepted = new Set(input.candidateIds);
        const rejectedIds = candidates.map(candidate => candidate.id).filter(candidateId => !accepted.has(candidateId));
        if (input.candidateIds.length > 0) {
          await tx.floorImportCandidate.updateMany({
            where: { jobId, id: { in: input.candidateIds } },
            data: { reviewStatus: "accepted", reviewedAt: locked.dbNow }
          });
        }
        if (rejectedIds.length > 0) {
          await tx.floorImportCandidate.updateMany({
            where: { jobId, id: { in: rejectedIds } },
            data: { reviewStatus: "rejected", reviewedAt: locked.dbNow }
          });
        }

        const deletedObjects = await tx.floorMapObject.deleteMany({ where: { floorId } });
        const unplacedFixtures = await tx.fixture.updateMany({
          where: { floorId },
          data: { placementStatus: "unplaced", positionVerifiedAt: null, x: 0, y: 0 }
        });
        const deletedSlots = await tx.floorLightSlot.deleteMany({ where: { floorId } });
        const acceptedCandidates = candidates.filter(candidate => accepted.has(candidate.id));
        const createdSlots = acceptedCandidates.length === 0
          ? { count: 0 }
          : await tx.floorLightSlot.createMany({
              data: acceptedCandidates.map(candidate => ({
                floorId,
                sourceImportJobId: jobId,
                sourceCandidateId: candidate.id,
                x: candidate.x,
                y: candidate.y,
                rotation: candidate.rotation
              }))
            });

        const existingPlan = await tx.floorPlan.findUnique({
          where: { floorId }, select: { width: true, height: true, gridSize: true }
        });
        const renderedPath = assetAccessPath(floorId, locked.renderedAssetId);
        const sourcePath = assetAccessPath(floorId, locked.sourceAssetId);
        const plan = {
          imageUrl: renderedPath,
          sourceType: "image" as const,
          originalFileUrl: sourcePath,
          renderedImageUrl: renderedPath,
          width: viewport.width,
          height: viewport.height,
          gridSize: existingPlan?.gridSize ?? 10
        };
        await tx.floorPlan.upsert({
          where: { floorId },
          create: { floorId, ...plan },
          update: { ...plan, version: { increment: 1 } }
        });
        await tx.floor.update({ where: { id: floorId }, data: { mapRevision: { increment: 1 } } });

        const snapshotFloor = await tx.floor.findUnique({
          where: { id: floorId },
          include: {
            floorPlan: true,
            fixtures: { orderBy: { id: "asc" } },
            mapObjects: { orderBy: { id: "asc" } },
            lightSlots: { orderBy: { id: "asc" } }
          }
        });
        if (!snapshotFloor) throw new NotFoundException("floor not found");
        const snapshot = buildFloorEditorSnapshot(snapshotFloor);
        const revision = input.expectedRevision + 1;
        const changeSummary = {
          floorImportJobId: jobId,
          floorPlanChanged: true,
          acceptedCandidates: input.candidateIds.length,
          rejectedCandidates: rejectedIds.length,
          deletedObjectCount: deletedObjects.count,
          unplacedFixtureCount: unplacedFixtures.count,
          deletedSlotCount: deletedSlots.count,
          createdSlotCount: createdSlots.count,
          fixtureUpdates: unplacedFixtures.count,
          objectCreates: 0,
          objectUpdates: 0,
          objectDeletes: deletedObjects.count
        };
        await tx.floorMapRevision.create({
          data: {
            floorId, revision, snapshot: snapshot as Prisma.InputJsonValue,
            snapshotSha256: hashFloorEditorSnapshot(snapshot),
            changeSummary: changeSummary as Prisma.InputJsonValue,
            changedBy: user.id
          }
        });
        await this.audit.record({
          organizationId: authorizedSite.organizationId, siteId: authorizedSite.id, actorId: user.id,
          action: "floor_import.applied", targetType: "floor_import_job", targetId: jobId,
          outcome: "success", metadata: {
            floorId, revision, acceptedCandidateIds: [...input.candidateIds].sort(),
            snapshotSha256: hashFloorEditorSnapshot(snapshot)
          }, transaction: tx
        });
        const completed = await tx.floorImportJob.updateMany({
          where: { id: jobId, floorId, status: "applying" },
          data: {
            status: "completed", stage: "completed", appliedAt: locked.dbNow,
            completedAt: locked.dbNow, progressPercent: 100
          }
        });
        if (completed.count !== 1) throw new ConflictException("floor import job changed concurrently");
        return {
          jobId, status: "completed" as const, revision,
          acceptedCandidateIds: [...input.candidateIds].sort(),
          renderedAssetId: locked.renderedAssetId,
          deletedObjectCount: deletedObjects.count,
          unplacedFixtureCount: unplacedFixtures.count,
          createdSlotCount: createdSlots.count,
          floorPlan: plan
        };
      }, EDITOR_TRANSACTION_OPTIONS);
    } catch (error) {
      if (isPrismaCode(error, "P2034")) throw new ConflictException("floor import apply conflicted, please retry");
      if (isPrismaCode(error, "P2028")) {
        throw new ServiceUnavailableException({ code: "floor_import_apply_timeout", message: "floor import apply timed out; reload before retrying" });
      }
      throw error;
    }
  }

  private async authorizeFloor(user: AuthenticatedUser, floorId: string, capability: "read" | "manage") {
    const floor = await this.prisma.floor.findUnique({ where: { id: floorId }, select: { id: true, siteId: true } });
    if (!floor) throw new NotFoundException("floor not found");
    await this.access.assert(user, floor.siteId, capability);
    return floor;
  }

  private async publicJob(job: Prisma.FloorImportJobGetPayload<{ select: typeof jobSelect }>) {
    let renderedViewport: { width: number; height: number } | null = null;
    if (["review_required", "applying", "completed"].includes(job.status)) {
      if (!this.storage) throw new InternalServerErrorException("floor import storage is unavailable");
      const rendered = job.renderedAsset;
      if (!rendered || rendered.status !== "ready" || rendered.mimeType !== "image/svg+xml" ||
          !isSupportedRenderedEncoding(rendered.contentEncoding) || rendered.cleanupStartedAt) {
        throw new ConflictException("rendered floor asset is not ready for review");
      }
      const sizeBytes = Number(rendered.sizeBytes);
      if (!Number.isSafeInteger(sizeBytes)) throw new ConflictException("rendered floor asset ledger is invalid");
      try {
        if (rendered.contentEncoding === "unknown") {
          if (!this.renderedReconciler) throw new Error("rendered floor asset reconciler is unavailable");
          const reconciled = await this.renderedReconciler.reconcile({ ...rendered });
          rendered.contentEncoding = reconciled.contentEncoding;
          renderedViewport = floorImportRenderedViewportSchema.parse({
            width: reconciled.width, height: reconciled.height
          });
        } else {
          const knownEncoding = rendered.contentEncoding === "gzip" ? "gzip" : null;
          renderedViewport = floorImportRenderedViewportSchema.parse(
            await this.storage.readFloorRenderedMetadata(rendered.objectKey, {
              sizeBytes,
              sha256: rendered.sha256,
              mimeType: "image/svg+xml",
              contentEncoding: knownEncoding
            })
          );
        }
      } catch {
        throw new ServiceUnavailableException("rendered floor asset metadata is unavailable");
      }
    }
    return publicJob(job, renderedViewport);
  }

  private parse<T>(schema: { parse(value: unknown): T }, value: unknown, message: string): T {
    try { return schema.parse(value); }
    catch { throw new BadRequestException(message); }
  }

  private async lockApplyState(tx: Prisma.TransactionClient, floorId: string, jobId: string) {
    const rows = await tx.$queryRaw<LockedApplyRow[]>(Prisma.sql`
      SELECT floor."status"::text AS "status", floor."mapRevision", floor."editorLeaseFence",
        floor."editorLeaseTokenHash", floor."editorLeaseExpiresAt", clock_timestamp() AS "dbNow",
        job."status"::text AS "jobStatus", job."sourceAssetId", job."renderedAssetId",
        rendered."mimeType" AS "renderedMimeType",
        rendered."contentEncoding" AS "renderedContentEncoding",
        rendered."objectKey" AS "renderedObjectKey", rendered."sizeBytes" AS "renderedSizeBytes",
        rendered."sha256" AS "renderedSha256"
      FROM "Floor" AS floor
      JOIN "FloorImportJob" AS job ON job."floorId" = floor."id" AND job."id" = ${jobId}
      JOIN "FloorAsset" AS source ON source."id" = job."sourceAssetId"
      JOIN "FloorAsset" AS rendered ON rendered."id" = job."renderedAssetId"
      WHERE floor."id" = ${floorId}
        AND source."status" = 'ready' AND source."cleanupStartedAt" IS NULL
        AND rendered."status" = 'ready' AND rendered."cleanupStartedAt" IS NULL
      FOR UPDATE OF floor, job, source, rendered
    `);
    return rows[0] ?? null;
  }

  private assertEditorAuthority(locked: LockedApplyRow, input: FloorImportApplyInput) {
    const leaseActive = Boolean(
      locked.editorLeaseTokenHash &&
      locked.editorLeaseFence === input.leaseFence &&
      locked.editorLeaseTokenHash === hashEditorLeaseToken(input.leaseToken) &&
      locked.editorLeaseExpiresAt &&
      locked.editorLeaseExpiresAt.getTime() > locked.dbNow.getTime()
    );
    if (!leaseActive) throw new ConflictException("floor editor lease is no longer active");
    if (locked.mapRevision !== input.expectedRevision) throw new ConflictException("floor editor revision conflict");
  }
}

const jobSelect = {
  id: true, floorId: true, sourceAssetId: true, renderedAssetId: true, sourceFormat: true,
  status: true, stage: true, progressPercent: true, attemptCount: true,
  parserVersion: true, detectorVersion: true, detectorProfileId: true,
  detectorProfileVersion: true, detectorProfileDigest: true, failureCode: true,
  startedAt: true, reviewRequiredAt: true, appliedAt: true, completedAt: true,
  failedAt: true, cancelledAt: true, createdAt: true, updatedAt: true,
  renderedAsset: { select: {
    id: true, objectKey: true, status: true, mimeType: true, contentEncoding: true,
    sizeBytes: true, sha256: true, cleanupStartedAt: true
  } }
} satisfies Prisma.FloorImportJobSelect;

const candidateSelect = {
  id: true, sourceEntityId: true, layerName: true, blockName: true, x: true, y: true,
  rotation: true, confidence: true, detectionMethod: true, provider: true, model: true,
  inputDigest: true, profileVersion: true, profileDigest: true, reviewStatus: true
} satisfies Prisma.FloorImportCandidateSelect;

function publicJob(
  job: Prisma.FloorImportJobGetPayload<{ select: typeof jobSelect }>,
  renderedViewport: { width: number; height: number } | null
) {
  return {
    jobId: job.id,
    floorId: job.floorId,
    sourceAssetId: job.sourceAssetId,
    renderedAssetId: job.renderedAssetId,
    sourceFormat: job.sourceFormat,
    status: job.status,
    stage: job.stage,
    progressPercent: job.progressPercent,
    attemptCount: job.attemptCount,
    parserVersion: job.parserVersion,
    detectorVersion: job.detectorVersion,
    detectorProfileId: job.detectorProfileId,
    detectorProfileVersion: job.detectorProfileVersion,
    detectorProfileDigest: job.detectorProfileDigest,
    failureCode: job.failureCode,
    sourceAssetPath: assetAccessPath(job.floorId, job.sourceAssetId),
    renderedAssetPath: job.renderedAssetId ? assetAccessPath(job.floorId, job.renderedAssetId) : null,
    renderedViewport,
    startedAt: iso(job.startedAt),
    reviewRequiredAt: iso(job.reviewRequiredAt),
    appliedAt: iso(job.appliedAt),
    completedAt: iso(job.completedAt),
    failedAt: iso(job.failedAt),
    cancelledAt: iso(job.cancelledAt),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString()
  };
}

function iso(value: Date | null) { return value?.toISOString() ?? null; }

export function assetAccessPath(floorId: string, assetId: string) {
  return `/api/floors/${encodeURIComponent(floorId)}/assets/${encodeURIComponent(assetId)}/content`;
}

function isPrismaCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function isUniqueConflict(error: unknown) {
  return isPrismaCode(error, "P2002");
}

function isSupportedRenderedEncoding(value: string | null): value is "gzip" | "unknown" | null {
  return value === null || value === "gzip" || value === "unknown";
}

function currentRenderedAssetId(
  floorId: string,
  floorPlan: { imageUrl: string; renderedImageUrl: string | null } | null
) {
  const path = floorPlan?.renderedImageUrl;
  if (!path || floorPlan.imageUrl !== path) return null;
  try {
    const url = new URL(path, "https://floor-assets.invalid");
    if (url.origin !== "https://floor-assets.invalid" || url.search || url.hash) return null;
    const segments = url.pathname.split("/");
    if (segments.length !== 7 || segments[1] !== "api" || segments[2] !== "floors" ||
        segments[4] !== "assets" || segments[6] !== "content") return null;
    const pathFloorId = decodeURIComponent(segments[3]);
    const assetId = decodeURIComponent(segments[5]);
    if (pathFloorId !== floorId || !z.string().uuid().safeParse(assetId).success) return null;
    return assetAccessPath(floorId, assetId) === path ? assetId : null;
  } catch {
    return null;
  }
}
