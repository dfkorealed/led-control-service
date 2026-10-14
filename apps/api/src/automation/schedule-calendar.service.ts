import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { projectScheduleCalendar } from "@led-control/automation-engine";
import { type ScheduleCalendarResponse } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { loadScheduleHolidayDatasets, toLightingScheduleSnapshot } from "./automation-snapshot.service";
import { validCivilDate } from "./holiday-provider";

const rangeSchema = z.object({ from: z.string().refine(validCivilDate), to: z.string().refine(validCivilDate) }).strict()
  .refine(range => {
    const days = (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 + 1;
    return days >= 1 && days <= 42;
  });

@Injectable()
export class ScheduleCalendarService {
  constructor(private readonly prisma: PrismaService, private readonly siteAccess: SiteAccessService) {}

  async get(siteId: string, actor: AuthenticatedUser, range: { from: string; to: string }): Promise<ScheduleCalendarResponse> {
    const parsed = rangeSchema.safeParse(range);
    if (!parsed.success) throw new BadRequestException("invalid schedule calendar range");
    try {
      return await this.prisma.$transaction(async tx => {
        const site = await this.siteAccess.assertReadInTransaction(tx, actor, siteId);
        // This is deliberately independent from bounded/filterable list(). All
        // authorized rules, revisions and holiday pointers share one read view.
        const rows = await tx.lightingSchedule.findMany({ where: { siteId },
          include: { fixtures: { select: { fixtureId: true } } }, orderBy: { id: "asc" } });
        const gateways = await tx.gatewayAutomationConfiguration.findMany({ where: { siteId },
          select: { gatewayId: true, desiredRevision: true, appliedRevision: true, payloadHash: true }, orderBy: { gatewayId: "asc" } });
        const schedules = rows.map(row => toLightingScheduleSnapshot(row));
        const holidayCoverage = await loadScheduleHolidayDatasets(tx, schedules, site.timeZone, parsed.data);
        const revisionKey = canonicalPayloadHash({ siteId, timeZone: site.timeZone, gateways,
          schedules: rows.map(row => ({ id: row.id, desiredRevision: row.desiredRevision, appliedRevision: row.appliedRevision })),
          holidayDatasets: holidayCoverage.map(dataset => ({ year: dataset.year, revision: dataset.revision, payloadHash: dataset.payloadHash })) });
        return { ...parsed.data, timeZone: site.timeZone, complete: true as const, revisionKey, holidayCoverage, schedules,
          occurrences: projectScheduleCalendar({ rules: schedules, ...parsed.data, timeZone: site.timeZone, datasets: holidayCoverage }) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({ code: "schedule_calendar_storage_unavailable" });
    }
  }
}
