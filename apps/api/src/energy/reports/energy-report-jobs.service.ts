import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { energyReportRequestSchema, energyReportJobSchema, energyReportListQuerySchema, energyReportListResponseSchema, energyReportDownloadResponseSchema } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { SiteAccessService } from "../../access/site-access.service";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { ObjectStorageService } from "../../storage/object-storage.service";
import { canonicalJson, EnergyReportDocumentBuilder } from "./energy-report-document.builder";
import { EnergyReportSnapshotService } from "./energy-report-snapshot.service";
import { decodeReportCursor, encodeReportCursor } from "./report-list-cursor";
import { buildReportListWhere, normalizeReportFilters, type ReportCursorPosition } from "./report-list-filters";

// Public reads intentionally omit the potentially large document/data snapshots and actor data.
const jobSelect = {
  id: true, siteId: true, requestSnapshot: true, status: true, progressPercent: true,
  createdAt: true, startedAt: true, completedAt: true, expiresAt: true, failureCode: true,
  format: true, objectKey: true, objectDeletedAt: true, targetLabelSnapshot: true
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
          const targetLabelSnapshot = await this.snapshots.captureTargetLabel(tx, siteId, request);
          return tx.energyReportJob.create({ data: {
            id: randomUUID(), siteId, requestedByUserId: user.id, requestedByActorId: user.id,
            requestedByLoginIdSnapshot: user.loginId, requestHash, format: request.format,
            requestSnapshot: request, targetLabelSnapshot, createdAt: now
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

  async list(user: AuthenticatedUser, siteId: string, rawQuery: unknown = {}, now = new Date()) {
    await this.access.assert(user, siteId, "read");
    const invalidQuery = () => new BadRequestException("invalid energy report list query");
    if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) throw invalidQuery();
    const input = rawQuery as Record<string, unknown>;
    // HTTP duplicate parameters are arrays. Reject them before numeric coercion
    // could accidentally accept a singleton array as a valid page size.
    if (input.limit !== undefined && typeof input.limit !== "string" && typeof input.limit !== "number") throw invalidQuery();
    const parsed = energyReportListQuerySchema.safeParse({ ...input, limit: input.limit ?? 20 });
    if (!parsed.success) throw invalidQuery();
    const query = parsed.data;
    const filters = normalizeReportFilters(query);
    let cursor: ReportCursorPosition | undefined;
    try { cursor = query.cursor ? decodeReportCursor(query.cursor, filters) : undefined; }
    catch { throw invalidQuery(); }

    try {
      const site = await this.prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { timeZone: true } });
      let filterWhere: Prisma.EnergyReportJobWhereInput;
      let pageWhere: Prisma.EnergyReportJobWhereInput;
      try {
        filterWhere = buildReportListWhere(siteId, filters, site.timeZone, now);
        pageWhere = buildReportListWhere(siteId, filters, site.timeZone, now, cursor);
      } catch { throw invalidQuery(); }
      const [totalCount, rows] = await this.prisma.$transaction(async tx => {
        const totalCount = await tx.energyReportJob.count({ where: filterWhere });
        const rows = await tx.energyReportJob.findMany({ where: pageWhere, take: query.limit + 1,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: jobSelect });
        return [totalCount, rows] as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      const reports = rows.slice(0, query.limit);
      return energyReportListResponseSchema.parse({ reports: reports.map(report => publicJob(report, now)), totalCount,
        nextCursor: rows.length > query.limit ? encodeReportCursor(reports[reports.length - 1], filters) : null });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      // Database and corrupt stored-data diagnostics are not user query errors.
      throw new InternalServerErrorException("could not list energy reports");
    }
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
  const request = energyReportRequestSchema.parse(report.requestSnapshot);
  return energyReportJobSchema.parse({ reportId: report.id, siteId: report.siteId, request: report.requestSnapshot,
    ...(report.targetLabelSnapshot == null ? {} : { target: { scope: request.scope, identityId: request.identityId, label: report.targetLabelSnapshot } }),
    status: report.status === "completed" && report.expiresAt && report.expiresAt <= now ? "expired" : report.status,
    progressPercent: report.progressPercent, createdAt: report.createdAt.toISOString(),
    startedAt: report.startedAt?.toISOString() ?? null, completedAt: report.completedAt?.toISOString() ?? null,
    expiresAt: report.expiresAt?.toISOString() ?? null, failureCode: report.failureCode });
}
