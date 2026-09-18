import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma, type FloorImportJob } from "@prisma/client";
import { cadSceneManifestSchema, type CadImportStage, type CadSceneManifest } from "@led-control/shared";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, statfs, utimes } from "node:fs/promises";
import { join } from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { type CadConverter } from "./cad-converter";
import { type CadCoreExecutor } from "./cad-core-executor";
import {
  assertCadImportTempBudget,
  CAD_IMPORT_MAX_DXF_BYTES,
  CAD_IMPORT_MAX_SOURCE_BYTES
} from "./cad-resource-limits";
import type { LightingDetectorRegistry } from "./lighting-detector-registry";
import {
  FloorImportAttemptCleanupService,
  type FloorImportAttemptIdentity
} from "./floor-import-attempt-cleanup.service";
import {
  CAD_IMPORT_CONVERTER, CAD_IMPORT_CORE_EXECUTOR, CAD_IMPORT_RULE_DETECTOR, CAD_IMPORT_WORKER_OPTIONS,
  type FloorImportWorkerOptions
} from "./floor-import.tokens";
import { cadRegionPreviewPersistenceIdentity, cadScenePersistenceIdentity } from "./cad-scene-persistence";
import {
  candidateRegionDigestsEqual,
  computeCandidateRegionDigests,
  type CadCandidateRegionDigestMap
} from "./cad-candidate-region-digest";

export {
  CAD_IMPORT_CONVERTER, CAD_IMPORT_CORE_EXECUTOR, CAD_IMPORT_RULE_DETECTOR, CAD_IMPORT_WORKER_OPTIONS,
  type FloorImportWorkerOptions
} from "./floor-import.tokens";

const MAX_ATTEMPTS = 3;
const PARSER_VERSION = "ascii-dxf-stream-v2";
const CANDIDATE_WRITE_CHUNK = 250;
export const CAD_IMPORT_MAX_CONCURRENT_JOBS = 1;

@Injectable()
export class FloorImportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly owner = randomUUID();
  private readonly logger = new Logger(FloorImportWorkerService.name);
  private readonly options: FloorImportWorkerOptions;
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private activeRun: Promise<boolean> | null = null;
  private activeAbort: AbortController | null = null;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    @Inject(CAD_IMPORT_CONVERTER) private readonly converter: CadConverter,
    @Inject(CAD_IMPORT_RULE_DETECTOR) private readonly ruleRegistry: LightingDetectorRegistry,
    @Inject(CAD_IMPORT_CORE_EXECUTOR) private readonly core: CadCoreExecutor,
    @Optional() @Inject(CAD_IMPORT_WORKER_OPTIONS) options?: FloorImportWorkerOptions,
    @Optional() private readonly attemptCleanup?: FloorImportAttemptCleanupService
  ) {
    this.options = options ?? { tempRoot: "/tmp", pollIntervalMs: 1000, enabled: true };
  }

  onModuleInit() {
    if (this.timer || this.options.enabled === false || process.env.NODE_ENV === "test") return;
    this.stopping = false;
    this.timer = setInterval(() => void this.runOnce().catch(() => this.logger.warn("CAD import worker poll failed")), this.options.pollIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = undefined;
    this.heartbeat = undefined;
    this.activeAbort?.abort();
    await this.activeRun?.catch(() => undefined);
  }

  async claimNext(): Promise<FloorImportJob | null> {
    if (this.stopping) return null;
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "FloorImportJob" SET "status" = 'failed', "stage" = 'failed',
        "failureCode" = 'CAD_IMPORT_ATTEMPTS_EXHAUSTED',
        "failureMessage" = 'CAD import attempts were exhausted after lease expiry',
        "failedAt" = (clock_timestamp() AT TIME ZONE 'UTC'),
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
        "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" IN (
        SELECT "id" FROM "FloorImportJob"
        WHERE "status" = 'processing' AND "attemptCount" >= ${MAX_ATTEMPTS}
          AND "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
        ORDER BY "createdAt", "id" LIMIT 20 FOR UPDATE SKIP LOCKED
      )
    `);
    if (this.stopping) return null;
    const candidates = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "FloorImportJob"
      WHERE "attemptCount" < ${MAX_ATTEMPTS}
        AND ("status" = 'queued' OR (
          "status" = 'processing' AND "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
        ))
      ORDER BY "createdAt", "id" LIMIT 20
    `);
    for (const candidate of candidates) {
      if (this.stopping) return null;
      const rows = await this.prisma.$queryRaw<FloorImportJob[]>(Prisma.sql`
        WITH candidate AS (
          SELECT "id" FROM "FloorImportJob"
          WHERE "id" = ${candidate.id} AND "attemptCount" < ${MAX_ATTEMPTS}
            AND ("status" = 'queued' OR (
              "status" = 'processing' AND "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
            ))
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "FloorImportJob" AS job SET "status" = 'processing', "stage" = 'downloading',
          "progressPercent" = GREATEST("progressPercent", 1), "attemptCount" = "attemptCount" + 1,
          "leaseOwner" = ${this.owner},
          "leaseExpiresAt" = (statement_timestamp() AT TIME ZONE 'UTC') + interval '30 seconds',
          "startedAt" = COALESCE("startedAt", (statement_timestamp() AT TIME ZONE 'UTC')),
          "failureCode" = NULL, "failureMessage" = NULL, "failedAt" = NULL,
          "updatedAt" = (statement_timestamp() AT TIME ZONE 'UTC')
        FROM candidate WHERE job."id" = candidate."id" RETURNING job.*
      `);
      if (rows[0]) return rows[0];
    }
    return null;
  }

  async runOnce(): Promise<boolean> {
    // One retained CAD model per process is the production memory/concurrency contract.
    if (this.activeRun || this.stopping) return false;
    const run = this.executeOnce();
    this.activeRun = run;
    try { return await run; }
    finally { if (this.activeRun === run) this.activeRun = null; }
  }

  private async executeOnce() {
    const job = await this.claimNext();
    if (!job || this.stopping) return false;
    await this.process(job);
    return true;
  }

  private async process(job: FloorImportJob) {
    const abort = new AbortController();
    this.activeAbort = abort;
    let tempDirectory: string | undefined;
    let attempt: FloorImportAttemptIdentity | undefined;
    let phase: ImportPhase = "download";
    let leaseLost = false;
    let renewing = false;
    const pulse = async (progress: number, stage: CadImportStage) => {
      if (tempDirectory) await utimes(tempDirectory, new Date(), new Date()).catch(() => undefined);
      if (this.stopping || leaseLost || !(await this.renew(job, progress, stage))) {
        leaseLost = true;
        abort.abort();
        throw new Error("CAD_IMPORT_LEASE_LOST");
      }
    };
    this.heartbeat = setInterval(() => {
      if (renewing || leaseLost || this.stopping) return;
      renewing = true;
      if (tempDirectory) void utimes(tempDirectory, new Date(), new Date()).catch(() => undefined);
      void this.renew(job).then(renewed => {
        if (!renewed) { leaseLost = true; abort.abort(); }
      }).catch(() => { leaseLost = true; abort.abort(); }).finally(() => { renewing = false; });
    }, 10_000);
    this.heartbeat.unref();

    try {
      tempDirectory = await mkdtemp(join(this.options.tempRoot, `floor-import-${job.id}-attempt-${job.attemptCount}-`));
      const inputPath = join(tempDirectory, `source.${job.sourceFormat}`);
      const dxfPath = join(tempDirectory, "converted.dxf");
      const renderedPath = join(tempDirectory, "rendered.svg");
      const source = await this.prisma.floorAsset.findUniqueOrThrow({
        where: { id: job.sourceAssetId },
        select: { objectKey: true, sizeBytes: true, sha256: true, mimeType: true, floor: { select: { siteId: true } } }
      });
      const resolvedProfileId = this.ruleRegistry.resolve({ sourceSha256: source.sha256, siteId: source.floor.siteId });
      if (job.detectorProfileId === null) {
        const changed = await this.prisma.$executeRaw(Prisma.sql`
          UPDATE "FloorImportJob" SET "detectorProfileId" = ${resolvedProfileId},
            "updatedAt" = (statement_timestamp() AT TIME ZONE 'UTC')
          WHERE ${this.fence(job)} AND "detectorProfileId" IS NULL
        `);
        if (changed !== 1) throw new Error("CAD_IMPORT_PROFILE_RESOLUTION_LOST");
        job.detectorProfileId = resolvedProfileId;
      } else {
        this.ruleRegistry.assertBinding({
          profileId: job.detectorProfileId, sourceSha256: source.sha256, siteId: source.floor.siteId
        });
      }
      const profileId = resolvedProfileId;
      await this.storage.downloadFloorAssetToFile(source.objectKey, inputPath, {
        maxBytes: CAD_IMPORT_MAX_SOURCE_BYTES,
        expectedBytes: Number(source.sizeBytes),
        expectedMimeType: source.mimeType,
        expectedSha256: source.sha256,
        abortSignal: abort.signal
      });
      await pulse(15, "converting");

      phase = "convert";
      await this.converter.convert({ inputPath, outputPath: dxfPath, abortSignal: abort.signal });
      const converted = await stat(dxfPath);
      if (!converted.isFile() || converted.size < 1 || converted.size > CAD_IMPORT_MAX_DXF_BYTES) {
        throw new Error("CAD converted DXF size limit exceeded");
      }
      await pulse(35, "parsing");

      phase = "render";
      // The production temp root is dedicated to this single-concurrency worker,
      // so this preflight exclusively reserves the raw, gzip, and filesystem budget.
      assertCadImportTempBudget(
        await statfs(tempDirectory, { bigint: true }),
        Number(source.sizeBytes) + converted.size
      );
      phase = "parse";
      const persistedRegions = await this.prisma.floorImportRegion.findMany({
        where: { jobId: job.id },
        orderBy: [{ regionId: "asc" }, { id: "asc" }],
        select: { regionId: true, candidateIdentityDigest: true, selectedAt: true }
      });
      const selectedRegions = persistedRegions.filter(region => region.selectedAt !== null);
      if (selectedRegions.length > 1) throw new Error("CAD import has multiple selected regions");
      const selectedRegion = selectedRegions[0];
      let expectedCandidateRegionDigests: CadCandidateRegionDigestMap | undefined;
      if (selectedRegion) {
        if (persistedRegions.some(region => region.candidateIdentityDigest === null)) {
          throw new Error("CAD_IMPORT_REGION_DIGEST_MISSING_REIMPORT_REQUIRED");
        }
        expectedCandidateRegionDigests = Object.fromEntries(
          persistedRegions.map(region => [region.regionId, region.candidateIdentityDigest!])
        );
      }
      const core = await this.core.execute({
        dxfPath,
        renderedPath,
        artifactDirectory: tempDirectory,
        jobId: job.id,
        selectedRegionId: selectedRegion?.regionId ?? null,
        ...(expectedCandidateRegionDigests ? { expectedCandidateRegionDigests } : {}),
        profileId,
        abortSignal: abort.signal
      });
      const rules = this.ruleRegistry.get(profileId);
      if (core.profileId !== profileId || core.profileVersion !== rules.profileVersion ||
          core.profileDigest !== rules.profileDigest) throw new Error("CAD detector profile metadata mismatch");
      const regions = core.regions;
      if (!Array.isArray(regions) || regions.length < 1 || regions.length > 100) {
        throw new Error("CAD import region count is outside the API contract");
      }
      if (!Array.isArray(core.candidateRegionAssignments)) {
        throw new Error("CAD core candidate region assignments are unavailable");
      }
      const candidateRegionDigests = computeCandidateRegionDigests(
        regions.map(region => region.regionId),
        core.candidateRegionAssignments,
        core.candidates.map(candidate => candidate.sourceEntityId)
      );
      if (expectedCandidateRegionDigests &&
          !candidateRegionDigestsEqual(candidateRegionDigests, expectedCandidateRegionDigests)) {
        throw new Error("CAD core candidate region assignments changed after selection");
      }
      const selectedRegionId = selectedRegion?.regionId ?? (regions.length === 1 ? regions[0].regionId : null);
      if (selectedRegionId && !regions.some(region => region.regionId === selectedRegionId)) {
        throw new Error("selected CAD import region no longer exists");
      }
      if (Boolean(core.scene) !== Boolean(selectedRegionId)) {
        throw new Error("CAD core scene selection artifact mismatch");
      }
      const previewArtifacts = core.regionPreviews ?? [];
      if (!selectedRegion && (previewArtifacts.length !== regions.length ||
          new Set(previewArtifacts.map(preview => preview.regionId)).size !== regions.length ||
          regions.some(region => !previewArtifacts.some(preview => preview.regionId === region.regionId)))) {
        throw new Error("CAD core region preview artifact mismatch");
      }
      const candidates = core.selectedCandidates ?? core.candidates;
      const rendered = core.rendered;
      await pulse(70, "rendering");

      phase = "render";
      const viewport = rendered.viewport;
      let manifest: CadSceneManifest | null = null;
      if (core.scene) {
        const identity = cadScenePersistenceIdentity(job.id, selectedRegionId!);
        if (core.scene.sceneId !== identity.sceneId || core.scene.manifestAssetId !== identity.manifestAssetId ||
            core.scene.manifestFilename !== `${identity.manifestAssetId}.json`) {
          throw new Error("CAD core scene identity mismatch");
        }
        const manifestPayload = await readFile(safeArtifactPath(tempDirectory, core.scene.manifestFilename, ".json"));
        if (manifestPayload.byteLength !== core.scene.manifestByteSize ||
            sha256(manifestPayload) !== core.scene.manifestSha256) {
          throw new Error("CAD core manifest artifact integrity mismatch");
        }
        const parsed = JSON.parse(manifestPayload.toString("utf8")) as Record<string, unknown>;
        manifest = cadSceneManifestSchema.parse({
          ...parsed,
          byteSize: core.scene.manifestByteSize,
          sha256: core.scene.manifestSha256
        });
        if (manifest.sceneId !== identity.sceneId || manifest.regionId !== selectedRegionId ||
            manifest.manifestAssetId !== identity.manifestAssetId ||
            manifest.width !== core.scene.width || manifest.height !== core.scene.height ||
            !sameNumericRecord(manifest.sourceBounds, core.scene.sourceBounds) ||
            !sameNumericRecord(manifest.transform, core.scene.transform) ||
            manifest.tiles.some(tile => tile.assetId !== identity.tileAssetId(tile))) {
          throw new Error("CAD core manifest identity mismatch");
        }
        if (!this.attemptCleanup) throw new Error("CAD import cleanup ledger is unavailable");
        attempt = await this.attemptCleanup.armAttempt(
          { jobId: job.id, floorId: job.floorId, attemptCount: job.attemptCount },
          { sizeBytes: rendered.sizeBytes, sha256: rendered.sha256 }
        );
      }

      const cadAssets = [
        ...previewArtifacts.map(preview => {
          const region = regions.find(candidate => candidate.regionId === preview.regionId)!;
          const identity = cadRegionPreviewPersistenceIdentity(job.id, region.regionId);
          if (preview.assetId !== identity.assetId || preview.filename !== `${identity.assetId}.svg`) {
            throw new Error("CAD region preview identity mismatch");
          }
          return {
            id: preview.assetId,
            kind: "cad_region_preview" as const,
            objectKey: identity.objectKey(job.floorId),
            mimeType: "image/svg+xml",
            contentEncoding: "gzip" as const,
            sizeBytes: preview.sizeBytes,
            sha256: preview.sha256,
            inputPath: safeArtifactPath(tempDirectory!, preview.filename, ".svg"),
            metadata: regionPreviewMetadata(region, preview.viewport)
          };
        }),
        ...(manifest ? [{
          id: manifest.manifestAssetId,
          kind: "cad_manifest" as const,
          objectKey: cadScenePersistenceIdentity(job.id, manifest.regionId).manifestObjectKey(job.floorId),
          mimeType: "application/json",
          contentEncoding: undefined,
          sizeBytes: manifest.byteSize,
          sha256: manifest.sha256,
          inputPath: safeArtifactPath(tempDirectory!, `${manifest.manifestAssetId}.json`, ".json"),
          metadata: undefined
        }, ...manifest.tiles.map(tile => ({
          id: tile.assetId,
          kind: "cad_tile" as const,
          objectKey: cadScenePersistenceIdentity(job.id, manifest!.regionId).tileObjectKey(job.floorId, tile),
          mimeType: "application/vnd.led-control.cad-tile",
          contentEncoding: undefined,
          sizeBytes: tile.byteSize,
          sha256: tile.sha256,
          inputPath: safeArtifactPath(tempDirectory!, `${tile.assetId}.bin`, ".bin"),
          metadata: boundsMetadata(tile.bounds)
        }))] : [])
      ];
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await this.prisma.floorAsset.createMany({
        data: cadAssets.map(asset => ({
          id: asset.id,
          floorId: job.floorId,
          kind: asset.kind,
          status: "pending" as const,
          objectKey: asset.objectKey,
          mimeType: asset.mimeType,
          contentEncoding: asset.contentEncoding,
          sizeBytes: BigInt(asset.sizeBytes),
          sha256: asset.sha256,
          uploadExpiresAt: expiresAt
        })),
        skipDuplicates: true
      });
      const stagedAssets = await this.prisma.floorAsset.findMany({
        where: { id: { in: cadAssets.map(asset => asset.id) } },
        select: {
          id: true, floorId: true, kind: true, status: true, objectKey: true, mimeType: true,
          contentEncoding: true, sizeBytes: true, sha256: true, cleanupStartedAt: true
        }
      });
      if (stagedAssets.length !== cadAssets.length || cadAssets.some(expected => {
        const actual = stagedAssets.find(asset => asset.id === expected.id);
        return !actual || actual.floorId !== job.floorId || actual.kind !== expected.kind || actual.status !== "pending" ||
          actual.objectKey !== expected.objectKey || actual.mimeType !== expected.mimeType ||
          actual.contentEncoding !== (expected.contentEncoding ?? null) || actual.sizeBytes !== BigInt(expected.sizeBytes) ||
          actual.sha256 !== expected.sha256 || actual.cleanupStartedAt !== null;
      })) throw new Error("CAD scene pending asset identity conflict");

      phase = "storage";
      if (attempt) {
        await this.storage.putFloorRenderedObjectFile(attempt.objectKey, renderedPath, rendered, viewport, abort.signal);
        await this.storage.verifyFloorRenderedObject(attempt.objectKey, {
          sizeBytes: rendered.sizeBytes, sha256: rendered.sha256,
          mimeType: "image/svg+xml", contentEncoding: rendered.contentEncoding, ...viewport
        }, abort.signal);
      }
      for (const asset of cadAssets) {
        const expected = {
          sizeBytes: asset.sizeBytes,
          sha256: asset.sha256,
          contentType: asset.mimeType,
          ...(asset.contentEncoding ? { contentEncoding: asset.contentEncoding } : {}),
          ...(asset.metadata ? { metadata: asset.metadata } : {})
        };
        await this.storage.putCadSceneObjectFile(asset.objectKey, asset.inputPath, expected, abort.signal);
        await this.storage.verifyCadSceneObject(asset.objectKey, expected, abort.signal);
      }
      await pulse(90, "persisting");

      phase = "persist";
      await this.prisma.$transaction(async tx => {
        const readyAt = new Date();
        if (attempt) {
          const lockedAttempt = await tx.$queryRaw<Array<{ assetId: string }>>(Prisma.sql`
            SELECT asset."id" AS "assetId"
            FROM "Floor" AS floor
            JOIN "FloorAsset" AS asset ON asset."floorId" = floor."id"
            JOIN "FloorImportAttemptCleanup" AS cleanup ON cleanup."assetId" = asset."id"
            WHERE floor."id" = ${job.floorId}
              AND asset."id" = ${attempt.assetId} AND asset."objectKey" = ${attempt.objectKey}
              AND asset."status" = 'pending' AND asset."cleanupStartedAt" IS NULL
              AND cleanup."jobId" = ${job.id} AND cleanup."attemptCount" = ${job.attemptCount}
              AND cleanup."objectKey" = ${attempt.objectKey} AND cleanup."committedAt" IS NULL
              AND cleanup."cleanedAt" IS NULL AND cleanup."leaseOwner" IS NULL
            FOR UPDATE OF floor, asset, cleanup
          `);
          if (!lockedAttempt[0]) throw new Error("CAD_IMPORT_ATTEMPT_IDENTITY_LOST");
          const ready = await tx.floorAsset.updateMany({
            where: { id: attempt.assetId, objectKey: attempt.objectKey, status: "pending", cleanupStartedAt: null },
            data: { status: "ready", readyAt, uploadExpiresAt: null }
          });
          if (ready.count !== 1) throw new Error("CAD_IMPORT_ATTEMPT_IDENTITY_LOST");
        } else {
          const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT job."id"
            FROM "Floor" AS floor
            JOIN "FloorImportJob" AS job ON job."floorId" = floor."id"
            WHERE floor."id" = ${job.floorId}
              AND job."id" = ${job.id} AND job."status" = 'processing'
              AND job."leaseOwner" = ${this.owner} AND job."attemptCount" = ${job.attemptCount}
              AND job."leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
            FOR UPDATE OF floor, job
          `);
          if (!locked[0]) throw new Error("CAD_IMPORT_LEASE_LOST");
        }
        if (cadAssets.length > 0) {
          const promoted = await tx.floorAsset.updateMany({
            where: { id: { in: cadAssets.map(asset => asset.id) }, status: "pending", cleanupStartedAt: null },
            data: { status: "ready", readyAt, uploadExpiresAt: null }
          });
          if (promoted.count !== cadAssets.length) throw new Error("CAD scene asset promotion conflict");
        }
        const existingRegions = await tx.floorImportRegion.findMany({ where: { jobId: job.id } });
        if (existingRegions.length === 0) {
          await tx.floorImportRegion.createMany({ data: regions.map(region => ({
            jobId: job.id,
            regionId: region.regionId,
            minX: region.bounds.minX,
            minY: region.bounds.minY,
            maxX: region.bounds.maxX,
            maxY: region.bounds.maxY,
            primitiveCount: region.primitiveCount,
            candidateIdentityDigest: candidateRegionDigests[region.regionId],
            previewAssetId: cadRegionPreviewPersistenceIdentity(job.id, region.regionId).assetId,
            selectedAt: regions.length === 1 ? readyAt : null
          })) });
        } else if (existingRegions.length !== regions.length || regions.some(region => {
          const stored = existingRegions.find(candidate => candidate.regionId === region.regionId);
          return !stored || stored.minX !== region.bounds.minX || stored.minY !== region.bounds.minY ||
            stored.maxX !== region.bounds.maxX || stored.maxY !== region.bounds.maxY ||
            stored.primitiveCount !== region.primitiveCount ||
            stored.candidateIdentityDigest !== candidateRegionDigests[region.regionId];
        })) throw new Error("CAD import region changed between selection and scene build");
        await tx.floorImportCandidate.deleteMany({ where: { jobId: job.id } });
        const candidateRows = candidates.map(candidate => {
          const method = candidate.method === "ai" ? "ai_assisted" as const : "rule_based" as const;
          return {
              jobId: job.id, sourceEntityId: candidate.sourceEntityId,
              layerName: candidate.layerName, blockName: candidate.blockName,
              x: candidate.x, y: candidate.y, rotation: candidate.rotation,
              confidence: candidate.confidence, detectionMethod: method,
              provider: method === "ai_assisted" ? candidate.provider ?? null : null,
              model: method === "ai_assisted" ? candidate.model ?? null : null,
              inputDigest: method === "ai_assisted" ? candidate.inputDigest ?? null : null,
              profileVersion: core.profileVersion, profileDigest: core.profileDigest
          };
        });
        for (let offset = 0; offset < candidateRows.length; offset += CANDIDATE_WRITE_CHUNK) {
          await tx.floorImportCandidate.createMany({ data: candidateRows.slice(offset, offset + CANDIDATE_WRITE_CHUNK) });
        }
        const changed = attempt ? await tx.$executeRaw(Prisma.sql`
          UPDATE "FloorImportJob" SET "status" = 'review_required', "stage" = 'review_required',
            "progressPercent" = 100, "renderedAssetId" = ${attempt.assetId}, "parserVersion" = ${PARSER_VERSION},
            "detectorVersion" = ${`${core.profileVersion}:${core.profileDigest}+ai-disabled-v1`},
            "detectorProfileVersion" = ${core.profileVersion}, "detectorProfileDigest" = ${core.profileDigest},
            "reviewRequiredAt" = (statement_timestamp() AT TIME ZONE 'UTC'),
            "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
            "updatedAt" = (statement_timestamp() AT TIME ZONE 'UTC')
          WHERE ${this.fence(job)}
        `) : await tx.$executeRaw(Prisma.sql`
          UPDATE "FloorImportJob" SET "status" = 'region_selection_required',
            "stage" = 'region_selection_required', "progressPercent" = GREATEST("progressPercent", 70),
            "parserVersion" = ${PARSER_VERSION},
            "detectorVersion" = ${`${core.profileVersion}:${core.profileDigest}+ai-disabled-v1`},
            "detectorProfileVersion" = ${core.profileVersion}, "detectorProfileDigest" = ${core.profileDigest},
            "reviewRequiredAt" = (statement_timestamp() AT TIME ZONE 'UTC'),
            "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
            "updatedAt" = (statement_timestamp() AT TIME ZONE 'UTC')
          WHERE ${this.fence(job)}
        `);
        if (changed !== 1) throw new Error("CAD_IMPORT_LEASE_LOST");
        if (attempt) {
          const reconciled = await tx.floorImportAttemptCleanup.updateMany({
            where: {
              jobId: job.id, attemptCount: job.attemptCount, assetId: attempt.assetId,
              objectKey: attempt.objectKey, committedAt: null, cleanedAt: null, leaseOwner: null
            },
            data: { committedAt: readyAt, lastError: null }
          });
          if (reconciled.count !== 1) throw new Error("CAD_IMPORT_ATTEMPT_CLEANUP_LEASED");
        }
      }, { maxWait: 5_000, timeout: 30_000 });
    } catch (error) {
      if (this.stopping) {
        if (attempt && this.attemptCleanup) await this.attemptCleanup.requestCleanup(attempt);
        return;
      }
      const failureCode = phaseFailureCode(phase);
      const changed = await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "FloorImportJob" SET
          "status" = CASE WHEN "attemptCount" >= ${MAX_ATTEMPTS}
            THEN 'failed'::"FloorImportJobStatus" ELSE 'queued'::"FloorImportJobStatus" END,
          "stage" = CASE WHEN "attemptCount" >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
          "startedAt" = CASE WHEN "attemptCount" >= ${MAX_ATTEMPTS} THEN "startedAt" ELSE NULL END,
          "failureCode" = CASE WHEN "attemptCount" >= ${MAX_ATTEMPTS} THEN ${failureCode} ELSE NULL END,
          "failureMessage" = CASE WHEN "attemptCount" >= ${MAX_ATTEMPTS} THEN 'CAD import processing failed' ELSE NULL END,
          "failedAt" = CASE WHEN "attemptCount" >= ${MAX_ATTEMPTS}
            THEN (clock_timestamp() AT TIME ZONE 'UTC') ELSE NULL END,
          "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
          "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE ${this.fence(job)}
      `);
      if (attempt && this.attemptCleanup) await this.attemptCleanup.requestCleanup(attempt);
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      if (this.activeAbort === abort) this.activeAbort = null;
      if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async renew(job: FloorImportJob, progress?: number, stage?: CadImportStage) {
    return (await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "FloorImportJob" SET
        "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '30 seconds',
        "progressPercent" = GREATEST("progressPercent", ${progress ?? 1}),
        "stage" = COALESCE(${stage ?? null}, "stage"),
        "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE ${this.fence(job)}
    `)) === 1;
  }

  private fence(job: FloorImportJob) {
    return Prisma.sql`"id" = ${job.id} AND "status" = 'processing'
      AND "leaseOwner" = ${this.owner} AND "attemptCount" = ${job.attemptCount}
      AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')`;
  }

}

type ImportPhase = "download" | "convert" | "parse" | "detect" | "render" | "storage" | "persist";

function phaseFailureCode(phase: ImportPhase) {
  const codes: Record<ImportPhase, string> = {
    download: "CAD_IMPORT_SOURCE_INVALID",
    convert: "CAD_IMPORT_CONVERSION_FAILED",
    parse: "CAD_IMPORT_PARSE_FAILED",
    detect: "CAD_IMPORT_DETECTION_FAILED",
    render: "CAD_IMPORT_RENDER_FAILED",
    storage: "CAD_IMPORT_STORAGE_FAILED",
    persist: "CAD_IMPORT_PERSIST_FAILED"
  };
  return codes[phase];
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeArtifactPath(directory: string, filename: string, extension: ".json" | ".bin" | ".svg") {
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  if (!new RegExp(`^${uuid}\\${extension}$`, "i").test(filename)) {
    throw new Error("invalid CAD core artifact filename");
  }
  return join(directory, filename);
}

function boundsMetadata(bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
  return {
    "cad-min-x": String(bounds.minX),
    "cad-min-y": String(bounds.minY),
    "cad-max-x": String(bounds.maxX),
    "cad-max-y": String(bounds.maxY)
  };
}

function sameNumericRecord(
  left: Record<string, number>,
  right: Record<string, number>
): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}

function regionPreviewMetadata(
  region: {
    regionId: string;
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
    textCount: number;
    lightCandidateCount: number;
    area: number;
  },
  viewport: { width: number; height: number }
) {
  return {
    ...boundsMetadata(region.bounds),
    "cad-region-id": region.regionId,
    "cad-width": String(viewport.width),
    "cad-height": String(viewport.height),
    "cad-text-count": String(region.textCount),
    "cad-light-count": String(region.lightCandidateCount),
    "cad-area": String(region.area)
  };
}
