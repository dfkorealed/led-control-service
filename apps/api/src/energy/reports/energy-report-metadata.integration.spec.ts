import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { disposablePostgres } from "../../../test/support/disposable-postgres";
import { EnergyReportJobsService } from "./energy-report-jobs.service";
import { EnergyReportSnapshotService } from "./energy-report-snapshot.service";
import { EnergyReportDocumentBuilder } from "./energy-report-document.builder";
import { EnergyReportWorkerService } from "./energy-report-worker.service";
import { ExcelEnergyReportRenderer } from "./excel-energy-report.renderer";
import { PdfEnergyReportRenderer } from "./pdf-energy-report.renderer";
import { ObjectStorageService } from "../../storage/object-storage.service";
import { SiteAccessService } from "../../access/site-access.service";

(process.env.REPORT_METADATA_TEST === "1" ? describe : describe.skip)("report metadata on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let prisma: PrismaClient;
  let jobs: EnergyReportJobsService;
  let worker: EnergyReportWorkerService;
  const organizationId = randomUUID(); const siteId = randomUUID(); const actorId = randomUUID();
  const floorId = randomUUID(); const fixtureId = randomUUID(); const groupId = randomUUID();
  const request = { from: "2026-09-01", to: "2026-09-02", scope: "site", identityId: siteId, format: "xlsx" };
  const user = { id: actorId, loginId: "metadata-reader", organizationId, organizationType: "customer", role: "admin", status: "active" } as never;
  const bytes = new Map<string, { Body: Buffer; ContentType: string }>();
  let failure: "none" | "put" | "head" | "mismatch" = "none";
  let legacyId: string;
  let storage: ObjectStorageService;
  const renderer = new ExcelEnergyReportRenderer();

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    expect(cluster.deploy(url, "20260915_statistics_operations_retention").status).toBe(0);
    prisma = new PrismaClient({ datasourceUrl: `${url}?options=-c%20timezone%3DAsia%2FSeoul` });
    await prisma.organization.create({ data: { id: organizationId, name: "Metadata test", type: "customer" } });
    await prisma.user.create({ data: { id: actorId, organizationId, name: "Reader", loginId: "metadata-reader", passwordHash: "unused", role: "admin" } });
    await prisma.site.create({ data: { id: siteId, organizationId, adminUserId: actorId, name: "접수 현장", timeZone: "UTC" } });
    legacyId = randomUUID();
    // Exercise an actual upgrade row without asking the newly generated Prisma model
    // to select a column that does not exist until the next deploy.
    await prisma.$executeRaw`INSERT INTO "EnergyReportJob" ("id", "siteId", "requestedByActorId", "requestedByLoginIdSnapshot", "requestHash", "format", "requestSnapshot", "updatedAt")
      VALUES (${legacyId}, ${siteId}, ${actorId}, 'legacy', ${"b".repeat(64)}, 'xlsx', ${JSON.stringify(request)}::jsonb, (clock_timestamp() AT TIME ZONE 'UTC'))`;
    expect(cluster.deploy(url).status).toBe(0);
    storage = new ObjectStorageService({ send: async (command: any) => {
      if (command instanceof PutObjectCommand) {
        if (failure === "put") throw new Error("S3 password=private-token bucket=secret");
        bytes.set(command.input.Key!, { Body: Buffer.from(command.input.Body as Buffer), ContentType: command.input.ContentType! });
      }
      if (command instanceof HeadObjectCommand) {
        if (failure === "head") throw new Error("HEAD private-token");
        const object = bytes.get(command.input.Key!)!;
        return { ContentLength: object.Body.length, ContentType: object.ContentType,
          ChecksumSHA256: failure === "mismatch" ? "wrong" : createHash("sha256").update(object.Body).digest("base64") };
      }
      return {};
    } } as never, { bucket: "floors", reportBucket: "reports", publicBaseUrl: "https://public.example" });
    const snapshots = new EnergyReportSnapshotService(prisma as never, new EnergyReportDocumentBuilder());
    jobs = new EnergyReportJobsService(prisma as never, new SiteAccessService(prisma as never), storage, snapshots);
    worker = new EnergyReportWorkerService(prisma as never, storage, snapshots, renderer, new PdfEnergyReportRenderer());
  }, 60_000);
  afterAll(async () => { worker?.onModuleDestroy(); await prisma?.$disconnect(); cluster?.stop(); });

  it("keeps a legacy null label stable and forbids replacing or filling labels after INSERT", async () => {
    const [legacy] = await prisma.$queryRaw<Array<{ targetLabelSnapshot: string | null }>>`SELECT "targetLabelSnapshot" FROM "EnergyReportJob" WHERE "id" = ${legacyId}`;
    expect(legacy.targetLabelSnapshot).toBeNull();
    expect(await jobs.detail(user, siteId, legacyId)).toMatchObject({ target: { label: `현장: ${siteId}` } });
    await expect(prisma.$executeRaw`UPDATE "EnergyReportJob" SET "targetLabelSnapshot" = 'invented' WHERE "id" = ${legacyId}`).rejects.toThrow();
    await prisma.energyReportJob.delete({ where: { id: legacyId } });
    const created = await jobs.create(user, siteId, request);
    expect(created).toMatchObject({ target: { label: "접수 현장" }, requestedAt: created.createdAt });
    expect(Math.abs(Date.parse(created.requestedAt) - Date.now())).toBeLessThan(1500);
    await expect(prisma.$executeRaw`UPDATE "EnergyReportJob" SET "targetLabelSnapshot" = 'replaced' WHERE "id" = ${created.reportId}`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE "EnergyReportJob" SET "targetLabelSnapshot" = NULL WHERE "id" = ${created.reportId}`).rejects.toThrow();
    await prisma.$executeRaw`UPDATE "EnergyReportJob" SET "targetLabelSnapshot" = '접수 현장' WHERE "id" = ${created.reportId}`;
    await prisma.site.update({ where: { id: siteId }, data: { name: "나중 현장" } });
    await worker.runOnce();
    expect(await jobs.detail(user, siteId, created.reportId)).toMatchObject({ status: "completed", target: { label: "접수 현장" } });
    const row = await prisma.energyReportJob.findUniqueOrThrow({ where: { id: created.reportId } });
    expect(row.documentSnapshot).toMatchObject({ metadata: expect.arrayContaining([{ label: "대상", value: "접수 현장", displayValue: "접수 현장" }]) });
    await expect(prisma.energyReportJob.update({ where: { id: row.id }, data: { documentSnapshot: { changed: true } } })).rejects.toThrow();
  });

  it("preserves fixture, floor and group labels after rename and operational deletion before processing", async () => {
    await prisma.floor.create({ data: { id: floorId, siteId, name: "접수 층", level: 1 } });
    await prisma.fixture.create({ data: { id: fixtureId, siteId, floorId, name: "접수 조명", ratedWatt: 40, x: 0, y: 0 } });
    // A legacy group without a live gateway is still a valid analytics target.
    await prisma.fixtureGroup.create({ data: { id: groupId, siteId, floorId, name: "접수 그룹", lifecycleStatus: "invalid" } });
    const fixture = await prisma.energyFixtureIdentity.create({ data: { siteId, fixtureId, trackingStartedAt: new Date("2026-09-01Z"),
      dimensionVersions: { create: { name: "접수 조명", floorId, floorName: "접수 층", ratedWatt: 40, effectiveFrom: new Date("2026-09-01Z") } } } });
    const group = await prisma.energyGroupIdentity.create({ data: { siteId, groupId, trackingStartedAt: new Date("2026-09-01Z"),
      dimensionVersions: { create: { name: "접수 그룹", effectiveFrom: new Date("2026-09-01Z") } } } });
    const requests = [{ scope: "fixture", identityId: fixture.id, label: "접수 조명" },
      { scope: "floor", identityId: floorId, label: "접수 층" }, { scope: "group", identityId: group.id, label: "접수 그룹" }];
    const created = [];
    for (const { label, ...target } of requests) {
      const job = await jobs.create(user, siteId, { ...request, ...target });
      expect(job.target.label).toBe(label); created.push(job);
    }
    await prisma.energyFixtureDimensionVersion.updateMany({ where: { energyFixtureId: fixture.id }, data: { name: "변경 조명", floorName: "변경 층" } });
    await prisma.energyGroupDimensionVersion.updateMany({ where: { energyGroupId: group.id }, data: { name: "변경 그룹" } });
    await prisma.fixtureGroup.delete({ where: { id: groupId } });
    await prisma.fixture.delete({ where: { id: fixtureId } });
    await prisma.floor.delete({ where: { id: floorId } });
    for (let index = 0; index < created.length; index++) await worker.runOnce();
    for (let index = 0; index < created.length; index++) {
      expect(await jobs.detail(user, siteId, created[index].reportId)).toMatchObject({ status: "completed", target: requests[index] });
      const row = await prisma.energyReportJob.findUniqueOrThrow({ where: { id: created[index].reportId } });
      expect(row.documentSnapshot).toMatchObject({ metadata: expect.arrayContaining([{ label: "대상", value: requests[index].label, displayValue: requests[index].label }]) });
    }
  });

  it.each(["put", "head", "mismatch"] as const)("classifies %s storage failures after bounded retries without exposing raw errors", async mode => {
    failure = mode;
    const created = await jobs.create(user, siteId, request);
    try {
      await worker.runOnce(); await worker.runOnce(); await worker.runOnce();
      const result = await jobs.detail(user, siteId, created.reportId);
      expect(result).toMatchObject({ status: "failed", failureCode: "REPORT_STORAGE_UNAVAILABLE", failure: { code: "storage_unavailable" } });
      expect(JSON.stringify(result)).not.toContain("private-token");
    } finally { failure = "none"; }
  });

  it("classifies renderer errors", async () => {
    const render = jest.spyOn(renderer, "render").mockRejectedValue(new Error("renderer private-token"));
    const created = await jobs.create(user, siteId, request);
    try {
      await worker.runOnce(); await worker.runOnce(); await worker.runOnce();
      expect(await jobs.detail(user, siteId, created.reportId)).toMatchObject({ failureCode: "REPORT_RENDERING_FAILED", failure: { code: "rendering_failed" } });
    } finally { render.mockRestore(); }
  });

  it("classifies invalid stored documents", async () => {
    const invalid = await prisma.energyReportJob.create({ data: { siteId, requestedByActorId: actorId, requestedByLoginIdSnapshot: "reader",
      requestHash: "c".repeat(64), format: "xlsx", requestSnapshot: request, dataSnapshot: {},
      documentSnapshot: { contentFingerprint: "a".repeat(64) }, contentFingerprint: "a".repeat(64) } });
    await worker.runOnce(); await worker.runOnce(); await worker.runOnce();
    expect(await jobs.detail(user, siteId, invalid.id)).toMatchObject({ failureCode: "REPORT_SNAPSHOT_INVALID", failure: { code: "snapshot_invalid" } });
  });
});
