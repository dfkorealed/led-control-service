import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

const TEST_DATA_PREFIX = "led-control-test-data/v1/";
const GATEWAY_PREFIX = `${TEST_DATA_PREFIX}gateway/`;
const NODE_PREFIX = `${TEST_DATA_PREFIX}node/`;
const FIXTURE_PREFIX = "[TEST DATA] Fixture ";
const FIXTURES_PER_FLOOR = 200;
const GRID_COLUMNS = 20;

export type TestDataCounts = {
  created: number;
  existing: number;
  deleted: number;
};

export type TestDataMutationResult = {
  floors: TestDataCounts & { total: number };
  gateways: TestDataCounts;
  fixtures: TestDataCounts;
};

@Injectable()
export class TestDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async create(user: AuthenticatedUser, siteId: string): Promise<TestDataMutationResult> {
    this.assertEnabled();

    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertManageInTransaction(tx, user, siteId);
      const floors = await tx.floor.findMany({
        where: { siteId },
        select: { id: true, siteId: true },
        orderBy: { level: "asc" }
      });
      if (floors.length === 0) throw new BadRequestException("site must have at least one floor to generate test data");

      const result: TestDataMutationResult = {
        floors: { total: floors.length, created: 0, existing: floors.length, deleted: 0 },
        gateways: { created: 0, existing: 0, deleted: 0 },
        fixtures: { created: 0, existing: 0, deleted: 0 }
      };
      const now = new Date();
      const gatewayIds: string[] = [];

      for (const floor of floors) {
        const gateway = await this.findOrCreateGateway(tx, siteId, floor.id, now, result);
        gatewayIds.push(gateway.id);
        await this.findOrCreateFloorFixtures(tx, siteId, floor.id, gateway.id, now, result);
      }
      await tx.gateway.updateMany({
        where: { id: { in: gatewayIds } },
        data: { lastHeartbeatAt: now }
      });
      return result;
    });
  }

  async remove(user: AuthenticatedUser, siteId: string): Promise<TestDataMutationResult> {
    this.assertEnabled();

    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertManageInTransaction(tx, user, siteId);
      const floors = await tx.floor.findMany({ where: { siteId }, select: { id: true } });
      const markerGateways = await tx.gateway.findMany({
        where: { siteId, serialNumber: { startsWith: GATEWAY_PREFIX } },
        select: { id: true }
      });
      const markerFixtures = await tx.fixture.findMany({
        where: {
          siteId,
          name: { startsWith: FIXTURE_PREFIX },
          meshNode: { gatewayId: { in: markerGateways.map((gateway) => gateway.id) }, deviceUuid: { startsWith: NODE_PREFIX } }
        },
        select: { id: true }
      });
      const gatewayAttachedFixtures = await tx.fixture.findMany({
        // This intentionally has no site predicate. Gateway deletion changes
        // every attached fixture through the composite mesh-node relation.
        where: { meshNode: { gatewayId: { in: markerGateways.map((gateway) => gateway.id) } } },
        select: { id: true, siteId: true, floorId: true, gatewayId: true, meshNodeId: true, name: true }
      });
      if (!this.haveSameIds(markerFixtures, gatewayAttachedFixtures)) {
        throw new ConflictException("test data cleanup is blocked by fixtures outside the verified marker chain");
      }
      await this.assertSafeToDeleteGateways(tx, markerGateways.map((gateway) => gateway.id));
      await this.assertSafeToDeleteFixtures(tx, markerFixtures.map((fixture) => fixture.id));

      // The selectors use only values this service controls. Never broaden these
      // predicates: normal gateway serials, fixture names, and nodes must survive cleanup.
      const fixtures = await tx.fixture.deleteMany({
        // The ID set was read through the full gateway → node → fixture marker
        // chain above, then dependency-checked. A prefix-only delete could touch
        // a marker-like node that was reassigned to a real gateway.
        where: { id: { in: markerFixtures.map((fixture) => fixture.id) } }
      });
      const gateways = await tx.gateway.deleteMany({
        where: { siteId, serialNumber: { startsWith: GATEWAY_PREFIX } }
      });
      return {
        floors: { total: floors.length, created: 0, existing: 0, deleted: 0 },
        gateways: { created: 0, existing: 0, deleted: gateways.count },
        fixtures: { created: 0, existing: 0, deleted: fixtures.count }
      };
    });
  }

  private assertEnabled() {
    if (process.env.VITE_TEST_DATA_TOOLS_ENABLED !== "true") {
      // Return 404 rather than advertising a production-only destructive endpoint.
      throw new NotFoundException();
    }
  }

  private async findOrCreateGateway(
    tx: Prisma.TransactionClient,
    siteId: string,
    floorId: string,
    now: Date,
    result: TestDataMutationResult
  ) {
    const serialNumber = `${GATEWAY_PREFIX}${floorId}`;
    const existing = await tx.gateway.findUnique({ where: { serialNumber } });
    if (existing) {
      if (existing.siteId !== siteId) {
        throw new ConflictException("test data gateway marker is assigned to a different site");
      }
      result.gateways.existing += 1;
      return existing;
    }
    const gateway = await tx.gateway.create({
      data: {
        siteId,
        name: `[TEST DATA] Gateway ${floorId}`,
        serialNumber,
        firmwareVersion: "test-data-v1",
        lastHeartbeatAt: now,
        claimedAt: now,
        // The generated nodes occupy 0x0100 through 0x01c7. Reserving the
        // following address prevents normal registration from reusing them.
        nextMeshUnicastAddress: 0x01c8
      }
    });
    result.gateways.created += 1;
    return gateway;
  }

  private async findOrCreateFloorFixtures(
    tx: Prisma.TransactionClient,
    siteId: string,
    floorId: string,
    gatewayId: string,
    now: Date,
    result: TestDataMutationResult
  ) {
    const slots = Array.from({ length: FIXTURES_PER_FLOOR }, (_, index) => ({
      index,
      deviceUuid: `${NODE_PREFIX}${floorId}/${index + 1}`
    }));
    const existingNodes = await tx.meshNode.findMany({
      where: { deviceUuid: { in: slots.map((slot) => slot.deviceUuid) } },
      select: { id: true, gatewayId: true, deviceUuid: true }
    });
    const nodesByDeviceUuid = new Map(existingNodes
      .filter((node): node is typeof node & { deviceUuid: string } => node.deviceUuid !== null)
      .map((node) => [node.deviceUuid, node]));
    if (existingNodes.some((node) => node.gatewayId !== gatewayId)) {
      throw new ConflictException("test data node marker is assigned to a different gateway");
    }
    const missingNodes = slots.filter((slot) => !nodesByDeviceUuid.has(slot.deviceUuid));
    if (missingNodes.length > 0) {
      const nodeCreates = missingNodes.map((slot) => ({
        id: randomUUID(),
        gatewayId,
        deviceUuid: slot.deviceUuid,
        serialNumber: `[TEST DATA] Node ${floorId}-${slot.index + 1}`,
        meshAddress: this.meshAddress(slot.index),
        firmwareVersion: "test-data-v1"
      }));
      await tx.meshNode.createMany({ data: nodeCreates });
      for (const node of nodeCreates) nodesByDeviceUuid.set(node.deviceUuid, node);
    }
    const nodeIds = slots.map((slot) => nodesByDeviceUuid.get(slot.deviceUuid)!.id);
    const existingFixtures = await tx.fixture.findMany({
      where: { meshNodeId: { in: nodeIds } },
      select: { id: true, meshNodeId: true, siteId: true, floorId: true, gatewayId: true, name: true }
    });
    if (existingFixtures.some((fixture) => fixture.siteId !== siteId
      || fixture.floorId !== floorId
      || fixture.gatewayId !== gatewayId
      || fixture.meshNodeId === null
      || !nodeIds.includes(fixture.meshNodeId)
      || !fixture.name.startsWith(FIXTURE_PREFIX))) {
      throw new ConflictException("test data fixture marker has an unexpected site, floor, gateway, or name");
    }
    const fixtureNodeIds = new Set(existingFixtures
      .map((fixture) => fixture.meshNodeId)
      .filter((meshNodeId): meshNodeId is string => meshNodeId !== null));
    const fixtureCreates = slots
      .filter((slot) => !fixtureNodeIds.has(nodesByDeviceUuid.get(slot.deviceUuid)!.id))
      .map((slot) => this.fixtureCreateData(
        siteId,
        floorId,
        gatewayId,
        nodesByDeviceUuid.get(slot.deviceUuid)!.id,
        slot.index,
        now
      ));
    if (fixtureCreates.length > 0) {
      await tx.fixture.createMany({ data: fixtureCreates });
    }
    result.fixtures.existing += existingFixtures.length;
    result.fixtures.created += fixtureCreates.length;
    await tx.fixture.updateMany({
      where: {
        siteId,
        floorId,
        gatewayId,
        meshNodeId: { in: nodeIds },
        name: { startsWith: FIXTURE_PREFIX }
      },
      data: {
        status: "online",
        statusReason: null,
        lastSeenAt: now,
        lastStateOccurredAt: now
      }
    });
  }

  private async assertSafeToDeleteGateways(tx: Prisma.TransactionClient, gatewayIds: string[]) {
    if (gatewayIds.length === 0) return;
    const gatewayWhere = { gatewayId: { in: gatewayIds } };
    const [unmarkedNode, unmarkedFixture, ...directGatewayRelations] = await Promise.all([
      tx.meshNode.findFirst({
        where: {
          ...gatewayWhere,
          OR: [{ deviceUuid: null }, { NOT: { deviceUuid: { startsWith: NODE_PREFIX } } }]
        },
        select: { id: true }
      }),
      tx.fixture.findFirst({
        where: {
          meshNode: { gatewayId: { in: gatewayIds }, deviceUuid: { startsWith: NODE_PREFIX } },
          NOT: { name: { startsWith: FIXTURE_PREFIX } }
        },
        select: { id: true }
      }),
      tx.fixtureGroup.findFirst({ where: gatewayWhere, select: { id: true } }),
      tx.meshControlGroup.findFirst({ where: gatewayWhere, select: { id: true } }),
      tx.commandDispatch.findFirst({ where: gatewayWhere, select: { id: true } }),
      tx.processedGatewayEvent.findFirst({ where: gatewayWhere, select: { eventId: true } }),
      tx.provisioningSession.findFirst({ where: gatewayWhere, select: { id: true } }),
      tx.gatewayCertificate.findFirst({ where: gatewayWhere, select: { id: true } }),
      tx.gatewayInventory.findFirst({ where: { claimedGatewayId: { in: gatewayIds } }, select: { id: true } }),
      tx.mqttOutbox.findFirst({ where: gatewayWhere, select: { id: true } }),
      tx.gatewayAutomationConfiguration.findFirst({ where: gatewayWhere, select: { gatewayId: true } }),
      tx.lightingSchedule.findFirst({ where: gatewayWhere, select: { id: true } }),
      tx.vehicleEventRule.findFirst({ where: gatewayWhere, select: { id: true } }),
      tx.manualOverride.findFirst({ where: gatewayWhere, select: { id: true } }),
      tx.automationExecution.findFirst({ where: gatewayWhere, select: { id: true } })
    ]);
    if (unmarkedNode || unmarkedFixture || directGatewayRelations.some(Boolean)) {
      // A gateway delete cascades or nulls several relations. Refuse the whole
      // transaction instead of attempting a partial cleanup of unknown data.
      throw new ConflictException("test data cleanup is blocked by non-test gateway dependencies");
    }
  }

  private haveSameIds(left: Array<{ id: string }>, right: Array<{ id: string }>) {
    if (left.length !== right.length) return false;
    const leftIds = new Set(left.map((row) => row.id));
    return right.every((row) => leftIds.has(row.id));
  }

  private async assertSafeToDeleteFixtures(tx: Prisma.TransactionClient, fixtureIds: string[]) {
    if (fixtureIds.length === 0) return;
    const fixtureWhere = { fixtureId: { in: fixtureIds } };
    const dependencies = await Promise.all([
      tx.groupFixture.findFirst({ where: fixtureWhere }),
      tx.energyUsage.findFirst({ where: fixtureWhere }),
      tx.fixtureEnergyDailyAggregate.findFirst({ where: fixtureWhere }),
      tx.fixtureEnergyStateCursor.findFirst({ where: fixtureWhere }),
      tx.commandFixtureResult.findFirst({ where: fixtureWhere }),
      tx.lightingScheduleFixture.findFirst({ where: fixtureWhere }),
      tx.vehicleEventSource.findFirst({ where: fixtureWhere }),
      tx.vehicleEventTarget.findFirst({ where: fixtureWhere }),
      tx.manualOverrideFixture.findFirst({ where: fixtureWhere }),
      tx.automationExecutionFixtureResult.findFirst({ where: fixtureWhere }),
      tx.processedGatewayEvent.findFirst({ where: fixtureWhere })
    ]);
    if (dependencies.some(Boolean)) {
      throw new ConflictException("test data cleanup is blocked by non-test fixture dependencies");
    }
  }

  private fixtureCreateData(
    siteId: string,
    floorId: string,
    gatewayId: string,
    meshNodeId: string,
    index: number,
    now: Date
  ) {
    const column = index % GRID_COLUMNS;
    const row = Math.floor(index / GRID_COLUMNS);
    return {
      floorId,
      siteId,
      gatewayId,
      meshNodeId,
      name: `${FIXTURE_PREFIX}${String(index + 1).padStart(3, "0")}`,
      ratedWatt: "40.00",
      x: column * 60 + 30,
      y: row * 60 + 30,
      size: 24,
      placementStatus: "placed" as const,
      positionVerifiedAt: now,
      status: "online" as const,
      brightness: (index * 17) % 101,
      rssi: -42 - (index % 25),
      hopCount: (index % 4) + 1,
      commandSuccessRate: 0.96 + (index % 5) / 100,
      lastSeenAt: now,
      lastStateOccurredAt: now,
      firstStateOccurredAt: now,
      powerOn: true
    };
  }

  private meshAddress(index: number) {
    return `0x${(0x0100 + index).toString(16).padStart(4, "0")}`;
  }
}
