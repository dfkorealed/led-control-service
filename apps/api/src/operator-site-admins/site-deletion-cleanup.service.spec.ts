import { SiteDeletionCleanupService } from "./site-deletion-cleanup.service";
import { ConflictException } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { ObjectStorageService } from "../storage/object-storage.service";
import { EnergyReportWorkerService } from "../energy/reports/energy-report-worker.service";
import { EnergyReportJobsService } from "../energy/reports/energy-report-jobs.service";

describe("SiteDeletionCleanupService", () => {
  it("deletes assets, revokes every inventory certificate, and completes the durable job", async () => {
    const prisma = createPrisma({
      id: "cleanup-1",
      objectKeys: ["floors/floor-1/map.png"],
      inventoryIds: ["inventory-1"],
      attempts: 1,
      createdAt: new Date(Date.now() - 10 * 60 * 1_000)
    });
    const storage = { deleteObject: jest.fn().mockResolvedValue({}) };
    const certificates = { revokeInventoryCertificates: jest.fn().mockResolvedValue({ revoked: 2 }) };
    const service = new SiteDeletionCleanupService(prisma as never, certificates as never, storage as never);

    await expect(service.processNow("cleanup-1")).resolves.toEqual({ status: "completed" });

    expect(storage.deleteObject).toHaveBeenCalledWith("floors/floor-1/map.png");
    expect(certificates.revokeInventoryCertificates).toHaveBeenCalledWith("inventory-1");
    expect(prisma.siteDeletionCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: { completedAt: expect.any(Date), lockedAt: null, leaseExpiresAt: null, lastError: null }
    });
  });

  it("keeps a failed cleanup pending with a bounded retry and sanitized error", async () => {
    const prisma = createPrisma({
      id: "cleanup-1",
      objectKeys: ["floors/floor-1/map.png"],
      inventoryIds: [],
      attempts: 1,
      createdAt: new Date(Date.now() - 10 * 60 * 1_000)
    });
    const storage = { deleteObject: jest.fn().mockRejectedValue(new Error("secret endpoint detail")) };
    const service = new SiteDeletionCleanupService(
      prisma as never,
      { revokeInventoryCertificates: jest.fn() } as never,
      storage as never
    );

    await expect(service.processNow("cleanup-1")).resolves.toEqual({ status: "pending" });
    expect(prisma.siteDeletionCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: expect.objectContaining({
        nextAttemptAt: expect.any(Date),
        lockedAt: null,
        leaseExpiresAt: null,
        lastError: "EXTERNAL_CLEANUP_FAILED"
      })
    });
  });

  it("does not process a job already leased by another API instance", async () => {
    const prisma = createPrisma({
      id: "cleanup-1", objectKeys: [], inventoryIds: [], attempts: 1, createdAt: new Date()
    });
    prisma.siteDeletionCleanup.updateMany.mockResolvedValue({ count: 0 });
    const storage = { deleteObject: jest.fn() };
    const service = new SiteDeletionCleanupService(
      prisma as never,
      { revokeInventoryCertificates: jest.fn() } as never,
      storage as never
    );

    await expect(service.processNow("cleanup-1")).resolves.toEqual({ status: "skipped" });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("waits for outstanding presigned upload URLs to expire before deleting objects", async () => {
    const prisma = createPrisma({
      id: "cleanup-1",
      objectKeys: ["floors/floor-1/pending.png"],
      inventoryIds: ["inventory-1"],
      attempts: 1,
      createdAt: new Date()
    });
    const storage = { deleteObject: jest.fn() };
    const certificates = { revokeInventoryCertificates: jest.fn().mockResolvedValue({ revoked: 1 }) };
    const service = new SiteDeletionCleanupService(prisma as never, certificates as never, storage as never);

    await expect(service.processNow("cleanup-1")).resolves.toEqual({ status: "pending" });

    expect(certificates.revokeInventoryCertificates).toHaveBeenCalledWith("inventory-1");
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(prisma.siteDeletionCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: expect.objectContaining({
        nextAttemptAt: expect.any(Date),
        lastError: "UPLOAD_URL_EXPIRY_PENDING"
      })
    });
  });
});

function createPrisma(job: { id: string; objectKeys: string[]; inventoryIds: string[]; attempts: number; createdAt: Date }) {
  return {
    siteDeletionCleanup: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockResolvedValue(job),
      findMany: jest.fn().mockResolvedValue([])
    }
  };
}

const reportDatabaseUrl = process.env.ENERGY_REPORT_TEST_DATABASE_URL;
(reportDatabaseUrl ? describe : describe.skip)("durable report site deletion barrier", () => {
  const organizationId = randomUUID(); const siteId = randomUUID(); const actorId = randomUUID();
  let prisma: PrismaClient; let service: SiteDeletionCleanupService; let storage: ObjectStorageService;
  let fail = false; let deleting: (() => Promise<void>) | undefined;
  const objects = new Set<string>();
  const key = (id: string, n: number) => `reports/${siteId}/${id}/attempt-${n}.pdf`;
  const enqueue = async (processing = false) => {
    const job = await prisma.energyReportJob.create({ data: { siteId, requestedByActorId: actorId,
      requestedByLoginIdSnapshot: "reader", requestHash: randomUUID().replaceAll("-", "").repeat(2), format: "pdf", requestSnapshot: {},
      attemptCount: 3, ...(processing ? { status: "processing", progressPercent: 25, startedAt: new Date(), leaseOwner: "live-worker", leaseExpiresAt: new Date(Date.now() + 30_000) } : {}) } });
    for (let n = 1; n <= 3; n++) objects.add(key(job.id, n));
    return job;
  };
  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: reportDatabaseUrl });
    await prisma.organization.create({ data: { id: organizationId, name: "Deletion isolated", type: "customer" } });
    await prisma.user.create({ data: { id: actorId, organizationId, loginId: `delete-${actorId}`, name: "Reader", role: "admin", passwordHash: "unused" } });
    await prisma.site.create({ data: { id: siteId, organizationId, adminUserId: actorId, name: "Deletion" } });
    storage = new ObjectStorageService({ send: async (command: unknown) => {
      if (!(command instanceof DeleteObjectCommand) || command.input.Bucket !== "private-reports") throw new Error("wrong bucket");
      if (fail) throw new Error("secret storage details");
      await deleting?.(); objects.delete(command.input.Key!); return {};
    } } as never, { bucket: "public-floors", reportBucket: "private-reports", publicBaseUrl: "https://public.example" });
    service = new SiteDeletionCleanupService(prisma as never, {} as never, storage);
  });
  beforeEach(async () => {
    await prisma.siteDeletionCleanup.deleteMany({ where: { siteId } });
    await prisma.energyReportJob.deleteMany({ where: { siteId } });
    await prisma.energyReportObjectCleanup.deleteMany({ where: { siteId } });
    objects.clear(); fail = false; deleting = undefined;
  });
  afterAll(async () => {
    await prisma.siteDeletionCleanup.deleteMany({ where: { siteId } });
    await prisma.site.delete({ where: { id: siteId } });
    await prisma.energyReportObjectCleanup.deleteMany({ where: { siteId } });
    await prisma.user.delete({ where: { id: actorId } });
    await prisma.organization.delete({ where: { id: organizationId } }); await prisma.$disconnect();
  });
  it("persists all attempt keys before external deletion and blocks queued claims and new report requests", async () => {
    const job = await enqueue();
    await prisma.energyReportJob.create({ data: { siteId, requestedByActorId: actorId, requestedByLoginIdSnapshot: "reader",
      requestHash: "c".repeat(64), format: "pdf", requestSnapshot: {} } });
    const prepared = await service.prepareReportDeletion(siteId);
    expect(prepared?.objectKeys.sort()).toEqual([key(job.id, 1), key(job.id, 2), key(job.id, 3)]);
    expect(objects.size).toBe(0);
    expect(await prisma.energyReportJob.count({ where: { siteId } })).toBe(2);
    const marker = await prisma.siteDeletionCleanup.findUnique({ where: { siteId } });
    expect(marker?.objectKeys).toEqual(expect.arrayContaining([key(job.id, 1), key(job.id, 2), key(job.id, 3)]));
    const worker = new EnergyReportWorkerService(prisma as never, storage, {} as never, {} as never);
    expect(await worker.claimNext()).toBeNull();
    const jobs = new EnergyReportJobsService(prisma as never, { assert: async () => undefined } as never, storage);
    await expect(jobs.create({ id: actorId, loginId: "reader" } as never, siteId,
      { from: "2026-09-01", to: "2026-09-02", scope: "site", identityId: siteId, format: "pdf" })).rejects.toBeInstanceOf(ConflictException);
    expect(await prisma.energyReportJob.count({ where: { siteId } })).toBe(2);
  });
  it.each([0, 1])("reserves all three private attempt keys for a pre-upgrade paused claim at attempt %s", async attemptCount => {
    const job = await enqueue();
    await prisma.energyReportJob.update({ where: { id: job.id }, data: { attemptCount } });
    await service.prepareReportDeletion(siteId);
    expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: job.id } })).toMatchObject({
      objectKeys: [key(job.id, 1), key(job.id, 2), key(job.id, 3)]
    });
  });
  it.each([false, true])("rejects processing work without deleting any files, including expired leases: %s", async expired => {
    const job = await enqueue(true);
    if (expired) await prisma.energyReportJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(0) } });
    await expect(service.prepareReportDeletion(siteId)).rejects.toBeInstanceOf(ConflictException);
    expect(objects.size).toBe(3);
    expect(await prisma.siteDeletionCleanup.findUnique({ where: { siteId } })).toBeNull();
  });
  it("preserves the site, report rows and durable target inventory on S3 failure, then retries idempotently", async () => {
    await enqueue(); fail = true;
    await expect(service.prepareReportDeletion(siteId)).rejects.toThrow();
    expect(await prisma.site.findUnique({ where: { id: siteId } })).not.toBeNull();
    expect(await prisma.energyReportJob.count({ where: { siteId } })).toBe(1);
    expect(await prisma.siteDeletionCleanup.findUnique({ where: { siteId } })).not.toBeNull();
    fail = false;
    await service.prepareReportDeletion(siteId); await service.prepareReportDeletion(siteId);
    expect(objects.size).toBe(0);
  });
  it("recovers processing stranded behind a committed barrier after an interrupted deletion", async () => {
    const job = await enqueue(true);
    await prisma.energyReportJob.update({ where: { id: job.id }, data: { attemptCount: 1, leaseExpiresAt: new Date(0) } });
    await prisma.siteDeletionCleanup.create({ data: { siteId, inventoryIds: [], objectKeys: [key(job.id, 1)], lastError: "REPORTS_BEFORE_SITE_DELETE" } });
    const worker = new EnergyReportWorkerService(prisma as never, storage, {} as never, {} as never);
    expect(await worker.claimNext()).toBeNull();
    expect(await prisma.energyReportJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: "failed", leaseOwner: null });
    fail = true;
    await expect(service.prepareReportDeletion(siteId)).rejects.toMatchObject({ status: 503 });
    fail = false;
    await expect(service.prepareReportDeletion(siteId)).resolves.toMatchObject({ objectKeys: [key(job.id, 1)] });
  });
  it("rechecks a committed deletion marker after a claim statement has already taken its PostgreSQL snapshot", async () => {
    const job = await enqueue();
    await prisma.energyReportJob.update({ where: { id: job.id }, data: { attemptCount: 1 } });
    const gated = new Proxy(prisma, { get(target, property) {
      if (property === "$queryRaw") return (query: Prisma.Sql) => {
        const strings = [...query.strings];
        // Test-only gate INSIDE the real SQL statement: PostgreSQL has already
        // fixed its MVCC snapshot, but has not acquired the candidate row lock.
        const gate = "snapshot_gate AS MATERIALIZED (SELECT pg_advisory_xact_lock(70912008::bigint))";
        strings[0] = strings[0].replace('FROM "EnergyReportJob" WHERE "attemptCount" < 3',
          'FROM "EnergyReportJob" CROSS JOIN snapshot_gate WHERE "attemptCount" < 3');
        strings[0] = /^\s*WITH\b/.test(strings[0]) ? strings[0].replace("WITH", `WITH ${gate},`) : `WITH ${gate} ${strings[0]}`;
        return target.$queryRaw(Prisma.sql(strings, ...query.values));
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const worker = new EnergyReportWorkerService(gated as never, storage, {} as never, {} as never);
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const blocker = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(70912008::bigint)::text`;
      locked(); await gate;
    });
    await acquired;
    const claim = worker.claimNext();
    try {
      let waiting = false;
      for (let n = 0; n < 200 && !waiting; n++) {
        const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE '%snapshot_gate%'
        ) AS waiting`;
        waiting = rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      fail = true;
      await expect(service.prepareReportDeletion(siteId)).rejects.toMatchObject({ status: 503 });
      expect(await prisma.siteDeletionCleanup.findUnique({ where: { siteId } })).not.toBeNull();
      release(); await blocker;
      expect(await claim).toBeNull();
      expect(await prisma.energyReportJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: "queued", attemptCount: 1 });
      fail = false;
      await expect(service.prepareReportDeletion(siteId)).resolves.toMatchObject({ objectKeys: [key(job.id, 1)] });
    } finally { release(); await blocker; await claim; }
  });
  it("commits the barrier and releases database locks before waiting for S3", async () => {
    const job = await enqueue();
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    deleting = async () => { started(); await gate; };
    const pending = service.prepareReportDeletion(siteId);
    try {
      await entered;
      expect(await prisma.siteDeletionCleanup.findUnique({ where: { siteId } })).not.toBeNull();
      await prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`;
        await tx.$queryRaw`SELECT "id" FROM "EnergyReportJob" WHERE "id" = ${job.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`;
      });
    } finally { release(); await pending; }
  });
  it("does not complete a pre-cascade marker before the final floor/inventory payload is committed", async () => {
    await enqueue();
    const prepared = await service.prepareReportDeletion(siteId);
    await prisma.siteDeletionCleanup.update({ where: { id: prepared.id }, data: { createdAt: new Date(0) } });
    expect(await service.processNow(prepared.id)).toEqual({ status: "pending" });
    expect(await prisma.siteDeletionCleanup.findUnique({ where: { id: prepared.id } })).toMatchObject({ completedAt: null });
  });
});
