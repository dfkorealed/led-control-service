import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AutomationController } from "./automation.controller";
import { AutomationClock } from "./automation-clock";
import { AutomationSnapshotService } from "./automation-snapshot.service";
import { SchedulesService } from "./schedules.service";
import { TargetSnapshotService } from "./target-snapshot.service";

@Module({
  imports: [PrismaModule, AccessModule],
  controllers: [AutomationController],
  providers: [AutomationClock, AutomationSnapshotService, SchedulesService, TargetSnapshotService],
  exports: [AutomationClock, AutomationSnapshotService, SchedulesService, TargetSnapshotService]
})
export class AutomationModule {}
