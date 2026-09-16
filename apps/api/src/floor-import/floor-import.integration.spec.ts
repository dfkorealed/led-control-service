import { ConflictException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditService } from "../audit/audit.service";
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
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    cluster?.stop();
  });

  async function sourceAsset(mimeType = "application/dxf") {
    const id = randomUUID();
    return prisma.floorAsset.create({ data: {
      id, floorId, kind: "original", status: "ready", objectKey: `floors/${floorId}/${id}.dxf`,
      mimeType, sizeBytes: 128n, sha256: "a".repeat(64), readyAt: new Date()
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
      putFloorRenderedObject: jest.fn(async (key: string) => {
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
    const detector = { detect: jest.fn().mockResolvedValue([]) };
    const attemptCleanup = new FloorImportAttemptCleanupService(prisma as never, raceStorage as never, {
      tempRoot: root, pollIntervalMs: 1000, enabled: false
    });
    const importWorker = new FloorImportWorkerService(
      prisma as never, raceStorage as never, converter as never, detector as never, detector as never,
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
      mimeType: "image/svg+xml", sizeBytes: 256n, sha256: "b".repeat(64), readyAt: new Date()
    } });
    await prisma.floorImportJob.create({ data: {
      id: jobId, floorId, sourceAssetId: source.id, renderedAssetId: renderedId, sourceFormat: "dxf",
      status: "review_required", stage: "review_required", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), parserVersion: "ascii-dxf-v1", detectorVersion: "rule-v1"
    } });
    const acceptedId = randomUUID(); const rejectedId = randomUUID();
    await prisma.floorImportCandidate.createMany({ data: [
      { id: acceptedId, jobId, sourceEntityId: "insert-1", layerName: "LIGHT", blockName: "LED", x: 10, y: 20, rotation: 0, confidence: 0.95, detectionMethod: "rule_based" },
      { id: rejectedId, jobId, sourceEntityId: "insert-2", layerName: "LIGHT", blockName: "LED", x: 30, y: 40, rotation: 0, confidence: 0.90, detectionMethod: "rule_based" }
    ] });
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

    await expect(service().apply(user, floorId, jobId, {
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8, candidateIds: [acceptedId]
    })).resolves.toMatchObject({ status: "completed", revision: 5, acceptedCandidateIds: [acceptedId] });

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
    const source = await sourceAsset();
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
      expect((await send("POST", collection, undefined, { sourceAssetId: source.id, sourceFormat: "dxf" })).status).toBe(401);
      const createdResponse = await send("POST", collection, adminCookie, { sourceAssetId: source.id, sourceFormat: "dxf" });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { jobId: string };
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
