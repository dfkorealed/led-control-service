import { Module } from "@nestjs/common";
import { MqttModule } from "../mqtt/mqtt.module";
import { PrismaModule } from "../prisma/prisma.module";
import { CommandsController } from "./commands.controller";
import { CommandsService } from "./commands.service";

@Module({
  imports: [PrismaModule, MqttModule],
  controllers: [CommandsController],
  providers: [CommandsService]
})
export class CommandsModule {}
