import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { PrismaModule } from "../prisma/prisma.module";
import { CommandsController } from "./commands.controller";
import { CommandsService } from "./commands.service";
import { CommandDispatchService } from "./command-dispatch.service";

@Module({
  imports: [PrismaModule, MqttModule, AuthModule],
  controllers: [CommandsController],
  providers: [CommandsService, CommandDispatchService]
})
export class CommandsModule {}
