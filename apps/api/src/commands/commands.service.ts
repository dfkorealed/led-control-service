import { BadRequestException, Injectable } from "@nestjs/common";
import { dimmingCommandSchema } from "@led-control/shared";
import { MqttService } from "../mqtt/mqtt.service";
import { PrismaService } from "../prisma/prisma.service";

interface CreateDimmingCommandInput {
  siteId: string;
  targetType: "fixture" | "group";
  targetId: string;
  brightness: number;
  requestedBy: string;
}

@Injectable()
export class CommandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mqttService: MqttService
  ) {}

  async createDimmingCommand(input: CreateDimmingCommandInput) {
    if (!Number.isInteger(input.brightness) || input.brightness < 0 || input.brightness > 100) {
      throw new BadRequestException("brightness must be an integer from 0 to 100");
    }

    const user = await this.prisma.user.findUnique({ where: { id: input.requestedBy } });
    if (!user) {
      throw new BadRequestException("requestedBy must reference an existing user id");
    }

    const command = await this.prisma.command.create({
      data: {
        siteId: input.siteId,
        requestedBy: input.requestedBy,
        targetType: input.targetType,
        targetId: input.targetId,
        brightness: input.brightness
      }
    });

    const payload = dimmingCommandSchema.parse({
      commandId: command.id,
      siteId: command.siteId,
      targetType: command.targetType,
      targetId: command.targetId,
      brightness: command.brightness,
      requestedBy: command.requestedBy,
      requestedAt: command.createdAt.toISOString()
    });

    await this.mqttService.publishDimmingCommand(payload);
    return command;
  }
}
