import { Injectable } from "@nestjs/common";
import { energyReportTargetsResponseSchema, type EnergyReportTargetsResponse } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../../access/site-access.service";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { PrismaService } from "../../prisma/prisma.service";
import { addCalendarDays, formatCalendarDate, localDateAt } from "../energy-periods";
import { isReportTextSupported } from "./report-text";

@Injectable()
export class EnergyReportTargetsService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService) {}

  async list(user: AuthenticatedUser, siteId: string, now = new Date()): Promise<EnergyReportTargetsResponse> {
    await this.access.assert(user, siteId, "read");
    return this.prisma.$transaction(async tx => {
      const site = await tx.site.findUniqueOrThrow({ where: { id: siteId }, select: { name: true, timeZone: true } });
      const [fixtures, groups, floors, historicalFloors] = await Promise.all([
        tx.energyFixtureIdentity.findMany({ where: { siteId }, orderBy: { id: "asc" }, select: { id: true,
          dimensionVersions: { orderBy: { effectiveFrom: "desc" }, take: 1, select: { name: true } } } }),
        tx.energyGroupIdentity.findMany({ where: { siteId }, orderBy: { id: "asc" }, select: { id: true,
          dimensionVersions: { orderBy: { effectiveFrom: "desc" }, take: 1, select: { name: true } } } }),
        tx.floor.findMany({ where: { siteId }, orderBy: { id: "asc" }, select: { id: true, name: true } }),
        tx.energyFixtureDimensionVersion.findMany({ where: { energyFixture: { siteId } },
          orderBy: [{ effectiveFrom: "desc" }, { id: "asc" }], distinct: ["floorId"], select: { floorId: true, floorName: true } })
      ]);
      // Retired operational objects remain selectable through durable analytics history.
      // The label is the latest stored name, not a claim about membership in the report period.
      const floorNames = new Map(historicalFloors.map(row => [row.floorId, row.floorName]));
      for (const floor of floors) floorNames.set(floor.id, floor.name);
      const targets: EnergyReportTargetsResponse["targets"] = [
        { scope: "site", identityId: siteId, label: site.name },
        ...fixtures.map(row => ({ scope: "fixture" as const, identityId: row.id, label: row.dimensionVersions[0]?.name ?? row.id })),
        ...[...floorNames].sort(([a], [b]) => a.localeCompare(b)).map(([identityId, label]) => ({ scope: "floor" as const, identityId, label })),
        ...groups.map(row => ({ scope: "group" as const, identityId: row.id, label: row.dimensionVersions[0]?.name ?? row.id }))
      ];
      return energyReportTargetsResponseSchema.parse({ siteId, timeZone: site.timeZone,
        lastCompletedDate: formatCalendarDate(addCalendarDays(localDateAt(now, site.timeZone), -1)),
        targets: targets.filter(target => isReportTextSupported(target)) });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
