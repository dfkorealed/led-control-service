import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import type { DimmingTarget } from "@led-control/shared";
import type { Prisma, VehicleSensorProtocol, BioPulseReadiness } from "@prisma/client";
import { loadBioSensorEligibility } from "./bio-sensor-eligibility";
import { assertFixtureRegistrationsActive } from "../fixtures/fixture-registration-removal-policy";

type TargetFixture = {
  id: string;
  siteId: string;
  meshNodeId: string | null;
  gatewayId: string | null;
  meshNode: {
    vehicleSensorProtocol: VehicleSensorProtocol;
    vehicleSensorCapabilityStatus: "unknown" | "supported" | "unsupported";
    vehicleSensorCapabilityVerifiedAt: Date | null;
    bioPulseReadiness: BioPulseReadiness;
    bioPulseCapabilityRevision: bigint;
    bioPulseProfileId: string | null;
    bioPulseVerifiedAt: Date | null;
  } | null;
};

const targetFixtureSelect = {
  id: true,
  siteId: true,
  meshNodeId: true,
  gatewayId: true,
  meshNode: {
    select: {
      vehicleSensorCapabilityStatus: true,
      vehicleSensorCapabilityVerifiedAt: true,
      vehicleSensorProtocol: true,
      bioPulseReadiness: true,
      bioPulseCapabilityRevision: true,
      bioPulseProfileId: true,
      bioPulseVerifiedAt: true
    }
  }
} satisfies Prisma.FixtureSelect;

@Injectable()
export class TargetSnapshotService {
  async resolve(tx: Prisma.TransactionClient, siteId: string, target: DimmingTarget): Promise<string[]> {
    const fixtures = await this.loadSelection(tx, siteId, target);
    await assertFixtureRegistrationsActive(tx, fixtures.map(fixture => fixture.id));
    if (fixtures.length === 0) throw new BadRequestException("automation target must contain at least one fixture");
    if (fixtures.some((fixture) => fixture.siteId !== siteId)) {
      throw new BadRequestException("automation target contains a fixture from another site");
    }
    this.assertRegistered(fixtures);
    return [...new Set(fixtures.map((fixture) => fixture.id))].sort(compareIds);
  }

  async resolveVehicleSources(
    tx: Prisma.TransactionClient,
    siteId: string,
    fixtureIds: string[],
    allowUnavailable = false
  ): Promise<{ fixtureIds: string[]; sensorProtocol: VehicleSensorProtocol }> {
    const fixtures = await this.loadSelection(tx, siteId, { type: "fixtures", fixtureIds });
    await assertFixtureRegistrationsActive(tx, fixtures.map(fixture => fixture.id));
    this.assertRegistered(fixtures);
    const protocols = new Set(fixtures.map(fixture => fixture.meshNode?.vehicleSensorProtocol));
    const sensorProtocol = fixtures[0]?.meshNode?.vehicleSensorProtocol;
    if (!sensorProtocol || protocols.size !== 1 || (sensorProtocol === "bio_usb_pulse" && fixtures.length !== 1)) {
      throw new BadRequestException("vehicle event requires one protocol and exactly one BIO source");
    }
    const bio = !allowUnavailable && sensorProtocol === "bio_usb_pulse"
      ? await loadBioSensorEligibility(tx, fixtures.map(fixture => fixture.id)) : null;
    if (!allowUnavailable && fixtures.some(({ id, meshNode: node }) => !node || (sensorProtocol === "bio_usb_pulse"
      ? bio?.get(id)?.status !== "ready" || bio.get(id)!.blockedReasons.length !== 0
      : node.vehicleSensorCapabilityStatus !== "supported" || node.vehicleSensorCapabilityVerifiedAt === null))) {
      throw new BadRequestException({ message: "vehicle event source is unavailable", blockedReasons: bio ? [...bio.values()].flatMap(view => view.blockedReasons) : ["capability_unverified"] });
    }
    return { fixtureIds: [...new Set(fixtures.map((fixture) => fixture.id))].sort(compareIds), sensorProtocol };
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
    await assertFixtureRegistrationsActive(tx, fixtureIds);
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
        select: { fixtures: { where: { retiredAt: null }, select: targetFixtureSelect } }
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
