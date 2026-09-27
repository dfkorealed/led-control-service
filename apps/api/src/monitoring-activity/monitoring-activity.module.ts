import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MonitoringActivityController } from "./monitoring-activity.controller";
import { MonitoringActivityService } from "./monitoring-activity.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule],
  controllers: [MonitoringActivityController],
  providers: [MonitoringActivityService]
})
export class MonitoringActivityModule {}
