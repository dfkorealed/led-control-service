import { PrismaClient } from "@prisma/client";
import { demoIds } from "@led-control/shared";
import { createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const prisma = new PrismaClient();
const scrypt = promisify(scryptCallback);

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function main() {
  await prisma.energyUsage.deleteMany();
  await prisma.command.deleteMany();
  await prisma.session.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.groupFixture.deleteMany();
  await prisma.fixtureGroup.deleteMany();
  await prisma.fixture.deleteMany();
  await prisma.discoveredMeshNode.deleteMany();
  await prisma.provisioningSession.deleteMany();
  await prisma.meshNode.deleteMany();
  await prisma.gateway.deleteMany();
  await prisma.floorPlan.deleteMany();
  await prisma.floor.deleteMany();
  await prisma.site.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();

  const organization = await prisma.organization.create({
    data: { id: demoIds.organizationId, name: "Demo Parking Operator" }
  });

  const user = await prisma.user.create({
    data: {
      id: demoIds.userId,
      organizationId: organization.id,
      email: "operator@example.com",
      name: "Demo Operator",
      passwordHash: await hashPassword("demo-password-1234"),
      role: "admin",
      status: "active"
    }
  });

  const site = await prisma.site.create({
    data: {
      id: demoIds.siteId,
      organizationId: organization.id,
      name: "Demo Underground Parking",
      address: "Seoul",
      tariffKwhRate: "160.00"
    }
  });

  const gateway = await prisma.gateway.create({
    data: {
      id: demoIds.gatewayId,
      siteId: site.id,
      name: "Gateway B2",
      serialNumber: "GW-DEMO-001",
      firmwareVersion: "mock-1.0.0"
    }
  });

  const floor = await prisma.floor.create({
    data: {
      id: demoIds.floorId,
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
    data: { id: demoIds.groupId, siteId: site.id, name: "B2 Entrance Zone" }
  });

  await prisma.invitation.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      email: "new-admin@example.com",
      role: "admin",
      tokenHash: hashToken("demo-invite-token"),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    }
  });

  for (let index = 0; index < 12; index += 1) {
    const meshNode = await prisma.meshNode.create({
      data: {
        id: demoIds.meshNodeIds[index],
        gatewayId: gateway.id,
        deviceUuid: `esp32h2-installed-b2-${String(index + 1).padStart(3, "0")}`,
        serialNumber: `LC-INST-B2-${String(index + 1).padStart(3, "0")}`,
        meshAddress: `0x${(index + 1).toString(16).padStart(4, "0")}`,
        firmwareVersion: "mock-node-1.0.0"
      }
    });

    const fixture = await prisma.fixture.create({
      data: {
        id: demoIds.fixtureIds[index],
        floorId: floor.id,
        meshNodeId: meshNode.id,
        name: `B2-L${String(index + 1).padStart(2, "0")}`,
        ratedWatt: "40.00",
        x: 120 + (index % 4) * 220,
        y: 140 + Math.floor(index / 4) * 180,
        status: "online",
        brightness: 60,
        rssi: -58 - index,
        hopCount: 1 + (index % 3),
        commandSuccessRate: 0.98,
        lastSeenAt: new Date()
      }
    });

    if (index < 4) {
      await prisma.groupFixture.create({
        data: { groupId: group.id, fixtureId: fixture.id }
      });
    }
  }

  console.log({
    organizationId: organization.id,
    siteId: site.id,
    userId: user.id,
    demoLoginEmail: user.email,
    demoLoginPassword: "demo-password-1234",
    demoInviteToken: "demo-invite-token"
  });
}

main().finally(async () => {
  await prisma.$disconnect();
});
