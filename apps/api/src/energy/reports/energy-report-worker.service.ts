import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, type EnergyReportJob } from "@prisma/client";
import { energyReportDocumentSchema } from "@led-control/shared";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { ObjectStorageService } from "../../storage/object-storage.service";
import { EnergyReportSnapshotService } from "./energy-report-snapshot.service";
import { PdfEnergyReportRenderer } from "./pdf-energy-report.renderer";
import { canonicalJson } from "./energy-report-document.builder";
import { reportBlocks, verifyManifest } from "./report-renderer";
import { ZodError } from "zod";

@Injectable()
export class EnergyReportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly owner = randomUUID();
  private readonly logger = new Logger(EnergyReportWorkerService.name);
  private timer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService,
    private readonly snapshots: EnergyReportSnapshotService, private readonly pdf: PdfEnergyReportRenderer) {}
  onModuleInit() {
    if (this.timer || process.env.NODE_ENV === "test") return;
    this.stopping = false;
    this.timer = setInterval(() => void this.runOnce().catch(() => this.logger.warn("Report worker poll failed")), 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer); clearInterval(this.heartbeat);
    this.timer = undefined; this.heartbeat = undefined;
  }

  async claimNext(): Promise<EnergyReportJob | null> {
    if (this.stopping) return null;
    // A crashed third attempt cannot be reclaimed. A deletion barrier likewise makes
    // lower attempts unreclaimable; retire them after lease expiry so an interrupted
    // deletion can recover instead of leaving processing/409 permanently stranded.
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "EnergyReportJob" SET "status" = 'failed', "failureCode" = 'REPORT_ATTEMPTS_EXHAUSTED',
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" IN (SELECT "id" FROM "EnergyReportJob"
        WHERE "status" = 'processing' AND "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
          AND ("attemptCount" >= 3 OR EXISTS (SELECT 1 FROM "SiteDeletionCleanup" cleanup WHERE cleanup."siteId" = "EnergyReportJob"."siteId"))
        ORDER BY "createdAt", "id" LIMIT 20 FOR UPDATE SKIP LOCKED)
    `);
    if (this.stopping) return null;
    const candidates = await this.prisma.$queryRaw<Array<{ id: string; siteId: string }>>(Prisma.sql`
      SELECT "id", "siteId" FROM "EnergyReportJob" WHERE "attemptCount" < 3
        AND NOT EXISTS (SELECT 1 FROM "SiteDeletionCleanup" cleanup WHERE cleanup."siteId" = "EnergyReportJob"."siteId")
        AND ("status" = 'queued' OR ("status" = 'processing' AND "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')))
      ORDER BY "createdAt", "id" LIMIT 20
    `);
    for (const candidate of candidates) {
      if (this.stopping) return null;
      const claimed = await this.prisma.$transaction(async tx => {
        // Site first (same lock order as deletion). The marker read must be a NEW
        // READ COMMITTED statement after this lock, not part of the candidate snapshot.
        const sites = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "Site" WHERE "id" = ${candidate.siteId} FOR KEY SHARE SKIP LOCKED
        `);
        if (!sites.length || await tx.siteDeletionCleanup.findUnique({ where: { siteId: candidate.siteId } })) return null;
        const rows = await tx.$queryRaw<EnergyReportJob[]>(Prisma.sql`
          WITH candidate AS (
            SELECT "id" FROM "EnergyReportJob" WHERE "id" = ${candidate.id} AND "attemptCount" < 3
              AND ("status" = 'queued' OR ("status" = 'processing' AND "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')))
            FOR UPDATE SKIP LOCKED
          )
          UPDATE "EnergyReportJob" AS job SET "status" = 'processing', "progressPercent" = 1,
            "attemptCount" = "attemptCount" + 1, "leaseOwner" = ${this.owner},
            "leaseExpiresAt" = (statement_timestamp() AT TIME ZONE 'UTC') + interval '30 seconds',
            "startedAt" = COALESCE("startedAt", (statement_timestamp() AT TIME ZONE 'UTC')),
            "failureCode" = NULL, "updatedAt" = (statement_timestamp() AT TIME ZONE 'UTC')
          FROM candidate WHERE job."id" = candidate."id" RETURNING job.*
        `);
        return rows[0] ?? null;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      if (claimed) return claimed;
    }
    return null;
  }

  async runOnce(): Promise<boolean> {
    if (this.running || this.stopping) return false;
    this.running = true;
    try {
      const job = await this.claimNext();
      // Destruction may run while either claim query is in flight. A row already claimed
      // remains recoverable at its original lease deadline; never start new attempt work.
      if (this.stopping || !job) return false;
      await this.process(job);
      return true;
    } finally { this.running = false; }
  }

  private async process(job: EnergyReportJob) {
    let leaseLost = false;
    let renewing = false;
    let uploadedKey: string | undefined;
    const pulse = async (progress?: number) => {
      const renewed = !this.stopping && !leaseLost && await this.renew(job, progress);
      // Shutdown can occur while renewal is awaiting its DB response, too.
      if (!renewed || this.stopping || leaseLost) {
        leaseLost = true;
        throw new Error("REPORT_LEASE_LOST");
      }
    };
    this.heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void pulse().catch(() => { leaseLost = true; }).finally(() => { renewing = false; });
    }, 10_000);
    this.heartbeat.unref();
    try {
      // Old workers must be stopped before the reset migration. Fail closed if
      // a stale or malformed claim reaches this process during a rolling release.
      if (job.format !== "pdf") throw new ReportProcessingError("REPORT_RENDERING_FAILED");
      let storedDocument = job.documentSnapshot;
      if (storedDocument === null) {
        const snapshot = await this.snapshots.capture(job.id, job.siteId, job.requestSnapshot, new Date(), job.targetLabelSnapshot)
          .catch(error => {
            if (error instanceof BadRequestException || error instanceof NotFoundException || error instanceof ZodError) {
              throw new ReportProcessingError("REPORT_SNAPSHOT_INVALID");
            }
            throw error;
          });
        await pulse(10);
        const rows = await this.prisma.$queryRaw<Array<{ documentSnapshot: Prisma.JsonValue }>>(Prisma.sql`
          UPDATE "EnergyReportJob" SET "dataSnapshot" = ${JSON.stringify(snapshot.dataSnapshot)}::jsonb,
            "documentSnapshot" = ${JSON.stringify(snapshot.documentSnapshot)}::jsonb,
            "contentFingerprint" = ${snapshot.documentSnapshot.contentFingerprint}, "progressPercent" = 20, "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
          WHERE ${this.fence(job)} AND "documentSnapshot" IS NULL RETURNING "documentSnapshot"
        `);
        if (!rows[0]) throw new Error("REPORT_LEASE_LOST");
        // Render the value returned by the database write, not a fresh computed document.
        storedDocument = rows[0].documentSnapshot;
      }
      const document = await reportPhase("REPORT_SNAPSHOT_INVALID", () => {
        const parsed = energyReportDocumentSchema.parse(storedDocument);
        const { contentFingerprint, ...fingerprintInput } = parsed;
        if (parsed.reportId !== job.id || contentFingerprint !== createHash("sha256").update(canonicalJson(fingerprintInput)).digest("hex")) {
          throw new Error("REPORT_DOCUMENT_INVALID");
        }
        return parsed;
      });
      await pulse(25);
      const rendered = await reportPhase("REPORT_RENDERING_FAILED", async () => {
        const result = await this.pdf.render(document);
        verifyManifest(reportBlocks(document), result.manifest);
        if (result.extension !== job.format || result.bytes.length < 1 || result.bytes.length > 25 * 1024 * 1024) {
          throw new Error("REPORT_FILE_INVALID");
        }
        return result;
      });
      await pulse(60);
      const key = `reports/${job.siteId}/${job.id}/attempt-${job.attemptCount}.${rendered.extension}`;
      // Record the attempted key before PUT; a rejected transport may already have stored bytes.
      uploadedKey = key;
      await reportPhase("REPORT_STORAGE_UNAVAILABLE", () => this.storage.putReportObject(key, rendered.bytes, rendered.contentType));
      await pulse(85);
      const sha256 = createHash("sha256").update(rendered.bytes).digest("hex");
      await reportPhase("REPORT_STORAGE_UNAVAILABLE", async () => {
        const head = await this.storage.headReportObject(key);
        if (head.ContentLength !== rendered.bytes.length || head.ContentType !== rendered.contentType
          || head.ChecksumSHA256 !== Buffer.from(sha256, "hex").toString("base64")) {
          throw new Error("REPORT_STORAGE_VERIFICATION_FAILED");
        }
      });
      await pulse(95);
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "EnergyReportJob" SET "status" = 'completed', "progressPercent" = 100,
          "objectKey" = ${key}, "contentType" = ${rendered.contentType}, "sizeBytes" = ${rendered.bytes.length}, "contentSha256" = ${sha256},
          "completedAt" = (statement_timestamp() AT TIME ZONE 'UTC'), "expiresAt" = (statement_timestamp() AT TIME ZONE 'UTC') + interval '7 days',
          "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = (statement_timestamp() AT TIME ZONE 'UTC')
        WHERE ${this.fence(job)}
      `);
    } catch (error) {
      // Shutdown leaves the current attempt reclaimable at its lease deadline and must
      // not issue fresh writes/deletions against dependencies that are being destroyed.
      if (this.stopping) return;
      // Only our own phase codes are persisted. DB/SDK/render messages can contain
      // credentials or private object paths and must never become public metadata.
      const failureCode = error instanceof ReportProcessingError ? error.failureCode : "REPORT_GENERATION_FAILED";
      const changed = await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "EnergyReportJob" SET
          "status" = CASE WHEN "attemptCount" >= 3 THEN 'failed'::"EnergyReportStatus" ELSE 'queued'::"EnergyReportStatus" END,
          "progressPercent" = 0, "startedAt" = CASE WHEN "attemptCount" >= 3 THEN "startedAt" ELSE NULL END,
          "failureCode" = CASE WHEN "attemptCount" >= 3 THEN ${failureCode} ELSE NULL END,
          "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE ${this.fence(job)}
      `);
      // Delete only after our fenced failure transition succeeds. If completion committed
      // but its response was lost, this update changes zero rows and the valid file survives.
      // Stale/uncertain attempt objects are left for the report cleanup sweep.
      if (changed && uploadedKey) await this.storage.deleteReportObject(uploadedKey).catch(() => undefined);
    } finally {
      clearInterval(this.heartbeat); this.heartbeat = undefined;
    }
  }

  private async renew(job: EnergyReportJob, progress?: number) {
    return (await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "EnergyReportJob" SET "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '30 seconds',
        "progressPercent" = GREATEST("progressPercent", ${progress ?? 1}), "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE ${this.fence(job)}
    `)) === 1;
  }

  private fence(job: EnergyReportJob) {
    // Owner and attempt prevent a late callback from an earlier claim of this same process;
    // the database clock prevents an already-expired lease from being resurrected.
    // Prisma DateTime uses timestamp without time zone; every SQL timestamp is explicitly
    // UTC so a non-UTC PostgreSQL session cannot shift lease/API/file-expiry times.
    return Prisma.sql`"id" = ${job.id} AND "status" = 'processing' AND "leaseOwner" = ${this.owner}
      AND NOT EXISTS (SELECT 1 FROM "SiteDeletionCleanup" cleanup WHERE cleanup."siteId" = ${job.siteId})
      AND "attemptCount" = ${job.attemptCount} AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')`;
  }
}

type ReportPhaseFailure = "REPORT_SNAPSHOT_INVALID" | "REPORT_RENDERING_FAILED" | "REPORT_STORAGE_UNAVAILABLE";
class ReportProcessingError extends Error {
  constructor(readonly failureCode: ReportPhaseFailure) { super(failureCode); }
}
async function reportPhase<T>(failureCode: ReportPhaseFailure, operation: () => T | Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { throw new ReportProcessingError(failureCode); }
}
