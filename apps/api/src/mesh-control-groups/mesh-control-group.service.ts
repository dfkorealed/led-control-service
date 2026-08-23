import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { MeshControlGroupStatus, Prisma } from "@prisma/client";

const MIN_MESH_GROUP_ADDRESS = 0xc000;
const MAX_MESH_GROUP_ADDRESS = 0xfeff;

type MeshControlTarget =
  | { targetType: "floor"; targetId: string }
  | { targetType: "fixture_group"; targetId: string };

type AttachProvisionedNodeInput = {
  meshNodeId: string;
  gatewayId: string;
  floorId: string;
  fixtureGroupIds: string[];
};

type ReadyDestinationInput =
  | { type: "floor"; floorId: string; gatewayId: string }
  | { type: "fixture_group"; fixtureGroupId: string; gatewayId: string };

type GatewayGroupResyncInput = {
  siteId: string;
  gatewayId: string;
};

@Injectable()
export class MeshControlGroupService {
  async resetGatewayGroupsForResync(tx: Prisma.TransactionClient, input: GatewayGroupResyncInput) {
    const gateways = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Gateway"
      WHERE "id" = ${input.gatewayId} AND "siteId" = ${input.siteId}
      FOR UPDATE
    `;
    if (gateways.length === 0) {
      return { groupCount: 0, memberCount: 0 };
    }

    // Stable group ordering serializes concurrent full resets without introducing
    // a second version sequence for an idempotent recovery request.
    const groups = await tx.$queryRaw<Array<{ id: string; configurationVersion: number }>>`
      SELECT "id", "configurationVersion"
      FROM "MeshControlGroup"
      WHERE "gatewayId" = ${input.gatewayId}
      ORDER BY "id"
      FOR UPDATE
    `;
    const groupIds = groups.map((group) => group.id);
    if (groupIds.length === 0) {
      return { groupCount: 0, memberCount: 0 };
    }

    const groupUpdate = await tx.meshControlGroup.updateMany({
      where: {
        gatewayId: input.gatewayId,
        id: { in: groupIds }
      },
      data: {
        status: MeshControlGroupStatus.configuring,
        lastError: null
      }
    });
    const memberUpdate = await tx.meshControlGroupMember.updateMany({
      where: {
        gatewayId: input.gatewayId,
        groupId: { in: groupIds }
      },
      data: {
        subscriptionStatus: "pending",
        statusVersion: 0,
        lastError: null
      }
    });

    return { groupCount: groupUpdate.count, memberCount: memberUpdate.count };
  }

  async ensureFloorGroup(tx: Prisma.TransactionClient, gatewayId: string, floorId: string) {
    return this.ensureGroup(tx, gatewayId, { targetType: "floor", targetId: floorId });
  }

  async ensureFixtureGroup(tx: Prisma.TransactionClient, gatewayId: string, fixtureGroupId: string) {
    return this.ensureGroup(tx, gatewayId, {
      targetType: "fixture_group",
      targetId: fixtureGroupId
    });
  }

  async attachProvisionedNode(tx: Prisma.TransactionClient, input: AttachProvisionedNodeInput) {
    const gatewaySiteId = await this.assertMeshNodeGatewayBoundary(tx, input.meshNodeId, input.gatewayId);
    await this.assertFloorBoundary(tx, input.floorId, gatewaySiteId);

    const fixtureGroupIds = Array.from(new Set(input.fixtureGroupIds)).sort();
    await this.assertFixtureGroupBoundary(tx, fixtureGroupIds, gatewaySiteId);

    const floorGroup = await this.ensureFloorGroup(tx, input.gatewayId, input.floorId);
    await this.attachMemberToGroup(tx, floorGroup.id, floorGroup.gatewayId, input.meshNodeId);

    for (const fixtureGroupId of fixtureGroupIds) {
      const fixtureGroup = await this.ensureFixtureGroup(tx, input.gatewayId, fixtureGroupId);
      await this.attachMemberToGroup(tx, fixtureGroup.id, fixtureGroup.gatewayId, input.meshNodeId);
    }
  }

  async getReadyDestination(tx: Prisma.TransactionClient, input: ReadyDestinationInput) {
    await this.assertDestinationTargetBoundary(tx, input);

    const group = await tx.meshControlGroup.findFirst({
      where: input.type === "floor"
        ? {
          gatewayId: input.gatewayId,
          targetType: "floor",
          targetId: input.floorId
        }
        : {
          gatewayId: input.gatewayId,
          targetType: "fixture_group",
          targetId: input.fixtureGroupId
        },
      select: {
        id: true,
        groupAddress: true,
        configurationVersion: true,
        status: true
      }
    });
    if (!group || group.status !== MeshControlGroupStatus.ready) {
      throw new BadRequestException("mesh control group is not ready");
    }

    return {
      groupId: group.id,
      groupAddress: group.groupAddress,
      configurationVersion: group.configurationVersion
    };
  }

  private async ensureGroup(
    tx: Prisma.TransactionClient,
    gatewayId: string,
    target: MeshControlTarget
  ) {
    const existingGroup = await tx.meshControlGroup.findFirst({
      where: {
        gatewayId,
        targetType: target.targetType,
        targetId: target.targetId
      }
    });
    if (existingGroup) {
      const gatewaySiteId = await this.loadGatewaySiteId(tx, gatewayId);
      const targetSiteId = await this.loadTargetSiteId(tx, target);
      if (targetSiteId !== gatewaySiteId) {
        throw new BadRequestException(`${target.targetType} does not belong to the gateway site`);
      }
      return existingGroup;
    }

    const gateway = await this.lockGateway(tx, gatewayId);
    const reloadedGroup = await tx.meshControlGroup.findFirst({
      where: {
        gatewayId,
        targetType: target.targetType,
        targetId: target.targetId
      }
    });
    if (reloadedGroup) {
      return reloadedGroup;
    }

    const targetSiteId = await this.loadTargetSiteId(tx, target);
    if (targetSiteId !== gateway.siteId) {
      throw new BadRequestException(`${target.targetType} does not belong to the gateway site`);
    }

    const address = gateway.nextMeshGroupAddress;
    if (address < MIN_MESH_GROUP_ADDRESS || address > MAX_MESH_GROUP_ADDRESS) {
      throw new BadRequestException("mesh group address range exhausted");
    }

    await tx.gateway.update({
      where: { id: gatewayId },
      data: { nextMeshGroupAddress: { increment: 1 } },
      select: { nextMeshGroupAddress: true }
    });

    return tx.meshControlGroup.create({
      data: {
        gatewayId,
        targetType: target.targetType,
        targetId: target.targetId,
        groupAddress: this.formatAddress(address),
        status: MeshControlGroupStatus.configuring,
        configurationVersion: 1
      }
    });
  }

  private async loadGatewaySiteId(tx: Prisma.TransactionClient, gatewayId: string) {
    const gateway = await tx.gateway.findUnique({
      where: { id: gatewayId },
      select: { siteId: true }
    });
    if (!gateway) {
      throw new NotFoundException("gateway not found");
    }

    return gateway.siteId;
  }

  private async lockGateway(tx: Prisma.TransactionClient, gatewayId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string; siteId: string; nextMeshGroupAddress: number }>>`
      SELECT "id", "siteId", "nextMeshGroupAddress"
      FROM "Gateway"
      WHERE "id" = ${gatewayId}
      FOR UPDATE
    `;
    const gateway = rows[0];
    if (!gateway) {
      throw new NotFoundException("gateway not found");
    }

    return gateway;
  }

  private async loadTargetSiteId(tx: Prisma.TransactionClient, target: MeshControlTarget) {
    if (target.targetType === "floor") {
      const floor = await tx.floor.findUnique({
        where: { id: target.targetId },
        select: { siteId: true }
      });
      if (!floor) {
        throw new NotFoundException("floor not found");
      }

      return floor.siteId;
    }

    const fixtureGroup = await tx.fixtureGroup.findUnique({
      where: { id: target.targetId },
      select: { siteId: true }
    });
    if (!fixtureGroup) {
      throw new NotFoundException("fixture group not found");
    }

    return fixtureGroup.siteId;
  }

  private async assertMeshNodeGatewayBoundary(
    tx: Prisma.TransactionClient,
    meshNodeId: string,
    gatewayId: string
  ) {
    const meshNode = await tx.meshNode.findFirst({
      where: { id: meshNodeId, gatewayId },
      select: {
        id: true,
        gatewayId: true,
        gateway: { select: { siteId: true } }
      }
    });
    if (!meshNode) {
      throw new NotFoundException("mesh node not found");
    }

    return meshNode.gateway.siteId;
  }

  private async assertFloorBoundary(tx: Prisma.TransactionClient, floorId: string, gatewaySiteId: string) {
    const floor = await tx.floor.findFirst({
      where: { id: floorId, siteId: gatewaySiteId },
      select: { id: true }
    });
    if (!floor) {
      throw new NotFoundException("floor not found");
    }
  }

  private async assertFixtureGroupBoundary(
    tx: Prisma.TransactionClient,
    fixtureGroupIds: string[],
    gatewaySiteId: string
  ) {
    if (fixtureGroupIds.length === 0) return;

    const fixtureGroups = await tx.fixtureGroup.findMany({
      where: {
        id: { in: fixtureGroupIds },
        siteId: gatewaySiteId
      },
      select: { id: true }
    });
    if (fixtureGroups.length !== fixtureGroupIds.length) {
      throw new NotFoundException("fixture group not found");
    }
  }

  private async assertDestinationTargetBoundary(tx: Prisma.TransactionClient, input: ReadyDestinationInput) {
    if (input.type === "floor") {
      const floor = await tx.floor.findFirst({
        where: {
          id: input.floorId,
          site: { gateways: { some: { id: input.gatewayId } } }
        },
        select: { id: true }
      });
      if (!floor) {
        throw new NotFoundException("mesh control group target not found");
      }
      return;
    }

    const fixtureGroup = await tx.fixtureGroup.findFirst({
      where: {
        id: input.fixtureGroupId,
        site: { gateways: { some: { id: input.gatewayId } } }
      },
      select: { id: true }
    });
    if (!fixtureGroup) {
      throw new NotFoundException("mesh control group target not found");
    }
  }

  private async attachMemberToGroup(
    tx: Prisma.TransactionClient,
    groupId: string,
    gatewayId: string,
    meshNodeId: string
  ) {
    const lockedGroup = await this.lockControlGroup(tx, groupId, gatewayId);

    const inserted = await tx.meshControlGroupMember.createMany({
      data: [{
        groupId,
        gatewayId,
        meshNodeId
      }],
      skipDuplicates: true
    });
    if (inserted.count === 0) return;

    const group = await tx.meshControlGroup.findFirst({
      where: { id: groupId, gatewayId },
      select: {
        id: true,
        gatewayId: true,
        configurationVersion: true,
        _count: { select: { members: true } }
      }
    });
    if (!group) {
      throw new NotFoundException("mesh control group not found");
    }

    if (lockedGroup.status === MeshControlGroupStatus.ready || lockedGroup.status === MeshControlGroupStatus.failed) {
      await tx.meshControlGroup.update({
        where: { id: groupId },
        data: {
          status: MeshControlGroupStatus.configuring,
          configurationVersion: { increment: 1 },
          lastError: null
        }
      });
      await this.resetGroupMembers(tx, groupId, gatewayId);
      return;
    }

    if (group._count.members <= 1) return;

    await tx.meshControlGroup.update({
      where: { id: groupId },
      data: {
        status: MeshControlGroupStatus.configuring,
        lastError: null
      }
    });
    await this.resetGroupMembers(tx, groupId, gatewayId);
  }

  private async resetGroupMembers(tx: Prisma.TransactionClient, groupId: string, gatewayId: string) {
    await tx.meshControlGroupMember.updateMany({
      where: { groupId, gatewayId },
      data: {
        subscriptionStatus: "pending",
        statusVersion: 0,
        lastError: null
      }
    });
  }

  private async lockControlGroup(tx: Prisma.TransactionClient, groupId: string, gatewayId: string) {
    const rows = await tx.$queryRaw<Array<{
      id: string;
      gatewayId: string;
      status: MeshControlGroupStatus;
      configurationVersion: number;
    }>>`
      SELECT "id", "gatewayId", "status", "configurationVersion"
      FROM "MeshControlGroup"
      WHERE "id" = ${groupId} AND "gatewayId" = ${gatewayId}
      FOR UPDATE
    `;
    const group = rows[0];
    if (!group) {
      throw new NotFoundException("mesh control group not found");
    }

    return group;
  }

  private formatAddress(address: number) {
    return `0x${address.toString(16).padStart(4, "0")}`;
  }
}
