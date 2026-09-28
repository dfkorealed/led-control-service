import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AutomationRuntimeModule } from "../automation/automation-runtime.module";
import { AuthModule } from "../auth/auth.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { MeshControlGroupModule } from "../mesh-control-groups/mesh-control-group.module";
import { PrismaModule } from "../prisma/prisma.module";
import { CommandsController } from "./commands.controller";
import { CommandsService } from "./commands.service";
import { CommandDispatchService } from "./command-dispatch.service";
import { CommandStatusService } from "./command-status.service";
import { CommandVerificationService } from "./command-verification.service";
import { CommandRecoveryService } from "./command-recovery.service";
import { CommandSafetyDigest } from "./command-safety-digest";
import { CommandRecoveryRolloutGuard } from "./command-recovery-rollout.guard";

@Module({
  imports: [PrismaModule, MqttModule, AuthModule, AccessModule, MeshControlGroupModule, AutomationRuntimeModule],
  controllers: [CommandsController],
  providers: [CommandsService, CommandDispatchService, CommandStatusService, CommandVerificationService,
    CommandRecoveryService, CommandSafetyDigest, CommandRecoveryRolloutGuard]
})
export class CommandsModule {}
