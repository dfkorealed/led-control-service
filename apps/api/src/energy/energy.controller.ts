import { Controller, Get, Header, Param, Query, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { parseComparisonPreset } from "./energy-comparison-query";
import { EnergyService } from "./energy.service";

@UseGuards(SessionAuthGuard)
@Controller("energy")
export class EnergyController {
  constructor(private readonly energyService: EnergyService) {}

  @Get("default/estimate")
  @Header("Deprecation", "true")
  getDefaultEstimate(@CurrentUser() user: AuthenticatedUser) {
    return this.energyService.getDefaultSiteEstimate(user);
  }

  @Get("sites/:siteId/estimate")
  @Header("Deprecation", "true")
  getSiteEstimate(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string) {
    return this.energyService.getSiteEstimate(user, siteId);
  }

  @Get("sites/:siteId/summary")
  getSiteSummary(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string) {
    return this.energyService.getSiteSummary(user, siteId);
  }

  @Get("sites/:siteId/comparisons")
  getSiteComparisons(
    @CurrentUser() user: AuthenticatedUser,
    @Param("siteId") siteId: string,
    @Query("preset") preset: string
  ) {
    return this.energyService.getSiteComparisons(user, siteId, parseComparisonPreset(preset));
  }

  @Get("sites/:siteId/series")
  getSiteSeries(
    @CurrentUser() user: AuthenticatedUser,
    @Param("siteId") siteId: string,
    @Query("granularity") granularity: "day" | "month",
    @Query("from") from: string,
    @Query("to") to: string
  ) {
    return this.energyService.getSiteSeries(user, siteId, { granularity, from, to });
  }
}
