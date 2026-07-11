import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { MqttService } from "./mqtt.service";
import { FixtureFreshnessService } from "../fixtures/fixture-freshness.service";

@Module({
  imports: [PrismaModule],
  providers: [MqttService, FixtureFreshnessService],
  exports: [MqttService]
})
export class MqttModule {}
