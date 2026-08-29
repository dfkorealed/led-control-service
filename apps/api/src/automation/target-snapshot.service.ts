import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import type { DimmingTarget } from "@led-control/shared";
import type { Prisma } from "@prisma/client";

type TargetFixture = {
  id: string;
  siteId: string;
  meshNodeId: string | null;
  gatewayId: string | null;
};

const targetFixtureSelect = {
  id: true,
  siteId: true,
  meshNodeId: true,
  gatewayId: true
} satisfies Prisma.FixtureSelect;

@Injectable()
export class TargetSnapshotService {
  async resolve(tx: Prisma.TransactionClient, siteId: string, target: DimmingTarget): Promise<string[]> {
    const fixtures = await this.loadSelection(tx, siteId, target);
    if (fixtures.length === 0) throw new BadRequestException("automation target must contain at least one fixture");
    if (fixtures.some((fixture) => fixture.siteId !== siteId)) {
      throw new BadRequestException("automation target contains a fixture from another site");
    }
    this.assertRegistered(fixtures);
    return [...new Set(fixtures.map((fixture) => fixture.id))].sort(compareIds);
  }

  async assertSingleGateway(
    tx: Prisma.TransactionClient,
    fixtureIds: string[]
  ): Promise<string> {
    const fixtures = await tx.fixture.findMany({
      where: { id: { in: fixtureIds } },
      select: targetFixtureSelect
    });
    if (fixtures.length !== fixtureIds.length) {
      throw new BadRequestException("automation target contains an unavailable fixture");
    }
    this.assertRegistered(fixtures);

    const gatewayIds = [...new Set(fixtures.map((fixture) => fixture.gatewayId!))];
    if (gatewayIds.length !== 1) {
      throw new ConflictException({ code: "single_gateway_required" });
    }
    const fixtureSiteIds = [...new Set(fixtures.map((fixture) => fixture.siteId))];
    const gateway = await tx.gateway.findUnique({
      where: { id: gatewayIds[0] },
      select: { siteId: true }
    });
    if (fixtureSiteIds.length !== 1 || !gateway || gateway.siteId !== fixtureSiteIds[0]) {
      throw new BadRequestException("automation target gateway does not belong to the fixture site");
    }
    return gatewayIds[0];
  }

  private async loadSelection(
    tx: Prisma.TransactionClient,
    siteId: string,
    target: DimmingTarget
  ): Promise<TargetFixture[]> {
    if (target.type === "fixture" || target.type === "fixtures") {
      const requestedIds = target.type === "fixture" ? [target.fixtureId] : target.fixtureIds;
      const fixtures = await tx.fixture.findMany({
        where: { id: { in: requestedIds }, siteId },
        select: targetFixtureSelect
      });
      if (fixtures.length !== requestedIds.length) {
        throw new BadRequestException("automation target contains an unavailable fixture");
      }
      return fixtures;
    }

    if (target.type === "floor") {
      const floor = await tx.floor.findFirst({
        where: { id: target.floorId, siteId },
        select: { fixtures: { select: targetFixtureSelect } }
      });
      if (!floor) throw new BadRequestException("automation target floor not found");
      return floor.fixtures;
    }

    const group = await tx.fixtureGroup.findFirst({
      where: { id: target.groupId, siteId, lifecycleStatus: "active" },
      select: {
        groupFixtures: { select: { fixture: { select: targetFixtureSelect } } }
      }
    });
    if (!group) throw new BadRequestException("automation target group not found");
    return group.groupFixtures.map((membership) => membership.fixture);
  }

  private assertRegistered(fixtures: TargetFixture[]) {
    // Automation may be configured while a Gateway is offline. Structural
    // controllability therefore means a completed MeshNode/Gateway mapping,
    // not current heartbeat or fixture reachability.
    if (fixtures.some((fixture) => !fixture.meshNodeId || !fixture.gatewayId)) {
      throw new BadRequestException("automation target contains an unregistered fixture");
    }
  }
}

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
