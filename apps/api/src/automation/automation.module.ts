import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AutomationController } from "./automation.controller";
import { SchedulesService } from "./schedules.service";
import { TargetSnapshotService } from "./target-snapshot.service";

@Module({
  imports: [PrismaModule, AccessModule],
  controllers: [AutomationController],
  providers: [SchedulesService, TargetSnapshotService],
  exports: [SchedulesService, TargetSnapshotService]
})
export class AutomationModule {}

