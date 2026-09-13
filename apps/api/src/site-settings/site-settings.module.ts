import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";
import { FixtureEnergyCheckpointService } from "../energy/fixture-state-ingestion.service";
import { PrismaModule } from "../prisma/prisma.module";
import { SiteSettingsController } from "./site-settings.controller";
import { SiteSettingsService } from "./site-settings.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule],
  controllers: [SiteSettingsController],
  providers: [SiteSettingsService, EnergyDimensionHistoryService, FixtureEnergyCheckpointService]
})
export class SiteSettingsModule {}
