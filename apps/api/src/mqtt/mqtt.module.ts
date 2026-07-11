import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { MqttService } from "./mqtt.service";
import { FixtureFreshnessService } from "../fixtures/fixture-freshness.service";
import { CommandTimeoutService } from "../commands/command-timeout.service";
import { OutboxPublisherService } from "./outbox-publisher.service";

@Module({
  imports: [PrismaModule],
  providers: [MqttService, FixtureFreshnessService, OutboxPublisherService, CommandTimeoutService],
  exports: [MqttService]
})
export class MqttModule {}
