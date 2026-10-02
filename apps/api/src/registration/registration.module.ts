import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AccessModule } from "../access/access.module";
import { MeshControlGroupModule } from "../mesh-control-groups/mesh-control-group.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RegistrationAllocationService } from "./registration-allocation.service";
import { RegistrationController } from "./registration.controller";
import { RegistrationService } from "./registration.service";
import { AuditModule } from "../audit/audit.module";
import { AutomationClock } from "../automation/automation-clock";
import { BioClassificationReconciliationService } from "./bio-classification-reconciliation.service";

@Module({
  imports: [PrismaModule, MqttModule, MeshControlGroupModule, AuthModule, AccessModule, AuditModule],
  controllers: [RegistrationController],
  providers: [RegistrationService, RegistrationAllocationService, BioClassificationReconciliationService, AutomationClock],
  exports: [RegistrationService, RegistrationAllocationService]
})
export class RegistrationModule {}
