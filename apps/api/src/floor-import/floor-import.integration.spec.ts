import { ConflictException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditService } from "../audit/audit.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuthService } from "../auth/auth.service";
import { FloorAssetCleanupService } from "../floor-editor/floor-asset-cleanup.service";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { ObjectStorageService } from "../storage/object-storage.service";
import { FloorImportService } from "./floor-import.service";
import { CAD_IMPORT_WORKER_OPTIONS, FloorImportWorkerService } from "./floor-import-worker.service";
import { FloorImportAttemptCleanupService } from "./floor-import-attempt-cleanup.service";
import { FloorImportModule } from "./floor-import.module";
import { FixedLightingDetectorRegistry, PROVIDED_SAMPLE_DWG_SHA256 } from "./lighting-detector-registry";

const enabled = process.env.FLOOR_IMPORT_INTEGRATION === "1";
(enabled ? describe : describe.skip)("floor import PostgreSQL lifecycle", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let prisma: PrismaClient;
  let databaseUrl: string;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const siteId = randomUUID();
  const floorId = randomUUID();
  const user = {
    id: userId, organizationId, organizationType: "customer" as const, loginId: "cad-admin",
    name: "CAD Admin", role: "admin" as const, status: "active" as const, mustChangePassword: false
  };
  const access = {
    assert: jest.fn().mockResolvedValue({ id: siteId, organizationId }),
    assertManageInTransaction: jest.fn().mockResolvedValue({ id: siteId, organizationId })
  };
  const storage = { readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 640, height: 480 }) };
  const terminalProfile = {
    detectorProfileId: "generic-lighting-v1" as const,
    detectorProfileVersion: "legacy-unknown",
    detectorProfileDigest: "0".repeat(64)
  };

  beforeAll(async () => {
    cluster = await disposablePostgres();
    databaseUrl = cluster.database();
    const deployed = cluster.deploy(databaseUrl);
    if (deployed.status !== 0) throw new Error(deployed.stderr || deployed.stdout);
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    await prisma.organization.create({ data: { id: organizationId, name: "CAD import", type: "customer" } });
    await prisma.user.create({ data: {
      id: userId, organizationId, loginId: user.loginId, name: user.name, passwordHash: "unused", role: "admin"
    } });
    await prisma.site.create({ data: { id: siteId, organizationId, adminUserId: userId, name: "CAD site", timeZone: "UTC" } });
    await prisma.floor.create({ data: { id: floorId, siteId, name: "CAD floor", level: 1 } });
  }, 90_000);

  beforeEach(async () => {
    await prisma.floorImportAttemptCleanup.deleteMany();
    await prisma.floorImportJob.deleteMany({ where: { floorId } });
    await prisma.floorMapRevision.deleteMany({ where: { floorId } });
    await prisma.floorMapObject.deleteMany({ where: { floorId } });
    await prisma.fixture.deleteMany({ where: { floorId } });
    await prisma.floorPlan.deleteMany({ where: { floorId } });
    await prisma.floorAsset.deleteMany({ where: { floorId } });
    await prisma.auditLog.deleteMany({ where: { siteId } });
    await prisma.floor.update({ where: { id: floorId }, data: {
      mapRevision: 0, editorLeaseFence: 0, editorLeaseTokenHash: null,
      editorLeaseHolderId: null, editorLeaseHolderName: null,
      editorLeaseAcquiredAt: null, editorLeaseExpiresAt: null
    } });
    await prisma.site.update({ where: { id: siteId }, data: { adminUserId: userId } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    cluster?.stop();
  });

  async function sourceAsset(mimeType = "application/dxf", sha256 = "a".repeat(64)) {
    const id = randomUUID();
    return prisma.floorAsset.create({ data: {
      id, floorId, kind: "original", status: "ready", objectKey: `floors/${floorId}/${id}.${mimeType.includes("dwg") ? "dwg" : "dxf"}`,
      mimeType, sizeBytes: 128n, sha256, readyAt: new Date()
    } });
  }

  async function renderedAsset() {
    const id = randomUUID();
    return prisma.floorAsset.create({ data: {
      id, floorId, kind: "rendered", status: "ready",
      objectKey: `floors/${floorId}/${id}.svg`, mimeType: "image/svg+xml",
      contentEncoding: "gzip",
      sizeBytes: 256n, sha256: "b".repeat(64), readyAt: new Date()
    } });
  }

  function service() {
    return new FloorImportService(prisma as never, access as never, new AuditService(prisma as never), storage as never);
  }

  function worker() {
    return new FloorImportWorkerService(
      prisma as never, {} as never, {} as never, {} as never, {} as never,
      { tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false }
    );
  }

  it("enforces one active job per floor and releases the key after cancellation", async () => {
    const first = await sourceAsset(); const second = await sourceAsset();
    const imports = service();
    const created = await imports.create(user, floorId, { sourceAssetId: first.id, sourceFormat: "dxf" });
    await expect(imports.create(user, floorId, { sourceAssetId: second.id, sourceFormat: "dxf" }))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(imports.cancel(user, floorId, created.jobId)).resolves.toMatchObject({ status: "cancelled" });
    await expect(imports.create(user, floorId, { sourceAssetId: second.id, sourceFormat: "dxf" }))
      .resolves.toMatchObject({ status: "queued", sourceAssetId: second.id });
  });

  it("reauthorizes active lookup after a concurrent PostgreSQL admin revocation", async () => {
    const source = await sourceAsset();
    await prisma.floorImportJob.create({ data: { floorId, sourceAssetId: source.id, sourceFormat: "dxf" } });
    const replacement = await prisma.user.create({ data: {
      organizationId, loginId: `active_replacement_${randomUUID()}`, name: "Replacement Admin",
      passwordHash: "unused", role: "admin"
    } });
    const revoker = new PrismaClient({ datasourceUrl: databaseUrl });
    const imports = new FloorImportService(
      prisma as never,
      new SiteAccessService(prisma as never),
      new AuditService(prisma as never),
      storage as never
    );
    let release!: () => void; let locked!: () => void;
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    const siteLocked = new Promise<void>(resolve => { locked = resolve; });
    const revoking = revoker.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`;
      await tx.site.update({ where: { id: siteId }, data: { adminUserId: replacement.id } });
      locked();
      await releaseGate;
    }, { timeout: 10_000 });
    await siteLocked;

    const reading = imports.getActive(user, floorId);
    try {
      await waitForSiteLockWait(prisma, 3000);
    } finally {
      release();
    }
    await revoking;

    await expect(reading).rejects.toBeInstanceOf(NotFoundException);
    await revoker.$disconnect();
  }, 15_000);

  it("keeps applying transaction-local and recovers only DB-clock rows older than two minutes", async () => {
    const source = await sourceAsset();
    const rendered = await renderedAsset();
    const review = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, renderedAssetId: rendered.id, sourceFormat: "dxf",
      status: "review_required", stage: "review_required", progressPercent: 100,
      attemptCount: 1, startedAt: new Date(), reviewRequiredAt: new Date(), ...terminalProfile
    } });
    const transactionClient = new PrismaClient({ datasourceUrl: databaseUrl });
    let release!: () => void; let applying!: () => void;
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    const applyingWritten = new Promise<void>(resolve => { applying = resolve; });
    const applyingTransaction = transactionClient.$transaction(async tx => {
      await tx.floorImportJob.update({
        where: { id: review.id }, data: { status: "applying", stage: "applying" }
      });
      applying();
      await releaseGate;
      const now = new Date();
      await tx.floorImportJob.update({
        where: { id: review.id }, data: {
          status: "completed", stage: "completed", appliedAt: now, completedAt: now
        }
      });
    }, { timeout: 10_000 });
    await applyingWritten;

    await expect(service().getActive(user, floorId)).resolves.toMatchObject({
      job: { jobId: review.id, status: "review_required" }
    });
    release();
    await applyingTransaction;
    await expect(service().getActive(user, floorId)).resolves.toEqual({ job: null });

    const staleSource = await sourceAsset();
    const staleRendered = await renderedAsset();
    const stale = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: staleSource.id, renderedAssetId: staleRendered.id, sourceFormat: "dxf",
      status: "applying", stage: "applying", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(Date.now() - 180_000), reviewRequiredAt: new Date(Date.now() - 180_000), ...terminalProfile
    } });
    await prisma.$executeRaw`UPDATE "FloorImportJob" SET "updatedAt" = clock_timestamp() - INTERVAL '121 seconds' WHERE "id" = ${stale.id}`;
    await expect(service().getActive(user, floorId)).resolves.toEqual({ job: null });
    await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: stale.id } })).resolves.toMatchObject({
      status: "failed", stage: "failed", failureCode: "CAD_IMPORT_STALE_APPLYING", failedAt: expect.any(Date)
    });

    const freshSource = await sourceAsset();
    const freshRendered = await renderedAsset();
    const fresh = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: freshSource.id, renderedAssetId: freshRendered.id, sourceFormat: "dxf",
      status: "applying", stage: "applying", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), ...terminalProfile
    } });
    await prisma.$executeRaw`UPDATE "FloorImportJob" SET "updatedAt" = clock_timestamp() WHERE "id" = ${fresh.id}`;
    await expect(service().getActive(user, floorId)).resolves.toEqual({ job: null });
    await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: fresh.id } })).resolves.toMatchObject({
      status: "applying", failureCode: null, failedAt: null
    });
    await transactionClient.$disconnect();
  }, 15_000);

  it("recovers expired leases and retires an expired third attempt without a fourth claim", async () => {
    const source = await sourceAsset();
    const job = await prisma.floorImportJob.create({ data: { floorId, sourceAssetId: source.id, sourceFormat: "dxf" } });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const currentWorker = worker();
      await expect(currentWorker.claimNext()).resolves.toMatchObject({ id: job.id, attemptCount: attempt, status: "processing" });
      await prisma.floorImportJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(0) } });
      await currentWorker.onModuleDestroy();
    }
    const finalWorker = worker();
    await expect(finalWorker.claimNext()).resolves.toBeNull();
    await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({
      status: "failed", attemptCount: 3, leaseOwner: null, leaseExpiresAt: null,
      failureCode: "CAD_IMPORT_ATTEMPTS_EXHAUSTED", failedAt: expect.any(Date)
    });
    await finalWorker.onModuleDestroy();
  });

  it("keeps an attempt object when pending asset cleanup races the worker ready promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-cleanup-race-"));
    const source = await sourceAsset();
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf"
    } });
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    const objects = new Set<string>();
    let uploadedKey = "";
    let signalPut!: () => void; let releasePut!: () => void;
    let signalDelete!: () => void; let releaseDelete!: () => void;
    const putStarted = new Promise<void>(resolve => { signalPut = resolve; });
    const putGate = new Promise<void>(resolve => { releasePut = resolve; });
    const deleteStarted = new Promise<void>(resolve => { signalDelete = resolve; });
    const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });
    const raceStorage = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObjectFile: jest.fn(async (key: string) => {
        uploadedKey = key; objects.add(key); signalPut(); await putGate;
      }),
      verifyFloorRenderedObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("attempt object disappeared before verification");
      }),
      deleteObject: jest.fn(async (key: string) => {
        signalDelete(); await deleteGate; objects.delete(key);
      })
    };
    const converter = { convert: jest.fn(async ({ inputPath, outputPath }: { inputPath: string; outputPath: string }) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const detector = { profileId: "generic-lighting-v1", profileVersion: "test/1", profileDigest: "b".repeat(64) };
    const registry = {
      resolve: jest.fn().mockReturnValue("generic-lighting-v1"), assertBinding: jest.fn(), get: jest.fn().mockReturnValue(detector)
    };
    const core = { execute: jest.fn(async ({ renderedPath }: { renderedPath: string }) => {
      await writeFile(renderedPath, "gzip-svg");
      return {
        profileId: "generic-lighting-v1", profileVersion: "test/1", profileDigest: "b".repeat(64),
        modelEntityCount: 1, blockCount: 0, candidates: [],
        rendered: { sizeBytes: 8, rawSizeBytes: 64, sha256: "b".repeat(64), viewport: { width: 12, height: 12 },
          renderedOccurrences: 1, contentEncoding: "gzip" }
      };
    }) };
    const attemptCleanup = new FloorImportAttemptCleanupService(prisma as never, raceStorage as never, {
      tempRoot: root, pollIntervalMs: 1000, enabled: false
    });
    const importWorker = new FloorImportWorkerService(
      prisma as never, raceStorage as never, converter as never, registry as never, core as never,
      { tempRoot: root, pollIntervalMs: 1000, enabled: false }, attemptCleanup
    );
    const genericCleanup = new FloorAssetCleanupService(prisma as never, raceStorage as never);
    const workerRun = importWorker.runOnce();
    let cleanupRun: Promise<{ processed: number; deleted: number }> | undefined;
    try {
      await putStarted;
      cleanupRun = genericCleanup.processPending(new Date(Date.now() + 10 * 60_000));
      await Promise.race([
        cleanupRun.then(() => undefined),
        deleteStarted
      ]);
      releasePut();
      await workerRun;
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ status: "review_required" });
      releaseDelete();
      await cleanupRun;

      expect(objects.has(uploadedKey)).toBe(true);
      await expect(prisma.floorAsset.findUniqueOrThrow({ where: { objectKey: uploadedKey } }))
        .resolves.toMatchObject({ status: "ready", cleanupStartedAt: null });
    } finally {
      releasePut(); releaseDelete();
      await Promise.allSettled([workerRun, cleanupRun ?? Promise.resolve()]);
      await importWorker.onModuleDestroy();
      await attemptCleanup.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rolls back a failed middle candidate chunk, retries, persists 2,000 rows and cleans the failed attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-worker-pg-"));
    const source = await sourceAsset();
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf", detectorProfileId: "generic-lighting-v1"
    } });
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    const objects = new Set<string>();
    const storageForWorker = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObjectFile: jest.fn(async (key: string) => { objects.add(key); }),
      verifyFloorRenderedObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("missing worker object");
      }),
      deleteObject: jest.fn(async (key: string) => { objects.delete(key); })
    };
    const converter = { convert: jest.fn(async ({ inputPath, outputPath }: { inputPath: string; outputPath: string }) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const registry = new FixedLightingDetectorRegistry();
    const profile = registry.get("generic-lighting-v1");
    const candidates = Array.from({ length: 2_000 }, (_, index) => ({
      sourceEntityId: `insert-${index}`, layerName: "LIGHT", blockName: "LED",
      x: index, y: index, rotation: 0, confidence: 0.9, method: "rule" as const
    }));
    const core = { execute: jest.fn(async ({ renderedPath }: { renderedPath: string }) => {
      await writeFile(renderedPath, "gzip-svg");
      return {
        profileId: "generic-lighting-v1" as const,
        profileVersion: profile.profileVersion!, profileDigest: profile.profileDigest!,
        modelEntityCount: 1, blockCount: 0, candidates,
        rendered: { sizeBytes: 8, rawSizeBytes: 64, sha256: "d".repeat(64), viewport: { width: 2_002, height: 2_002 },
          renderedOccurrences: 1, contentEncoding: "gzip" as const }
      };
    }) };
    const cleanup = new FloorImportAttemptCleanupService(prisma as never, storageForWorker as never, {
      tempRoot: root, pollIntervalMs: 1000, enabled: false
    });
    const makeWorker = () => new FloorImportWorkerService(
      prisma as never, storageForWorker as never, converter as never, registry, core,
      { tempRoot: root, pollIntervalMs: 1000, enabled: false }, cleanup
    );

    try {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION fail_cad_candidate_chunk() RETURNS trigger AS $$
        BEGIN
          IF NEW."sourceEntityId" = 'insert-750' THEN RAISE EXCEPTION 'forced middle chunk failure'; END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql
      `);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_cad_candidate_chunk BEFORE INSERT ON "FloorImportCandidate"
        FOR EACH ROW EXECUTE FUNCTION fail_cad_candidate_chunk()`);
      const first = makeWorker();
      await expect(first.runOnce()).resolves.toBe(true);
      await first.onModuleDestroy();
      await expect(prisma.floorImportCandidate.count({ where: { jobId: job.id } })).resolves.toBe(0);
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ status: "queued", attemptCount: 1 });

      await prisma.$executeRawUnsafe(`DROP TRIGGER fail_cad_candidate_chunk ON "FloorImportCandidate"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION fail_cad_candidate_chunk()`);
      const retry = makeWorker();
      await expect(retry.runOnce()).resolves.toBe(true);
      await retry.onModuleDestroy();
      await expect(prisma.floorImportCandidate.count({ where: { jobId: job.id } })).resolves.toBe(2_000);
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ status: "review_required", attemptCount: 2 });

      await cleanup.sweepAttempts(new Date(Date.now() + 10 * 60_000));
      expect(storageForWorker.deleteObject).toHaveBeenCalledWith(`floors/${floorId}/${job.id}-attempt-1.svg`);
      await expect(prisma.floorAsset.findFirst({ where: { objectKey: `floors/${floorId}/${job.id}-attempt-1.svg` } }))
        .resolves.toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_cad_candidate_chunk ON "FloorImportCandidate"`).catch(() => undefined);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS fail_cad_candidate_chunk()`).catch(() => undefined);
      await cleanup.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("reaps a late PUT during a bounded quiet period and then terminally retires the orphan tombstone", async () => {
    const killedFloor = await prisma.floor.create({ data: { siteId, name: "Killed import floor", level: 99 } });
    const sourceId = randomUUID();
    const source = await prisma.floorAsset.create({ data: {
      id: sourceId, floorId: killedFloor.id, kind: "original", status: "ready",
      objectKey: `floors/${killedFloor.id}/${sourceId}.dxf`, mimeType: "application/dxf",
      sizeBytes: 128n, sha256: "a".repeat(64), readyAt: new Date()
    } });
    const job = await prisma.floorImportJob.create({ data: {
      floorId: killedFloor.id, sourceAssetId: source.id, sourceFormat: "dxf"
    } });
    const claimed = await worker().claimNext();
    expect(claimed).toMatchObject({ id: job.id, attemptCount: 1, status: "processing" });
    const objects = new Set<string>();
    const attemptStorage = {
      deleteObject: jest.fn(async (key: string) => { objects.delete(key); })
    };
    const beforeKill = new FloorImportAttemptCleanupService(prisma as never, attemptStorage as never, {
      tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false
    });
    const attempt = await beforeKill.armAttempt(
      { jobId: job.id, floorId: killedFloor.id, attemptCount: 1 },
      { sizeBytes: 256, sha256: "b".repeat(64) },
      new Date("2026-09-17T00:00:00.000Z")
    );
    objects.add(attempt.objectKey); // Process dies after PUT and before the ready/link transaction.
    await prisma.floor.delete({ where: { id: killedFloor.id } });
    expect(await prisma.floorImportJob.findUnique({ where: { id: job.id } })).toBeNull();
    expect(await prisma.floorAsset.findUnique({ where: { id: attempt.assetId } })).toBeNull();
    await prisma.floorImportAttemptCleanup.update({
      where: { jobId_attemptCount: { jobId: job.id, attemptCount: 1 } },
      data: { nextAttemptAt: new Date(0) }
    });

    const restarted = new FloorImportAttemptCleanupService(prisma as never, attemptStorage as never, {
      tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false
    });
    const firstSweepAt = new Date("2026-09-17T01:00:00.000Z");
    await restarted.sweepAttempts(firstSweepAt);
    expect(objects).not.toContain(attempt.objectKey);
    expect(await prisma.floorAsset.findUnique({ where: { id: attempt.assetId } })).toBeNull();
    await expect(prisma.floorImportAttemptCleanup.findUniqueOrThrow({
      where: { jobId_attemptCount: { jobId: job.id, attemptCount: 1 } }
    })).resolves.toMatchObject({ committedAt: null, lastCleanedAt: firstSweepAt, lastError: null });

    objects.add(attempt.objectKey); // A paused transport completes after the first cleanup pass.
    await restarted.sweepAttempts(new Date(firstSweepAt.getTime() + 60_000));
    expect(objects).toContain(attempt.objectKey);
    expect(attemptStorage.deleteObject).toHaveBeenCalledTimes(1);

    const terminalSweepAt = new Date(firstSweepAt.getTime() + 15 * 60_000);
    await restarted.sweepAttempts(terminalSweepAt);
    expect(objects).not.toContain(attempt.objectKey);
    expect(attemptStorage.deleteObject).toHaveBeenCalledTimes(2);
    const terminal = await prisma.floorImportAttemptCleanup.findUniqueOrThrow({
      where: { jobId_attemptCount: { jobId: job.id, attemptCount: 1 } }
    });
    expect(terminal).toMatchObject({ committedAt: null, lastCleanedAt: terminalSweepAt, lastError: null });
    expect((terminal as typeof terminal & { cleanedAt: Date | null }).cleanedAt).toEqual(terminalSweepAt);

    await restarted.sweepAttempts(new Date(terminalSweepAt.getTime() + 60_000));
    expect(attemptStorage.deleteObject).toHaveBeenCalledTimes(2);
    await restarted.onModuleDestroy();
  });

  it("atomically applies the rendered background and reviews candidates without replacing fixtures or map objects", async () => {
    const source = await sourceAsset(); const renderedId = randomUUID(); const jobId = randomUUID();
    await prisma.floorAsset.create({ data: {
      id: renderedId, floorId, kind: "rendered", status: "ready", objectKey: `floors/${floorId}/${renderedId}.svg`,
      mimeType: "image/svg+xml", contentEncoding: null, sizeBytes: 256n, sha256: "b".repeat(64), readyAt: new Date()
    } });
    await prisma.floorImportJob.create({ data: {
      id: jobId, floorId, sourceAssetId: source.id, renderedAssetId: renderedId, sourceFormat: "dxf",
      status: "review_required", stage: "review_required", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), parserVersion: "ascii-dxf-v1", detectorVersion: "rule-v1",
      ...terminalProfile
    } });
    const candidateIds = Array.from({ length: 2_000 }, () => randomUUID());
    const acceptedId = candidateIds[0]; const rejectedId = candidateIds.at(-1)!;
    await prisma.floorImportCandidate.createMany({ data: candidateIds.map((id, index) => ({
      id, jobId, sourceEntityId: `insert-${index}`, layerName: "LIGHT", blockName: "LED",
      x: 10 + index, y: 20 + index, rotation: 0, confidence: 0.95, detectionMethod: "rule_based" as const,
      profileVersion: "test/1", profileDigest: "b".repeat(64)
    })) });
    await expect(service().listCandidates(user, floorId, jobId)).resolves.toMatchObject({ candidates: expect.any(Array) });
    expect((await service().listCandidates(user, floorId, jobId)).candidates).toHaveLength(2_000);
    const fixtureId = randomUUID(); const objectId = randomUUID();
    await prisma.fixture.create({ data: { id: fixtureId, floorId, siteId, name: "Existing fixture", ratedWatt: 40, x: 11, y: 22 } });
    await prisma.floorMapObject.create({ data: {
      id: objectId, floorId, type: "rectangle", x: 1, y: 2, width: 3, height: 4
    } });
    await prisma.floor.update({ where: { id: floorId }, data: {
      mapRevision: 4, editorLeaseFence: 8, editorLeaseTokenHash: hashEditorLeaseToken("lease-token"),
      editorLeaseHolderId: userId, editorLeaseHolderName: user.name,
      editorLeaseAcquiredAt: new Date(), editorLeaseExpiresAt: new Date(Date.now() + 60_000)
    } });

    const applied = await service().apply(user, floorId, jobId, {
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8, candidateIds: candidateIds.slice(0, 1_302)
    });
    expect(applied).toMatchObject({ status: "completed", revision: 5 });
    expect(storage.readFloorRenderedMetadata).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ contentEncoding: null }));
    expect(applied.acceptedCandidateIds).toHaveLength(1_302);
    expect(new Set(applied.acceptedCandidateIds)).toEqual(new Set(candidateIds.slice(0, 1_302)));

    await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: jobId } })).resolves.toMatchObject({
      status: "completed", appliedAt: expect.any(Date), completedAt: expect.any(Date)
    });
    expect(await prisma.floorImportCandidate.findMany({ where: { jobId }, orderBy: { id: "asc" }, select: { id: true, reviewStatus: true, reviewedAt: true } }))
      .toEqual(expect.arrayContaining([
        { id: acceptedId, reviewStatus: "accepted", reviewedAt: expect.any(Date) },
        { id: rejectedId, reviewStatus: "rejected", reviewedAt: expect.any(Date) }
      ]));
    await expect(prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).resolves.toMatchObject({ x: 11, y: 22 });
    await expect(prisma.floorMapObject.findUniqueOrThrow({ where: { id: objectId } })).resolves.toMatchObject({ x: 1, y: 2, width: 3, height: 4 });
    await expect(prisma.floor.findUniqueOrThrow({ where: { id: floorId } })).resolves.toMatchObject({ mapRevision: 5 });
    await expect(prisma.floorPlan.findUniqueOrThrow({ where: { floorId } })).resolves.toMatchObject({
      width: 640, height: 480, imageUrl: `/api/floors/${floorId}/assets/${renderedId}/content`
    });
    await expect(prisma.floorMapRevision.findUniqueOrThrow({ where: { floorId_revision: { floorId, revision: 5 } } }))
      .resolves.toMatchObject({ changedBy: userId });
    await expect(prisma.auditLog.findFirstOrThrow({ where: { targetId: jobId, action: "floor_import.applied" } }))
      .resolves.toMatchObject({ actorId: userId, outcome: "success" });
  });

  it("allows an existing rendered SVG to retain an identity ledger", async () => {
    const source = await sourceAsset(); const rendered = await renderedAsset();
    await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, renderedAssetId: rendered.id, sourceFormat: "dxf",
      status: "review_required", stage: "review_required", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), ...terminalProfile
    } });
    await expect(prisma.floorAsset.update({
      where: { id: rendered.id }, data: { contentEncoding: null }
    })).resolves.toMatchObject({ contentEncoding: null });
  });

  it("enforces admin, viewer, tenant, session, and transaction-time permission boundaries over real HTTP", async () => {
    const viewer = await prisma.user.create({ data: {
      organizationId, loginId: `cad_viewer_${randomUUID()}`, name: "CAD Viewer", passwordHash: "unused", role: "viewer"
    } });
    await prisma.siteMembership.create({ data: { siteId, userId: viewer.id, accessLevel: "read" } });
    const otherOrganization = await prisma.organization.create({ data: { name: "Other CAD tenant", type: "customer" } });
    const otherAdmin = await prisma.user.create({ data: {
      organizationId: otherOrganization.id, loginId: `other_cad_${randomUUID()}`, name: "Other Admin", passwordHash: "unused", role: "admin"
    } });
    await prisma.site.create({ data: { organizationId: otherOrganization.id, adminUserId: otherAdmin.id, name: "Other CAD site" } });
    const replacement = await prisma.user.create({ data: {
      organizationId, loginId: `replacement_${randomUUID()}`, name: "Replacement Admin", passwordHash: "unused", role: "admin"
    } });
    const source = await sourceAsset("application/dwg", PROVIDED_SAMPLE_DWG_SHA256);
    const module = await Test.createTestingModule({ imports: [FloorImportModule] })
      .overrideProvider(PrismaService).useValue(prisma)
      .overrideProvider(RedisProvider).useValue({ onModuleInit: () => undefined, onModuleDestroy: () => undefined })
      .overrideProvider(ObjectStorageService).useValue(storage)
      .overrideProvider(CAD_IMPORT_WORKER_OPTIONS).useValue({ tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false })
      .compile();
    const app: INestApplication = module.createNestApplication({ logger: false });
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const cookie = async (id: string) => {
      const token = randomUUID();
      await prisma.session.create({ data: {
        userId: id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000)
      } });
      return `${AuthService.sessionCookieName}=${token}`;
    };
    const send = (method: string, path: string, session?: string, body?: unknown) => fetch(`${base}${path}`, {
      method, headers: { "content-type": "application/json", ...(session ? { cookie: session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const adminCookie = await cookie(userId); const viewerCookie = await cookie(viewer.id); const otherCookie = await cookie(otherAdmin.id);
    try {
      const collection = `/floors/${floorId}/import-jobs`;
      expect((await send("POST", collection, undefined, { sourceAssetId: source.id, sourceFormat: "dwg" })).status).toBe(401);
      const createdResponse = await send("POST", collection, adminCookie, { sourceAssetId: source.id, sourceFormat: "dwg" });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { jobId: string; detectorProfileId: string };
      expect(created.detectorProfileId).toBe("site-drawing-20260803-v1");
      expect((await send("GET", `${collection}/${created.jobId}`, viewerCookie)).status).toBe(200);
      expect((await send("GET", `${collection}/${created.jobId}/candidates`, viewerCookie)).status).toBe(200);
      const viewerSource = await sourceAsset();
      expect((await send("POST", collection, viewerCookie, { sourceAssetId: viewerSource.id, sourceFormat: "dxf" })).status).toBe(403);
      expect((await send("POST", `${collection}/${created.jobId}/cancel`, viewerCookie)).status).toBe(403);
      expect((await send("GET", `${collection}/${created.jobId}`, otherCookie)).status).toBe(404);

      const raceFloor = await prisma.floor.create({ data: { siteId, name: "CAD race floor", level: 2 } });
      const raceSourceId = randomUUID();
      await prisma.floorAsset.create({ data: {
        id: raceSourceId, floorId: raceFloor.id, kind: "original", status: "ready",
        objectKey: `floors/${raceFloor.id}/${raceSourceId}.dxf`, mimeType: "application/dxf",
        sizeBytes: 128n, sha256: "c".repeat(64), readyAt: new Date()
      } });
      const revoker = new PrismaClient({ datasourceUrl: databaseUrl });
      let release!: () => void; let locked!: () => void;
      const releaseGate = new Promise<void>(resolve => { release = resolve; });
      const siteLocked = new Promise<void>(resolve => { locked = resolve; });
      const revoke = revoker.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`;
        locked();
        await releaseGate;
        await tx.site.update({ where: { id: siteId }, data: { adminUserId: replacement.id } });
      }, { timeout: 10_000 });
      await siteLocked;
      const raced = send("POST", `/floors/${raceFloor.id}/import-jobs`, adminCookie, {
        sourceAssetId: raceSourceId, sourceFormat: "dxf"
      });
      try {
        await waitForSiteLockWait(prisma, 3000);
      } finally { release(); }
      await revoke;
      expect((await raced).status).toBe(404);
      expect(await prisma.floorImportJob.count({ where: { floorId: raceFloor.id } })).toBe(0);
      await revoker.$disconnect();
    } finally { await app.close(); }
  }, 30_000);
});

async function waitForSiteLockWait(prisma: PrismaClient, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::integer AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "Site"%' AND query LIKE '%FOR UPDATE%'
    `;
    if (rows[0]?.waiting > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("floor import request did not reach the Site authorization lock");
}
