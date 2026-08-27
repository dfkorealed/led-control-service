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
  const createdOrganizationIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const provider = await prisma.organization.create({ data: { id: randomUUID(), name: "Operator Provider", type: "service_provider" } });
    const passwords = new PasswordService();
    const user = await prisma.user.create({
      data: {
        id: randomUUID(), organizationId: provider.id, loginId: `operator_${randomUUID().slice(0, 8)}`,
        email: null, name: "Operator", passwordHash: await passwords.hash("operator password"), role: "operator", status: "active"
      }
    });
    operator = { ...user, organizationType: "service_provider" };
    service = new OperatorSiteAdminsService(prisma, passwords, new AuditService(prisma));
  });

  afterEach(async () => {
    for (const organizationId of createdOrganizationIds.splice(0)) {
      await prisma.auditLog.deleteMany({ where: { organizationId } });
      await prisma.session.deleteMany({ where: { user: { organizationId } } });
      await prisma.site.deleteMany({ where: { organizationId } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.organization.delete({ where: { id: organizationId } });
    }
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { userId: operator.id } });
    await prisma.user.delete({ where: { id: operator.id } });
    await prisma.organization.delete({ where: { id: operator.organizationId } });
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

  it("disables an admin, revokes sessions and leaves the site unassigned", async () => {
    const created = await service.createSiteAdmin(operator, {
      customerName: "Disable Customer", siteName: "Disable Site", adminName: "Disable Admin",
      loginId: `disable_${randomUUID().slice(0, 8)}`, initialPassword: "initial password"
    });
    const adminId = created.admin!.id;
    createdOrganizationIds.push((await prisma.site.findUniqueOrThrow({ where: { id: created.siteId } })).organizationId);
    await prisma.session.createMany({ data: [
      { userId: adminId, tokenHash: randomUUID(), rememberMe: false, expiresAt: new Date("2026-09-01T00:00:00.000Z") },
      { userId: adminId, tokenHash: randomUUID(), rememberMe: true, expiresAt: new Date("2026-09-01T00:00:00.000Z") }
    ] });

    await service.disable(operator, adminId);

    await expect(prisma.user.findUniqueOrThrow({ where: { id: adminId } })).resolves.toMatchObject({ status: "disabled" });
    await expect(prisma.site.findUniqueOrThrow({ where: { id: created.siteId } })).resolves.toMatchObject({ adminUserId: null });
    await expect(prisma.session.count({ where: { userId: adminId, revokedAt: null } })).resolves.toBe(0);
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

  it("keeps reset-disable competition consistent and maps the serialization loser to conflict", async () => {
    const created = await service.createSiteAdmin(operator, {
      customerName: "Reset Disable Race Customer", siteName: "Reset Disable Race Site", adminName: "Race Admin",
      loginId: `reset_disable_${randomUUID().slice(0, 8)}`, initialPassword: "initial password"
    });
    const adminId = created.admin!.id;
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
        racers[1].service.disable(operator, adminId)
      ]);
    } finally {
      await Promise.all(racers.map((racer) => racer.disconnect()));
    }

    expect(results.filter(isFulfilled)).toHaveLength(1);
    expect(results.filter(isConflictRejected)).toHaveLength(1);
    const [storedAdmin, storedSite, activeSessions, audits] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: adminId } }),
      prisma.site.findUniqueOrThrow({ where: { id: created.siteId } }),
      prisma.session.count({ where: { userId: adminId, revokedAt: null } }),
      prisma.auditLog.count({
        where: { targetId: adminId, action: { in: ["operator.site_admin_password_reset", "operator.site_admin_disabled"] } }
      })
    ]);
    expect(activeSessions).toBe(0);
    expect(audits).toBe(1);
    if (storedAdmin.status === "disabled") {
      expect(storedSite.adminUserId).toBeNull();
    } else {
      expect(storedAdmin.status).toBe("active");
      expect(storedSite.adminUserId).toBe(adminId);
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
            if (hooks.afterUserFindFirst) await hooks.afterUserFindFirst();
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
        new AuditService(extended as unknown as PrismaService)
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
