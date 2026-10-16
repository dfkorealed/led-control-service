import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";
import { FixtureEnergyCheckpointService } from "../energy/fixture-state-ingestion.service";
import { PrismaModule } from "../prisma/prisma.module";
import { FixturesController } from "./fixtures.controller";
import { FixturesService } from "./fixtures.service";
import { FixtureRegistrationRemovalRuntimeModule } from "./fixture-registration-removal-runtime.module";
import { FixtureRegistrationRemovalsController } from "./fixture-registration-removals.controller";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, FixtureRegistrationRemovalRuntimeModule],
  controllers: [FixturesController, FixtureRegistrationRemovalsController],
  providers: [FixturesService, FixtureEnergyCheckpointService, EnergyDimensionHistoryService]
})
export class FixturesModule {}
