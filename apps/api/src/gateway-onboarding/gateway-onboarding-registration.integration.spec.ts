import { ConflictException, HttpException, NotFoundException } from "@nestjs/common";
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
      await prisma.discoveredMeshNode.deleteMany({
        where: { session: { site: { organizationId: scenario.organizationId } } }
      });
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

  it("blocks every registration mutation after the assigned admin is reassigned and disabled", async () => {
    const scenario = await createScenario("registration_reassignment", 0);
    const gateways = await Promise.all(Array.from({ length: 4 }, (_, index) => prisma.gateway.create({
      data: {
        siteId: scenario.siteId,
        name: `Race gateway ${index + 1}`,
        serialNumber: `GW-REGISTRATION-RACE-${randomUUID()}`,
        firmwareVersion: "1.0.0",
        lastHeartbeatAt: new Date()
      }
    })));
    const retrySession = await prisma.provisioningSession.create({
      data: {
        siteId: scenario.siteId,
        floorId: scenario.floorId,
        gatewayId: gateways[1].id,
        requestedBy: scenario.admin.id,
        status: "active",
        scanStatus: "failed",
        scanCorrelationId: randomUUID(),
        scanAttempt: 1
      }
    });
    const registerSession = await prisma.provisioningSession.create({
      data: {
        siteId: scenario.siteId,
        floorId: scenario.floorId,
        gatewayId: gateways[2].id,
        requestedBy: scenario.admin.id,
        status: "active",
        scanStatus: "completed",
        scanCorrelationId: randomUUID(),
        scanAttempt: 1
      }
    });
    const discoveredNode = await prisma.discoveredMeshNode.create({
      data: {
        sessionId: registerSession.id,
        deviceUuid: randomUUID(),
        serialNumber: `NODE-${randomUUID()}`,
        rssi: -52,
        oobCapability: "static_oob",
        firmwareVersion: "1.0.0"
      }
    });
    const completionSession = await prisma.provisioningSession.create({
      data: {
        siteId: scenario.siteId,
        floorId: scenario.floorId,
        gatewayId: gateways[3].id,
        requestedBy: scenario.admin.id,
        status: "active",
        scanStatus: "completed",
        scanCorrelationId: randomUUID(),
        scanAttempt: 1
      }
    });

    const realAccess = new SiteAccessService(prisma);
    let releasePrechecks!: () => void;
    let signalAllPrechecks!: () => void;
    let precheckCount = 0;
    const allPrechecks = new Promise<void>((resolve) => { signalAllPrechecks = resolve; });
    const continueAfterPrechecks = new Promise<void>((resolve) => { releasePrechecks = resolve; });
    const gatedAccess = {
      assert: async (...args: Parameters<SiteAccessService["assert"]>) => {
        const access = await realAccess.assert(...args);
        precheckCount += 1;
        if (precheckCount === 4) signalAllPrechecks();
        await continueAfterPrechecks;
        return access;
      },
      assertCommissionInTransaction: realAccess.assertCommissionInTransaction.bind(realAccess)
    } as SiteAccessService;
    const registration = new RegistrationService(
      prisma,
      { publishProvisionDevice: jest.fn() } as never,
      gatedAccess,
      new RegistrationAllocationService(),
      { ensureFloorGroup: jest.fn().mockResolvedValue({ id: randomUUID() }) } as never
    );

    const mutations = [
      registration.createSession(scenario.admin, {
        siteId: scenario.siteId,
        floorId: scenario.floorId,
        gatewayId: gateways[0].id
      }),
      registration.retryScan(scenario.admin, retrySession.id),
      registration.registerNode(scenario.admin, registerSession.id, discoveredNode.id, {
        fixtureName: "Race fixture",
        x: 100,
        y: 100
      }),
      registration.completeSession(scenario.admin, completionSession.id)
    ];

    await allPrechecks;
    await prisma.$transaction(async (tx) => {
      await tx.site.update({ where: { id: scenario.siteId }, data: { adminUserId: scenario.otherAdmin.id } });
      await tx.user.update({ where: { id: scenario.admin.id }, data: { status: "disabled" } });
    });
    releasePrechecks();

    const results = await Promise.allSettled(mutations);
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(NotFoundException);
    }
    await expect(prisma.provisioningSession.count({ where: { gatewayId: gateways[0].id } })).resolves.toBe(0);
    await expect(prisma.provisioningScanOutbox.count({ where: { sessionId: retrySession.id } })).resolves.toBe(0);
    await expect(prisma.provisioningSession.findUniqueOrThrow({ where: { id: retrySession.id } })).resolves.toMatchObject({
      scanStatus: "failed",
      scanAttempt: 1
    });
    await expect(prisma.discoveredMeshNode.findUniqueOrThrow({ where: { id: discoveredNode.id } })).resolves.toMatchObject({
      status: "discovered",
      meshAddress: null,
      pendingFixtureName: null
    });
    await expect(prisma.provisioningSession.findUniqueOrThrow({ where: { id: completionSession.id } })).resolves.toMatchObject({
      status: "active",
      completedAt: null
    });
  }, 15_000);

  it("serializes parallel invalid claims so verification is bounded and every request is audited", async () => {
    const scenario = await createScenario("parallel_invalid", 1);
    const onboarding = new GatewayOnboardingService(prisma, new SiteAccessService(prisma));
    const verify = jest.spyOn(onboarding, "verifyClaimCode").mockResolvedValue(false);

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => onboarding.claimGateway(scenario.admin, {
      siteId: scenario.siteId,
      serialNumber: scenario.inventories[0].serialNumber,
      claimCode: "wrong-claim-code",
      name: "Rejected gateway"
    })));

    expect(verify).toHaveBeenCalledTimes(5);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof HttpException
      && result.reason.getStatus() === 401)).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof HttpException
      && result.reason.getStatus() === 429)).toHaveLength(1);
    const audits = await prisma.gatewayClaimAudit.findMany({
      where: { inventoryId: scenario.inventories[0].id },
      orderBy: { createdAt: "asc" }
    });
    expect(audits).toHaveLength(6);
    expect(audits.filter((audit) => audit.reason === "invalid_claim_code")).toHaveLength(5);
    expect(audits.filter((audit) => audit.reason === "rate_limited")).toHaveLength(1);
  }, 15_000);

  it("keeps a successful parallel claim atomic and audits the already-consumed terminal request", async () => {
    const scenario = await createScenario("parallel_success", 1);
    const onboarding = new GatewayOnboardingService(prisma, new SiteAccessService(prisma));

    const results = await Promise.allSettled(Array.from({ length: 2 }, () => onboarding.claimGateway(scenario.admin, {
      siteId: scenario.siteId,
      serialNumber: scenario.inventories[0].serialNumber,
      claimCode: scenario.inventories[0].claimCode,
      name: "Atomic gateway"
    })));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof ConflictException)).toHaveLength(1);
    await expect(prisma.gateway.count({ where: { serialNumber: scenario.inventories[0].serialNumber } })).resolves.toBe(1);
    await expect(prisma.gatewayInventory.findUniqueOrThrow({ where: { id: scenario.inventories[0].id } })).resolves.toMatchObject({
      claimCodeHash: null
    });
    const audits = await prisma.gatewayClaimAudit.findMany({ where: { inventoryId: scenario.inventories[0].id } });
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "claimed", reason: null }),
      expect.objectContaining({ outcome: "failed", reason: "already_consumed" })
    ]));
  }, 15_000);

  it("does not serialize claims for different normalized serials through a global lock", async () => {
    const first = await createScenario("different_serial_first", 1);
    const second = await createScenario("different_serial_second", 1);
    const onboarding = new GatewayOnboardingService(prisma, new SiteAccessService(prisma));
    let releaseVerifications!: () => void;
    let signalBothVerifications!: () => void;
    const reachedCodes = new Set<string>();
    const bothVerifications = new Promise<void>((resolve) => { signalBothVerifications = resolve; });
    const continueVerifications = new Promise<void>((resolve) => { releaseVerifications = resolve; });
    jest.spyOn(onboarding, "verifyClaimCode").mockImplementation(async (claimCode) => {
      reachedCodes.add(claimCode);
      if (reachedCodes.size === 2) signalBothVerifications();
      await continueVerifications;
      return true;
    });

    const claims = [first, second].map((scenario) => onboarding.claimGateway(scenario.admin, {
      siteId: scenario.siteId,
      serialNumber: scenario.inventories[0].serialNumber,
      claimCode: scenario.inventories[0].claimCode,
      name: "Independent gateway"
    }));
    await bothVerifications;
    releaseVerifications();

    await expect(Promise.all(claims)).resolves.toHaveLength(2);
  }, 15_000);

  async function createScenario(label: string, inventoryCount: number) {
    const suffix = `${label}_${randomUUID().slice(0, 8)}`;
    const organization = await prisma.organization.create({
      data: { id: randomUUID(), name: `${label} customer`, type: "customer" }
    });
    const customerScenario = { organizationId: organization.id, inventoryIds: [] as string[] };
    scenarios.push(customerScenario);
    const adminRecord = await prisma.user.create({ data: userData(organization.id, `admin_${suffix}`, "admin") });
    const otherAdminRecord = await prisma.user.create({ data: userData(organization.id, `other_admin_${suffix}`, "admin") });
    const site = await prisma.site.create({
      data: {
        id: randomUUID(), organizationId: organization.id, adminUserId: adminRecord.id,
        name: `${label} site`, address: "서울시 강남구", tariffKwhRate: 160
      }
    });
    const floor = await prisma.floor.create({ data: { siteId: site.id, name: "B2", level: -2 } });
    const existingProvider = await prisma.organization.findFirst({ where: { type: "service_provider" } });
    const provider = existingProvider ?? await prisma.organization.create({
      data: { id: randomUUID(), name: `${label} provider`, type: "service_provider" }
    });
    if (!existingProvider) scenarios.push({ organizationId: provider.id, inventoryIds: [] });
    const operatorRecord = await prisma.user.findFirst({ where: { role: "operator", status: "active" } })
      ?? await prisma.user.create({ data: userData(provider.id, `operator_${suffix}`, "operator") });
    const inventoryIds = customerScenario.inventoryIds;
    const inventories = await Promise.all(Array.from({ length: inventoryCount }, async (_, index) => {
      const serialNumber = `GW-${suffix}-${index + 1}`.toUpperCase();
      const claimCode = `claim-${suffix}-${index + 1}`;
      const hashing = new GatewayOnboardingService({} as PrismaService, {} as SiteAccessService);
      const inventory = await prisma.gatewayInventory.create({
        data: {
          serialNumber,
          claimCodeHash: await hashing.hashClaimCode(claimCode),
          certificateFingerprint: randomUUID().replace(/-/g, "").repeat(2).toUpperCase()
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
