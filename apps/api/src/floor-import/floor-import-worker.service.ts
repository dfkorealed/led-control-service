import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma, type FloorImportJob } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { type CadConverter } from "./cad-converter";
import { type CadCoreExecutor } from "./cad-core-executor";
import type { LightingDetectorRegistry } from "./lighting-detector-registry";
import {
  FloorImportAttemptCleanupService,
  type FloorImportAttemptIdentity
} from "./floor-import-attempt-cleanup.service";
import {
  CAD_IMPORT_CONVERTER, CAD_IMPORT_CORE_EXECUTOR, CAD_IMPORT_RULE_DETECTOR, CAD_IMPORT_WORKER_OPTIONS,
  type FloorImportWorkerOptions
} from "./floor-import.tokens";

export {
  CAD_IMPORT_CONVERTER, CAD_IMPORT_CORE_EXECUTOR, CAD_IMPORT_RULE_DETECTOR, CAD_IMPORT_WORKER_OPTIONS,
  type FloorImportWorkerOptions
} from "./floor-import.tokens";

const MAX_ATTEMPTS = 3;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_DXF_BYTES = 256 * 1024 * 1024;
const MAX_TEMP_DISK_BYTES = 512 * 1024 * 1024;
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
          "progressPercent" = 1, "attemptCount" = "attemptCount" + 1,
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
    const pulse = async (progress: number, stage: string) => {
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
        maxBytes: MAX_SOURCE_BYTES,
        expectedBytes: Number(source.sizeBytes),
        expectedMimeType: source.mimeType,
        expectedSha256: source.sha256,
        abortSignal: abort.signal
      });
      await pulse(15, "converting");

      phase = "convert";
      await this.converter.convert({ inputPath, outputPath: dxfPath, abortSignal: abort.signal });
      const converted = await stat(dxfPath);
      if (!converted.isFile() || converted.size < 1 || converted.size > MAX_DXF_BYTES) {
        throw new Error("CAD converted DXF size limit exceeded");
      }
      await pulse(35, "parsing");

      phase = "parse";
      const core = await this.core.execute({
        dxfPath, renderedPath, profileId, abortSignal: abort.signal
      });
      const rules = this.ruleRegistry.get(profileId);
      if (core.profileId !== profileId || core.profileVersion !== rules.profileVersion ||
          core.profileDigest !== rules.profileDigest) throw new Error("CAD detector profile metadata mismatch");
      const { candidates, rendered } = core;
      await pulse(70, "rendering");

      phase = "render";
      if (Number(source.sizeBytes) + converted.size + rendered.sizeBytes > MAX_TEMP_DISK_BYTES) {
        throw new Error("CAD import temporary disk limit exceeded");
      }
      const viewport = rendered.viewport;
      if (!this.attemptCleanup) throw new Error("CAD import cleanup ledger is unavailable");
      attempt = await this.attemptCleanup.armAttempt(
        { jobId: job.id, floorId: job.floorId, attemptCount: job.attemptCount },
        { sizeBytes: rendered.sizeBytes, sha256: rendered.sha256 }
      );

      phase = "storage";
      await this.storage.putFloorRenderedObjectFile(attempt.objectKey, renderedPath, rendered, viewport, abort.signal);
      await this.storage.verifyFloorRenderedObject(attempt.objectKey, {
        sizeBytes: rendered.sizeBytes, sha256: rendered.sha256, mimeType: "image/svg+xml", contentEncoding: rendered.contentEncoding, ...viewport
      }, abort.signal);
      await pulse(90, "persisting");

      phase = "persist";
      const persistedAttempt = attempt;
      await this.prisma.$transaction(async tx => {
        const readyAt = new Date();
        const lockedAttempt = await tx.$queryRaw<Array<{ assetId: string }>>(Prisma.sql`
          SELECT asset."id" AS "assetId"
          FROM "Floor" AS floor
          JOIN "FloorAsset" AS asset ON asset."floorId" = floor."id"
          JOIN "FloorImportAttemptCleanup" AS cleanup ON cleanup."assetId" = asset."id"
          WHERE floor."id" = ${job.floorId}
            AND asset."id" = ${persistedAttempt.assetId}
            AND asset."objectKey" = ${persistedAttempt.objectKey}
            AND asset."status" = 'pending'
            AND asset."cleanupStartedAt" IS NULL
            AND cleanup."jobId" = ${job.id}
            AND cleanup."attemptCount" = ${job.attemptCount}
            AND cleanup."objectKey" = ${persistedAttempt.objectKey}
            AND cleanup."committedAt" IS NULL
            AND cleanup."cleanedAt" IS NULL
            AND cleanup."leaseOwner" IS NULL
          FOR UPDATE OF floor, asset, cleanup
        `);
        if (!lockedAttempt[0]) throw new Error("CAD_IMPORT_ATTEMPT_IDENTITY_LOST");
        const ready = await tx.floorAsset.updateMany({
          where: {
            id: persistedAttempt.assetId, objectKey: persistedAttempt.objectKey,
            status: "pending", cleanupStartedAt: null
          },
          data: { status: "ready", readyAt: readyAt, uploadExpiresAt: null }
        });
        if (ready.count !== 1) throw new Error("CAD_IMPORT_ATTEMPT_IDENTITY_LOST");
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
        const changed = await tx.$executeRaw(Prisma.sql`
          UPDATE "FloorImportJob" SET "status" = 'review_required', "stage" = 'review_required',
            "progressPercent" = 100, "renderedAssetId" = ${attempt!.assetId},
            "parserVersion" = ${PARSER_VERSION},
            "detectorVersion" = ${`${core.profileVersion}:${core.profileDigest}+ai-disabled-v1`},
            "detectorProfileVersion" = ${core.profileVersion},
            "detectorProfileDigest" = ${core.profileDigest},
            "reviewRequiredAt" = (statement_timestamp() AT TIME ZONE 'UTC'),
            "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
            "updatedAt" = (statement_timestamp() AT TIME ZONE 'UTC')
          WHERE ${this.fence(job)}
        `);
        if (changed !== 1) throw new Error("CAD_IMPORT_LEASE_LOST");
        const reconciled = await tx.floorImportAttemptCleanup.updateMany({
          where: {
            jobId: job.id, attemptCount: job.attemptCount, assetId: attempt!.assetId,
            objectKey: attempt!.objectKey, committedAt: null, cleanedAt: null, leaseOwner: null
          },
          data: { committedAt: readyAt, lastError: null }
        });
        if (reconciled.count !== 1) throw new Error("CAD_IMPORT_ATTEMPT_CLEANUP_LEASED");
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
          "progressPercent" = CASE WHEN "attemptCount" >= ${MAX_ATTEMPTS} THEN "progressPercent" ELSE 0 END,
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

  private async renew(job: FloorImportJob, progress?: number, stage?: string) {
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
