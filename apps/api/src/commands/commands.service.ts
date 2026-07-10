import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
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
    if (user.role === "viewer") {
      throw new ForbiddenException("viewer users cannot control lights");
    }

    const targetFixtureIds = await this.resolveTargetFixtureIds(input, user.organizationId);
    if (targetFixtureIds.length === 0) {
      throw new BadRequestException("control target not found in the user's site");
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
      targetFixtureIds,
      brightness: command.brightness,
      requestedBy: command.requestedBy,
      requestedAt: command.createdAt.toISOString()
    });

    await this.mqttService.publishDimmingCommand(payload);
    return command;
  }

  private async resolveTargetFixtureIds(input: CreateDimmingCommandInput, organizationId: string) {
    if (input.targetType === "fixture") {
      const fixture = await this.prisma.fixture.findFirst({
        where: {
          id: input.targetId,
          floor: { siteId: input.siteId, site: { organizationId } }
        }
      });
      return fixture ? [fixture.id] : [];
    }

    const group = await this.prisma.fixtureGroup.findFirst({
      where: {
        id: input.targetId,
        siteId: input.siteId,
        site: { organizationId }
      },
      include: { groupFixtures: true }
    });
    return group?.groupFixtures.map((item) => item.fixtureId) ?? [];
  }
}
