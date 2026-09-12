import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { energyReportRequestSchema, energyReportJobSchema, energyReportListResponseSchema, energyReportDownloadResponseSchema } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { SiteAccessService } from "../../access/site-access.service";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { ObjectStorageService } from "../../storage/object-storage.service";
import { canonicalJson, EnergyReportDocumentBuilder } from "./energy-report-document.builder";
import { EnergyReportSnapshotService } from "./energy-report-snapshot.service";

// Public reads intentionally omit the potentially large document/data snapshots and actor data.
const jobSelect = {
  id: true, siteId: true, requestSnapshot: true, status: true, progressPercent: true,
  createdAt: true, startedAt: true, completedAt: true, expiresAt: true, failureCode: true,
  format: true, objectKey: true, objectDeletedAt: true
} satisfies Prisma.EnergyReportJobSelect;
type JobRow = Prisma.EnergyReportJobGetPayload<{ select: typeof jobSelect }>;

@Injectable()
export class EnergyReportJobsService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly storage: ObjectStorageService,
    private readonly snapshots: EnergyReportSnapshotService = new EnergyReportSnapshotService(prisma, new EnergyReportDocumentBuilder())) {}
  async create(user: AuthenticatedUser, siteId: string, rawRequest: unknown, now = new Date()) {
    await this.access.assert(user, siteId, "read");
    const parsed = energyReportRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new BadRequestException("invalid energy report request");
    const request = parsed.data;
    if (await this.prisma.siteDeletionCleanup.findUnique({ where: { siteId }, select: { id: true } })) {
      throw new ConflictException("site deletion is pending");
    }
    // A read-only preflight uses the real scope/date/fact selection, outside Site
    // locks, so unrelated names cannot reject a job. Discard this document; the
    // worker still captures its one durable immutable snapshot and revalidates it.
    await this.snapshots.capture(randomUUID(), siteId, request, now);
    const requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex");
    const where: Prisma.EnergyReportJobWhereInput = { siteId, requestedByActorId: user.id, requestHash, status: { in: ["queued", "processing"] } };
    const existing = await this.prisma.energyReportJob.findFirst({ where, select: jobSelect });
    if (existing) return publicJob(existing, now);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const created = await this.prisma.$transaction(async tx => {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR KEY SHARE`);
          if (await tx.siteDeletionCleanup.findUnique({ where: { siteId }, select: { id: true } })) {
            throw new ConflictException("site deletion is pending");
          }
          return tx.energyReportJob.create({ data: {
            id: randomUUID(), siteId, requestedByUserId: user.id, requestedByActorId: user.id,
            requestedByLoginIdSnapshot: user.loginId, requestHash, format: request.format,
            requestSnapshot: request
          }, select: jobSelect });
        });
        return publicJob(created, now);
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "P2002")) throw error;
        const winner = await this.prisma.energyReportJob.findFirst({ where, select: jobSelect });
        if (winner) return publicJob(winner, now);
        // The winning row can become terminal between the unique-index conflict and
        // this lookup, releasing the active key. Retry INSERT under the same DB index;
        // bound repeated churn so requests never loop forever or expose a raw P2002.
      }
    }
    throw new ConflictException("report request changed concurrently; retry");
  }

  async list(user: AuthenticatedUser, siteId: string, now = new Date()) {
    await this.access.assert(user, siteId, "read");
    const reports = await this.prisma.energyReportJob.findMany({ where: { siteId }, take: 50,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: jobSelect });
    return energyReportListResponseSchema.parse({ reports: reports.map(report => publicJob(report, now)) });
  }

  async detail(user: AuthenticatedUser, siteId: string, reportId: string, now = new Date()) {
    await this.access.assert(user, siteId, "read");
    return publicJob(await this.findInSite(siteId, reportId), now);
  }

  async download(user: AuthenticatedUser, siteId: string, reportId: string, now?: Date) {
    await this.access.assert(user, siteId, "read");
    const report = await this.findInSite(siteId, reportId);
    // A slow authorization/database read can cross the expiry boundary after request entry.
    const checkedAt = now ?? new Date();
    if (report.status !== "completed" || !report.expiresAt || report.expiresAt <= checkedAt || report.objectDeletedAt
      || !report.objectKey?.startsWith(`reports/${siteId}/${reportId}/`) || !report.objectKey.endsWith(`.${report.format}`)) {
      throw new NotFoundException("report file not found");
    }
    const request = energyReportRequestSchema.parse(report.requestSnapshot);
    const filename = `energy-report_${request.from}_${request.to}_${reportId}.${report.format}`;
    const downloadUrl = await this.storage.createReportDownloadUrl(report.objectKey, filename);
    return energyReportDownloadResponseSchema.parse({ reportId, format: report.format, downloadUrl, expiresInSeconds: 300 });
  }

  private async findInSite(siteId: string, reportId: string) {
    const report = await this.prisma.energyReportJob.findFirst({ where: { id: reportId, siteId }, select: jobSelect });
    if (!report) throw new NotFoundException("report not found");
    return report;
  }
}

function publicJob(report: JobRow, now: Date) {
  return energyReportJobSchema.parse({ reportId: report.id, siteId: report.siteId, request: report.requestSnapshot,
    status: report.status === "completed" && report.expiresAt && report.expiresAt <= now ? "expired" : report.status,
    progressPercent: report.progressPercent, createdAt: report.createdAt.toISOString(),
    startedAt: report.startedAt?.toISOString() ?? null, completedAt: report.completedAt?.toISOString() ?? null,
    expiresAt: report.expiresAt?.toISOString() ?? null, failureCode: report.failureCode });
}
