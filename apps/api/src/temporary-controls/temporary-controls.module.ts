import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { AutomationRuntimeModule } from "../automation/automation-runtime.module";
import { TargetSnapshotService } from "../automation/target-snapshot.service";
import { MqttModule } from "../mqtt/mqtt.module";
import { PrismaModule } from "../prisma/prisma.module";
import { TemporaryControlsController } from "./temporary-controls.controller";
import { TemporaryControlsService } from "./temporary-controls.service";
import { TemporaryControlPublisher } from "./temporary-control-publisher";
import { TemporaryControlResults } from "./temporary-control-results";
import { TemporaryControlRetention } from "./temporary-control-retention";

@Module({ imports: [PrismaModule, AccessModule, AuthModule, AutomationRuntimeModule, MqttModule],
  controllers: [TemporaryControlsController],
  providers: [TemporaryControlsService, TargetSnapshotService, TemporaryControlPublisher, TemporaryControlResults, TemporaryControlRetention],
  exports: [TemporaryControlsService, TemporaryControlResults] })
export class TemporaryControlsModule {}
