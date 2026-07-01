import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.energyUsage.deleteMany();
  await prisma.command.deleteMany();
  await prisma.groupFixture.deleteMany();
  await prisma.fixtureGroup.deleteMany();
  await prisma.fixture.deleteMany();
  await prisma.meshNode.deleteMany();
  await prisma.gateway.deleteMany();
  await prisma.floorPlan.deleteMany();
  await prisma.floor.deleteMany();
  await prisma.site.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();

  const organization = await prisma.organization.create({
    data: { name: "Demo Parking Operator" }
  });

  const user = await prisma.user.create({
    data: {
      organizationId: organization.id,
      email: "operator@example.com",
      name: "Demo Operator",
      role: "admin"
    }
  });

  const site = await prisma.site.create({
    data: {
      organizationId: organization.id,
      name: "Demo Underground Parking",
      address: "Seoul",
      tariffKwhRate: "160.00"
    }
  });

  const gateway = await prisma.gateway.create({
    data: {
      siteId: site.id,
      name: "Gateway B2",
      serialNumber: "GW-DEMO-001",
      firmwareVersion: "mock-1.0.0"
    }
  });

  const floor = await prisma.floor.create({
    data: {
      siteId: site.id,
      name: "B2",
      level: -2,
      floorPlan: {
        create: {
          imageUrl: "/demo/floor-b2.svg",
          width: 1200,
          height: 800
        }
      }
    }
  });

  const group = await prisma.fixtureGroup.create({
    data: { siteId: site.id, name: "B2 Entrance Zone" }
  });

  for (let index = 0; index < 12; index += 1) {
    const meshNode = await prisma.meshNode.create({
      data: {
        gatewayId: gateway.id,
        meshAddress: `0x${(index + 1).toString(16).padStart(4, "0")}`,
        firmwareVersion: "mock-node-1.0.0"
      }
    });

    const fixture = await prisma.fixture.create({
      data: {
        floorId: floor.id,
        meshNodeId: meshNode.id,
        name: `B2-L${String(index + 1).padStart(2, "0")}`,
        ratedWatt: "40.00",
        x: 120 + (index % 4) * 220,
        y: 140 + Math.floor(index / 4) * 180,
        status: "online",
        brightness: 60,
        lastSeenAt: new Date()
      }
    });

    if (index < 4) {
      await prisma.groupFixture.create({
        data: { groupId: group.id, fixtureId: fixture.id }
      });
    }
  }

  console.log({ organizationId: organization.id, siteId: site.id, userId: user.id });
}

main().finally(async () => {
  await prisma.$disconnect();
});
