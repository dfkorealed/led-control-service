import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { MeshControlGroupStatus, Prisma } from "@prisma/client";

const MIN_MESH_GROUP_ADDRESS = 0xc000;
const MAX_MESH_GROUP_ADDRESS = 0xfeff;

type MeshControlTarget =
  | { targetType: "floor"; targetId: string }
  | { targetType: "fixture_group"; targetId: string };

@Injectable()
export class MeshControlGroupService {
  async ensureFloorGroup(tx: Prisma.TransactionClient, gatewayId: string, floorId: string) {
    return this.ensureGroup(tx, gatewayId, { targetType: "floor", targetId: floorId });
  }

  async ensureFixtureGroup(tx: Prisma.TransactionClient, gatewayId: string, fixtureGroupId: string) {
    return this.ensureGroup(tx, gatewayId, {
      targetType: "fixture_group",
      targetId: fixtureGroupId
    });
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

  private formatAddress(address: number) {
    return `0x${address.toString(16).padStart(4, "0")}`;
  }
}
