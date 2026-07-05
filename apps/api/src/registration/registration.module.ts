import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RegistrationController } from "./registration.controller";
import { RegistrationService } from "./registration.service";

@Module({
  imports: [PrismaModule, MqttModule, AuthModule],
  controllers: [RegistrationController],
  providers: [RegistrationService],
  exports: [RegistrationService]
})
export class RegistrationModule {}
