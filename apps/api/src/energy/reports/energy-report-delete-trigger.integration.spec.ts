import { PrismaClient } from "@prisma/client";
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { EnergyReportCleanupService, recordReportCleanup } from "./energy-report-cleanup.service";
import { ObjectStorageService } from "../../storage/object-storage.service";

const databaseUrl = process.env.ENERGY_REPORT_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("report deletion trigger after full migration", () => {
  const organizationId = randomUUID();
  const sites: string[] = [];
  const objects = new Set<string>();
  let prisma: PrismaClient;
  let storage: ObjectStorageService;
  let cleanup: EnergyReportCleanupService;

  beforeAll(async () => {
    const connection = new URL(databaseUrl!);
    connection.searchParams.set("options", "-c timezone=Asia/Seoul");
    prisma = new PrismaClient({ datasourceUrl: connection.toString() });
    await prisma.organization.create({ data: { id: organizationId, name: "Legacy deletion trigger", type: "customer" } });
    storage = new ObjectStorageService({ send: async (command: unknown) => {
      if (command instanceof PutObjectCommand && command.input.Bucket === "private-reports") {
        objects.add(command.input.Key!); return {};
      }
      if (command instanceof DeleteObjectCommand && command.input.Bucket === "private-reports") {
        objects.delete(command.input.Key!); return {};
      }
      if (command instanceof HeadObjectCommand && command.input.Bucket === "private-reports") {
        if (!objects.has(command.input.Key!)) throw Object.assign(new Error("object absent"), { $metadata: { httpStatusCode: 404 } });
        return { ContentLength: Buffer.byteLength("late legacy upload") };
      }
      throw new Error("unexpected storage boundary");
    } } as never, { bucket: "public-floors", reportBucket: "private-reports", publicBaseUrl: "https://public.example" });
    cleanup = new EnergyReportCleanupService(prisma as never, storage);
  });
  afterEach(async () => {
    // DELETE/cascade itself now creates a tombstone, so remove test tombstones last.
    await prisma.site.deleteMany({ where: { id: { in: sites } } });
    await prisma.energyReportObjectCleanup.deleteMany({ where: { siteId: { in: sites.splice(0) } } });
    objects.clear();
  });
  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
  });
  const enqueue = async (format: "xlsx" | "pdf", attemptCount: number) => {
    const siteId = randomUUID(); sites.push(siteId);
    await prisma.site.create({ data: { id: siteId, organizationId, name: "Post-migration old API" } });
    return prisma.energyReportJob.create({ data: {
      siteId, requestedByActorId: randomUUID(), requestedByLoginIdSnapshot: "legacy",
      requestHash: "a".repeat(64), format, attemptCount, requestSnapshot: {},
      createdAt: new Date(Date.now() - 91 * 86_400_000),
      ...(attemptCount ? { status: "failed", startedAt: new Date(), failureCode: "REPORT_GENERATION_FAILED" } : {})
    } });
  };

  it.each([
    { deletion: "site cascade", format: "pdf" as const, attemptCount: 0 },
    { deletion: "manual DELETE", format: "xlsx" as const, attemptCount: 1 },
    { deletion: "legacy ninety-day DELETE", format: "pdf" as const, attemptCount: 3 }
  ])("reaps late uploads after $deletion by an old instance without runtime inventory", async ({ deletion, format, attemptCount }) => {
    const job = await enqueue(format, attemptCount);
    const keys = [1, 2, 3].map(n => `reports/${job.siteId}/${job.id}/attempt-${n}.${format}`);
    expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: job.id } })).toBeNull();
    // The DB migrations have completed. These statements deliberately do not call
    // prepareReportDeletion/recordReportCleanup or any current application workflow.
    if (deletion === "site cascade") await prisma.$executeRaw`DELETE FROM "Site" WHERE "id" = ${job.siteId}`;
    else if (deletion === "manual DELETE") await prisma.$executeRaw`DELETE FROM "EnergyReportJob" WHERE "id" = ${job.id}`;
    else await prisma.$executeRaw`DELETE FROM "EnergyReportJob" WHERE "id" = ${job.id}
      AND "status" = 'failed' AND "createdAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - interval '90 days'`;
    expect(await prisma.energyReportJob.findUnique({ where: { id: job.id } })).toBeNull();
    const contentType = format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    for (const key of keys) await storage.putReportObject(key, Buffer.from("late legacy upload"), contentType);
    await cleanup.prune(new Date(Date.now() + 60_000));
    expect(objects.size).toBe(0);
    expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: job.id } })).toMatchObject({
      siteId: job.siteId, objectKeys: keys, lastCleanedAt: expect.any(Date)
    });
  });

  it("extends existing runtime inventory idempotently without invalidating a live cleanup lease", async () => {
    const job = await enqueue("pdf", 1);
    await prisma.$transaction(tx => recordReportCleanup(tx, job));
    const keys = [1, 2, 3].map(n => `reports/${job.siteId}/${job.id}/attempt-${n}.pdf`);
    const leaseExpiresAt = new Date(Date.now() + 30_000);
    const nextAttemptAt = new Date(Date.now() + 60_000);
    await prisma.energyReportObjectCleanup.update({ where: { reportId: job.id }, data: {
      objectKeys: [keys[0]], leaseOwner: "current-cleanup-owner", leaseExpiresAt, nextAttemptAt
    } });
    await prisma.$executeRaw`DELETE FROM "EnergyReportJob" WHERE "id" = ${job.id}`;
    await prisma.$executeRaw`DELETE FROM "EnergyReportJob" WHERE "id" = ${job.id}`;
    expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: job.id } })).toMatchObject({
      objectKeys: keys, leaseOwner: "current-cleanup-owner", leaseExpiresAt, nextAttemptAt
    });
    expect(await prisma.energyReportObjectCleanup.count({ where: { reportId: job.id } })).toBe(1);
  });
  it("rejects deletion of malformed legacy identities instead of recording an unsafe object path", async () => {
    const job = await enqueue("pdf", 1);
    await expect(prisma.$transaction(async tx => {
      await tx.energyReportJob.create({ data: { id: "../not-a-report", siteId: job.siteId,
        requestedByActorId: randomUUID(), requestedByLoginIdSnapshot: "invalid fixture", requestHash: "b".repeat(64),
        format: "pdf", requestSnapshot: {} } });
      await expect(tx.$executeRaw`DELETE FROM "EnergyReportJob" WHERE "id" = '../not-a-report'`)
        .rejects.toMatchObject({ meta: { code: "23514" } });
      // Roll back the deliberately invalid fixture without disabling either DB guard.
      throw new Error("ROLLBACK_INVALID_IDENTITY_FIXTURE");
    })).rejects.toThrow("ROLLBACK_INVALID_IDENTITY_FIXTURE");
    expect(await prisma.energyReportObjectCleanup.findUnique({ where: { reportId: "../not-a-report" } })).toBeNull();
  });
});
