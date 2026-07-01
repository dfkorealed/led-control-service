import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { MqttService } from "./mqtt.service";

@Module({
  imports: [PrismaModule],
  providers: [MqttService],
  exports: [MqttService]
})
export class MqttModule {}
