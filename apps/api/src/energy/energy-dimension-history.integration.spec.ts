import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/auth.types";
import { FixtureGroupsService } from "../fixture-groups/fixture-groups.service";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { PrismaService } from "../prisma/prisma.service";
import { EnergyDimensionHistoryService } from "./energy-dimension-history.service";

const databaseUrl = process.env.ENERGY_DIMENSION_HISTORY_TEST_DATABASE_URL
  ?? process.env.ENERGY_QUERY_TEST_DATABASE_URL
  ?? process.env.FIXTURE_STATE_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const rollbackMessage = "ROLLBACK_ENERGY_DIMENSION_HISTORY_INTEGRATION";

describeWithDatabase("energy dimension history PostgreSQL fixture-group transaction", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => prisma?.$disconnect());

  it("creates a fixture group and its energy history without deserializing the advisory lock result", async () => {
    const ids = {
      organizationId: randomUUID(),
      siteId: randomUUID(),
      floorId: randomUUID(),
      gatewayId: randomUUID(),
      meshNodeId: randomUUID(),
      fixtureId: randomUUID(),
      energyFixtureId: randomUUID()
    };
    const user: AuthenticatedUser = {
      id: randomUUID(),
      organizationId: ids.organizationId,
      organizationType: "customer",
      loginId: "fixture_user",
      name: "Energy integration admin",
      role: "admin",
      mustChangePassword: false,
      status: "active"
    };

    await expect(prisma.$transaction(async (tx) => {
      await tx.organization.create({
        data: { id: ids.organizationId, name: "Energy dimension integration", type: "customer" }
      });
      await tx.site.create({
        data: {
          id: ids.siteId,
          organizationId: ids.organizationId,
          name: "Energy dimension site",
          address: "Integration"
        }
      });
      await tx.floor.create({
        data: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 }
      });
      await tx.gateway.create({
        data: {
          id: ids.gatewayId,
          siteId: ids.siteId,
          name: "Energy dimension gateway",
          serialNumber: `ENERGY-DIMENSION-${ids.gatewayId}`,
          firmwareVersion: "integration"
        }
      });
      await tx.meshNode.create({
        data: {
          id: ids.meshNodeId,
          gatewayId: ids.gatewayId,
          deviceUuid: `energy-dimension-${ids.meshNodeId}`,
          meshAddress: "0x1201",
          firmwareVersion: "integration"
        }
      });
      const trackingStartedAt = new Date("2026-09-11T00:00:00.000Z");
      await tx.fixture.create({
        data: {
          id: ids.fixtureId,
          floorId: ids.floorId,
          siteId: ids.siteId,
          gatewayId: ids.gatewayId,
          meshNodeId: ids.meshNodeId,
          name: "B1-L01",
          ratedWatt: "40.00",
          x: 10,
          y: 10,
          energyTrackingStartedAt: trackingStartedAt
        }
      });
      await tx.energyFixtureIdentity.create({
        data: {
          id: ids.energyFixtureId,
          siteId: ids.siteId,
          fixtureId: ids.fixtureId,
          trackingStartedAt,
          dimensionVersions: {
            create: {
              name: "B1-L01",
              floorId: ids.floorId,
              floorName: "B1",
              ratedWatt: "40.00",
              effectiveFrom: trackingStartedAt
            }
          }
        }
      });

      const siteAccess = {
        assert: jest.fn().mockResolvedValue({ id: ids.siteId }),
        assertManageInTransaction: jest.fn().mockResolvedValue({
          id: ids.siteId,
          organizationId: ids.organizationId
        })
      };
      const transactionalPrisma = {
        $transaction: (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)
      };
      const service = new FixtureGroupsService(
        transactionalPrisma as never,
        siteAccess as never,
        new MeshControlGroupService(),
        new EnergyDimensionHistoryService()
      );

      const group = await service.create(user, ids.siteId, {
        name: "B1 entrance",
        floorId: ids.floorId,
        gatewayId: ids.gatewayId,
        fixtureIds: [ids.fixtureId]
      });
      const identity = await tx.energyGroupIdentity.findUniqueOrThrow({
        where: { groupId: group.id },
        include: { dimensionVersions: true, memberships: true }
      });

      expect(group).toMatchObject({ name: "B1 entrance", fixtureCount: 1 });
      expect(identity.dimensionVersions).toEqual([
        expect.objectContaining({ name: "B1 entrance", effectiveTo: null })
      ]);
      expect(identity.memberships).toEqual([
        expect.objectContaining({ energyFixtureId: ids.energyFixtureId, effectiveTo: null })
      ]);

      throw new Error(rollbackMessage);
    })).rejects.toThrow(rollbackMessage);

    await expect(prisma.organization.count({ where: { id: ids.organizationId } })).resolves.toBe(0);
  }, 15_000);
});
