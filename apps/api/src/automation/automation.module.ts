import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AutomationController, VehicleEventRulesController } from "./automation.controller";
import { AutomationClock } from "./automation-clock";
import { AutomationSnapshotService } from "./automation-snapshot.service";
import { SchedulesService } from "./schedules.service";
import { TargetSnapshotService } from "./target-snapshot.service";
import { VehicleEventRulesService } from "./vehicle-event-rules.service";
import { VehicleSensorCapabilityService } from "./vehicle-sensor-capability.service";

@Module({
  imports: [PrismaModule, AccessModule],
  controllers: [AutomationController, VehicleEventRulesController],
  providers: [
    AutomationClock,
    AutomationSnapshotService,
    SchedulesService,
    TargetSnapshotService,
    VehicleEventRulesService,
    VehicleSensorCapabilityService
  ],
  exports: [
    AutomationClock,
    AutomationSnapshotService,
    SchedulesService,
    TargetSnapshotService,
    VehicleEventRulesService,
    VehicleSensorCapabilityService
  ]
})
export class AutomationModule {}
