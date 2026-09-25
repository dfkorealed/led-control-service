import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { RedisModule } from "../redis/redis.module";
import { LandingInquiryRateLimitService } from "./landing-inquiry-rate-limit.service";
import { LANDING_MAIL_CONNECTION, UnconfiguredLandingMailConnection } from "./landing-mail-connection";
import { LandingInquiriesController } from "./landing-inquiries.controller";
import { LandingInquiriesService } from "./landing-inquiries.service";

@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [LandingInquiriesController],
  providers: [LandingInquiriesService, LandingInquiryRateLimitService,
    { provide: LANDING_MAIL_CONNECTION, useClass: UnconfiguredLandingMailConnection }],
  exports: [LandingInquiriesService]
})
export class LandingInquiriesModule {}
