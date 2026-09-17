import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma, type FloorImportAttemptCleanup } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { CAD_IMPORT_WORKER_OPTIONS, type FloorImportWorkerOptions } from "./floor-import.tokens";

const SWEEP_INTERVAL_MS = 60_000;
const TEMP_STALE_MS = 15 * 60_000;
const RETRY_INTERVAL_MS = 60_000;
const ATTEMPT_GRACE_MS = 5 * 60_000;
const ORPHAN_QUIET_PERIOD_MS = 15 * 60_000;
const BATCH_SIZE = 25;
const TEMP_DIRECTORY_PATTERN = /^floor-import-[a-f0-9-]{36}-attempt-[1-3]-[A-Za-z0-9_-]+$/i;

export interface FloorImportAttemptIdentity {
  jobId: string;
  floorId: string;
  attemptCount: number;
  assetId: string;
  objectKey: string;
}

@Injectable()
export class FloorImportAttemptCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FloorImportAttemptCleanupService.name);
  private readonly options: FloorImportWorkerOptions;
  private timer?: NodeJS.Timeout;
  private activeSweep: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    @Optional() @Inject(CAD_IMPORT_WORKER_OPTIONS) options?: FloorImportWorkerOptions
  ) {
    this.options = options ?? { tempRoot: "/tmp", pollIntervalMs: 1000 };
  }

  onModuleInit() {
    if (this.timer || process.env.NODE_ENV === "test") return;
    this.stopping = false;
    void this.runSweep();
    this.timer = setInterval(() => void this.runSweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeSweep?.catch(() => undefined);
  }

  async armAttempt(
    input: { jobId: string; floorId: string; attemptCount: number },
    rendered: { sizeBytes: number; sha256: string },
    now = new Date()
  ): Promise<FloorImportAttemptIdentity> {
    const objectKey = attemptObjectKey(input);
    return this.prisma.$transaction(async tx => {
      const existing = await tx.floorImportAttemptCleanup.findUnique({
        where: { jobId_attemptCount: { jobId: input.jobId, attemptCount: input.attemptCount } }
      });
      const cleanup = existing ?? await tx.floorImportAttemptCleanup.create({ data: {
        jobId: input.jobId, floorId: input.floorId, attemptCount: input.attemptCount,
        assetId: randomUUID(), objectKey,
        nextAttemptAt: new Date(now.getTime() + ATTEMPT_GRACE_MS)
      } });
      if (cleanup.floorId !== input.floorId || cleanup.objectKey !== objectKey || cleanup.committedAt || cleanup.cleanedAt) {
        throw new Error("CAD import attempt identity conflict");
      }
      const asset = await tx.floorAsset.findUnique({ where: { id: cleanup.assetId } });
      if (!asset) {
        await tx.floorAsset.create({ data: {
          id: cleanup.assetId, floorId: input.floorId, kind: "rendered", status: "pending",
          objectKey, mimeType: "image/svg+xml", contentEncoding: "gzip",
          sizeBytes: BigInt(rendered.sizeBytes), sha256: rendered.sha256,
          uploadExpiresAt: new Date(now.getTime() + ATTEMPT_GRACE_MS)
        } });
      } else if (asset.floorId !== input.floorId || asset.objectKey !== objectKey || asset.status !== "pending" ||
          asset.mimeType !== "image/svg+xml" || asset.contentEncoding !== "gzip" ||
          asset.sizeBytes !== BigInt(rendered.sizeBytes) || asset.sha256 !== rendered.sha256) {
        throw new Error("CAD import attempt asset identity conflict");
      }
      return cleanupIdentity(cleanup);
    });
  }

  async requestCleanup(identity: FloorImportAttemptIdentity): Promise<"deleted" | "deferred" | "retained"> {
    let asset: { id: string; objectKey: string; status: string } | null;
    try {
      asset = await this.prisma.floorAsset.findUnique({
        where: { id: identity.assetId }, select: { id: true, objectKey: true, status: true }
      });
    } catch {
      // A read error is not evidence that the ledger is absent. The durable
      // tombstone remains eligible for reconciliation after the database recovers.
      return "deferred";
    }
    if (asset?.status === "ready") return "retained";
    if (asset && (asset.id !== identity.assetId || asset.objectKey !== identity.objectKey)) return "retained";

    try {
      const claimed = await this.prisma.floorImportAttemptCleanup.updateMany({
        where: {
          jobId: identity.jobId, attemptCount: identity.attemptCount,
          committedAt: null, cleanedAt: null, leaseOwner: null
        },
        data: { nextAttemptAt: new Date(), leaseOwner: null, leaseExpiresAt: null }
      });
      if (claimed.count !== 1) return "deferred";
    } catch {
      return "deferred";
    }
    if (asset) return "deferred";
    try {
      await this.storage.deleteObject(identity.objectKey);
      const cleanedAt = new Date();
      const recorded = await this.prisma.floorImportAttemptCleanup.updateMany({
        where: {
          jobId: identity.jobId, attemptCount: identity.attemptCount,
          committedAt: null, cleanedAt: null, leaseOwner: null
        },
        data: {
          lastCleanedAt: cleanedAt, nextAttemptAt: new Date(cleanedAt.getTime() + ORPHAN_QUIET_PERIOD_MS),
          lastError: null
        }
      });
      return recorded.count === 1 ? "deleted" : "deferred";
    } catch {
      return "deferred";
    }
  }

  async sweepStaleTemp(now = new Date()) {
    let entries;
    try { entries = await readdir(this.options.tempRoot, { withFileTypes: true }); }
    catch { return { scanned: 0, deleted: 0 }; }
    let scanned = 0; let deleted = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !TEMP_DIRECTORY_PATTERN.test(entry.name)) continue;
      scanned++;
      const path = join(this.options.tempRoot, entry.name);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory() || info.mtime.getTime() > now.getTime() - TEMP_STALE_MS) continue;
        await rm(path, { recursive: true, force: true });
        deleted++;
      } catch { /* A concurrent owner or sweep can remove the path first. */ }
    }
    return { scanned, deleted };
  }

  private runSweep() {
    if (this.stopping || this.activeSweep) return this.activeSweep ?? Promise.resolve();
    const run = Promise.all([this.sweepAttempts(), this.sweepStaleTemp()]).then(() => undefined)
      .catch(() => this.logger.warn("CAD import cleanup sweep failed"));
    this.activeSweep = run;
    void run.finally(() => { if (this.activeSweep === run) this.activeSweep = null; }).catch(() => undefined);
    return run;
  }

  async sweepAttempts(now = new Date()) {
    const seen: string[] = [];
    for (let index = 0; index < BATCH_SIZE && !this.stopping; index++) {
      const owner = randomUUID();
      const rows = await this.prisma.$queryRaw<FloorImportAttemptCleanup[]>(Prisma.sql`
        WITH candidate AS (
          SELECT cleanup."jobId", cleanup."attemptCount"
          FROM "FloorImportAttemptCleanup" AS cleanup
          LEFT JOIN "FloorImportJob" AS job ON job."id" = cleanup."jobId"
          WHERE cleanup."committedAt" IS NULL AND cleanup."cleanedAt" IS NULL
            AND cleanup."nextAttemptAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
            AND (cleanup."leaseExpiresAt" IS NULL OR cleanup."leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC'))
            AND (job."id" IS NULL OR NOT (
              job."status" = 'processing' AND job."attemptCount" = cleanup."attemptCount"
              AND job."leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
            ))
            ${seen.length ? Prisma.sql`AND cleanup."objectKey" NOT IN (${Prisma.join(seen)})` : Prisma.empty}
          ORDER BY cleanup."nextAttemptAt", cleanup."jobId", cleanup."attemptCount"
          LIMIT 1 FOR UPDATE OF cleanup SKIP LOCKED
        )
        UPDATE "FloorImportAttemptCleanup" AS cleanup
        SET "leaseOwner" = ${owner},
          "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '30 seconds',
          "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
        FROM candidate
        WHERE cleanup."jobId" = candidate."jobId" AND cleanup."attemptCount" = candidate."attemptCount"
        RETURNING cleanup.*
      `);
      const cleanup = rows[0];
      if (!cleanup) break;
      seen.push(cleanup.objectKey);
      await this.processClaim(cleanup, owner, now);
    }
  }

  private async processClaim(cleanup: FloorImportAttemptCleanup, owner: string, now: Date) {
    let canDelete = false;
    try {
      const asset = await this.prisma.floorAsset.findUnique({
        where: { id: cleanup.assetId }, select: { id: true, objectKey: true, status: true }
      });
      const linked = await this.prisma.floorImportJob.findFirst({
        where: { id: cleanup.jobId, renderedAssetId: cleanup.assetId }, select: { id: true }
      });
      if (asset?.status === "ready" && asset.objectKey === cleanup.objectKey && linked) {
        await this.prisma.floorImportAttemptCleanup.updateMany({
          where: {
            jobId: cleanup.jobId, attemptCount: cleanup.attemptCount,
            leaseOwner: owner, cleanedAt: null
          },
          data: { committedAt: now, leaseOwner: null, leaseExpiresAt: null, lastError: null }
        });
        return;
      }
      canDelete = !asset || (asset.status === "pending" && asset.objectKey === cleanup.objectKey);
      if (!canDelete) throw new Error("CAD import cleanup identity mismatch");
      await this.storage.deleteObject(cleanup.objectKey);
      await this.prisma.$transaction(async tx => {
        // Match the worker's lock order so cleanup cannot erase an attempt asset
        // after its lease expires while object deletion is in flight.
        const assets = await tx.$queryRaw<Array<{ id: string; objectKey: string; status: string }>>(Prisma.sql`
          SELECT "id", "objectKey", "status"
          FROM "FloorAsset"
          WHERE "id" = ${cleanup.assetId}
          FOR UPDATE
        `);
        const ownership = await tx.$queryRaw<Array<{ jobId: string }>>(Prisma.sql`
          SELECT "jobId"
          FROM "FloorImportAttemptCleanup"
          WHERE "jobId" = ${cleanup.jobId}
            AND "attemptCount" = ${cleanup.attemptCount}
            AND "leaseOwner" = ${owner}
            AND "committedAt" IS NULL
            AND "cleanedAt" IS NULL
            AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
          FOR UPDATE
        `);
        if (!ownership[0]) return;
        const lockedAsset = assets[0];
        if (lockedAsset && (lockedAsset.objectKey !== cleanup.objectKey || lockedAsset.status !== "pending")) {
          throw new Error("CAD import cleanup identity changed");
        }
        await tx.floorAsset.deleteMany({
          where: { id: cleanup.assetId, objectKey: cleanup.objectKey, status: "pending" }
        });
        const terminalCleanup = cleanup.lastCleanedAt !== null;
        await tx.floorImportAttemptCleanup.updateMany({
          where: {
            jobId: cleanup.jobId, attemptCount: cleanup.attemptCount,
            leaseOwner: owner, committedAt: null, cleanedAt: null
          },
          data: {
            leaseOwner: null, leaseExpiresAt: null,
            nextAttemptAt: new Date(now.getTime() + (terminalCleanup ? 0 : ORPHAN_QUIET_PERIOD_MS)),
            lastCleanedAt: now, cleanedAt: terminalCleanup ? now : null, lastError: null
          }
        });
      });
    } catch {
      await this.prisma.floorImportAttemptCleanup.updateMany({
        where: {
          jobId: cleanup.jobId, attemptCount: cleanup.attemptCount,
          leaseOwner: owner, committedAt: null, cleanedAt: null
        },
        data: {
          leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date(now.getTime() + RETRY_INTERVAL_MS),
          lastError: canDelete ? "CAD_IMPORT_OBJECT_CLEANUP_FAILED" : "CAD_IMPORT_CLEANUP_IDENTITY_MISMATCH"
        }
      }).catch(() => undefined);
    }
  }
}

function attemptObjectKey(input: { jobId: string; floorId: string; attemptCount: number }) {
  if (!Number.isInteger(input.attemptCount) || input.attemptCount < 1 || input.attemptCount > 3) {
    throw new Error("invalid CAD import attempt count");
  }
  return `floors/${input.floorId}/${input.jobId}-attempt-${input.attemptCount}.svg`;
}

function cleanupIdentity(cleanup: Pick<FloorImportAttemptCleanup, "jobId" | "floorId" | "attemptCount" | "assetId" | "objectKey">) {
  return {
    jobId: cleanup.jobId, floorId: cleanup.floorId, attemptCount: cleanup.attemptCount,
    assetId: cleanup.assetId, objectKey: cleanup.objectKey
  };
}
