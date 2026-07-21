import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PkiModule } from "../pki/pki.module";
import { DeviceCertificateGuard } from "./device-certificate.guard";
import { GatewayOnboardingController } from "./gateway-onboarding.controller";
import { GatewayOnboardingService } from "./gateway-onboarding.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, PkiModule],
  controllers: [GatewayOnboardingController],
  providers: [GatewayOnboardingService, DeviceCertificateGuard]
})
export class GatewayOnboardingModule {}
