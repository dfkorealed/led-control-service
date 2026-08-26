import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { MeshGroupSubscriptionSyncPayload } from "@led-control/shared";
import { MeshControlGroupStatus, Prisma } from "@prisma/client";

const MIN_MESH_GROUP_ADDRESS = 0xc000;
const MAX_MESH_GROUP_ADDRESS = 0xfeff;
const MAX_FIXTURE_GROUPS_PER_NODE = 15;
const MAX_CONFIGURATION_VERSION = 2_147_483_647;
const MESH_GROUP_RESYNC_EVENT_TYPE = "mesh_group_resync_request";

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
  eventId: string;
  occurredAt: string;
};

type PrepareSubscriptionSyncInput = {
  groupId: string;
  gatewayId: string;
  configurationVersion: number;
  requestedAt: string;
};

type LockedGateway = {
  id: string;
  siteId: string;
  nextMeshGroupAddress: number;
};

@Injectable()
export class MeshControlGroupService {
  async prepareSubscriptionSync(
    tx: Prisma.TransactionClient,
    input: PrepareSubscriptionSyncInput
  ): Promise<MeshGroupSubscriptionSyncPayload | null> {
    const groups = await tx.$queryRaw<Array<{
      id: string;
      gatewayId: string;
      groupAddress: string;
      configurationVersion: number;
      operationPlanVersion: number;
      status: MeshControlGroupStatus;
      siteId: string;
    }>>`
      SELECT group_state."id", group_state."gatewayId", group_state."groupAddress",
        group_state."configurationVersion", group_state."operationPlanVersion",
        group_state."status", gateway."siteId"
      FROM "MeshControlGroup" group_state
      INNER JOIN "Gateway" gateway ON gateway."id" = group_state."gatewayId"
      WHERE group_state."id" = ${input.groupId}
        AND group_state."gatewayId" = ${input.gatewayId}
        AND group_state."configurationVersion" = ${input.configurationVersion}
        AND group_state."status" IN ('configuring', 'retiring')
      FOR UPDATE OF group_state
    `;
    const group = groups[0];
    if (!group) return null;

    const desiredMembers = await tx.meshControlGroupMember.findMany({
      where: { groupId: group.id, gatewayId: group.gatewayId, desired: true },
      orderBy: [{ meshNodeId: "asc" }],
      select: {
        meshNodeId: true,
        meshNode: { select: { meshAddress: true } }
      }
    });
    const normalizedDesired = desiredMembers.map((member) => ({
      meshNodeId: member.meshNodeId,
      meshAddress: member.meshNode.meshAddress.toLowerCase()
    }));

    if (group.operationPlanVersion !== group.configurationVersion) {
      const appliedMembers = await tx.meshControlGroupAppliedMember.findMany({
        where: { groupId: group.id, gatewayId: group.gatewayId },
        orderBy: [{ meshNodeId: "asc" }, { meshAddress: "asc" }],
        select: { meshNodeId: true, meshAddress: true }
      });
      const desiredKeys = new Set(normalizedDesired.map(meshMemberKey));
      const appliedKeys = new Set(appliedMembers.map(meshMemberKey));
      const operations = [
        ...appliedMembers
          .map(normalizeMeshMember)
          .filter((member) => !desiredKeys.has(meshMemberKey(member)))
          .map((member) => ({ action: "delete" as const, ...member })),
        ...normalizedDesired
          .filter((member) => !appliedKeys.has(meshMemberKey(member)))
          .map((member) => ({ action: "add" as const, ...member }))
      ];

      await tx.meshControlGroupExpectedOperation.deleteMany({
        where: { groupId: group.id, configurationVersion: group.configurationVersion }
      });
      if (operations.length > 0) {
        await tx.meshControlGroupExpectedOperation.createMany({
          data: operations.map((operation) => ({
            operationId: randomUUID(),
            groupId: group.id,
            gatewayId: group.gatewayId,
            configurationVersion: group.configurationVersion,
            ...operation,
            status: "pending" as const,
            lastError: null
          }))
        });
      }
      await tx.meshControlGroup.updateMany({
        where: {
          id: group.id,
          gatewayId: group.gatewayId,
          configurationVersion: group.configurationVersion
        },
        data: { operationPlanVersion: group.configurationVersion }
      });
    }

    const expectedOperations = await tx.meshControlGroupExpectedOperation.findMany({
      where: {
        groupId: group.id,
        gatewayId: group.gatewayId,
        configurationVersion: group.configurationVersion
      },
      orderBy: [{ action: "desc" }, { meshNodeId: "asc" }, { meshAddress: "asc" }],
      select: {
        operationId: true,
        action: true,
        meshNodeId: true,
        meshAddress: true
      }
    });

    return {
      siteId: group.siteId,
      gatewayId: group.gatewayId,
      groupId: group.id,
      version: group.configurationVersion,
      groupAddress: group.groupAddress.toLowerCase(),
      desiredMembers: normalizedDesired,
      expectedOperations: expectedOperations.map((operation) => ({
        ...operation,
        meshAddress: operation.meshAddress.toLowerCase()
      })),
      requestedAt: input.requestedAt
    };
  }

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

    // Resync events have no monotonic sequence. The gateway row lock serializes
    // this per-event-type sequence allocation while eventId remains the dedupe key.
    const insertedEvents = await tx.$queryRaw<Array<{ eventId: string }>>`
      INSERT INTO "ProcessedGatewayEvent" ("eventId", "gatewayId", "sequence", "eventType", "occurredAt")
      SELECT
        ${input.eventId},
        ${input.gatewayId},
        COALESCE(MAX("sequence"), -1::bigint) + 1::bigint,
        ${MESH_GROUP_RESYNC_EVENT_TYPE},
        ${new Date(input.occurredAt)}
      FROM "ProcessedGatewayEvent"
      WHERE "gatewayId" = ${input.gatewayId}
        AND "eventType" = ${MESH_GROUP_RESYNC_EVENT_TYPE}
      ON CONFLICT DO NOTHING
      RETURNING "eventId"
    `;
    if (insertedEvents.length === 0) {
      return { groupCount: 0, memberCount: 0 };
    }

    // Stable group ordering serializes concurrent full resets without introducing
    // a second version sequence for an idempotent recovery request.
    const groups = await tx.$queryRaw<Array<{
      id: string;
      configurationVersion: number;
      status: MeshControlGroupStatus;
    }>>`
      SELECT "id", "configurationVersion", "status"
      FROM "MeshControlGroup"
      WHERE "gatewayId" = ${input.gatewayId}
        AND "status" <> 'retired'
      ORDER BY "id"
      FOR UPDATE
    `;
    const groupIds = groups.map((group) => group.id);
    if (groupIds.length === 0) {
      return { groupCount: 0, memberCount: 0 };
    }
    if (groups.some((group) => group.configurationVersion >= MAX_CONFIGURATION_VERSION)) {
      throw new InternalServerErrorException("mesh control group configuration version exhausted");
    }

    const configuringGroupIds = groups
      .filter((group) => group.status !== MeshControlGroupStatus.retiring)
      .map((group) => group.id);
    const retiringGroupIds = groups
      .filter((group) => group.status === MeshControlGroupStatus.retiring)
      .map((group) => group.id);
    let groupCount = 0;
    if (configuringGroupIds.length > 0) {
      const update = await tx.meshControlGroup.updateMany({
        where: { gatewayId: input.gatewayId, id: { in: configuringGroupIds } },
        data: {
          status: MeshControlGroupStatus.configuring,
          configurationVersion: { increment: 1 },
          operationPlanVersion: 0,
          lastError: null
        }
      });
      groupCount += update.count;
    }
    if (retiringGroupIds.length > 0) {
      const update = await tx.meshControlGroup.updateMany({
        where: { gatewayId: input.gatewayId, id: { in: retiringGroupIds } },
        data: {
          status: MeshControlGroupStatus.retiring,
          configurationVersion: { increment: 1 },
          operationPlanVersion: 0,
          lastError: null
        }
      });
      groupCount += update.count;
    }
    const memberUpdate = await tx.meshControlGroupMember.updateMany({
      where: {
        gatewayId: input.gatewayId,
        groupId: { in: groupIds }
      },
      data: {
        subscriptionStatus: "pending",
        statusVersion: 0,
        operationId: null,
        operation: null,
        lastError: null
      }
    });

    return { groupCount, memberCount: memberUpdate.count };
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
    const fixtureGroupIds = Array.from(new Set(input.fixtureGroupIds)).sort();
    if (fixtureGroupIds.length > MAX_FIXTURE_GROUPS_PER_NODE) {
      throw new BadRequestException(`a node can belong to at most ${MAX_FIXTURE_GROUPS_PER_NODE} fixture groups`);
    }

    const gateway = await this.lockGateway(tx, input.gatewayId);
    const gatewaySiteId = await this.assertMeshNodeGatewayBoundary(tx, input.meshNodeId, input.gatewayId);
    await this.assertFloorBoundary(tx, input.floorId, gatewaySiteId);
    await this.assertFixtureGroupBoundary(tx, fixtureGroupIds, gatewaySiteId);

    const floorGroup = await this.ensureGroup(
      tx,
      input.gatewayId,
      { targetType: "floor", targetId: input.floorId },
      gateway
    );
    await this.attachMemberToGroup(tx, floorGroup.id, floorGroup.gatewayId, input.meshNodeId);

    for (const fixtureGroupId of fixtureGroupIds) {
      const fixtureGroup = await this.ensureGroup(
        tx,
        input.gatewayId,
        { targetType: "fixture_group", targetId: fixtureGroupId },
        gateway
      );
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
    target: MeshControlTarget,
    lockedGateway?: LockedGateway
  ) {
    const gateway = lockedGateway ?? await this.lockGateway(tx, gatewayId);
    const existingGroup = await tx.meshControlGroup.findFirst({
      where: {
        gatewayId,
        targetType: target.targetType,
        targetId: target.targetId
      }
    });
    if (existingGroup) {
      const targetSiteId = await this.loadTargetSiteId(tx, target);
      if (targetSiteId !== gateway.siteId) {
        throw new BadRequestException(`${target.targetType} does not belong to the gateway site`);
      }
      return existingGroup;
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

    const insertedGroups = await tx.$queryRaw<Array<{
      id: string;
      gatewayId: string;
      targetType: "floor" | "fixture_group";
      targetId: string;
      groupAddress: string;
      status: MeshControlGroupStatus;
      configurationVersion: number;
      lastError: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>>(Prisma.sql`
      INSERT INTO "MeshControlGroup" (
        "id", "gatewayId", "targetType", "targetId", "groupAddress",
        "status", "configurationVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${randomUUID()}, ${gatewayId}, CAST(${target.targetType} AS "MeshControlTargetType"),
        ${target.targetId}, ${this.formatAddress(address)}, 'configuring', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT ("gatewayId", "targetType", "targetId") DO NOTHING
      RETURNING *
    `);
    if (insertedGroups[0]) return insertedGroups[0];

    const concurrentGroup = await tx.meshControlGroup.findFirst({
      where: { gatewayId, targetType: target.targetType, targetId: target.targetId }
    });
    if (concurrentGroup) return concurrentGroup;
    throw new InternalServerErrorException("mesh control group conflict could not be recovered");
  }

  private async lockGateway(tx: Prisma.TransactionClient, gatewayId: string) {
    const rows = await tx.$queryRaw<LockedGateway[]>`
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
        lifecycleStatus: "active",
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
          operationPlanVersion: 0,
          lastError: null
        }
      });
      await this.resetGroupMembers(tx, groupId, gatewayId);
      return;
    }

    if (group._count.members <= 1) {
      await tx.meshControlGroup.update({
        where: { id: groupId },
        data: { operationPlanVersion: 0 }
      });
      return;
    }

    await tx.meshControlGroup.update({
      where: { id: groupId },
      data: {
        status: MeshControlGroupStatus.configuring,
        operationPlanVersion: 0,
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
        operationId: null,
        operation: null,
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

function normalizeMeshMember(member: { meshNodeId: string; meshAddress: string }) {
  return { meshNodeId: member.meshNodeId, meshAddress: member.meshAddress.toLowerCase() };
}

function meshMemberKey(member: { meshNodeId: string; meshAddress: string }) {
  return `${member.meshNodeId}:${member.meshAddress.toLowerCase()}`;
}
