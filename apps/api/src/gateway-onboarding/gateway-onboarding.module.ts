import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { DeviceCertificateGuard } from "./device-certificate.guard";
import { GatewayOnboardingController } from "./gateway-onboarding.controller";
import { GatewayOnboardingService } from "./gateway-onboarding.service";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [GatewayOnboardingController],
  providers: [GatewayOnboardingService, DeviceCertificateGuard]
})
export class GatewayOnboardingModule {}
