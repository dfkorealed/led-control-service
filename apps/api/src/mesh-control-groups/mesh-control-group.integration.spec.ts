import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { MeshControlGroupService } from "./mesh-control-group.service";

const databaseUrl = process.env.MESH_CONTROL_GROUP_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("MeshControlGroup PostgreSQL conflict recovery", () => {
  const ids = {
    organizationId: randomUUID(),
    siteId: randomUUID(),
    floorId: randomUUID(),
    gatewayId: randomUUID(),
    winnerId: randomUUID()
  };
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.organization.create({
      data: { id: ids.organizationId, name: "Mesh group race customer", type: "customer" }
    });
    await prisma.site.create({
      data: {
        id: ids.siteId,
        organizationId: ids.organizationId,
        name: "Mesh group race site",
        address: "Integration",
        tariffKwhRate: "100.00"
      }
    });
    await prisma.floor.create({
      data: { id: ids.floorId, siteId: ids.siteId, name: "Race floor", level: 1 }
    });
    await prisma.gateway.create({
      data: {
        id: ids.gatewayId,
        siteId: ids.siteId,
        name: "Race gateway",
        serialNumber: `RACE-${ids.gatewayId}`,
        firmwareVersion: "integration",
        nextMeshGroupAddress: 0xc000
      }
    });
    await prisma.meshControlGroup.create({
      data: {
        id: ids.winnerId,
        gatewayId: ids.gatewayId,
        targetType: "floor",
        targetId: ids.floorId,
        groupAddress: "0xc000",
        status: "configuring",
        configurationVersion: 1
      }
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.meshControlGroup.deleteMany({ where: { gatewayId: ids.gatewayId } });
    await prisma.gateway.deleteMany({ where: { id: ids.gatewayId } });
    await prisma.floor.deleteMany({ where: { id: ids.floorId } });
    await prisma.site.deleteMany({ where: { id: ids.siteId } });
    await prisma.organization.deleteMany({ where: { id: ids.organizationId } });
    await prisma.$disconnect();
  });

  it("reuses the concurrent winner without querying inside an aborted transaction", async () => {
    const service = new MeshControlGroupService();

    const result = await prisma.$transaction(async (tx) => {
      let firstLookup = true;
      const transaction = {
        $queryRaw: tx.$queryRaw.bind(tx),
        gateway: { update: tx.gateway.update.bind(tx.gateway) },
        floor: { findUnique: tx.floor.findUnique.bind(tx.floor) },
        meshControlGroup: {
          findFirst: (args: Parameters<typeof tx.meshControlGroup.findFirst>[0]) => {
            if (firstLookup) {
              firstLookup = false;
              return Promise.resolve(null);
            }
            return tx.meshControlGroup.findFirst(args);
          }
        }
      };

      const group = await service.ensureFloorGroup(transaction as never, ids.gatewayId, ids.floorId);
      const transactionStillUsable = await tx.meshControlGroup.count({ where: { id: ids.winnerId } });
      return { group, transactionStillUsable };
    });

    expect(result.group.id).toBe(ids.winnerId);
    expect(result.transactionStillUsable).toBe(1);
  });
});
