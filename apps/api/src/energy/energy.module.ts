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

@Module({
  imports: [PrismaModule, AuthModule, AccessModule],
  controllers: [EnergyController],
  providers: [EnergyAnalyticsQueryService, EnergyRankingsService, EnergyRetentionService, EnergyService, EnergyDimensionHistoryService]
})
export class EnergyModule {}
