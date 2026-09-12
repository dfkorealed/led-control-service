import { Body, Controller, Get, Header, HttpCode, Optional, Param, Post, Query, StreamableFile, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { parseComparisonPreset } from "./energy-comparison-query";
import { EnergyService } from "./energy.service";
import { EnergyHeatmapService } from "./energy-heatmap.service";
import { EnergyCsvExportService } from "./reports/energy-csv-export.service";
import { EnergyReportJobsService } from "./reports/energy-report-jobs.service";
import { EnergyReportTargetsService } from "./reports/energy-report-targets.service";

@UseGuards(SessionAuthGuard)
@Controller("energy")
export class EnergyController {
  constructor(
    private readonly energyService: EnergyService,
    private readonly heatmap?: EnergyHeatmapService,
    @Optional() private readonly reports?: EnergyReportJobsService,
    @Optional() private readonly csv?: EnergyCsvExportService,
    @Optional() private readonly reportTargets?: EnergyReportTargetsService
  ) {}

  @Get("sites/:siteId/report-targets")
  @Header("Cache-Control", "no-store")
  listReportTargets(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string) {
    if (!this.reportTargets) throw new Error("energy report targets service is unavailable");
    return this.reportTargets.list(user, siteId);
  }

  @Post("sites/:siteId/reports")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  createReport(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Body() request: unknown) {
    return this.reportService().create(user, siteId, request);
  }

  @Get("sites/:siteId/reports")
  @Header("Cache-Control", "no-store")
  listReports(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string) {
    return this.reportService().list(user, siteId);
  }

  @Get("sites/:siteId/reports/:reportId")
  @Header("Cache-Control", "no-store")
  getReport(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Param("reportId") reportId: string) {
    return this.reportService().detail(user, siteId, reportId);
  }

  @Get("sites/:siteId/reports/:reportId/download")
  @Header("Cache-Control", "no-store")
  downloadReport(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Param("reportId") reportId: string) {
    return this.reportService().download(user, siteId, reportId);
  }

  @Get("sites/:siteId/exports/csv")
  @Header("Cache-Control", "no-store")
  async exportCsv(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Query() query: Record<string, unknown>) {
    if (!this.csv) throw new Error("energy CSV service is unavailable");
    return new StreamableFile(await this.csv.export(user, siteId, query), {
      type: "text/csv; charset=utf-8", disposition: 'attachment; filename="energy-export.csv"'
    });
  }

  private reportService() {
    if (!this.reports) throw new Error("energy report service is unavailable");
    return this.reports;
  }

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

  @Get("sites/:siteId/rankings")
  getSiteRankings(
    @CurrentUser() user: AuthenticatedUser,
    @Param("siteId") siteId: string,
    @Query() query: Record<string, unknown>
  ) {
    return this.energyService.getSiteRankings(user, siteId, query);
  }

  @Get("sites/:siteId/heatmap")
  getSiteHeatmap(
    @CurrentUser() user: AuthenticatedUser,
    @Param("siteId") siteId: string,
    @Query() query: Record<string, unknown>
  ) {
    if (!this.heatmap) throw new Error("energy heatmap service is unavailable");
    return this.heatmap.getHeatmap(user, siteId, query);
  }
}
