import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PkiModule } from "../pki/pki.module";
import { DeviceCertificateGuard } from "./device-certificate.guard";
import { GatewayOnboardingController } from "./gateway-onboarding.controller";
import { GatewayOnboardingService } from "./gateway-onboarding.service";
import { GatewayRecommissionService } from "./gateway-recommission.service";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, PkiModule, StorageModule],
  controllers: [GatewayOnboardingController],
  providers: [GatewayOnboardingService, DeviceCertificateGuard, GatewayRecommissionService],
  exports: [GatewayRecommissionService]
})
export class GatewayOnboardingModule {}
