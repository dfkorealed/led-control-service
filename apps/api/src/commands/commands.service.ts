import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import {
  CreateDimmingCommandInput,
  DimmingTarget,
  gatewayDimmingCommandDraftV2Schema,
  isGatewayHeartbeatFresh,
  mqttTopicsV2
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { PrismaService } from "../prisma/prisma.service";
import { CommandDispatchService } from "./command-dispatch.service";

type DeliveryMode = "unicast" | "parallel_unicast" | "mesh_group";

interface FixtureGatewayMapping {
  fixtureId: string;
  fixtureName: string;
  floorId: string;
  status: "online" | "offline" | "fault";
  gatewayId: string | null;
  gatewayLastHeartbeatAt: Date | null;
}

interface ResolvedControlTarget {
  fixtureIds: string[];
  gatewayId: string;
  deliveryMode: DeliveryMode;
  destinationAddress?: string;
}

type FixtureRow = {
  id: string;
  floorId: string;
  name: string;
  status: "online" | "offline" | "fault";
  meshNode: {
    gatewayId: string;
    gateway: { lastHeartbeatAt: Date | null };
  } | null;
};

const fixtureControlSelect = {
  id: true,
  floorId: true,
  name: true,
  status: true,
  meshNode: {
    select: {
      gatewayId: true,
      gateway: { select: { lastHeartbeatAt: true } }
    }
  }
} satisfies Prisma.FixtureSelect;

@Injectable()
export class CommandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatchService: CommandDispatchService,
    private readonly siteAccess: SiteAccessService,
    private readonly meshControlGroups: MeshControlGroupService
  ) {}

  async createDimmingCommand(user: AuthenticatedUser, input: CreateDimmingCommandInput) {
    if (!Number.isInteger(input.brightness) || input.brightness < 0 || input.brightness > 100) {
      throw new BadRequestException("brightness must be an integer from 0 to 100");
    }

    await this.siteAccess.assert(user, input.siteId, "read");
    if (user.role === "viewer") throw new ForbiddenException("viewer users cannot control lights");
    await this.siteAccess.assert(user, input.siteId, "manage");

    return this.prisma.$transaction(async (tx) => {
      const mappings = await this.resolveTargetMappings(tx, input.siteId, input.target);
      if (mappings.length === 0) {
        throw new BadRequestException("control target not found in the user's site");
      }
      for (const mapping of mappings) this.assertControllable(mapping, input.target.type);

      const dispatchTarget = this.dispatchService.resolveSingleGateway(mappings);
      const resolved = await this.resolveDelivery(
        tx,
        input.siteId,
        input.target,
        mappings,
        dispatchTarget.gatewayId,
        dispatchTarget.fixtureIds
      );
      const targetId = this.targetId(input.target);
      const command = await tx.command.create({
        data: {
          siteId: input.siteId,
          requestedBy: user.id,
          targetType: input.target.type,
          targetId,
          targetFixtureIds: resolved.fixtureIds,
          brightness: input.brightness
        }
      });

      const gateway = await tx.gateway.update({
        where: { id: resolved.gatewayId },
        data: { nextCommandSequence: { increment: 1 } },
        select: { id: true, siteId: true, nextCommandSequence: true }
      });
      if (gateway.siteId !== input.siteId) {
        throw new BadRequestException("gateway does not belong to command site");
      }
      const sequence = Number(gateway.nextCommandSequence);
      if (!Number.isSafeInteger(sequence)) throw new Error("gateway command sequence exceeded safe integer range");

      const idempotencyKey = randomUUID();
      const dispatch = await tx.commandDispatch.create({
        data: {
          commandId: command.id,
          gatewayId: gateway.id,
          idempotencyKey,
          sequence,
          deliveryMode: resolved.deliveryMode,
          destinationAddress: resolved.destinationAddress ?? null
        }
      });
      await tx.commandFixtureResult.createMany({
        data: resolved.fixtureIds.map((fixtureId) => ({ dispatchId: dispatch.id, fixtureId }))
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
        targetFixtureIds: resolved.fixtureIds,
        deliveryMode: resolved.deliveryMode,
        ...(resolved.destinationAddress ? { destinationAddress: resolved.destinationAddress } : {}),
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

      return {
        ...command,
        dispatchCount: 1,
        selectedTargetCount: resolved.fixtureIds.length,
        transmissionCount: resolved.deliveryMode === "mesh_group" ? 1 : resolved.fixtureIds.length,
        deliveryMode: resolved.deliveryMode,
        terminalStatusUrl: `/commands/${command.id}`
      };
    });
  }

  private async resolveTargetMappings(
    tx: Prisma.TransactionClient,
    siteId: string,
    target: DimmingTarget
  ): Promise<FixtureGatewayMapping[]> {
    if (target.type === "fixture" || target.type === "fixtures") {
      const requestedIds = target.type === "fixture" ? [target.fixtureId] : [...target.fixtureIds].sort();
      const fixtures = await tx.fixture.findMany({
        where: { id: { in: requestedIds }, floor: { siteId } },
        select: fixtureControlSelect
      });
      if (fixtures.length !== requestedIds.length) return [];
      return this.toMappings(fixtures as FixtureRow[]);
    }

    if (target.type === "floor") {
      const floor = await tx.floor.findFirst({
        where: { id: target.floorId, siteId },
        select: { id: true, fixtures: { select: fixtureControlSelect } }
      });
      return floor ? this.toMappings(floor.fixtures as FixtureRow[]) : [];
    }

    const group = await tx.fixtureGroup.findFirst({
      where: {
        id: target.groupId,
        siteId,
        groupFixtures: { every: { fixture: { floor: { siteId } } } }
      },
      select: {
        id: true,
        groupFixtures: {
          select: { fixtureId: true, fixture: { select: fixtureControlSelect } }
        }
      }
    });
    return group
      ? this.toMappings(group.groupFixtures.map((item) => item.fixture) as FixtureRow[])
      : [];
  }

  private toMappings(fixtures: FixtureRow[]): FixtureGatewayMapping[] {
    return fixtures.map((fixture) => ({
      fixtureId: fixture.id,
      fixtureName: fixture.name,
      floorId: fixture.floorId,
      status: fixture.status,
      gatewayId: fixture.meshNode?.gatewayId ?? null,
      gatewayLastHeartbeatAt: fixture.meshNode?.gateway.lastHeartbeatAt ?? null
    })).sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
  }

  private async resolveDelivery(
    tx: Prisma.TransactionClient,
    siteId: string,
    target: DimmingTarget,
    mappings: FixtureGatewayMapping[],
    gatewayId: string,
    fixtureIds: string[]
  ): Promise<ResolvedControlTarget> {
    if (target.type === "fixture" || (target.type === "fixtures" && fixtureIds.length === 1)) {
      return { fixtureIds, gatewayId, deliveryMode: "unicast" };
    }
    if (target.type === "floor") {
      const destination = await this.meshControlGroups.getReadyDestination(tx, {
        type: "floor",
        floorId: target.floorId,
        gatewayId
      });
      return { fixtureIds, gatewayId, deliveryMode: "mesh_group", destinationAddress: destination.groupAddress };
    }
    if (target.type === "group") {
      const destination = await this.meshControlGroups.getReadyDestination(tx, {
        type: "fixture_group",
        fixtureGroupId: target.groupId,
        gatewayId
      });
      return { fixtureIds, gatewayId, deliveryMode: "mesh_group", destinationAddress: destination.groupAddress };
    }

    const promoted = await this.findExactReadyDestination(tx, siteId, gatewayId, mappings, fixtureIds);
    return promoted
      ? { fixtureIds, gatewayId, deliveryMode: "mesh_group", destinationAddress: promoted }
      : { fixtureIds, gatewayId, deliveryMode: "parallel_unicast" };
  }

  private async findExactReadyDestination(
    tx: Prisma.TransactionClient,
    siteId: string,
    gatewayId: string,
    mappings: FixtureGatewayMapping[],
    fixtureIds: string[]
  ) {
    const floorIds = [...new Set(mappings.map((mapping) => mapping.floorId))];
    const floors = await tx.floor.findMany({
      where: { id: { in: floorIds }, siteId },
      select: { id: true, fixtures: { select: { id: true } } }
    });
    const exactFloors = floors
      .filter((floor) => this.sameFixtureSet(fixtureIds, floor.fixtures.map((fixture) => fixture.id)))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const floor of exactFloors) {
      const address = await this.tryReadyDestination(tx, {
        type: "floor" as const,
        floorId: floor.id,
        gatewayId
      });
      if (address) return address;
    }

    const groups = await tx.fixtureGroup.findMany({
      where: {
        siteId,
        AND: [
          { groupFixtures: { some: { fixtureId: { in: fixtureIds } } } },
          { groupFixtures: { every: { fixture: { floor: { siteId } } } } }
        ]
      },
      select: { id: true, groupFixtures: { select: { fixtureId: true } } }
    });
    const exactGroups = groups
      .filter((group) => this.sameFixtureSet(fixtureIds, group.groupFixtures.map((item) => item.fixtureId)))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const group of exactGroups) {
      const address = await this.tryReadyDestination(tx, {
        type: "fixture_group" as const,
        fixtureGroupId: group.id,
        gatewayId
      });
      if (address) return address;
    }
    return null;
  }

  private async tryReadyDestination(
    tx: Prisma.TransactionClient,
    input:
      | { type: "floor"; floorId: string; gatewayId: string }
      | { type: "fixture_group"; fixtureGroupId: string; gatewayId: string }
  ) {
    try {
      return (await this.meshControlGroups.getReadyDestination(tx, input)).groupAddress;
    } catch (error) {
      if (error instanceof BadRequestException && error.message === "mesh control group is not ready") return null;
      throw error;
    }
  }

  private sameFixtureSet(expected: string[], actual: string[]) {
    if (expected.length !== actual.length) return false;
    const sortedActual = [...actual].sort();
    return expected.every((fixtureId, index) => fixtureId === sortedActual[index]);
  }

  private targetId(target: DimmingTarget) {
    if (target.type === "fixture") return target.fixtureId;
    if (target.type === "floor") return target.floorId;
    if (target.type === "group") return target.groupId;
    return null;
  }

  private assertControllable(mapping: FixtureGatewayMapping, targetType: DimmingTarget["type"]) {
    const prefix = targetType === "fixture" ? null : `target contains uncontrollable fixture: ${mapping.fixtureName}`;
    if (!mapping.gatewayId) throw new BadRequestException(prefix ?? "fixture is not mapped to a gateway");
    if (!isGatewayHeartbeatFresh(mapping.gatewayLastHeartbeatAt, new Date())) {
      throw new BadRequestException(prefix ?? "gateway is offline");
    }
    if (mapping.status === "fault") throw new BadRequestException(prefix ?? "fixture is in fault state");
    if (mapping.status === "offline") throw new BadRequestException(prefix ?? "fixture is offline");
  }
}
