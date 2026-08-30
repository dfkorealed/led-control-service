import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AutomationController, VehicleEventRulesController } from "./automation.controller";
import { AutomationRuntimeModule } from "./automation-runtime.module";
import { SchedulesService } from "./schedules.service";
import { TargetSnapshotService } from "./target-snapshot.service";
import { VehicleEventRulesService } from "./vehicle-event-rules.service";

@Module({
  imports: [PrismaModule, AccessModule, AutomationRuntimeModule],
  controllers: [AutomationController, VehicleEventRulesController],
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
