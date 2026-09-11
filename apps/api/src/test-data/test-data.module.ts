import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";
import { PrismaModule } from "../prisma/prisma.module";
import { TestDataController } from "./test-data.controller";
import { TestDataEnabledGuard } from "./test-data-enabled.guard";
import { TestDataService } from "./test-data.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule],
  controllers: [TestDataController],
  providers: [TestDataEnabledGuard, TestDataService, EnergyDimensionHistoryService]
})
export class TestDataModule {}
