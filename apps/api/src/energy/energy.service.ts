import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { EnergyComparisonPreset } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  EnergyAnalyticsQueryService,
  type EnergySeriesQuery
} from "./energy-analytics-query.service";

interface EstimateInput {
  ratedWatt: number;
  brightness: number;
  hours: number;
  tariffKwhRate: number;
}

@Injectable()
export class EnergyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    private readonly analytics: EnergyAnalyticsQueryService
  ) {}

  calculateEstimatedUsage(input: EstimateInput) {
    const kwh = Number(((input.ratedWatt * (input.brightness / 100) * input.hours) / 1000).toFixed(4));
    const cost = Number((kwh * input.tariffKwhRate).toFixed(2));
    return { kwh, cost };
  }

  async getDefaultSiteEstimate(user: AuthenticatedUser) {
    const siteIds = await this.siteAccess.listAccessibleSiteIds(user);
    const siteId = [...siteIds].sort()[0];
    if (!siteId) throw new NotFoundException("site not found");
    return this.getSiteEstimate(user, siteId);
  }

  async getSiteEstimate(user: AuthenticatedUser, siteId: string) {
    await this.siteAccess.assert(user, siteId, "read");
    const site = await this.prisma.site.findFirstOrThrow({
      where: { id: siteId },
      include: { floors: { include: { fixtures: true } } }
    });
    if (site.tariffKwhRate === null) {
      throw new ConflictException("site tariff is unavailable until installation is complete");
    }
    const fixtures = site.floors.flatMap((floor) => floor.fixtures);
    const tariffKwhRate = Number(site.tariffKwhRate);
    const daily = fixtures.reduce((sum, fixture) => {
      const estimate = this.calculateEstimatedUsage({
        ratedWatt: Number(fixture.ratedWatt),
        brightness: fixture.brightness,
        hours: 12,
        tariffKwhRate
      });
      return sum + estimate.kwh;
    }, 0);

    return {
      day: { kwh: Number(daily.toFixed(4)), cost: Number((daily * tariffKwhRate).toFixed(2)) },
      month: { kwh: Number((daily * 30).toFixed(4)), cost: Number((daily * 30 * tariffKwhRate).toFixed(2)) },
      year: { kwh: Number((daily * 365).toFixed(4)), cost: Number((daily * 365 * tariffKwhRate).toFixed(2)) }
    };
  }

  getSiteSummary(user: AuthenticatedUser, siteId: string) {
    return this.analytics.getSiteSummary(user, siteId);
  }

  getSiteSeries(user: AuthenticatedUser, siteId: string, query: EnergySeriesQuery) {
    return this.analytics.getSiteSeries(user, siteId, query);
  }

  getSiteComparisons(user: AuthenticatedUser, siteId: string, preset: EnergyComparisonPreset) {
    return this.analytics.getComparison(user, siteId, preset);
  }
}
