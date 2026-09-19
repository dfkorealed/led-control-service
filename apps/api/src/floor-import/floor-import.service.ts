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
  CAD_IMPORT_MAX_REGIONS,
  floorImportRegionListResponseSchema,
  floorImportRegionSelectInputSchema,
  floorImportApplyInputSchema,
  floorImportAppliedOverlayResponseSchema,
  floorImportCandidateListResponseSchema,
  floorImportRenderedViewportSchema,
  CAD_SCENE_MAX_PARTS_PER_TILE,
  CAD_SCENE_MAX_TILES_PER_AXIS,
  CAD_SCENE_MAX_MANIFEST_BYTES,
  cadSceneManifestSchema,
  type CadSceneManifest,
  type FloorImportApplyInput
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { type AuthenticatedUser } from "../auth/auth.types";
import { EDITOR_TRANSACTION_OPTIONS } from "../floor-editor/floor-editor.service";
import { buildFloorEditorSnapshot, buildMapDocumentSnapshot, hashFloorEditorSnapshot } from "../floor-editor/floor-editor-snapshot";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { assertActiveFloorStatus } from "../floor-editor/floor-lifecycle";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { FloorRenderedAssetReconciler } from "../storage/floor-rendered-asset-reconciler";
import { CAD_IMPORT_WORKER_OPTIONS, type FloorImportWorkerOptions } from "./floor-import.tokens";
import { CadMapPreparationService } from "./cad-map-preparation.service";
import { MapDocumentStore } from "../floor-editor/map-document-store";
import { FixedLightingDetectorRegistry } from "./lighting-detector-registry";
import { cadScenePersistenceIdentity } from "./cad-scene-persistence";
import { readExactRegionBounds } from "./floor-import-region-bounds";

const createInputSchema = z.object({
  sourceAssetId: z.string().uuid(),
  sourceFormat: z.enum(["dwg", "dxf"])
}).strict();

const activeStatuses = ["queued", "processing", "region_selection_required", "review_required"] as const;
const cancellableStatuses = ["queued", "processing", "region_selection_required", "review_required"] as const;

interface LockedApplyRow {
  status: string;
  mapRevision: number;
  editorLeaseFence: number;
  editorLeaseTokenHash: string | null;
  editorLeaseExpiresAt: Date | null;
  dbNow: Date;
  jobStatus: string;
  excludedRegionPrimitiveCount: number | null;
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

interface CadSceneDraft {
  sourceRegionRecordId: string;
  manifest: CadSceneManifest;
  manifestAsset: CadSceneAssetLedger;
  tileAssets: Map<string, CadSceneAssetLedger>;
}

interface CadSceneAssetLedger {
  id: string;
  objectKey: string;
  kind: string;
  status: string;
  mimeType: string;
  sizeBytes: bigint;
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
    @Optional() @Inject(CAD_IMPORT_WORKER_OPTIONS) private readonly workerOptions?: FloorImportWorkerOptions,
    @Optional() private readonly mapPreparation?: CadMapPreparationService,
    @Optional() private readonly mapStore?: MapDocumentStore
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

  async listRegions(user: AuthenticatedUser, floorId: string, jobId: string) {
    await this.authorizeFloor(user, floorId, "read");
    return this.readRegions(this.prisma, floorId, jobId);
  }

  private async readRegions(prisma: Pick<Prisma.TransactionClient, "floorImportJob" | "$queryRaw">, floorId: string, jobId: string) {
    const job = await prisma.floorImportJob.findFirst({
      where: { id: jobId, floorId },
      select: {
        id: true,
        excludedRegionPrimitiveCount: true,
        regions: {
          take: CAD_IMPORT_MAX_REGIONS + 1,
          orderBy: [{ regionId: "asc" }, { id: "asc" }],
          select: {
            regionId: true,
            primitiveCount: true, textCount: true, lightCandidateCount: true,
            previewWidth: true, previewHeight: true, selectedAt: true,
            previewAsset: {
              select: {
                id: true, status: true, kind: true, mimeType: true,
                contentEncoding: true, sizeBytes: true, sha256: true, cleanupStartedAt: true
              }
            }
          }
        }
      }
    });
    if (!job) throw new NotFoundException("floor import job not found");
    if (job.regions.length === 0) throw new ConflictException("floor import regions are not ready");
    if (job.regions.length > CAD_IMPORT_MAX_REGIONS) throw new ConflictException("floor import region count exceeds the limit");
    if (job.excludedRegionPrimitiveCount === null) {
      throw new ConflictException("floor import excluded primitive metadata is unavailable; re-import required");
    }

    const boundsById = await readExactRegionBounds(prisma, { jobId });
    const regions = job.regions.map(region => {
      const bounds = boundsById.get(region.regionId);
      if (!bounds) throw new ConflictException("floor import region bounds are unavailable");
      if (region.textCount == null || region.lightCandidateCount == null ||
          region.previewWidth == null || region.previewHeight == null) {
        throw new ConflictException("floor import region metadata is unavailable; re-import required");
      }
      const preview = region.previewAsset;
      if (!preview || preview.status !== "ready" || preview.kind !== "cad_region_preview" ||
          preview.mimeType !== "image/svg+xml" || preview.contentEncoding !== "gzip" || preview.cleanupStartedAt) {
        throw new ConflictException("floor import region preview is not ready");
      }
      const sizeBytes = Number(preview.sizeBytes);
      if (!Number.isSafeInteger(sizeBytes)) throw new ConflictException("floor import region preview ledger is invalid");
      return {
        regionId: region.regionId,
        bounds,
        primitiveCount: region.primitiveCount,
        textCount: region.textCount,
        lightCandidateCount: region.lightCandidateCount,
        area: (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY),
        preview: {
          assetId: preview.id,
          width: region.previewWidth,
          height: region.previewHeight,
          byteSize: sizeBytes,
          sha256: preview.sha256
        }
      };
    });
    const selected = job.regions.filter(region => region.selectedAt !== null);
    if (selected.length > 1) throw new ConflictException("floor import region selection ledger is invalid");
    const response = floorImportRegionListResponseSchema.safeParse({
      jobId,
      selectionStatus: selected.length === 0
        ? "selection_required"
        : job.regions.length === 1 ? "auto_selected" : "selected",
      selectedRegionId: selected[0]?.regionId ?? null,
      excludedRegionPrimitiveCount: job.excludedRegionPrimitiveCount,
      regions
    });
    if (!response.success) throw new ConflictException("floor import region metadata is invalid or exceeds the response budget");
    return response.data;
  }

  async selectRegion(user: AuthenticatedUser, floorId: string, jobId: string, rawInput: unknown) {
    const input = this.parse(floorImportRegionSelectInputSchema, rawInput, "invalid floor import region selection");
    const floor = await this.authorizeFloor(user, floorId, "manage");
    return this.prisma.$transaction(async tx => {
      await this.access.assertManageInTransaction(tx, user, floor.siteId);
      const jobs = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        SELECT job."status"::text AS "status"
        FROM "Floor" AS floor
        JOIN "FloorImportJob" AS job ON job."floorId" = floor."id"
        WHERE floor."id" = ${floorId} AND job."id" = ${jobId}
        FOR UPDATE OF floor, job
      `);
      if (!jobs[0]) throw new NotFoundException("floor import job not found");
      const regions = await tx.$queryRaw<Array<{
        id: string;
        regionId: string;
        selectedAt: Date | null;
        candidateIdentityDigest: string | null;
      }>>(Prisma.sql`
        SELECT "id", "regionId", "selectedAt", "candidateIdentityDigest"
        FROM "FloorImportRegion"
        WHERE "jobId" = ${jobId}
        ORDER BY "regionId", "id"
        LIMIT ${CAD_IMPORT_MAX_REGIONS + 1}
        FOR UPDATE
      `);
      if (jobs[0].status !== "region_selection_required" || regions.length < 2 || regions.length > CAD_IMPORT_MAX_REGIONS ||
          regions.some(region => region.selectedAt !== null)) {
        throw new ConflictException("floor import region can no longer be selected");
      }
      if (regions.some(region => !/^[a-f0-9]{64}$/.test(region.candidateIdentityDigest ?? ""))) {
        throw new ConflictException("CAD region candidate digest is unavailable; re-import required");
      }
      const selected = regions.find(region => region.regionId === input.regionId);
      if (!selected) throw new BadRequestException("selected region must belong to the requested import job");
      const selectedAt = new Date();
      const changedRegion = await tx.floorImportRegion.updateMany({
        where: { id: selected.id, jobId, selectedAt: null },
        data: { selectedAt }
      });
      const changedJob = await tx.floorImportJob.updateMany({
        where: { id: jobId, floorId, status: "region_selection_required" },
        data: {
          status: "queued", stage: "queued", progressPercent: 0, attemptCount: 0,
          startedAt: null, reviewRequiredAt: null,
          leaseOwner: null, leaseExpiresAt: null
        }
      });
      if (changedRegion.count !== 1 || changedJob.count !== 1) {
        throw new ConflictException("floor import region changed concurrently");
      }
      // Validate the full persisted response before committing the selection, so
      // legacy nulls or an oversized response cannot leave a failed request queued.
      return this.readRegions(tx, floorId, jobId);
    }, EDITOR_TRANSACTION_OPTIONS);
  }

  async getSceneManifestContent(user: AuthenticatedUser, floorId: string, jobId: string) {
    await this.authorizeFloor(user, floorId, "read");
    if (!this.storage) throw new InternalServerErrorException("floor import storage is unavailable");
    const draft = await this.loadCadSceneDraft(floorId, jobId);
    // byteSize/sha256 attest to the verified stored asset, not this enriched
    // HTTP representation. The raw file cannot contain its own SHA-256.
    if (Buffer.byteLength(JSON.stringify(draft.manifest), "utf8") > CAD_SCENE_MAX_MANIFEST_BYTES) {
      throw new ServiceUnavailableException("CAD scene manifest response exceeds its byte limit");
    }
    return draft.manifest;
  }

  async getSceneTileContent(
    user: AuthenticatedUser,
    floorId: string,
    jobId: string,
    rawCoordinates: unknown
  ) {
    await this.authorizeFloor(user, floorId, "read");
    if (!this.storage) throw new InternalServerErrorException("floor import storage is unavailable");
    const coordinates = this.parse(z.object({
      tileX: z.number().int().min(0).max(CAD_SCENE_MAX_TILES_PER_AXIS - 1),
      tileY: z.number().int().min(0).max(CAD_SCENE_MAX_TILES_PER_AXIS - 1),
      lod: z.number().int().min(0).max(2),
      part: z.number().int().min(0).max(CAD_SCENE_MAX_PARTS_PER_TILE - 1)
    }).strict(), rawCoordinates, "invalid CAD scene tile coordinates");
    const draft = await this.loadCadSceneDraft(floorId, jobId);
    const descriptor = draft.manifest.tiles.find(tile =>
      tile.tileX === coordinates.tileX && tile.tileY === coordinates.tileY &&
      tile.lod === coordinates.lod && tile.part === coordinates.part
    );
    if (!descriptor) throw new NotFoundException("CAD scene tile not found");
    const asset = draft.tileAssets.get(descriptor.assetId);
    if (!asset) throw new ConflictException("CAD scene tile ledger is invalid");
    try {
      await this.storage.verifyCadSceneObject(asset.objectKey, {
        sizeBytes: descriptor.byteSize,
        sha256: descriptor.sha256,
        contentType: "application/vnd.led-control.cad-tile",
        bounds: descriptor.bounds
      });
      return { url: await this.storage.createFloorAssetDownloadUrl(asset.objectKey) };
    } catch {
      throw new ServiceUnavailableException("CAD scene tile content is unavailable");
    }
  }

  async cancel(user: AuthenticatedUser, floorId: string, jobId: string) {
    const floor = await this.authorizeFloor(user, floorId, "manage");
    return this.prisma.$transaction(async tx => {
      const authorizedSite = await this.access.assertManageInTransaction(tx, user, floor.siteId);
      const now = new Date();
      await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id" = ${floorId} FOR UPDATE`;
      const changed = await tx.floorImportJob.updateMany({
        where: { id: jobId, floorId, status: { in: [...cancellableStatuses] } },
        data: {
          status: "cancelled", stage: "cancelled", leaseOwner: null, leaseExpiresAt: null,
          failureCode: null, failureMessage: null, cancelledAt: now, preparedMapGenerationId: null
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
    if (this.mapPreparation && this.mapStore) {
      const job = await this.prisma.floorImportJob.findFirst({ where: { id: jobId, floorId }, select: { preparedMapGenerationId: true } });
      if (job?.preparedMapGenerationId) {
        const input = this.parse(floorImportApplyInputSchema, rawInput, "invalid floor import apply request");
        return this.applyPreparedMap(user, floor.siteId, floorId, jobId, input);
      }
      if (await this.prisma.floorMapDocument.findUnique({ where: { floorId } })) {
        throw new ConflictException("common map import preparation required");
      }
    }
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
    const selectedRegion = await this.prisma.floorImportRegion.findFirst({
      where: { jobId, job: { floorId }, selectedAt: { not: null } }, select: { id: true }
    });
    const cadDraft = selectedRegion ? await this.loadCadSceneDraft(floorId, jobId) : null;
    const input = this.parse(floorImportApplyInputSchema, rawInput, "invalid floor import apply request");
    try {
      return await this.prisma.$transaction(async tx => {
        const authorizedSite = await this.access.assertManageInTransaction(tx, user, floor.siteId);
        const locked = await this.lockApplyState(tx, floorId, jobId);
        if (!locked) throw new NotFoundException("floor import job not found");
        assertActiveFloorStatus(locked.status);
        if (locked.excludedRegionPrimitiveCount === null) {
          throw new ConflictException("CAD region exclusion metadata is unavailable; re-import required");
        }
        this.assertEditorAuthority(locked, input);
        if (this.mapStore && await tx.floorMapDocument.findUnique({ where: { floorId } })) {
          throw new ConflictException("common map import preparation required");
        }
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

        if (cadDraft) await this.assertCadSceneDraftLocked(tx, floorId, jobId, cadDraft);

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
          imageUrl: cadDraft ? "" : renderedPath,
          sourceType: cadDraft ? "cad" as const : "image" as const,
          originalFileUrl: sourcePath,
          renderedImageUrl: cadDraft ? null : renderedPath,
          width: cadDraft?.manifest.width ?? viewport.width,
          height: cadDraft?.manifest.height ?? viewport.height,
          gridSize: cadDraft?.manifest.gridSize ?? existingPlan?.gridSize ?? 10
        };
        await tx.floorPlan.upsert({
          where: { floorId },
          create: { floorId, ...plan },
          update: { ...plan, version: { increment: 1 } }
        });
        await tx.floorCadScene.deleteMany({ where: { floorId } });
        if (cadDraft) {
          const manifest = cadDraft.manifest;
          // Scene version describes the manifest format. Replacement identity is
          // the new scene ID plus floor mapRevision, not an incremented format.
          // Prisma numeric parameters can lose one ULP for CAD coordinates. Insert
          // round-trip decimal strings directly as float8 so the initial row meets
          // the exact selected-region constraint; no repair update is permissible.
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "FloorCadScene" (
              "id", "floorId", "sourceImportJobId", "sourceRegionId", "version", "status",
              "width", "height", "tileSize", "primitiveCount", "tileCount", "manifestAssetId",
              "sourceMinX", "sourceMinY", "sourceMaxX", "sourceMaxY",
              "transformScaleX", "transformScaleY", "transformTranslateX", "transformTranslateY",
              "createdAt", "updatedAt"
            ) VALUES (
              ${manifest.sceneId}, ${floorId}, ${jobId}, ${cadDraft.sourceRegionRecordId},
              ${manifest.version}, 'active',
              ${manifest.width}, ${manifest.height}, ${manifest.tileSize},
              ${manifest.primitiveCount}, ${manifest.tileCount}, ${manifest.manifestAssetId},
              ${String(manifest.sourceBounds.minX)}::double precision,
              ${String(manifest.sourceBounds.minY)}::double precision,
              ${String(manifest.sourceBounds.maxX)}::double precision,
              ${String(manifest.sourceBounds.maxY)}::double precision,
              ${String(manifest.transform.scaleX)}::double precision,
              ${String(manifest.transform.scaleY)}::double precision,
              ${String(manifest.transform.translateX)}::double precision,
              ${String(manifest.transform.translateY)}::double precision,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
          `);
          for (let offset = 0; offset < manifest.tiles.length; offset += 250) {
            await tx.floorCadTile.createMany({
              data: manifest.tiles.slice(offset, offset + 250).map(tile => ({
                  sceneId: manifest.sceneId,
                  tileX: tile.tileX,
                  tileY: tile.tileY,
                  lod: tile.lod,
                  part: tile.part,
                  assetId: tile.assetId,
                  primitiveCount: tile.primitiveCount,
                  byteSize: BigInt(tile.byteSize),
                  minX: tile.bounds.minX,
                  minY: tile.bounds.minY,
                  maxX: tile.bounds.maxX,
                  maxY: tile.bounds.maxY
              }))
            });
          }
        }
        await tx.floor.update({ where: { id: floorId }, data: { mapRevision: { increment: 1 } } });

        const snapshotFloor = await tx.floor.findUnique({
          where: { id: floorId },
          include: {
            floorPlan: true,
            cadScene: { select: { id: true, width: true, height: true } },
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
            snapshotSha256: hashFloorEditorSnapshot(snapshot),
            changeSummary
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
          deletedSlotCount: deletedSlots.count,
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

  private async loadCadSceneDraft(floorId: string, jobId: string): Promise<CadSceneDraft> {
    if (!this.storage) throw new InternalServerErrorException("floor import storage is unavailable");
    const job = await this.prisma.floorImportJob.findFirst({
      where: { id: jobId, floorId },
      select: {
        id: true,
        regions: {
          where: { selectedAt: { not: null } },
          take: 2,
          select: { id: true, regionId: true, minX: true, minY: true, maxX: true, maxY: true }
        }
      }
    });
    if (!job) throw new NotFoundException("floor import job not found");
    if (job.regions.length !== 1) throw new ConflictException("CAD scene region selection is invalid");
    const region = job.regions[0];
    const identity = cadScenePersistenceIdentity(jobId, region.regionId);
    const manifestAsset = await this.prisma.floorAsset.findFirst({
      where: { id: identity.manifestAssetId, floorId },
      select: cadSceneAssetSelect
    });
    if (!manifestAsset || !validCadAsset(manifestAsset, "cad_manifest", "application/json")) {
      throw new ConflictException("CAD scene manifest is not ready");
    }
    const manifestSize = Number(manifestAsset.sizeBytes);
    if (!Number.isSafeInteger(manifestSize)) throw new ConflictException("CAD scene manifest ledger is invalid");
    let manifest: CadSceneManifest;
    try {
      manifest = cadSceneManifestSchema.parse(await this.storage.readCadSceneManifest(manifestAsset.objectKey, {
        sizeBytes: manifestSize, sha256: manifestAsset.sha256
      }));
    } catch {
      throw new ServiceUnavailableException("CAD scene manifest content is unavailable");
    }
    const expectedBounds = (await readExactRegionBounds(this.prisma, { jobId, regionId: region.regionId })).get(region.regionId);
    if (manifest.sceneId !== identity.sceneId || manifest.manifestAssetId !== identity.manifestAssetId ||
        manifest.regionId !== region.regionId || JSON.stringify(manifest.sourceBounds) !== JSON.stringify(expectedBounds) ||
        manifest.tiles.some(tile => tile.assetId !== identity.tileAssetId(tile))) {
      throw new ConflictException("CAD scene manifest identity is invalid");
    }
    const tileRows = await this.prisma.floorAsset.findMany({
      where: { id: { in: manifest.tiles.map(tile => tile.assetId) }, floorId },
      select: cadSceneAssetSelect
    });
    const tileAssets = new Map(tileRows.map(asset => [asset.id, asset]));
    for (const tile of manifest.tiles) {
      const asset = tileAssets.get(tile.assetId);
      if (!asset || !validCadAsset(asset, "cad_tile", "application/vnd.led-control.cad-tile") ||
          asset.sizeBytes !== BigInt(tile.byteSize) || asset.sha256 !== tile.sha256 ||
          asset.objectKey !== identity.tileObjectKey(floorId, tile)) {
        throw new ConflictException("CAD scene tile ledger is invalid");
      }
    }
    return { sourceRegionRecordId: region.id, manifest, manifestAsset, tileAssets };
  }

  private async assertCadSceneDraftLocked(
    tx: Prisma.TransactionClient,
    floorId: string,
    jobId: string,
    draft: CadSceneDraft
  ) {
    const assetIds = [draft.manifest.manifestAssetId, ...draft.manifest.tiles.map(tile => tile.assetId)];
    const locked = await tx.$queryRaw<Array<{ id: string; status: string; cleanupStartedAt: Date | null }>>(Prisma.sql`
      SELECT asset."id", asset."status"::text AS "status", asset."cleanupStartedAt"
      FROM "FloorAsset" AS asset
      JOIN "Floor" AS floor ON floor."id" = asset."floorId"
      JOIN "FloorImportJob" AS job ON job."floorId" = floor."id"
      JOIN "FloorImportRegion" AS region ON region."jobId" = job."id"
      WHERE floor."id" = ${floorId} AND job."id" = ${jobId}
        AND region."id" = ${draft.sourceRegionRecordId} AND region."selectedAt" IS NOT NULL
        AND asset."id" IN (${Prisma.join(assetIds)})
      ORDER BY asset."id"
      FOR UPDATE OF asset, region
    `);
    if (locked.length !== assetIds.length || locked.some(asset => asset.status !== "ready" || asset.cleanupStartedAt)) {
      throw new ConflictException("CAD scene assets changed concurrently");
    }
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

  private async applyPreparedMap(user: AuthenticatedUser, siteId: string, floorId: string, jobId: string, input: FloorImportApplyInput) {
    const ref = await this.mapPreparation!.readPrepared(floorId, jobId);
    if (ref.revision !== input.expectedRevision + 1) throw new ConflictException("prepared map revision conflict");
    // Verify bounded immutable metadata outside the publication transaction. The
    // revision pin below locks/revalidates all ready assets before job-pin release.
    await this.mapStore!.readManifest(floorId, ref);
    await this.mapPreparation!.readDisplayManifest(floorId, ref);
    return this.prisma.$transaction(async tx => {
      const site = await this.access.assertManageInTransaction(tx, user, siteId);
      await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id" = ${floorId} FOR UPDATE`;
      const floor = await tx.floor.findUniqueOrThrow({ where: { id: floorId } });
      assertActiveFloorStatus(floor.status);
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
      if (floor.siteId !== siteId || floor.mapRevision !== input.expectedRevision || floor.editorLeaseHolderId !== user.id ||
        floor.editorLeaseFence !== input.leaseFence || floor.editorLeaseTokenHash !== hashEditorLeaseToken(input.leaseToken) ||
        !floor.editorLeaseExpiresAt || floor.editorLeaseExpiresAt <= now) throw new ConflictException("floor editor authority changed");
      await tx.$queryRaw`SELECT "id" FROM "FloorImportJob" WHERE "id" = ${jobId} AND "floorId" = ${floorId} FOR UPDATE`;
      const job = await tx.floorImportJob.findFirst({ where: { id: jobId, floorId }, include: { preparedMapGeneration: true } });
      const generation = job?.preparedMapGeneration;
      // A review job is a durable preparation pin. Its valid prepared generation
      // must NOT be rejected merely because the unpinned one-hour TTL elapsed.
      if (!job || job.status !== "review_required" || job.preparedMapGenerationId !== ref.generationId ||
        !generation || generation.status !== "prepared" || generation.baseRevision !== ref.revision ||
        generation.sourceGenerationId !== null || generation.sourceRevision !== null || job.excludedRegionPrimitiveCount === null) {
        throw new ConflictException("prepared import changed; reload the review");
      }
      const old = await tx.floorMapDocument.findUnique({ where: { floorId } });
      if (old && old.revision !== input.expectedRevision) throw new ConflictException("common map revision conflict");
      const candidates = await tx.floorImportCandidate.findMany({ where: { jobId }, select: { id: true, x: true, y: true } });
      const accepted = new Set(input.candidateIds);
      if (input.candidateIds.some(id => !candidates.some(c => c.id === id))) throw new BadRequestException("candidate belongs to another job");
      if (candidates.some(c => accepted.has(c.id) && (c.x < 0 || c.y < 0 || c.x > ref.width || c.y > ref.height))) {
        throw new BadRequestException("candidate exceeds floor bounds");
      }
      await tx.floorImportJob.update({ where: { id: jobId }, data: { status: "applying", stage: "applying" } });
      await tx.floorImportCandidate.updateMany({ where: { jobId }, data: { reviewStatus: "rejected", reviewedAt: now } });
      await tx.floorImportCandidate.updateMany({ where: { jobId, id: { in: input.candidateIds } }, data: { reviewStatus: "accepted", reviewedAt: now } });
      const deletedObjects = await tx.floorMapObject.deleteMany({ where: { floorId } });
      const unplacedFixtures = await tx.fixture.updateMany({ where: { floorId }, data: { placementStatus: "unplaced", positionVerifiedAt: null, x: 0, y: 0 } });
      const deletedSlots = await tx.floorLightSlot.deleteMany({ where: { floorId } });
      // Copy DB float8 coordinates directly, avoiding Prisma JSON's one-ULP loss.
      if (input.candidateIds.length) await tx.$executeRaw(Prisma.sql`
        INSERT INTO "FloorLightSlot" ("id", "floorId", "sourceImportJobId", "sourceCandidateId", "x", "y", "rotation", "updatedAt")
        SELECT gen_random_uuid()::text, ${floorId}, ${jobId}, "id", "x", "y", "rotation", CURRENT_TIMESTAMP
        FROM "FloorImportCandidate" WHERE "jobId" = ${jobId} AND "id" IN (${Prisma.join(input.candidateIds)})`);
      const plan = { imageUrl: "", sourceType: "none" as const, originalFileUrl: null, renderedImageUrl: null,
        width: ref.width, height: ref.height, gridSize: ref.gridSize };
      await tx.floorPlan.upsert({ where: { floorId }, create: { floorId, ...plan }, update: { ...plan, version: { increment: 1 } } });
      await tx.floorCadScene.deleteMany({ where: { floorId } });
      const snapshotFloor = await tx.floor.findUniqueOrThrow({ where: { id: floorId }, include: {
        floorPlan: true, fixtures: { orderBy: { id: "asc" } }, mapObjects: true, lightSlots: { orderBy: { id: "asc" } } } });
      const legacy = buildFloorEditorSnapshot(snapshotFloor);
      const snapshot = buildMapDocumentSnapshot({ document: ref, fixtures: legacy.fixtures, lightSlots: "lightSlots" in legacy ? legacy.lightSlots ?? [] : [] });
      const changeSummary = { floorImportJobId: jobId, acceptedCandidates: accepted.size, deletedObjectCount: deletedObjects.count,
        unplacedFixtureCount: unplacedFixtures.count, deletedSlotCount: deletedSlots.count, createdSlotCount: accepted.size };
      const revision = await tx.floorMapRevision.create({ data: { floorId, revision: ref.revision, snapshot: snapshot as Prisma.InputJsonValue,
        snapshotSha256: hashFloorEditorSnapshot(snapshot), changedBy: user.id, changeSummary } });
      await this.mapStore!.pinRevision(tx, floorId, revision.id, ref);
      if (old) await tx.floorMapGeneration.update({ where: { id: old.activeGenerationId }, data: { status: "retired" } });
      await tx.floorMapGeneration.update({ where: { id: ref.generationId }, data: { status: "active" } });
      if (old) {
        const updated = await tx.floorMapDocument.updateMany({ where: { floorId, activeGenerationId: old.activeGenerationId, revision: input.expectedRevision },
          data: { activeGenerationId: ref.generationId, revision: ref.revision, changesSinceCheckpoint: 0, deltaDecodedBytes: 0 } });
        if (updated.count !== 1) throw new ConflictException("common map revision conflict");
      } else await tx.floorMapDocument.create({ data: { floorId, activeGenerationId: ref.generationId, revision: ref.revision } });
      await tx.floor.update({ where: { id: floorId }, data: { mapRevision: ref.revision } });
      await this.audit.record({ organizationId: site.organizationId, siteId, actorId: user.id, action: "floor_import.applied",
        targetType: "floor_import_job", targetId: jobId, outcome: "success", metadata: { ...changeSummary, generationId: ref.generationId }, transaction: tx });
      await tx.floorImportJob.update({ where: { id: jobId }, data: { status: "completed", stage: "completed", appliedAt: now,
        completedAt: now, progressPercent: 100, preparedMapGenerationId: null } });
      return { jobId, status: "completed" as const, revision: ref.revision, acceptedCandidateIds: [...accepted].sort(),
        renderedAssetId: job.renderedAssetId, ...changeSummary, floorPlan: plan, mapDocument: ref };
    }, { ...EDITOR_TRANSACTION_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  private async lockApplyState(tx: Prisma.TransactionClient, floorId: string, jobId: string) {
    const rows = await tx.$queryRaw<LockedApplyRow[]>(Prisma.sql`
      SELECT floor."status"::text AS "status", floor."mapRevision", floor."editorLeaseFence",
        floor."editorLeaseTokenHash", floor."editorLeaseExpiresAt", clock_timestamp() AS "dbNow",
        job."status"::text AS "jobStatus", job."excludedRegionPrimitiveCount",
        job."sourceAssetId", job."renderedAssetId",
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

const cadSceneAssetSelect = {
  id: true,
  objectKey: true,
  kind: true,
  status: true,
  mimeType: true,
  sizeBytes: true,
  sha256: true,
  cleanupStartedAt: true
} satisfies Prisma.FloorAssetSelect;

function validCadAsset(
  asset: CadSceneAssetLedger,
  kind: "cad_manifest" | "cad_tile",
  mimeType: string
) {
  return asset.kind === kind && asset.status === "ready" && asset.mimeType === mimeType &&
    asset.cleanupStartedAt === null;
}

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
