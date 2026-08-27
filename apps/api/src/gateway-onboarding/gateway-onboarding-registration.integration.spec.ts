import { NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { PrismaService } from "../prisma/prisma.service";
import { RegistrationAllocationService } from "../registration/registration-allocation.service";
import { RegistrationService } from "../registration/registration.service";
import { GatewayOnboardingService } from "./gateway-onboarding.service";

const databaseUrl = process.env.GATEWAY_ONBOARDING_REGISTRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("Gateway onboarding and registration PostgreSQL integration", () => {
  let prisma: PrismaService;
  const scenarios: Array<{ organizationId: string; inventoryIds: string[] }> = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterEach(async () => {
    for (const scenario of scenarios.splice(0)) {
      await prisma.provisioningSession.deleteMany({ where: { site: { organizationId: scenario.organizationId } } });
      await prisma.gatewayClaimAudit.deleteMany({ where: { site: { organizationId: scenario.organizationId } } });
      await prisma.gatewayInventory.updateMany({
        where: { id: { in: scenario.inventoryIds } },
        data: { claimedGatewayId: null }
      });
      await prisma.gateway.deleteMany({ where: { site: { organizationId: scenario.organizationId } } });
      await prisma.gatewayInventory.deleteMany({ where: { id: { in: scenario.inventoryIds } } });
      await prisma.floor.deleteMany({ where: { site: { organizationId: scenario.organizationId } } });
      await prisma.site.deleteMany({ where: { organizationId: scenario.organizationId } });
      await prisma.user.deleteMany({ where: { organizationId: scenario.organizationId } });
      await prisma.organization.deleteMany({ where: { id: scenario.organizationId } });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("allows only the assigned admin to claim, start and read commissioning while the operator can disable inventory", async () => {
    const scenario = await createScenario("access", 3);
    const access = new SiteAccessService(prisma);
    const onboarding = new GatewayOnboardingService(prisma, access, {
      revokeInventoryCertificates: jest.fn().mockResolvedValue({ revoked: 0 })
    } as never);
    const registration = new RegistrationService(
      prisma,
      { publishProvisionDevice: jest.fn() } as never,
      access,
      new RegistrationAllocationService(),
      {} as MeshControlGroupService
    );

    const claimed = await onboarding.claimGateway(scenario.admin, {
      siteId: scenario.siteId,
      serialNumber: scenario.inventories[0].serialNumber,
      claimCode: scenario.inventories[0].claimCode,
      name: "Assigned admin gateway"
    });
    await expect(onboarding.claimGateway(scenario.operator, {
      siteId: scenario.siteId,
      serialNumber: scenario.inventories[1].serialNumber,
      claimCode: scenario.inventories[1].claimCode,
      name: "Operator gateway"
    })).rejects.toBeInstanceOf(NotFoundException);
    await expect(onboarding.claimGateway(scenario.otherAdmin, {
      siteId: scenario.siteId,
      serialNumber: scenario.inventories[2].serialNumber,
      claimCode: scenario.inventories[2].claimCode,
      name: "Other admin gateway"
    })).rejects.toBeInstanceOf(NotFoundException);

    await expect(onboarding.disableInventory(scenario.operator, scenario.inventories[0].id))
      .resolves.toEqual({ status: "disabled", revoked: 0 });

    await prisma.gateway.update({ where: { id: claimed.gatewayId }, data: { lastHeartbeatAt: new Date() } });
    const session = await registration.createSession(scenario.admin, {
      siteId: scenario.siteId,
      floorId: scenario.floorId,
      gatewayId: claimed.gatewayId
    });
    await expect(registration.getSession(scenario.admin, session.id)).resolves.toMatchObject({ id: session.id, siteId: scenario.siteId });
    await expect(registration.getSession(scenario.operator, session.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(registration.createSession(scenario.otherAdmin, {
      siteId: scenario.siteId,
      floorId: scenario.floorId,
      gatewayId: claimed.gatewayId
    })).rejects.toBeInstanceOf(NotFoundException);
  }, 15_000);

  it("rejects a claim that was authorized before the assigned admin was reassigned", async () => {
    const scenario = await createScenario("reassignment", 1);
    const realAccess = new SiteAccessService(prisma);
    let allowLockedCheck!: () => void;
    let signalTransactionStarted!: () => void;
    const transactionStarted = new Promise<void>((resolve) => { signalTransactionStarted = resolve; });
    const continueLockedCheck = new Promise<void>((resolve) => { allowLockedCheck = resolve; });
    const gatedAccess = {
      assert: realAccess.assert.bind(realAccess),
      assertCommissionInTransaction: async (tx: Parameters<SiteAccessService["assertCommissionInTransaction"]>[0], user: AuthenticatedUser, siteId: string) => {
        signalTransactionStarted();
        await continueLockedCheck;
        return realAccess.assertCommissionInTransaction(tx, user, siteId);
      }
    } as SiteAccessService;
    const onboarding = new GatewayOnboardingService(prisma, gatedAccess);
    const claim = onboarding.claimGateway(scenario.admin, {
      siteId: scenario.siteId,
      serialNumber: scenario.inventories[0].serialNumber,
      claimCode: scenario.inventories[0].claimCode,
      name: "Stale admin gateway"
    });

    await transactionStarted;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.site.update({ where: { id: scenario.siteId }, data: { adminUserId: scenario.otherAdmin.id } });
        await tx.user.update({ where: { id: scenario.admin.id }, data: { status: "disabled" } });
      });
    } finally {
      allowLockedCheck();
    }

    await expect(claim).rejects.toBeInstanceOf(NotFoundException);
    await expect(prisma.gateway.count({ where: { serialNumber: scenario.inventories[0].serialNumber } })).resolves.toBe(0);
  }, 15_000);

  async function createScenario(label: string, inventoryCount: number) {
    const suffix = `${label}_${randomUUID().slice(0, 8)}`;
    const organization = await prisma.organization.create({
      data: { id: randomUUID(), name: `${label} customer`, type: "customer" }
    });
    scenarios.push({ organizationId: organization.id, inventoryIds: [] });
    const adminRecord = await prisma.user.create({ data: userData(organization.id, `admin_${suffix}`, "admin") });
    const otherAdminRecord = await prisma.user.create({ data: userData(organization.id, `other_admin_${suffix}`, "admin") });
    const site = await prisma.site.create({
      data: {
        id: randomUUID(), organizationId: organization.id, adminUserId: adminRecord.id,
        name: `${label} site`, address: "서울시 강남구", tariffKwhRate: 160
      }
    });
    const floor = await prisma.floor.create({ data: { siteId: site.id, name: "B2", level: -2 } });
    const provider = await prisma.organization.create({
      data: { id: randomUUID(), name: `${label} provider`, type: "service_provider" }
    });
    scenarios.push({ organizationId: provider.id, inventoryIds: [] });
    const operatorRecord = await prisma.user.create({ data: userData(provider.id, `operator_${suffix}`, "operator") });
    const inventoryIds = scenarios[scenarios.length - 2].inventoryIds;
    const inventories = await Promise.all(Array.from({ length: inventoryCount }, async (_, index) => {
      const serialNumber = `GW-${suffix}-${index + 1}`.toUpperCase();
      const claimCode = `claim-${suffix}-${index + 1}`;
      const hashing = new GatewayOnboardingService({} as PrismaService, {} as SiteAccessService);
      const inventory = await prisma.gatewayInventory.create({
        data: {
          serialNumber,
          claimCodeHash: await hashing.hashClaimCode(claimCode),
          certificateFingerprint: `${(index + 1).toString(16).padStart(2, "0")}`.repeat(32).toUpperCase()
        }
      });
      inventoryIds.push(inventory.id);
      return { id: inventory.id, serialNumber, claimCode };
    }));

    return {
      siteId: site.id,
      floorId: floor.id,
      inventories,
      admin: toAuthenticatedUser(adminRecord, "customer"),
      otherAdmin: toAuthenticatedUser(otherAdminRecord, "customer"),
      operator: toAuthenticatedUser(operatorRecord, "service_provider")
    };
  }
});

function userData(organizationId: string, loginId: string, role: "operator" | "admin") {
  return {
    id: randomUUID(), organizationId, loginId, email: null, name: loginId,
    passwordHash: "integration-only", role, status: "active" as const
  };
}

function toAuthenticatedUser(
  user: Pick<AuthenticatedUser, "id" | "organizationId" | "loginId" | "name" | "role" | "status">,
  organizationType: "service_provider" | "customer"
): AuthenticatedUser {
  return { ...user, organizationType };
}
