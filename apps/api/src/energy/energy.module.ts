import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { EnergyController } from "./energy.controller";
import { EnergyAnalyticsQueryService } from "./energy-analytics-query.service";
import { EnergyService } from "./energy.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule],
  controllers: [EnergyController],
  providers: [EnergyAnalyticsQueryService, EnergyService]
})
export class EnergyModule {}
