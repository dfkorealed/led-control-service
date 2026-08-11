import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { gatewayDimmingCommandDraftV2Schema, mqttTopicsV2 } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { CommandDispatchService } from "./command-dispatch.service";

export interface CreateDimmingCommandInput {
  siteId: string;
  targetType: "fixture" | "group";
  targetId: string;
  brightness: number;
}

interface FixtureGatewayMapping {
  fixtureId: string;
  fixtureName: string;
  status: "online" | "offline" | "fault";
  gatewayId: string | null;
  gatewayLastHeartbeatAt: Date | null;
}

@Injectable()
export class CommandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatchService: CommandDispatchService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async createDimmingCommand(user: AuthenticatedUser, input: CreateDimmingCommandInput) {
    if (!Number.isInteger(input.brightness) || input.brightness < 0 || input.brightness > 100) {
      throw new BadRequestException("brightness must be an integer from 0 to 100");
    }

    await this.siteAccess.assert(user, input.siteId, "read");
    if (user.role === "viewer") throw new ForbiddenException("viewer users cannot control lights");
    await this.siteAccess.assert(user, input.siteId, "manage");

    const mappings = await this.resolveTargetMappings(input);
    if (mappings.length === 0) throw new BadRequestException("control target not found in the user's site");
    for (const mapping of mappings) this.assertControllable(mapping, input.targetType);
    const dispatchGroups = this.dispatchService.groupByGateway(mappings);

    return this.prisma.$transaction(async (tx) => {
      const command = await tx.command.create({
        data: {
          siteId: input.siteId,
          requestedBy: user.id,
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
        const payload = gatewayDimmingCommandDraftV2Schema.parse({
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
      return { ...command, dispatchCount: dispatchGroups.length };
    });
  }

  private async resolveTargetMappings(input: CreateDimmingCommandInput): Promise<FixtureGatewayMapping[]> {
    if (input.targetType === "fixture") {
      const fixture = await this.prisma.fixture.findFirst({
        where: {
          id: input.targetId,
          floor: { siteId: input.siteId },
        },
        include: { meshNode: { include: { gateway: true } } }
      });
      return fixture
        ? [{
            fixtureId: fixture.id,
            fixtureName: fixture.name,
            status: fixture.status,
            gatewayId: fixture.meshNode?.gatewayId ?? null,
            gatewayLastHeartbeatAt: fixture.meshNode?.gateway.lastHeartbeatAt ?? null
          }]
        : [];
    }

    const group = await this.prisma.fixtureGroup.findFirst({
      where: { id: input.targetId, siteId: input.siteId },
      include: { groupFixtures: { include: { fixture: { include: { meshNode: { include: { gateway: true } } } } } } }
    });
    return (
      group?.groupFixtures.map((item) => ({
        fixtureId: item.fixtureId,
        fixtureName: item.fixture.name,
        status: item.fixture.status,
        gatewayId: item.fixture.meshNode?.gatewayId ?? null,
        gatewayLastHeartbeatAt: item.fixture.meshNode?.gateway.lastHeartbeatAt ?? null
      })) ?? []
    );
  }

  private assertControllable(mapping: FixtureGatewayMapping, targetType: "fixture" | "group") {
    const prefix = targetType === "group" ? `group contains uncontrollable fixture: ${mapping.fixtureName}` : null;
    if (!mapping.gatewayId) {
      throw new BadRequestException(prefix ?? "fixture is not mapped to a gateway");
    }
    if (!mapping.gatewayLastHeartbeatAt || Date.now() - mapping.gatewayLastHeartbeatAt.getTime() >= 90_000) {
      throw new BadRequestException(prefix ?? "gateway is offline");
    }
    if (mapping.status === "fault") {
      throw new BadRequestException(prefix ?? "fixture is in fault state");
    }
    if (mapping.status === "offline") {
      throw new BadRequestException(prefix ?? "fixture is offline");
    }
  }
}
