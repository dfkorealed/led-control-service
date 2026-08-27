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
});
