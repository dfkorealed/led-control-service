import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { createFixtureGroupSchema, FixtureGroupMetadata, UpdateFixtureGroupInput } from "@led-control/shared";
import { MeshControlGroupStatus, Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { PrismaService } from "../prisma/prisma.service";

const MAX_FIXTURE_GROUPS_PER_FIXTURE = 15;
const MAX_CONFIGURATION_VERSION = 2_147_483_647;

type LockedFixtureGroup = {
  id: string;
  siteId: string;
  floorId: string | null;
  gatewayId: string | null;
  name: string;
  lifecycleStatus: "active" | "retiring" | "retired" | "invalid";
};

type LockedMeshControlGroup = {
  id: string;
  gatewayId: string;
  configurationVersion: number;
  status: MeshControlGroupStatus;
};

type LockedFixture = {
  id: string;
  floorId: string;
  meshNodeId: string | null;
  meshNode: { gatewayId: string } | null;
};

@Injectable()
export class FixtureGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    private readonly meshControlGroups: MeshControlGroupService
  ) {}

  async list(user: AuthenticatedUser, siteId: string, floorId?: string): Promise<FixtureGroupMetadata[]> {
    await this.siteAccess.assert(user, siteId, "read");
    if (floorId) await this.assertFloorInSite(this.prisma, siteId, floorId);

    const groups = await this.prisma.fixtureGroup.findMany({
      where: { siteId, ...(floorId ? { floorId } : {}) },
      orderBy: [{ lifecycleStatus: "asc" }, { name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        floorId: true,
        gatewayId: true,
        lifecycleStatus: true,
        _count: { select: { groupFixtures: true } },
        gateway: {
          select: {
            meshControlGroups: {
              where: { targetType: "fixture_group" },
              select: { targetId: true, status: true, configurationVersion: true, lastError: true }
            }
          }
        }
      }
    });

    return groups.map((group) => this.metadata(group, group.gateway?.meshControlGroups.find(
      (meshGroup) => meshGroup.targetId === group.id
    ) ?? null, group._count.groupFixtures));
  }

  async create(user: AuthenticatedUser, siteId: string, rawInput: unknown): Promise<FixtureGroupMetadata> {
    const input = this.parseInput(rawInput);
    await this.siteAccess.assert(user, siteId, "manage");

    return this.prisma.$transaction(async (tx) => {
      const fixtures = await this.lockAndValidateBoundary(tx, siteId, input);
      await this.assertFixtureCapacity(tx, input.fixtureIds);

      const group = await tx.fixtureGroup.create({
        data: {
          siteId,
          name: input.name,
          floorId: input.floorId,
          gatewayId: input.gatewayId,
          lifecycleStatus: "active"
        }
      });
      await tx.groupFixture.createMany({
        data: fixtures.map((fixture) => ({ groupId: group.id, fixtureId: fixture.id }))
      });

      const meshGroup = await this.meshControlGroups.ensureFixtureGroup(tx, input.gatewayId, group.id);
      const lockedMeshGroup = await this.lockMeshControlGroup(tx, meshGroup.id, input.gatewayId);
      await this.replaceDesiredMembers(tx, lockedMeshGroup, fixtures.map((fixture) => fixture.meshNodeId!));

      return this.metadata({ ...group, name: input.name }, {
        status: MeshControlGroupStatus.configuring,
        configurationVersion: lockedMeshGroup.configurationVersion,
        lastError: null
      }, fixtures.length);
    });
  }

  async update(
    user: AuthenticatedUser,
    siteId: string,
    groupId: string,
    rawInput: unknown
  ): Promise<FixtureGroupMetadata> {
    const input = this.parseInput(rawInput);
    await this.siteAccess.assert(user, siteId, "manage");

    return this.prisma.$transaction(async (tx) => {
      const group = await this.lockFixtureGroup(tx, siteId, groupId);
      this.assertActive(group);
      const fixtures = await this.lockAndValidateBoundary(tx, siteId, input);
      await this.assertFixtureCapacity(tx, input.fixtureIds, group.id);

      const meshGroup = await this.lockMeshControlGroupForFixtureGroup(tx, group.id, input.gatewayId);
      const nextVersion = this.nextConfigurationVersion(meshGroup.configurationVersion);
      await tx.fixtureGroup.update({
        where: { id: group.id },
        data: {
          name: input.name,
          floorId: input.floorId,
          gatewayId: input.gatewayId,
          lifecycleStatus: "active"
        }
      });
      await tx.groupFixture.deleteMany({ where: { groupId: group.id } });
      await tx.groupFixture.createMany({
        data: fixtures.map((fixture) => ({ groupId: group.id, fixtureId: fixture.id }))
      });
      await tx.meshControlGroup.update({
        where: { id: meshGroup.id },
        data: {
          status: MeshControlGroupStatus.configuring,
          configurationVersion: { increment: 1 },
          lastError: null
        }
      });
      await this.replaceDesiredMembers(tx, { ...meshGroup, configurationVersion: nextVersion }, fixtures.map((fixture) => fixture.meshNodeId!));

      return this.metadata({ ...group, ...input }, {
        status: MeshControlGroupStatus.configuring,
        configurationVersion: nextVersion,
        lastError: null
      }, fixtures.length);
    });
  }

  async remove(user: AuthenticatedUser, siteId: string, groupId: string) {
    await this.siteAccess.assert(user, siteId, "manage");

    return this.prisma.$transaction(async (tx) => {
      const group = await this.lockFixtureGroup(tx, siteId, groupId);
      this.assertActive(group);
      const meshGroup = await this.lockMeshControlGroupForFixtureGroup(tx, group.id, group.gatewayId!);
      const nextVersion = this.nextConfigurationVersion(meshGroup.configurationVersion);

      await tx.fixtureGroup.update({
        where: { id: group.id },
        data: { lifecycleStatus: "retiring" }
      });
      await tx.meshControlGroup.update({
        where: { id: meshGroup.id },
        data: {
          status: MeshControlGroupStatus.retiring,
          configurationVersion: { increment: 1 },
          lastError: null
        }
      });
      await this.replaceDesiredMembers(tx, { ...meshGroup, configurationVersion: nextVersion }, []);

      return {
        id: group.id,
        lifecycleStatus: "retiring" as const,
        meshControlGroup: { status: "retiring" as const, version: nextVersion, error: null }
      };
    });
  }

  async resync(user: AuthenticatedUser, siteId: string, groupId: string): Promise<FixtureGroupMetadata> {
    await this.siteAccess.assert(user, siteId, "manage");

    return this.prisma.$transaction(async (tx) => {
      const group = await this.lockFixtureGroup(tx, siteId, groupId);
      if (group.lifecycleStatus === "invalid" || group.lifecycleStatus === "retired") {
        throw new BadRequestException("fixture group is read-only");
      }
      if (!group.gatewayId) throw new BadRequestException("fixture group is missing a gateway");

      const meshGroup = await this.lockMeshControlGroupForFixtureGroup(tx, group.id, group.gatewayId);
      const nextVersion = this.nextConfigurationVersion(meshGroup.configurationVersion);
      const status = group.lifecycleStatus === "retiring"
        ? MeshControlGroupStatus.retiring
        : MeshControlGroupStatus.configuring;
      await tx.meshControlGroup.update({
        where: { id: meshGroup.id },
        data: { status, configurationVersion: { increment: 1 }, lastError: null }
      });
      await this.resetMembershipProgress(tx, meshGroup.id, meshGroup.gatewayId);

      const fixtureCount = await tx.groupFixture.count({ where: { groupId: group.id } });
      return this.metadata(group, { status, configurationVersion: nextVersion, lastError: null }, fixtureCount);
    });
  }

  private parseInput(rawInput: unknown): UpdateFixtureGroupInput {
    const parsed = createFixtureGroupSchema.safeParse(rawInput);
    if (!parsed.success) throw new BadRequestException("invalid fixture group request");
    return parsed.data;
  }

  private async lockAndValidateBoundary(
    tx: Prisma.TransactionClient,
    siteId: string,
    input: UpdateFixtureGroupInput
  ): Promise<LockedFixture[]> {
    await this.assertFloorInSite(tx, siteId, input.floorId);
    await this.assertGatewayInSite(tx, siteId, input.gatewayId);
    const fixtureIds = [...input.fixtureIds].sort();
    const fixtures = await tx.$queryRaw<LockedFixture[]>(Prisma.sql`
      SELECT
        fixture."id",
        fixture."floorId",
        fixture."meshNodeId",
        json_build_object('gatewayId', mesh_node."gatewayId") AS "meshNode"
      FROM "Fixture" fixture
      LEFT JOIN "MeshNode" mesh_node ON mesh_node."id" = fixture."meshNodeId"
      WHERE fixture."id" IN (${Prisma.join(fixtureIds)})
      ORDER BY fixture."id"
      FOR UPDATE OF fixture
    `);
    if (fixtures.length !== fixtureIds.length) throw new NotFoundException("fixture not found");
    if (fixtures.some((fixture) => !fixture.meshNodeId || !fixture.meshNode)) {
      throw new BadRequestException("fixtures must be controllable");
    }
    if (fixtures.some((fixture) => fixture.floorId !== input.floorId || fixture.meshNode?.gatewayId !== input.gatewayId)) {
      throw new BadRequestException("fixtures must belong to the selected floor and gateway");
    }
    return fixtures;
  }

  private async assertFixtureCapacity(tx: Prisma.TransactionClient, fixtureIds: string[], excludedGroupId?: string) {
    const memberships = await tx.groupFixture.findMany({
      where: {
        fixtureId: { in: fixtureIds },
        group: { lifecycleStatus: { in: ["active", "retiring"] } }
      },
      select: { fixtureId: true, groupId: true }
    });
    const counts = new Map<string, number>();
    for (const membership of memberships) {
      if (membership.groupId === excludedGroupId) continue;
      counts.set(membership.fixtureId, (counts.get(membership.fixtureId) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count >= MAX_FIXTURE_GROUPS_PER_FIXTURE)) {
      throw new BadRequestException(
        "a fixture cannot belong to more than 15 active or retiring fixture groups"
      );
    }
  }

  private async assertFloorInSite(tx: Prisma.TransactionClient | PrismaService, siteId: string, floorId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Floor" WHERE "id" = ${floorId} AND "siteId" = ${siteId} FOR UPDATE
    `);
    if (rows.length === 0) throw new NotFoundException("floor not found");
  }

  private async assertGatewayInSite(tx: Prisma.TransactionClient, siteId: string, gatewayId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Gateway" WHERE "id" = ${gatewayId} AND "siteId" = ${siteId} FOR UPDATE
    `);
    if (rows.length === 0) throw new NotFoundException("gateway not found");
  }

  private async lockFixtureGroup(tx: Prisma.TransactionClient, siteId: string, groupId: string) {
    const rows = await tx.$queryRaw<LockedFixtureGroup[]>(Prisma.sql`
      SELECT "id", "siteId", "floorId", "gatewayId", "name", "lifecycleStatus"
      FROM "FixtureGroup"
      WHERE "id" = ${groupId} AND "siteId" = ${siteId}
      FOR UPDATE
    `);
    const group = rows[0];
    if (!group) throw new NotFoundException("fixture group not found");
    return group;
  }

  private async lockMeshControlGroup(tx: Prisma.TransactionClient, groupId: string, gatewayId: string) {
    const rows = await tx.$queryRaw<LockedMeshControlGroup[]>(Prisma.sql`
      SELECT "id", "gatewayId", "configurationVersion", "status"
      FROM "MeshControlGroup"
      WHERE "id" = ${groupId} AND "gatewayId" = ${gatewayId}
      FOR UPDATE
    `);
    const group = rows[0];
    if (!group) throw new InternalServerErrorException("fixture group mesh control group is missing");
    return group;
  }

  private async lockMeshControlGroupForFixtureGroup(
    tx: Prisma.TransactionClient,
    fixtureGroupId: string,
    gatewayId: string
  ) {
    const rows = await tx.$queryRaw<LockedMeshControlGroup[]>(Prisma.sql`
      SELECT "id", "gatewayId", "configurationVersion", "status"
      FROM "MeshControlGroup"
      WHERE "gatewayId" = ${gatewayId}
        AND "targetType" = 'fixture_group'
        AND "targetId" = ${fixtureGroupId}
      FOR UPDATE
    `);
    const group = rows[0];
    if (!group) throw new NotFoundException("fixture group mesh control group not found");
    return group;
  }

  private async replaceDesiredMembers(tx: Prisma.TransactionClient, meshGroup: LockedMeshControlGroup, meshNodeIds: string[]) {
    await tx.meshControlGroupMember.updateMany({
      where: { groupId: meshGroup.id, gatewayId: meshGroup.gatewayId },
      data: { desired: false, subscriptionStatus: "pending", statusVersion: 0, lastError: null }
    });
    for (const meshNodeId of [...meshNodeIds].sort()) {
      await tx.meshControlGroupMember.upsert({
        where: { groupId_meshNodeId: { groupId: meshGroup.id, meshNodeId } },
        create: {
          groupId: meshGroup.id,
          gatewayId: meshGroup.gatewayId,
          meshNodeId,
          desired: true,
          subscriptionStatus: "pending",
          statusVersion: 0,
          lastError: null
        },
        update: { desired: true, subscriptionStatus: "pending", statusVersion: 0, lastError: null }
      });
    }
  }

  private async resetMembershipProgress(tx: Prisma.TransactionClient, groupId: string, gatewayId: string) {
    await tx.meshControlGroupMember.updateMany({
      where: { groupId, gatewayId },
      data: { subscriptionStatus: "pending", statusVersion: 0, lastError: null }
    });
  }

  private metadata(
    group: Pick<LockedFixtureGroup, "id" | "name" | "floorId" | "gatewayId" | "lifecycleStatus">,
    meshGroup: { status: MeshControlGroupStatus | string; configurationVersion: number; lastError: string | null } | null,
    fixtureCount = 0
  ): FixtureGroupMetadata {
    return {
      id: group.id,
      name: group.name,
      floorId: group.floorId,
      gatewayId: group.gatewayId,
      lifecycleStatus: group.lifecycleStatus,
      fixtureCount,
      meshControlGroup: meshGroup
        ? {
          status: meshGroup.status as NonNullable<FixtureGroupMetadata["meshControlGroup"]>["status"],
          version: meshGroup.configurationVersion,
          error: meshGroup.lastError
        }
        : null
    };
  }

  private assertActive(group: LockedFixtureGroup) {
    if (group.lifecycleStatus !== "active") throw new BadRequestException("fixture group is read-only");
    if (!group.floorId || !group.gatewayId) throw new BadRequestException("fixture group is missing its boundary");
  }

  private nextConfigurationVersion(version: number) {
    if (version >= MAX_CONFIGURATION_VERSION) {
      throw new InternalServerErrorException("mesh control group configuration version exhausted");
    }
    return version + 1;
  }
}
