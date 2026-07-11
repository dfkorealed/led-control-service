import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { gatewayDimmingCommandV2Schema, mqttTopicsV2 } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CommandDispatchService } from "./command-dispatch.service";

interface CreateDimmingCommandInput {
  siteId: string;
  targetType: "fixture" | "group";
  targetId: string;
  brightness: number;
  requestedBy: string;
}

interface FixtureGatewayMapping {
  fixtureId: string;
  gatewayId: string | null;
}

@Injectable()
export class CommandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatchService: CommandDispatchService
  ) {}

  async createDimmingCommand(input: CreateDimmingCommandInput) {
    if (!Number.isInteger(input.brightness) || input.brightness < 0 || input.brightness > 100) {
      throw new BadRequestException("brightness must be an integer from 0 to 100");
    }

    const user = await this.prisma.user.findUnique({ where: { id: input.requestedBy } });
    if (!user) throw new BadRequestException("requestedBy must reference an existing user id");
    if (user.role === "viewer") throw new ForbiddenException("viewer users cannot control lights");

    const mappings = await this.resolveTargetMappings(input, user.organizationId);
    if (mappings.length === 0) throw new BadRequestException("control target not found in the user's site");
    const dispatchGroups = this.dispatchService.groupByGateway(mappings);

    return this.prisma.$transaction(async (tx) => {
      const command = await tx.command.create({
        data: {
          siteId: input.siteId,
          requestedBy: input.requestedBy,
          targetType: input.targetType,
          targetId: input.targetId,
          brightness: input.brightness
        }
      });

      for (const group of dispatchGroups) {
        const gateway = await tx.gateway.update({
          where: { id: group.gatewayId },
          data: { nextCommandSequence: { increment: 1 } },
          select: { id: true, siteId: true, nextCommandSequence: true }
        });
        if (gateway.siteId !== input.siteId) throw new BadRequestException("gateway does not belong to command site");
        const sequence = Number(gateway.nextCommandSequence);
        if (!Number.isSafeInteger(sequence)) throw new Error("gateway command sequence exceeded safe integer range");
        const idempotencyKey = randomUUID();
        const dispatch = await tx.commandDispatch.create({
          data: { commandId: command.id, gatewayId: gateway.id, idempotencyKey, sequence }
        });
        await tx.commandFixtureResult.createMany({
          data: group.fixtureIds.map((fixtureId) => ({ dispatchId: dispatch.id, fixtureId }))
        });
        const payload = gatewayDimmingCommandV2Schema.parse({
          commandId: command.id,
          dispatchId: dispatch.id,
          idempotencyKey,
          sequence,
          siteId: command.siteId,
          gatewayId: gateway.id,
          targetType: command.targetType,
          targetId: command.targetId,
          targetFixtureIds: group.fixtureIds,
          brightness: command.brightness,
          requestedBy: command.requestedBy,
          requestedAt: command.createdAt.toISOString()
        });
        await tx.mqttOutbox.create({
          data: {
            dispatchId: dispatch.id,
            topic: mqttTopicsV2.gatewayCommand(command.siteId, gateway.id, "dimming"),
            payload
          }
        });
      }
      return command;
    });
  }

  private async resolveTargetMappings(input: CreateDimmingCommandInput, organizationId: string): Promise<FixtureGatewayMapping[]> {
    if (input.targetType === "fixture") {
      const fixture = await this.prisma.fixture.findFirst({
        where: {
          id: input.targetId,
          floor: { siteId: input.siteId, site: { organizationId } },
          meshNode: { gateway: { siteId: input.siteId } }
        },
        include: { meshNode: true }
      });
      return fixture ? [{ fixtureId: fixture.id, gatewayId: fixture.meshNode?.gatewayId ?? null }] : [];
    }

    const group = await this.prisma.fixtureGroup.findFirst({
      where: { id: input.targetId, siteId: input.siteId, site: { organizationId } },
      include: { groupFixtures: { include: { fixture: { include: { meshNode: true } } } } }
    });
    return (
      group?.groupFixtures.map((item) => ({
        fixtureId: item.fixtureId,
        gatewayId: item.fixture.meshNode?.gatewayId ?? null
      })) ?? []
    );
  }
}
