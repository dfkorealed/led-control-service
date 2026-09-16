import { ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { FloorImportService } from "./floor-import.service";
import { FloorImportWorkerService } from "./floor-import-worker.service";

const enabled = process.env.FLOOR_IMPORT_INTEGRATION === "1";
(enabled ? describe : describe.skip)("floor import PostgreSQL lifecycle", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let prisma: PrismaClient;
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
    const databaseUrl = cluster.database();
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
});
