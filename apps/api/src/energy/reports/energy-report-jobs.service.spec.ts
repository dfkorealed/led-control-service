import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { energyReportJobSchema } from "@led-control/shared";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { S3Client } from "@aws-sdk/client-s3";
import { EnergyReportJobsService } from "./energy-report-jobs.service";
import { canonicalJson } from "./energy-report-document.builder";
import { ObjectStorageService } from "../../storage/object-storage.service";
import { SiteAccessService } from "../../access/site-access.service";
import { decodeReportCursor, encodeReportCursor } from "./report-list-cursor";
import { normalizeReportFilters } from "./report-list-filters";

const siteId = "20000000-0000-4000-8000-000000000001";
const reportId = "10000000-0000-4000-8000-000000000001";
const actorId = "30000000-0000-4000-8000-000000000001";
const user = { id: actorId, loginId: "report.reader" } as never;
const request = { from: "2026-09-01", to: "2026-09-02", scope: "site", identityId: siteId, format: "xlsx" };
const now = new Date("2026-09-10T00:00:00Z");
function job(overrides: Record<string, unknown> = {}) {
  return { id: reportId, siteId, requestSnapshot: request, status: "queued", progressPercent: 0,
    createdAt: now, startedAt: null, completedAt: null, expiresAt: null, failureCode: null,
    objectKey: null, format: "xlsx", objectDeletedAt: null, targetLabelSnapshot: null, ...overrides };
}
function setup() {
  const prisma = { $transaction: jest.fn(), $queryRaw: jest.fn().mockResolvedValue([{ id: siteId }]),
    site: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: siteId, name: "Report site", timeZone: "UTC" }) },
    energyFixtureIdentity: { findMany: jest.fn().mockResolvedValue([]) },
    siteDeletionCleanup: { findUnique: jest.fn().mockResolvedValue(null) }, energyReportJob: {
    findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0),
    create: jest.fn(async ({ data }) => job({ ...data, createdAt: now }))
  } };
  prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
  const access = { assert: jest.fn().mockResolvedValue(undefined) };
  const client = new S3Client({ region: "us-east-1", endpoint: "https://objects.example", forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  const storage = new ObjectStorageService(client, { bucket: "floors", reportBucket: "reports", publicBaseUrl: "https://public.example" });
  return { prisma, access, client, service: new EnergyReportJobsService(prisma as never, access as never, storage) };
}

describe("EnergyReportJobsService", () => {
  it("captures the label in the enqueue transaction after the discarded preflight", async () => {
    const { service, prisma, client } = setup();
    prisma.site.findUniqueOrThrow.mockResolvedValueOnce({ id: siteId, name: "사전 조회 이름", timeZone: "UTC" })
      .mockResolvedValue({ id: siteId, name: "접수 이름", timeZone: "UTC" });
    try {
      const result = await service.create(user, siteId, request, now);
      expect(result).toMatchObject({ target: { scope: "site", identityId: siteId, label: "접수 이름" },
        requestedAt: result.createdAt, failure: null });
      expect(prisma.energyReportJob.create.mock.calls[0][0].data.targetLabelSnapshot).toBe("접수 이름");
      expect(prisma.site.findUniqueOrThrow.mock.invocationCallOrder[1]).toBeGreaterThan(prisma.$queryRaw.mock.invocationCallOrder[0]);
    } finally { client.destroy(); }
  });

  it.each(["detail", "list"] as const)("%s preserves a stored target and redacts unknown legacy failure text", async method => {
    const { service, prisma, client } = setup();
    const row = job({ targetLabelSnapshot: "삭제된 조명", requestSnapshot: { ...request, scope: "fixture", identityId: actorId },
      status: "failed", startedAt: now, failureCode: "database password=private-token" });
    prisma.energyReportJob.findFirst.mockResolvedValue(row as never);
    prisma.energyReportJob.findMany.mockResolvedValue([row] as never);
    try {
      const result = method === "detail" ? await service.detail(user, siteId, reportId) : (await service.list(user, siteId)).reports[0];
      expect(result).toMatchObject({ target: { scope: "fixture", identityId: actorId, label: "삭제된 조명" },
        requestedAt: now.toISOString(), failureCode: "REPORT_GENERATION_FAILED",
        failure: { code: "generation_failed", message: expect.any(String), action: expect.any(String) } });
      expect(JSON.stringify(result)).not.toContain("private-token");
      if (method === "detail") expect(prisma.site.findUniqueOrThrow).not.toHaveBeenCalled();
      else expect(prisma.site.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: siteId }, select: { timeZone: true } });
    } finally { client.destroy(); }
  });

  it("discards the read-only text preflight and persists only request/actor metadata for the worker", async () => {
    const { service, prisma, access, client } = setup();
    const result = await service.create(user, siteId, request, now);
    expect(energyReportJobSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ siteId, request, status: "queued", progressPercent: 0 });
    const data = prisma.energyReportJob.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ requestedByUserId: actorId, requestedByActorId: actorId,
      requestedByLoginIdSnapshot: "report.reader", format: "xlsx", requestSnapshot: request,
      requestHash: createHash("sha256").update(canonicalJson(request)).digest("hex") });
    expect(data.documentSnapshot).toBeUndefined();
    expect(data.dataSnapshot).toBeUndefined();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.energyFixtureIdentity.findMany.mock.invocationCallOrder[0]).toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[0]);
    expect(access.assert.mock.invocationCallOrder[0]).toBeLessThan(prisma.energyReportJob.findFirst.mock.invocationCallOrder[0]);
    expect(JSON.stringify(result)).not.toMatch(/Snapshot|Actor|Login|Hash|objectKey|contentFingerprint|known|coverage|forecast|baseline|예상|추정/);
    client.destroy();
  });

  it.each(["create", "list", "detail", "download"] as const)("authorizes %s before any report/snapshot query", async method => {
    const { service, prisma, access, client } = setup();
    access.assert.mockRejectedValue(new NotFoundException());
    const promise = method === "create" ? service.create(user, siteId, request, now)
      : method === "list" ? service.list(user, siteId) : service[method](user, siteId, reportId);
    await expect(promise).rejects.toBeInstanceOf(NotFoundException);
    expect(access.assert).toHaveBeenCalledWith(user, siteId, "read");
    expect(prisma.energyReportJob.findFirst).not.toHaveBeenCalled();
    expect(prisma.energyReportJob.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    client.destroy();
  });

  it("rejects extra section fields and inverted dates without creating a job", async () => {
    const { service, prisma, client } = setup();
    await expect(service.create(user, siteId, { ...request, sections: ["summary"] }, now)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.energyReportJob.findFirst).not.toHaveBeenCalled();
    await expect(service.create(user, siteId, { ...request, to: "2026-08-31" }, now)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.energyReportJob.create).not.toHaveBeenCalled();
    client.destroy();
  });

  it("reuses the active canonical request after read-only preflight without writing a new snapshot", async () => {
    const { service, prisma, client } = setup();
    prisma.energyReportJob.findFirst.mockResolvedValue(job() as never);
    const result = await service.create(user, siteId, { format: "xlsx", identityId: siteId, scope: "site", to: request.to, from: request.from }, now);
    expect(result.reportId).toBe(reportId);
    expect(prisma.energyReportJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      siteId, requestedByActorId: actorId, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), status: { in: ["queued", "processing"] }
    } }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.energyReportJob.create).not.toHaveBeenCalled();
    client.destroy();
  });

  it("resolves the active unique-index race to the winning job", async () => {
    const { service, prisma, client } = setup();
    prisma.energyReportJob.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(job() as never);
    prisma.energyReportJob.create.mockRejectedValue({ code: "P2002" });
    await expect(service.create(user, siteId, request, now)).resolves.toMatchObject({ reportId, status: "queued" });
    client.destroy();
  });

  it("creates a valid new job when the P2002 winner became terminal before the active lookup", async () => {
    const { service, prisma, client } = setup();
    prisma.energyReportJob.create.mockRejectedValueOnce({ code: "P2002" });
    // The conflicting row committed a terminal state before this active-only read.
    prisma.energyReportJob.findFirst.mockResolvedValue(null);
    try {
      const result = await service.create(user, siteId, request, now);
      expect(energyReportJobSchema.parse(result)).toMatchObject({ siteId, request, status: "queued", progressPercent: 0 });
      expect(prisma.energyReportJob.create).toHaveBeenCalledTimes(2);
      expect(prisma.energyReportJob.create.mock.calls[1][0].data).toMatchObject({
        siteId, requestedByActorId: actorId, requestHash: createHash("sha256").update(canonicalJson(request)).digest("hex")
      });
    } finally { client.destroy(); }
  });

  it("bounds repeated terminal-winner churn and returns a retryable conflict instead of leaking P2002", async () => {
    const { service, prisma, client } = setup();
    prisma.energyReportJob.create.mockRejectedValue({ code: "P2002" });
    prisma.energyReportJob.findFirst.mockResolvedValue(null);
    try {
      await expect(service.create(user, siteId, request, now)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.energyReportJob.create).toHaveBeenCalledTimes(3);
      expect(prisma.energyReportJob.findFirst).toHaveBeenCalledTimes(4);
    } finally { client.destroy(); }
  });

  it("does not retry database errors unrelated to uniqueness", async () => {
    const { service, prisma, client } = setup();
    const error = { code: "P2003" };
    prisma.energyReportJob.create.mockRejectedValue(error);
    try {
      await expect(service.create(user, siteId, request, now)).rejects.toBe(error);
      expect(prisma.energyReportJob.create).toHaveBeenCalledTimes(1);
    } finally { client.destroy(); }
  });

  it("defaults to 20 newest site jobs without loading snapshots and projects expired status", async () => {
    const { service, prisma, client } = setup();
    prisma.energyReportJob.findMany.mockResolvedValue([job({ status: "completed", progressPercent: 100, startedAt: now, completedAt: now, expiresAt: new Date("2026-09-11T00:00:00Z") })] as never);
    const result = await service.list(user, siteId, {}, new Date("2026-09-11T00:00:00Z"));
    expect(result.reports[0].status).toBe("expired");
    expect(prisma.energyReportJob.findMany).toHaveBeenCalledWith({ where: expect.objectContaining({ siteId }), take: 21,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: expect.any(Object) });
    const select = (prisma.energyReportJob.findMany.mock.calls[0] as any)[0].select;
    expect(select.documentSnapshot).toBeUndefined();
    expect(select.dataSnapshot).toBeUndefined();
    client.destroy();
  });

  it("returns a bounded page and cursor while counting the whole filter in repeatable-read", async () => {
    const { service, prisma, client } = setup();
    const rows = Array.from({ length: 11 }, (_, index) => job({ id: `10000000-0000-4000-8000-${String(99 - index).padStart(12, "0")}` }));
    prisma.energyReportJob.findMany.mockResolvedValue(rows as never);
    prisma.energyReportJob.count.mockResolvedValue(83);
    const filters = normalizeReportFilters({ limit: 10, query: "서울" });
    const cursor = encodeReportCursor({ createdAt: now, id: reportId }, filters);
    try {
      const result = await service.list(user, siteId, { limit: "10", query: "서울", cursor }, now);
      expect(result.reports).toHaveLength(10);
      expect(result.totalCount).toBe(83);
      expect(decodeReportCursor(result.nextCursor!, filters)).toEqual({ createdAt: now, id: rows[9].id });
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
      const pageArgs = (prisma.energyReportJob.findMany.mock.calls[0] as any)[0];
      const countArgs = (prisma.energyReportJob.count.mock.calls[0] as any)[0];
      expect(pageArgs.take).toBe(11);
      expect(pageArgs.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
      expect(pageArgs.where.AND.at(-1)).toEqual({ OR: [{ createdAt: { lt: now } }, { createdAt: now, id: { lt: reportId } }] });
      expect(countArgs.where.AND).toEqual(pageArgs.where.AND.slice(0, -1));
      expect(pageArgs.select.documentSnapshot).toBeUndefined();
    } finally { client.destroy(); }
  });

  it("keeps the same expired report eligible before and after cleanup for both the page and total count", async () => {
    const { service, prisma, client } = setup();
    const elapsedBeforeCleanup = job({ status: "completed", progressPercent: 100, startedAt: now, completedAt: now,
      expiresAt: now, objectKey: `reports/${siteId}/${reportId}/attempt-1.xlsx` });
    const storedAfterCleanup = { ...elapsedBeforeCleanup, status: "expired", objectDeletedAt: now };
    prisma.energyReportJob.findMany.mockResolvedValueOnce([elapsedBeforeCleanup] as never).mockResolvedValueOnce([storedAfterCleanup] as never);
    prisma.energyReportJob.count.mockResolvedValue(1);
    try {
      const beforeCleanup = await service.list(user, siteId, { status: "expired" }, now);
      const afterCleanup = await service.list(user, siteId, { status: "expired" }, now);

      expect(beforeCleanup).toMatchObject({ totalCount: 1, reports: [{ reportId, status: "expired" }] });
      expect(afterCleanup).toMatchObject({ totalCount: 1, reports: [{ reportId, status: "expired" }] });
      for (let call = 0; call < 2; call++) {
        const pageWhere = (prisma.energyReportJob.findMany.mock.calls[call] as any)[0].where;
        const countWhere = (prisma.energyReportJob.count.mock.calls[call] as any)[0].where;
        expect(pageWhere).toEqual(countWhere);
        expect(pageWhere.AND).toContainEqual({ OR: [
          { status: "expired" },
          { status: "completed", expiresAt: { lte: now } }
        ] });
      }
    } finally { client.destroy(); }
  });

  it.each([{}, { limit: "100" }])("returns no cursor for an empty final page %j", async query => {
    const { service, client } = setup();
    try { expect(await service.list(user, siteId, query, now)).toEqual({ reports: [], nextCursor: null, totalCount: 0 }); }
    finally { client.destroy(); }
  });

  it.each([{ limit: 30 }, { extra: "secret" }, { cursor: "private-token" }, { requestedFrom: "2026-09-01" },
    { limit: [10, 20] }, { query: " " }])("sanitizes invalid list inputs before database access %j", async query => {
    const { service, prisma, client } = setup();
    try {
      await expect(service.list(user, siteId, query, now)).rejects.toMatchObject({
        response: { statusCode: 400, message: "invalid energy report list query" }
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally { client.destroy(); }
  });

  it("does not turn database failures into public query errors", async () => {
    const { service, prisma, client } = setup();
    prisma.energyReportJob.findMany.mockRejectedValue(new Error("database private-token"));
    try { await expect(service.list(user, siteId, {}, now)).rejects.toMatchObject({
      response: { statusCode: 500, message: "could not list energy reports" }
    }); } finally { client.destroy(); }
  });

  it.each(["detail", "download"] as const)("returns tenant-safe 404 for %s with the report lookup constrained by site", async method => {
    const { service, prisma, client } = setup();
    await expect(service[method](user, siteId, reportId)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.energyReportJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: reportId, siteId } }));
    client.destroy();
  });

  it.each(["queued", "processing", "failed", "expired", "elapsed", "deleted", "wrong-key"])("does not sign unavailable report: %s", async state => {
    const { service, prisma, client } = setup();
    prisma.energyReportJob.findFirst.mockResolvedValue(job({ status: ["elapsed", "deleted", "wrong-key"].includes(state) ? "completed" : state,
      expiresAt: new Date(state === "elapsed" ? "2026-09-10T00:00:00Z" : "2026-09-17T00:00:00Z"),
      objectDeletedAt: state === "deleted" ? now : null,
      objectKey: `reports/${state === "wrong-key" ? actorId : siteId}/${reportId}/attempt-1.xlsx` }) as never);
    await expect(service.download(user, siteId, reportId, now)).rejects.toBeInstanceOf(NotFoundException);
    client.destroy();
  });

  it("signs a completed unexpired file using generated ASCII filename and returns only the shared download shape", async () => {
    const { service, prisma, client } = setup();
    prisma.energyReportJob.findFirst.mockResolvedValue(job({ status: "completed", expiresAt: new Date("2026-09-17T00:00:00Z"),
      objectKey: `reports/${siteId}/${reportId}/attempt-2.xlsx` }) as never);
    const result = await service.download(user, siteId, reportId, now);
    expect(Object.keys(result).sort()).toEqual(["downloadUrl", "expiresInSeconds", "format", "reportId"]);
    expect(result.expiresInSeconds).toBe(300);
    expect(new URL(result.downloadUrl).searchParams.get("response-content-disposition"))
      .toBe(`attachment; filename="energy-report_2026-09-01_2026-09-02_${reportId}.xlsx"`);
    client.destroy();
  });
  it("checks expiry after a delayed database read before issuing a signed URL", async () => {
    const { service, prisma, client } = setup();
    jest.useFakeTimers({ now });
    prisma.energyReportJob.findFirst.mockImplementation(async () => {
      jest.setSystemTime(new Date(now.getTime() + 10_000));
      return job({ status: "completed", expiresAt: new Date(now.getTime() + 5000),
        objectKey: `reports/${siteId}/${reportId}/attempt-1.xlsx` }) as never;
    });
    try { await expect(service.download(user, siteId, reportId)).rejects.toBeInstanceOf(NotFoundException); }
    finally { jest.useRealTimers(); client.destroy(); }
  });
});

const databaseUrl = process.env.ENERGY_REPORT_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("report creation terminal-winner PostgreSQL race", () => {
  it("retries after a real unique-index conflict whose winner commits failed before recovery reads", async () => {
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const organizationId = randomUUID(); const actor = randomUUID(); const site = randomUUID();
    const request = { from: "2026-09-01", to: "2026-09-02", scope: "site", identityId: site, format: "xlsx" };
    const user = { id: actor, organizationId, organizationType: "customer", role: "admin", status: "active", loginId: `race-${actor}` } as never;
    let competitorId: string | undefined;
    let observedConflict = false;
    const scheduled = prisma.$extends({ query: { energyReportJob: {
      async create({ args, query }) {
        if (competitorId) return query(args);
        // Schedule the competing transaction after the service's empty lookup, but
        // before its INSERT. Both INSERTs and the partial unique index are real SQL.
        const competitor = await prisma.energyReportJob.create({ data: { ...args.data, id: randomUUID() } });
        competitorId = competitor.id;
        try { return await query(args); }
        catch (error) {
          observedConflict = typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
          await prisma.energyReportJob.update({ where: { id: competitor.id }, data: {
            status: "failed", attemptCount: 1, startedAt: new Date(), failureCode: "REPORT_GENERATION_FAILED"
          } });
          throw error;
        }
      }
    } } });
    try {
      await prisma.organization.create({ data: { id: organizationId, name: "Dedupe race", type: "customer" } });
      await prisma.user.create({ data: { id: actor, organizationId, name: "Reader", loginId: `race-${actor}`, role: "admin", passwordHash: "unused" } });
      await prisma.site.create({ data: { id: site, organizationId, adminUserId: actor, name: "Dedupe race" } });
      const service = new EnergyReportJobsService(scheduled as never, new SiteAccessService(prisma as never),
        new ObjectStorageService({} as never, { bucket: "public-floors", reportBucket: "private-reports", publicBaseUrl: "https://public.example" }));
      const result = await service.create(user, site, request);
      expect(observedConflict).toBe(true);
      expect(energyReportJobSchema.parse(result)).toMatchObject({ siteId: site, status: "queued", request });
      expect(result.reportId).not.toBe(competitorId);
      const rows = await prisma.energyReportJob.findMany({ where: { siteId: site } });
      expect(rows).toHaveLength(2);
      expect(rows.filter(row => row.status === "queued" || row.status === "processing")).toHaveLength(1);
      expect(rows.find(row => row.id === competitorId)?.status).toBe("failed");
    } finally {
      await prisma.site.deleteMany({ where: { id: site } });
      await prisma.energyReportObjectCleanup.deleteMany({ where: { siteId: site } });
      await prisma.user.deleteMany({ where: { id: actor } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.$disconnect();
    }
  });
});
