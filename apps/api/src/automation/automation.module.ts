import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AutomationController, VehicleEventRulesController } from "./automation.controller";
import { AutomationRuntimeModule } from "./automation-runtime.module";
import { SchedulesService } from "./schedules.service";
import { TargetSnapshotService } from "./target-snapshot.service";
import { VehicleEventRulesService } from "./vehicle-event-rules.service";
import { BioSensorProfilesController, BioSensorSitePolicyController } from "./bio-sensor-profiles.controller";
import { BioSensorPreparationController } from "./bio-sensor-preparation.controller";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, AutomationRuntimeModule],
  controllers: [AutomationController, VehicleEventRulesController, BioSensorProfilesController, BioSensorSitePolicyController, BioSensorPreparationController],
  providers: [
    SchedulesService,
    TargetSnapshotService,
    VehicleEventRulesService
  ],
  exports: [
    AutomationRuntimeModule,
    SchedulesService,
    TargetSnapshotService,
    VehicleEventRulesService
  ]
})
export class AutomationModule {}
