import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MonitoringRefreshController } from "./monitoring-refresh.controller";
import { MonitoringRefreshExpiryService } from "./monitoring-refresh-expiry.service";
import { MonitoringRefreshOutboxService } from "./monitoring-refresh-outbox.service";
import { MonitoringRefreshService } from "./monitoring-refresh.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, MqttModule],
  controllers: [MonitoringRefreshController],
  providers: [MonitoringRefreshService, MonitoringRefreshOutboxService, MonitoringRefreshExpiryService],
  exports: [MonitoringRefreshService]
})
export class MonitoringRefreshModule {}
