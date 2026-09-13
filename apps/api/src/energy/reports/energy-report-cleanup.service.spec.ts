import { PrismaClient } from "@prisma/client";
import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EnergyReportCleanupService } from "./energy-report-cleanup.service";
import { ObjectStorageService } from "../../storage/object-storage.service";
import { disposablePostgres } from "../../../test/support/disposable-postgres";
import { Logger } from "@nestjs/common";

const databaseUrl = process.env.ENERGY_REPORT_TEST_DATABASE_URL;
const selfOwned = process.env.REPORT_CLEANUP_TEST === "1";
(selfOwned || databaseUrl ? describe : describe.skip).each(["UTC", "Asia/Seoul"])("report retention with isolated PostgreSQL in %s", timeZone => {
  const organizationId = randomUUID(); const siteId = randomUUID();
  const now = new Date("2026-09-12T00:00:00.000Z");
  const day = 86_400_000;
  let prisma: PrismaClient;
  let cluster: Awaited<ReturnType<typeof disposablePostgres>> | undefined;
  let service: EnergyReportCleanupService;
  let logs: jest.SpyInstance;
  const objects = new Set<string>();
  let failKey: string | undefined;
  let failHeadKey: string | undefined;
  let deleting: (() => Promise<void>) | undefined;
  const key = (id: string, n: number, format = "xlsx") => `reports/${siteId}/${id}/attempt-${n}.${format}`;
  const enqueue = async (extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const status = extra.status ?? "completed";
    const terminalFile = status === "completed" || status === "expired";
    const job = await prisma.energyReportJob.create({ data: {
      id, siteId, requestedByActorId: randomUUID(), requestedByLoginIdSnapshot: "retention",
      requestHash: "a".repeat(64), format: "xlsx", status: "completed", attemptCount: 3,
      requestSnapshot: {}, objectKey: terminalFile ? key(id, 3) : null, createdAt: new Date(now.getTime() - 8 * day),
      progressPercent: terminalFile ? 100 : status === "processing" ? 1 : 0,
      startedAt: status === "queued" ? null : new Date(now.getTime() - 8 * day),
      completedAt: terminalFile ? new Date(now.getTime() - 7 * day) : null,
      expiresAt: terminalFile ? now : null, failureCode: status === "failed" ? "REPORT_GENERATION_FAILED" : null,
      leaseOwner: status === "processing" ? "worker" : null,
      leaseExpiresAt: status === "processing" ? now : null,
      ...(terminalFile ? { dataSnapshot: {}, documentSnapshot: { contentFingerprint: "a".repeat(64) },
        contentFingerprint: "a".repeat(64), contentSha256: "a".repeat(64), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 1 } : {}),
      ...extra
    } });
    for (let n = 1; n <= job.attemptCount; n++) objects.add(key(id, n, job.format));
    return job;
  };
  beforeAll(async () => {
    let url = databaseUrl!;
    if (selfOwned) {
      cluster = await disposablePostgres();
      url = cluster.database();
      expect(cluster.deploy(url, "20260916_report_operations_metadata").status).toBe(0);
      const legacyId = randomUUID();
      cluster.sql(url, `INSERT INTO "EnergyReportObjectCleanup" ("reportId", "siteId", "objectKeys", "lastCleanedAt", "updatedAt")
        VALUES ('${legacyId}', '${siteId}', '["${key(legacyId, 1)}"]', '2026-09-01', '2026-09-01')`);
      expect(cluster.deploy(url).status).toBe(0);
      const upgraded = JSON.parse(cluster.sql(url, `SELECT row_to_json(c) FROM "EnergyReportObjectCleanup" c WHERE "reportId" = '${legacyId}'`));
      expect(upgraded).toMatchObject({ deleteAttemptCount: 0, deleteRetryCount: 0, deleteFailureCount: 0,
        deletedObjectCount: 0, deletedBytes: 0, latePutObjectCount: 0, latePutBytes: 0,
        lastAttemptAt: null, lastCleanedAt: "2026-09-01T00:00:00" });
      cluster.sql(url, `DELETE FROM "EnergyReportObjectCleanup" WHERE "reportId" = '${legacyId}'`);
    }
    const connection = new URL(url);
    connection.searchParams.set("options", `-c timezone=${timeZone}`);
    prisma = new PrismaClient({ datasourceUrl: connection.toString() });
    expect(await prisma.$queryRawUnsafe('SHOW TimeZone')).toEqual([{ TimeZone: timeZone }]);
    await prisma.organization.create({ data: { id: organizationId, name: "Task 8 isolated", type: "customer" } });
    await prisma.site.create({ data: { id: siteId, organizationId, name: "Retention" } });
    const storage = new ObjectStorageService({ send: async (command: unknown) => {
      if (!(command instanceof DeleteObjectCommand || command instanceof HeadObjectCommand) || command.input.Bucket !== "private-reports") throw new Error("wrong storage boundary");
      if (command instanceof HeadObjectCommand) {
        if (command.input.Key === failHeadKey) throw new Error("HEAD secret endpoint detail");
        if (!objects.has(command.input.Key!)) throw Object.assign(new Error("secret missing object"), { $metadata: { httpStatusCode: 404 } });
        return { ContentLength: 10 };
      }
      if (command.input.Key === failKey) throw new Error("secret endpoint detail");
      await deleting?.();
      objects.delete(command.input.Key!); return {};
    } } as never, { bucket: "public-floors", reportBucket: "private-reports", publicBaseUrl: "https://public.example" });
    service = new EnergyReportCleanupService(prisma as never, storage);
  }, 60_000);
  beforeEach(async () => {
    logs = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await prisma.energyReportJob.deleteMany({ where: { siteId } });
    await prisma.energyReportObjectCleanup.deleteMany({ where: { siteId } });
    objects.clear(); failKey = undefined; failHeadKey = undefined; deleting = undefined;
  });
  afterEach(() => logs?.mockRestore());
  afterAll(async () => {
    try {
      if (prisma) {
        await prisma.site.deleteMany({ where: { id: siteId } });
        await prisma.energyReportObjectCleanup.deleteMany({ where: { siteId } });
        await prisma.organization.deleteMany({ where: { id: organizationId } });
      }
    } finally {
      try { await prisma?.$disconnect(); } finally { cluster?.stop(); }
    }
  });

  it("expires all attempt objects exactly at seven days while retaining metadata", async () => {
    const expired = await enqueue();
    const fresh = await enqueue({ expiresAt: new Date(now.getTime() + 1) });
    await service.prune(now);
    expect([...objects].sort()).toEqual([key(fresh.id, 1), key(fresh.id, 2), key(fresh.id, 3)]);
    expect(await prisma.energyReportJob.findUnique({ where: { id: expired.id } })).toMatchObject({ status: "expired", objectDeletedAt: now });
    await service.prune(now);
    expect(await prisma.energyReportJob.count({ where: { siteId } })).toBe(2);
  });
  it("keeps every object reference and metadata retryable when a partial S3 deletion fails", async () => {
    const job = await enqueue({ createdAt: new Date(now.getTime() - 90 * day) });
    failKey = key(job.id, 2);
    expect(await service.prune(now)).toMatchObject({ failed: 1, purged: 0 });
    expect(await prisma.energyReportJob.findUnique({ where: { id: job.id } })).toMatchObject({ objectKey: key(job.id, 3), objectDeletedAt: null });
    expect(objects.has(key(job.id, 3))).toBe(true);
    expect(await prisma.energyReportObjectCleanup.findUniqueOrThrow({ where: { reportId: job.id } })).toMatchObject({
      deleteAttemptCount: 1, deleteRetryCount: 0, deleteFailureCount: 1, lastAttemptAt: now,
      lastObservedObjectCount: 2, lastObservedBytes: 20n, deletedObjectCount: 1, deletedBytes: 10n,
      latePutObjectCount: 0, latePutBytes: 0n, lastError: "REPORT_OBJECT_CLEANUP_FAILED"
    });
    failKey = undefined;
    expect(await service.prune(new Date(now.getTime() + 60_000))).toMatchObject({ purged: 1 });
    expect(objects.size).toBe(0);
    expect(await prisma.energyReportJob.findUnique({ where: { id: job.id } })).toBeNull();
    expect(await prisma.energyReportObjectCleanup.findUniqueOrThrow({ where: { reportId: job.id } })).toMatchObject({
      deleteAttemptCount: 2, deleteRetryCount: 1, deleteFailureCount: 1,
      lastObservedObjectCount: 2, lastObservedBytes: 20n, deletedObjectCount: 3, deletedBytes: 30n,
      latePutObjectCount: 0, latePutBytes: 0n, lastError: null
    });
  });
  it("purges ninety-day metadata only after deleting lost attempts even without an objectKey", async () => {
    const old = await enqueue({ status: "failed", objectKey: null, format: "pdf", createdAt: new Date(now.getTime() - 90 * day) });
    const recent = await enqueue({ status: "failed", objectKey: null, attemptCount: 1, createdAt: new Date(now.getTime() - 90 * day + 1) });
    await service.prune(now);
    expect(objects.size).toBe(0);
    expect(await prisma.energyReportJob.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.energyReportJob.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
  it("never removes queued or processing attempts even when their lease and metadata are old", async () => {
    await enqueue({ status: "queued", createdAt: new Date(now.getTime() - 100 * day) });
    await enqueue({ status: "processing", leaseExpiresAt: new Date(0), createdAt: new Date(now.getTime() - 100 * day) });
    expect(await service.prune(now)).toMatchObject({ processed: 0 });
    expect(objects.size).toBe(6);
  });
  it("limits one sweep to fifty jobs and eventually advances beyond them", async () => {
    for (let n = 0; n < 51; n++) await enqueue({ createdAt: new Date(now.getTime() - 90 * day) });
    expect(await service.prune(now)).toMatchObject({ processed: 50, purged: 50, metrics: { backlogCount: 1, uninventoriedCount: 1 } });
    expect(await prisma.energyReportJob.count({ where: { siteId } })).toBe(1);
    await service.prune(now);
    expect(objects.size).toBe(0);
  });
  it("releases database row locks during S3 deletion while durable ownership excludes another cleanup", async () => {
    const job = await enqueue({ createdAt: new Date(now.getTime() - 90 * day) });
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    deleting = async () => { started(); await gate; };
    const first = service.prune(now);
    try {
      await entered;
      await prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`;
        await tx.$queryRaw`SELECT "id" FROM "EnergyReportJob" WHERE "id" = ${job.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT "reportId" FROM "EnergyReportObjectCleanup" WHERE "reportId" = ${job.id} FOR UPDATE`;
      });
      expect(await service.prune(now)).toMatchObject({ processed: 0 });
      expect(await prisma.energyReportJob.findUnique({ where: { id: job.id } })).not.toBeNull();
    } finally { release(); await first; }
    expect(objects.size).toBe(0);
  });
  it("keeps reaping exact attempt keys after the ninety-day metadata has already been purged", async () => {
    const job = await enqueue({ createdAt: new Date(now.getTime() - 90 * day) });
    await service.prune(now);
    expect(await prisma.energyReportJob.findUnique({ where: { id: job.id } })).toBeNull();
    objects.add(key(job.id, 1)); objects.add(key(job.id, 3));
    await service.prune(new Date(now.getTime() + 60_000));
    expect(objects.size).toBe(0);
    expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: job.id } })).toMatchObject({
      objectKeys: [key(job.id, 1), key(job.id, 2), key(job.id, 3)], deleteAttemptCount: 2, deleteRetryCount: 0,
      deletedObjectCount: 5, deletedBytes: 50n, latePutObjectCount: 2, latePutBytes: 20n
    });
    await service.prune(new Date(now.getTime() + 120_000));
    expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: job.id } })).toMatchObject({
      deleteAttemptCount: 3, deleteFailureCount: 0, lastObservedObjectCount: 0, lastObservedBytes: 0n,
      deletedObjectCount: 5, deletedBytes: 50n, latePutObjectCount: 2, latePutBytes: 20n
    });
  });
  it("backfills a completed legacy attempt-1 cleanup and reaps later attempt-2/3 uploads", async () => {
    const reportId = randomUUID();
    const schema = `report_cleanup_migration_${randomUUID().replaceAll("-", "")}`;
    const migration = readFileSync(resolve(process.cwd(), "prisma/migrations/20260913_report_object_cleanup_ledger/migration.sql"), "utf8");
    const objectKeys = await prisma.$transaction(async tx => {
      // Execute the actual migration in a fresh schema of the isolated test DB.
      // The legacy site and report are already gone; only a completed marker remains.
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      await tx.$executeRawUnsafe('CREATE TABLE "SiteDeletionCleanup" ("objectKeys" JSONB, "completedAt" TIMESTAMP)');
      await tx.$executeRaw`INSERT INTO "SiteDeletionCleanup" VALUES (${JSON.stringify([key(reportId, 1)])}::jsonb, CURRENT_TIMESTAMP)`;
      for (const statement of migration.split(";").filter(part => part.trim())) await tx.$executeRawUnsafe(statement);
      const rows = await tx.$queryRaw<Array<{ objectKeys: string[] }>>`SELECT "objectKeys" FROM "EnergyReportObjectCleanup" WHERE "reportId" = ${reportId}`;
      await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      return rows[0].objectKeys;
    });
    expect(objectKeys.sort()).toEqual([key(reportId, 1), key(reportId, 2), key(reportId, 3)]);
    await prisma.energyReportObjectCleanup.create({ data: { reportId, siteId, objectKeys, nextAttemptAt: now } });
    await service.prune(now); // Even a completed first ledger pass is not a terminal tombstone.
    objects.add(key(reportId, 2)); objects.add(key(reportId, 3));
    await service.prune(new Date(now.getTime() + 60_000));
    expect(objects.size).toBe(0);
  });
  it("recovers an expired cleanup lease and fences a delayed old owner from purging metadata", async () => {
    const job = await enqueue({ createdAt: new Date(now.getTime() - 90 * day) });
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    deleting = async () => { deleting = undefined; started(); await gate; };
    const first = service.prune(now);
    try {
      await entered;
      const old = await prisma.energyReportObjectCleanup.findUniqueOrThrow({ where: { reportId: job.id } });
      await prisma.energyReportObjectCleanup.update({ where: { reportId: job.id }, data: { leaseExpiresAt: new Date(0) } });
      failKey = key(job.id, 2);
      expect(await service.prune(now)).toMatchObject({ failed: 1 });
      failKey = undefined;
      release();
      expect(await first).toMatchObject({ purged: 0, ownershipLost: 1 });
      expect(await prisma.energyReportJob.findUnique({ where: { id: job.id } })).not.toBeNull();
      expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: job.id } })).toMatchObject({
        leaseOwner: null, lastError: "REPORT_OBJECT_CLEANUP_FAILED", lastCleanedAt: null,
        objectKeys: old.objectKeys, deleteAttemptCount: 1, deleteFailureCount: 1,
        lastObservedObjectCount: 2, lastObservedBytes: 20n, deletedObjectCount: 1, deletedBytes: 10n
      });
      expect(await service.prune(new Date(now.getTime() + 60_000))).toMatchObject({ purged: 1 });
    } finally { release(); await first; }
  });

  it("claims an initial fixed-time inventory now and leaves a future retry due at exactly its UTC boundary", async () => {
    const job = await enqueue();
    expect(await service.prune(now)).toMatchObject({ processed: 1, failed: 0 });
    expect(await service.prune(new Date(now.getTime() + 59_999))).toMatchObject({ processed: 0 });
    expect(await service.prune(new Date(now.getTime() + 60_000))).toMatchObject({ processed: 1, failed: 0 });
    expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: job.id } })).toMatchObject({
      deleteAttemptCount: 2, deleteFailureCount: 0, lastAttemptAt: new Date(now.getTime() + 60_000)
    });
  });

  it("keeps a HEAD failure retryable without deleting unmeasured objects or leaking storage errors", async () => {
    const job = await enqueue();
    failHeadKey = key(job.id, 1);
    const result = await service.prune(now);
    expect(result).toMatchObject({ failed: 1, metrics: {
      ledgerCount: 1, backlogCount: 1, dueCount: 0, retryPendingCount: 1,
      deleteAttemptCount: "1", deleteRetryCount: "0", deleteFailureCount: "1", deletedBytes: "0"
    } });
    expect(objects.size).toBe(3);
    expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: job.id } })).toMatchObject({
      lastObservedObjectCount: 0, lastObservedBytes: 0n, deletedObjectCount: 0, deletedBytes: 0n,
      lastError: "REPORT_OBJECT_CLEANUP_FAILED", lastCleanedAt: null
    });
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ event: "report_object_cleanup_sweep", ...result }));
    expect(JSON.stringify(logs.mock.calls)).not.toContain("secret");
  });

  it("reports oldest due age for leased backlog without claiming it", async () => {
    const reportId = randomUUID();
    await prisma.energyReportObjectCleanup.create({ data: { reportId, siteId, objectKeys: [key(reportId, 1)],
      nextAttemptAt: new Date(now.getTime() - 5000), leaseOwner: "other-worker", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    expect(await service.prune(now)).toMatchObject({ processed: 0, metrics: {
      ledgerCount: 1, backlogCount: 1, dueCount: 1, oldestDueAgeMs: 5000, retryPendingCount: 0
    } });
  });

  it("defaults new tombstones to UTC and rejects negative or inconsistent counters", async () => {
    const reportId = randomUUID();
    const before = Date.now();
    const row = await prisma.energyReportObjectCleanup.create({ data: { reportId, siteId, objectKeys: [key(reportId, 1)] } });
    const after = Date.now();
    for (const value of [row.createdAt, row.nextAttemptAt]) {
      expect(value.getTime()).toBeGreaterThanOrEqual(before);
      // PostgreSQL TIMESTAMP(3) rounds sub-milliseconds; Date.now() truncates them.
      expect(value.getTime()).toBeLessThanOrEqual(after + 1);
    }
    await expect(prisma.$executeRaw`UPDATE "EnergyReportObjectCleanup" SET "deletedBytes" = -1 WHERE "reportId" = ${reportId}`)
      .rejects.toMatchObject({ meta: { code: "23514" } });
    await expect(prisma.$executeRaw`UPDATE "EnergyReportObjectCleanup" SET "deleteFailureCount" = 1 WHERE "reportId" = ${reportId}`)
      .rejects.toMatchObject({ meta: { code: "23514" } });
    await expect(prisma.$executeRaw`UPDATE "EnergyReportObjectCleanup" SET "latePutObjectCount" = 1 WHERE "reportId" = ${reportId}`)
      .rejects.toMatchObject({ meta: { code: "23514" } });
  });

  it("counts failed late deletes once they succeed and keeps byte totals beyond a 32-bit integer", async () => {
    const job = await enqueue();
    await service.prune(now);
    await prisma.$executeRaw`UPDATE "EnergyReportObjectCleanup" SET "deletedBytes" = 2147483640 WHERE "reportId" = ${job.id}`;
    objects.add(key(job.id, 1));
    failKey = key(job.id, 1);
    await service.prune(new Date(now.getTime() + 60_000));
    expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: job.id } })).toMatchObject({
      latePutObjectCount: 0, latePutBytes: 0n, lastObservedBytes: 10n, deletedBytes: 2147483640n
    });
    failKey = undefined;
    const result = await service.prune(new Date(now.getTime() + 120_000));
    expect(result).toMatchObject({ retried: 1, metrics: {
      deleteAttemptCount: "3", deleteRetryCount: "1", deleteFailureCount: "1",
      latePutObjectCount: "1", latePutBytes: "10", deletedBytes: "2147483650", retryPendingCount: 0
    } });
    expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: job.id } })).toMatchObject({
      latePutObjectCount: 1, latePutBytes: 10n, deletedBytes: 2147483650n
    });
  });
});
