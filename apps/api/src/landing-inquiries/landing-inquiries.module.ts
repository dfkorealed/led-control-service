import { LandingMailTransport } from "./landing-mail.transport";
import { LandingMailWorker } from "./landing-mail.worker";
import { OperatorLandingInquiriesController } from "./operator-landing-inquiries.controller";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AccessModule } from "../access/access.module";
import { LandingMailOAuthService } from "./landing-mail-oauth.service";
import { LandingMailCallbackController, OperatorLandingMailController } from "./landing-mail.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { RedisModule } from "../redis/redis.module";
import { LandingInquiryRateLimitService } from "./landing-inquiry-rate-limit.service";
import { LANDING_MAIL_CONNECTION } from "./landing-mail-connection";
import { LandingInquiriesController } from "./landing-inquiries.controller";
import { LandingInquiriesService } from "./landing-inquiries.service";

@Module({
  imports: [PrismaModule, RedisModule, AuthModule, AccessModule],
  controllers: [OperatorLandingInquiriesController, LandingInquiriesController, LandingMailCallbackController, OperatorLandingMailController],
  providers: [LandingMailTransport, LandingMailWorker, LandingInquiriesService, LandingInquiryRateLimitService, LandingMailOAuthService,
    { provide: LANDING_MAIL_CONNECTION, useExisting: LandingMailOAuthService }],
  exports: [LandingInquiriesService, LandingMailOAuthService]
})
export class LandingInquiriesModule {}
