import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { EnergyController } from "./energy.controller";
import { EnergyAnalyticsQueryService } from "./energy-analytics-query.service";
import { EnergyService } from "./energy.service";
import { EnergyDimensionHistoryService } from "./energy-dimension-history.service";
import { EnergyRankingsService } from "./energy-rankings.service";
import { EnergyRetentionService } from "./energy-retention.service";
import { EnergyHeatmapService } from "./energy-heatmap.service";
import { EnergyObservedMeanService } from "./energy-observed-mean.service";
import { StorageModule } from "../storage/storage.module";
import { EnergyCsvExportService } from "./reports/energy-csv-export.service";
import { EnergyReportDocumentBuilder } from "./reports/energy-report-document.builder";
import { EnergyReportSnapshotService } from "./reports/energy-report-snapshot.service";
import { EnergyReportJobsService } from "./reports/energy-report-jobs.service";
import { EnergyReportWorkerService } from "./reports/energy-report-worker.service";
import { ExcelEnergyReportRenderer } from "./reports/excel-energy-report.renderer";
import { PdfEnergyReportRenderer } from "./reports/pdf-energy-report.renderer";
import { EnergyReportCleanupService } from "./reports/energy-report-cleanup.service";
import { EnergyReportTargetsService } from "./reports/energy-report-targets.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, StorageModule],
  controllers: [EnergyController],
  providers: [
    EnergyCsvExportService,
    EnergyReportDocumentBuilder,
    EnergyReportSnapshotService,
    EnergyReportJobsService,
    EnergyReportTargetsService,
    EnergyReportWorkerService,
    EnergyReportCleanupService,
    ExcelEnergyReportRenderer,
    PdfEnergyReportRenderer,
    EnergyAnalyticsQueryService,
    EnergyHeatmapService,
    EnergyObservedMeanService,
    EnergyRankingsService,
    EnergyRetentionService,
    EnergyService,
    EnergyDimensionHistoryService
  ]
})
export class EnergyModule {}
