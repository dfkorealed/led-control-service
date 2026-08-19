import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AccessModule } from "../access/access.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RegistrationAllocationService } from "./registration-allocation.service";
import { RegistrationController } from "./registration.controller";
import { RegistrationService } from "./registration.service";

@Module({
  imports: [PrismaModule, MqttModule, AuthModule, AccessModule],
  controllers: [RegistrationController],
  providers: [RegistrationService, RegistrationAllocationService],
  exports: [RegistrationService, RegistrationAllocationService]
})
export class RegistrationModule {}
