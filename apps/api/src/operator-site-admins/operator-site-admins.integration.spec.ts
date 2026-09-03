import { ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { PasswordService } from "../auth/password.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { OperatorSiteAdminsService } from "./operator-site-admins.service";

const databaseUrl = process.env.OPERATOR_SITE_ADMINS_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("OperatorSiteAdminsService PostgreSQL integration", () => {
  let prisma: PrismaService;
  let service: OperatorSiteAdminsService;
  let operator: AuthenticatedUser;
  let createdOperator = false;
  const createdOrganizationIds: string[] = [];
  const deletionSiteIds: string[] = [];
  const deletionInventoryIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const provider = await prisma.organization.findFirst({ where: { type: "service_provider" } })
      ?? await prisma.organization.create({ data: { id: randomUUID(), name: "Operator Provider", type: "service_provider" } });
    const passwords = new PasswordService();
    const existingOperator = await prisma.user.findFirst({ where: { role: "operator" } });
    const user = existingOperator ?? await prisma.user.create({
      data: {
        id: randomUUID(), organizationId: provider.id, loginId: `operator_${randomUUID().slice(0, 8)}`,
        email: null, name: "Operator", passwordHash: await passwords.hash("operator password"), role: "operator", status: "active"
      }
    });
    createdOperator = !existingOperator;
    operator = { ...user, organizationType: "service_provider" };
    service = new OperatorSiteAdminsService(
      prisma,
      passwords,
      new AuditService(prisma),
      { processNow: async () => ({ status: "completed" as const }) } as never
    );
  });

  afterEach(async () => {
    await prisma.siteDeletionCleanup.deleteMany({ where: { siteId: { in: deletionSiteIds.splice(0) } } });
    for (const organizationId of createdOrganizationIds.splice(0)) {
      await prisma.auditLog.deleteMany({ where: { organizationId } });
      await prisma.session.deleteMany({ where: { user: { organizationId } } });
      await prisma.site.deleteMany({ where: { organizationId } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await prisma.gatewayCertificate.deleteMany({ where: { inventoryId: { in: deletionInventoryIds } } });
    await prisma.gatewayInventory.deleteMany({ where: { id: { in: deletionInventoryIds.splice(0) } } });
  });

  afterAll(async () => {
    if (!operator) return;
    if (createdOperator) {
      await prisma.session.deleteMany({ where: { userId: operator.id } });
      await prisma.user.delete({ where: { id: operator.id } });
    }
    await prisma.$disconnect();
  });

  it("creates a customer, pending site and single admin atomically", async () => {
    const result = await service.createSiteAdmin(operator, {
      customerName: "Integration Customer", siteName: "Installation Pending", adminName: "Customer Admin",
      loginId: `customer_${randomUUID().slice(0, 8)}`, initialPassword: "initial password"
    });
    const storedSite = await prisma.site.findUniqueOrThrow({ where: { id: result.siteId }, include: { organization: true, admin: true } });
    createdOrganizationIds.push(storedSite.organizationId);

    expect(result).toMatchObject({ customerName: "Integration Customer", siteName: "Installation Pending", installationStatus: "pending" });
    expect(result.admin).toMatchObject({ id: storedSite.adminUserId, status: "active" });
    expect(storedSite).toMatchObject({ address: null, tariffKwhRate: null, organization: { type: "customer" } });
    expect(JSON.stringify(result)).not.toMatch(/password|passwordHash/i);
  });

  it("deletes an admin and the complete customer site", async () => {
    const created = await service.createSiteAdmin(operator, {
      customerName: "Disable Customer", siteName: "Disable Site", adminName: "Disable Admin",
      loginId: `disable_${randomUUID().slice(0, 8)}`, initialPassword: "initial password"
    });
    const adminId = created.admin!.id;
    deletionSiteIds.push(created.siteId);
    const organizationId = (await prisma.site.findUniqueOrThrow({ where: { id: created.siteId } })).organizationId;
    const floor = await prisma.floor.create({
      data: { siteId: created.siteId, name: "B1", level: -1 }
    });
    await prisma.floorPlan.create({
      data: { floorId: floor.id, imageUrl: "https://assets.example/map.png", width: 1200, height: 800 }
    });
    await prisma.floorMapObject.create({
      data: { floorId: floor.id, type: "rectangle", x: 10, y: 20, width: 100, height: 80 }
    });
    const gateway = await prisma.gateway.create({
      data: { siteId: created.siteId, name: "Main Gateway", serialNumber: `GW-${randomUUID()}`, firmwareVersion: "1.0.0" }
    });
    const claimedInventory = await prisma.gatewayInventory.create({
      data: { serialNumber: gateway.serialNumber, claimedGatewayId: gateway.id, claimedAt: new Date() }
    });
    const certificateInventory = await prisma.gatewayInventory.create({
      data: { serialNumber: `GW-CERT-${randomUUID()}` }
    });
    deletionInventoryIds.push(claimedInventory.id, certificateInventory.id);
    const certificate = await prisma.gatewayCertificate.create({
      data: {
        inventoryId: certificateInventory.id,
        gatewayId: gateway.id,
        purpose: "device",
        certificateSerial: randomUUID().replaceAll("-", ""),
        fingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        issuer: "integration-ca",
        notBefore: new Date("2026-01-01T00:00:00.000Z"),
        notAfter: new Date("2027-01-01T00:00:00.000Z"),
        status: "active"
      }
    });
    const meshNode = await prisma.meshNode.create({
      data: { gatewayId: gateway.id, deviceUuid: randomUUID().replaceAll("-", ""), meshAddress: "0x0100", firmwareVersion: "1.0.0" }
    });
    const fixture = await prisma.fixture.create({
      data: {
        floorId: floor.id, siteId: created.siteId, gatewayId: gateway.id, meshNodeId: meshNode.id,
        name: "B1-001", ratedWatt: "40.00", x: 30, y: 40
      }
    });
    await prisma.energyUsage.create({
      data: { fixtureId: fixture.id, source: "state", period: "2026-09-03", kwh: "1.2500", cost: "200.00" }
    });
    const provisioningSession = await prisma.provisioningSession.create({
      data: { siteId: created.siteId, floorId: floor.id, gatewayId: gateway.id, requestedBy: adminId }
    });
    await prisma.discoveredMeshNode.create({
      data: {
        sessionId: provisioningSession.id, deviceUuid: randomUUID().replaceAll("-", ""),
        serialNumber: `NODE-${randomUUID()}`, rssi: -55, oobCapability: "none", firmwareVersion: "1.0.0"
      }
    });
    const viewer = await prisma.user.create({
      data: {
        organizationId, loginId: `viewer_${randomUUID().slice(0, 8)}`, email: null, name: "Viewer",
        passwordHash: await new PasswordService().hash("viewer password"), role: "viewer", status: "active"
      }
    });
    await prisma.siteMembership.create({ data: { userId: viewer.id, siteId: created.siteId } });
    await prisma.session.create({
      data: { userId: viewer.id, tokenHash: randomUUID(), expiresAt: new Date("2027-01-01T00:00:00.000Z") }
    });
    await prisma.invitation.create({
      data: {
        organizationId, siteId: created.siteId, email: "viewer@example.com", role: "viewer",
        tokenHash: randomUUID(), expiresAt: new Date("2027-01-01T00:00:00.000Z")
      }
    });
    await prisma.session.createMany({ data: [
      { userId: adminId, tokenHash: randomUUID(), rememberMe: false, expiresAt: new Date("2026-09-01T00:00:00.000Z") },
      { userId: adminId, tokenHash: randomUUID(), rememberMe: true, expiresAt: new Date("2026-09-01T00:00:00.000Z") }
    ] });

    await service.deleteSiteAdmin(operator, adminId, "Disable Site");

    await expect(prisma.user.findUnique({ where: { id: adminId } })).resolves.toBeNull();
    await expect(prisma.site.findUnique({ where: { id: created.siteId } })).resolves.toBeNull();
    await expect(prisma.organization.findUnique({ where: { id: organizationId } })).resolves.toBeNull();
    await expect(prisma.floor.count({ where: { id: floor.id } })).resolves.toBe(0);
    await expect(prisma.gateway.count({ where: { id: gateway.id } })).resolves.toBe(0);
    await expect(prisma.meshNode.count({ where: { id: meshNode.id } })).resolves.toBe(0);
    await expect(prisma.fixture.count({ where: { id: fixture.id } })).resolves.toBe(0);
    await expect(prisma.energyUsage.count({ where: { fixtureId: fixture.id } })).resolves.toBe(0);
    await expect(prisma.provisioningSession.count({ where: { id: provisioningSession.id } })).resolves.toBe(0);
    await expect(prisma.user.findUnique({ where: { id: viewer.id } })).resolves.toBeNull();
    await expect(prisma.gatewayInventory.findUniqueOrThrow({ where: { id: claimedInventory.id } })).resolves.toMatchObject({
      claimedGatewayId: null,
      disabledAt: expect.any(Date)
    });
    await expect(prisma.gatewayCertificate.findUniqueOrThrow({ where: { id: certificate.id } })).resolves.toMatchObject({
      gatewayId: null,
      inventoryId: certificateInventory.id
    });
    await expect(prisma.siteDeletionCleanup.findUniqueOrThrow({ where: { siteId: created.siteId } })).resolves.toMatchObject({
      inventoryIds: expect.arrayContaining([claimedInventory.id, certificateInventory.id]),
      objectKeys: []
    });
    await expect(prisma.auditLog.count({
      where: { organizationId: operator.organizationId, targetId: created.siteId, action: "operator.site_deleted" }
    })).resolves.toBe(1);
  });

  it("allows exactly one of two replacement admins racing for the same unassigned site", async () => {
    const organizationId = randomUUID();
    const siteId = randomUUID();
    createdOrganizationIds.push(organizationId);
    await prisma.organization.create({ data: { id: organizationId, name: "Replacement Race Customer", type: "customer" } });
    await prisma.site.create({ data: { id: siteId, organizationId, name: "Replacement Race Site", address: null, tariffKwhRate: null } });
    const barrier = createBarrier(2);
    const racers = await Promise.all([
      createHookedService({ afterSiteFindFirst: barrier }),
      createHookedService({ afterSiteFindFirst: barrier })
    ]);
    const loginIds = [`race_a_${randomUUID().slice(0, 8)}`, `race_b_${randomUUID().slice(0, 8)}`];

    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled(racers.map((racer, index) => racer.service.createReplacementAdmin(operator, siteId, {
        adminName: `Race Admin ${index + 1}`,
        loginId: loginIds[index],
        initialPassword: "initial password"
      })));
    } finally {
      await Promise.all(racers.map((racer) => racer.disconnect()));
    }

    expect(results.filter(isFulfilled)).toHaveLength(1);
    expect(results.filter(isConflictRejected)).toHaveLength(1);
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    const admins = await prisma.user.findMany({ where: { organizationId, role: "admin" } });
    expect(admins).toHaveLength(1);
    expect(site.adminUserId).toBe(admins[0].id);
    expect(loginIds).toContain(admins[0].loginId);
  }, 15_000);

  it("keeps reset-delete competition consistent and rejects the loser safely", async () => {
    const created = await service.createSiteAdmin(operator, {
      customerName: "Reset Disable Race Customer", siteName: "Reset Disable Race Site", adminName: "Race Admin",
      loginId: `reset_disable_${randomUUID().slice(0, 8)}`, initialPassword: "initial password"
    });
    const adminId = created.admin!.id;
    deletionSiteIds.push(created.siteId);
    const organizationId = (await prisma.site.findUniqueOrThrow({ where: { id: created.siteId } })).organizationId;
    createdOrganizationIds.push(organizationId);
    await prisma.session.createMany({ data: [
      { userId: adminId, tokenHash: randomUUID(), rememberMe: false, expiresAt: new Date("2026-09-01T00:00:00.000Z") },
      { userId: adminId, tokenHash: randomUUID(), rememberMe: true, expiresAt: new Date("2026-09-01T00:00:00.000Z") }
    ] });
    const barrier = createBarrier(2);
    const racers = await Promise.all([
      createHookedService({ afterUserFindFirst: barrier }),
      createHookedService({ afterUserFindFirst: barrier })
    ]);

    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled([
        racers[0].service.resetPassword(operator, adminId, "replacement password"),
        racers[1].service.deleteSiteAdmin(operator, adminId, "Reset Disable Race Site")
      ]);
    } finally {
      await Promise.all(racers.map((racer) => racer.disconnect()));
    }

    expect(results.filter(isFulfilled)).toHaveLength(1);
    expect(results.filter(isConflictRejected)).toHaveLength(1);
    const [storedAdmin, storedSite, activeSessions, audits] = await Promise.all([
      prisma.user.findUnique({ where: { id: adminId } }),
      prisma.site.findUnique({ where: { id: created.siteId } }),
      prisma.session.count({ where: { userId: adminId, revokedAt: null } }),
      prisma.auditLog.count({
        where: { OR: [
          { targetId: adminId, action: "operator.site_admin_password_reset" },
          { targetId: created.siteId, action: "operator.site_deleted" }
        ] }
      })
    ]);
    expect(activeSessions).toBe(0);
    expect(audits).toBe(1);
    if (!storedAdmin) {
      expect(storedSite).toBeNull();
    } else {
      expect(storedAdmin.status).toBe("active");
      expect(storedSite?.adminUserId).toBe(adminId);
    }
  }, 15_000);

  it("rolls back the losing customer, site, and user on concurrent duplicate loginId creation", async () => {
    const suffix = randomUUID().slice(0, 8);
    const loginId = `duplicate_${suffix}`;
    const customerNames = [`Duplicate Customer ${suffix} A`, `Duplicate Customer ${suffix} B`];
    const siteNames = [`Duplicate Site ${suffix} A`, `Duplicate Site ${suffix} B`];
    const barrier = createBarrier(2);
    const racers = await Promise.all([
      createHookedService({ beforeOrganizationCreate: barrier }),
      createHookedService({ beforeOrganizationCreate: barrier })
    ]);

    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled(racers.map((racer, index) => racer.service.createSiteAdmin(operator, {
        customerName: customerNames[index],
        siteName: siteNames[index],
        adminName: `Duplicate Admin ${index + 1}`,
        loginId,
        initialPassword: "initial password"
      })));
    } finally {
      await Promise.all(racers.map((racer) => racer.disconnect()));
    }

    expect(results.filter(isFulfilled)).toHaveLength(1);
    expect(results.filter(isConflictRejected)).toHaveLength(1);
    const winner = await prisma.user.findUniqueOrThrow({ where: { loginId }, include: { administeredSite: true } });
    createdOrganizationIds.push(winner.organizationId);
    await expect(prisma.organization.count({ where: { name: { in: customerNames } } })).resolves.toBe(1);
    await expect(prisma.site.count({ where: { name: { in: siteNames } } })).resolves.toBe(1);
    await expect(prisma.user.count({ where: { loginId } })).resolves.toBe(1);
    expect(winner.administeredSite?.adminUserId).toBe(winner.id);
  }, 15_000);

  async function createHookedService(hooks: {
    afterSiteFindFirst?: () => Promise<void>;
    afterUserFindFirst?: () => Promise<void>;
    beforeOrganizationCreate?: () => Promise<void>;
  }) {
    const client = new PrismaService();
    let userFindHookCalled = false;
    const extended = client.$extends({
      query: {
        site: {
          async findFirst({ args, query }) {
            const result = await query(args);
            if (hooks.afterSiteFindFirst) await hooks.afterSiteFindFirst();
            return result;
          }
        },
        user: {
          async findFirst({ args, query }) {
            const result = await query(args);
            if (hooks.afterUserFindFirst && !userFindHookCalled) {
              userFindHookCalled = true;
              await hooks.afterUserFindFirst();
            }
            return result;
          }
        },
        organization: {
          async create({ args, query }) {
            if (hooks.beforeOrganizationCreate) await hooks.beforeOrganizationCreate();
            const result = await query(args);
            return result;
          }
        }
      }
    });
    await extended.$connect();
    return {
      service: new OperatorSiteAdminsService(
        extended as unknown as PrismaService,
        new PasswordService(),
        new AuditService(extended as unknown as PrismaService),
        { processNow: async () => ({ status: "completed" as const }) } as never
      ),
      disconnect: () => extended.$disconnect()
    };
  }
});

function createBarrier(participants: number) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived === participants) release();
    await open;
  };
}

function isFulfilled(result: PromiseSettledResult<unknown>): result is PromiseFulfilledResult<unknown> {
  return result.status === "fulfilled";
}

function isConflictRejected(result: PromiseSettledResult<unknown>) {
  return result.status === "rejected"
    && result.reason instanceof ConflictException
    && result.reason.getStatus() === 409;
}
