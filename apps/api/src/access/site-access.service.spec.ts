import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "./site-access.service";

describe("SiteAccessService", () => {
  const customerSiteId = "customer-site";
  const otherCustomerSiteId = "other-customer-site";
  const site = {
    id: customerSiteId,
    organizationId: "customer-org",
    adminUserId: "admin-1",
    memberships: [] as { id: string; accessLevel: "read" | "control" }[],
    organization: { id: "customer-org" }
  };
  const prisma = {
    site: { findUnique: jest.fn(), findMany: jest.fn() },
    siteMembership: { findMany: jest.fn() }
  };
  const operator: AuthenticatedUser = {
    id: "operator-1", organizationId: "provider-org", organizationType: "service_provider", loginId: "fixture_user",
    name: "Operator", role: "operator", status: "active"
  };
  const unassignedOperator: AuthenticatedUser = { ...operator, id: "operator-2" };
  const admin: AuthenticatedUser = {
    id: "admin-1", organizationId: "customer-org", organizationType: "customer", loginId: "fixture_user",
    name: "Admin", role: "admin", status: "active"
  };
  const viewer: AuthenticatedUser = { ...admin, id: "viewer-1", role: "viewer" };

  beforeEach(() => {
    jest.clearAllMocks();
    site.memberships = [];
    prisma.site.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === customerSiteId) return Promise.resolve(site);
      if (where.id === otherCustomerSiteId) {
        return Promise.resolve({
          ...site,
          id: otherCustomerSiteId,
          organizationId: "other-customer-org",
          organization: { id: "other-customer-org" }
        });
      }
      return Promise.resolve(null);
    });
  });

  async function createService() {
    const moduleRef = await Test.createTestingModule({
      providers: [SiteAccessService, { provide: PrismaService, useValue: prisma }]
    }).compile();
    return moduleRef.get(SiteAccessService);
  }

  it("grants commission only to the site's assigned admin", async () => {
    const assignedAdmin = admin;
    const otherAdmin: AuthenticatedUser = { ...admin, id: "admin-2" };
    const service = await createService();

    await expect(service.assert(assignedAdmin, customerSiteId, "commission")).resolves.toMatchObject({ id: customerSiteId });
    await expect(service.assert(otherAdmin, customerSiteId, "read")).rejects.toThrow("site not found");
    await expect(service.assert(operator, customerSiteId, "read")).rejects.toThrow("site not found");
  });

  it("hides a site from an operator even when it has a membership", async () => {
    site.memberships = [{ id: "membership-1", accessLevel: "read" }];
    const service = await createService();

    await expect(service.assert(unassignedOperator, customerSiteId, "read")).rejects.toThrow("site not found");
  });

  it("allows the assigned customer admin to manage its own site", async () => {
    site.memberships = [];
    const service = await createService();

    await expect(service.assert(admin, customerSiteId, "manage")).resolves.toMatchObject({ id: customerSiteId });
  });

  it("locks the site and reauthorizes the assigned active customer admin inside a manage transaction", async () => {
    const service = await createService();
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: customerSiteId }]),
      site: {
        findUnique: jest.fn().mockResolvedValue({
          id: customerSiteId,
          organizationId: admin.organizationId,
          adminUserId: admin.id,
          admin: {
            id: admin.id,
            organizationId: admin.organizationId,
            role: "admin",
            status: "active",
            organization: { type: "customer" }
          }
        })
      }
    };
    await expect(service.assertManageInTransaction(transaction as never, admin, customerSiteId)).resolves.toMatchObject({ id: customerSiteId });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("hides an assigned site from a disabled customer admin", async () => {
    const service = await createService();

    await expect(service.assert({ ...admin, status: "disabled" }, customerSiteId, "read")).rejects.toThrow("site not found");
  });

  it("forbids a viewer from managing a readable site", async () => {
    site.memberships = [{ id: "membership-1", accessLevel: "read" }];
    const service = await createService();

    await expect(service.assert(viewer, customerSiteId, "manage")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("grants a read member only read capability", async () => {
    site.memberships = [{ id: "membership-read", accessLevel: "read" }];
    const service = await createService();

    await expect(service.assert(viewer, customerSiteId, "read")).resolves.toMatchObject({ id: customerSiteId });
    await expect(service.assert(viewer, customerSiteId, "control")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.assert(viewer, customerSiteId, "manage")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.assert(viewer, customerSiteId, "commission")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.capabilities(viewer, customerSiteId)).resolves.toEqual({
      read: true,
      control: false,
      manage: false,
      commission: false
    });
  });

  it("grants a control member read and control capability only", async () => {
    site.memberships = [{ id: "membership-control", accessLevel: "control" }];
    const service = await createService();

    await expect(service.assert(viewer, customerSiteId, "read")).resolves.toMatchObject({ id: customerSiteId });
    await expect(service.assert(viewer, customerSiteId, "control")).resolves.toMatchObject({ id: customerSiteId });
    await expect(service.assert(viewer, customerSiteId, "manage")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.assert(viewer, customerSiteId, "commission")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.capabilities(viewer, customerSiteId)).resolves.toEqual({
      read: true,
      control: true,
      manage: false,
      commission: false
    });
  });

  it("grants every capability to the assigned admin", async () => {
    const service = await createService();

    await expect(service.capabilities(admin, customerSiteId)).resolves.toEqual({
      read: true,
      control: true,
      manage: true,
      commission: true
    });
  });

  it("locks the site and reauthorizes an active control member inside a control transaction", async () => {
    const service = await createService();
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: customerSiteId }]),
      site: {
        findUnique: jest.fn().mockResolvedValue({
          id: customerSiteId,
          organizationId: viewer.organizationId,
          adminUserId: admin.id,
          admin: null,
          memberships: [{
            accessLevel: "control",
            user: {
              id: viewer.id,
              organizationId: viewer.organizationId,
              role: "viewer",
              status: "active",
              organization: { type: "customer" }
            }
          }]
        })
      }
    };

    await expect(service.assertControlInTransaction(transaction as never, viewer, customerSiteId))
      .resolves.toMatchObject({ id: customerSiteId });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("forbids a persisted read member from controlling inside a transaction", async () => {
    const service = await createService();
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: customerSiteId }]),
      site: {
        findUnique: jest.fn().mockResolvedValue({
          id: customerSiteId,
          organizationId: viewer.organizationId,
          memberships: [{
            accessLevel: "read",
            user: {
              id: viewer.id,
              organizationId: viewer.organizationId,
              role: "viewer",
              status: "active",
              organization: { type: "customer" }
            }
          }]
        })
      }
    };

    await expect(service.assertControlInTransaction(transaction as never, viewer, customerSiteId))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it("does not reread membership or user state until the site lock resolves", async () => {
    const service = await createService();
    let resolveLock!: (rows: { id: string }[]) => void;
    const lock = new Promise<{ id: string }[]>((resolve) => {
      resolveLock = resolve;
    });
    const transaction = {
      $queryRaw: jest.fn().mockReturnValue(lock),
      site: {
        findUnique: jest.fn().mockResolvedValue({
          id: customerSiteId,
          organizationId: viewer.organizationId,
          memberships: [{
            accessLevel: "control",
            user: {
              id: viewer.id,
              organizationId: viewer.organizationId,
              role: "viewer",
              status: "active",
              organization: { type: "customer" }
            }
          }]
        })
      }
    };

    const assertion = service.assertControlInTransaction(transaction as never, viewer, customerSiteId);
    await Promise.resolve();
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.site.findUnique).not.toHaveBeenCalled();

    resolveLock([{ id: customerSiteId }]);
    await expect(assertion).resolves.toMatchObject({ id: customerSiteId });
  });

  it("hides a cross-customer membership from a viewer even when the membership row exists", async () => {
    site.memberships = [{ id: "cross-customer-membership", accessLevel: "read" }];
    const service = await createService();

    await expect(service.assert(viewer, otherCustomerSiteId, "read")).rejects.toThrow("site not found");
  });

  it("hides other customer sites from a customer admin even when the admin has a membership", async () => {
    site.memberships = [{ id: "cross-tenant-membership", accessLevel: "read" }];
    const service = await createService();

    await expect(service.assert(admin, otherCustomerSiteId, "read")).rejects.toThrow("site not found");
  });

  it("denies a service-provider admin all site access and returns no accessible sites", async () => {
    const service = await createService();
    const serviceProviderAdmin: AuthenticatedUser = { ...operator, role: "admin" };

    await expect(service.assert(serviceProviderAdmin, customerSiteId, "read")).rejects.toThrow("site not found");
    await expect(service.listAccessibleSiteIds(serviceProviderAdmin)).resolves.toEqual([]);
    expect(prisma.site.findMany).not.toHaveBeenCalled();
    expect(prisma.siteMembership.findMany).not.toHaveBeenCalled();
  });

  it("denies an operator in a customer organization all site access", async () => {
    const service = await createService();
    const customerOperator: AuthenticatedUser = { ...admin, role: "operator" };

    await expect(service.assert(customerOperator, customerSiteId, "read")).rejects.toThrow("site not found");
    await expect(service.listAccessibleSiteIds(customerOperator)).resolves.toEqual([]);
  });

  it("lists only the assigned site for an admin, viewer memberships, and no operator sites", async () => {
    prisma.site.findMany.mockResolvedValue([{ id: "customer-site" }]);
    prisma.siteMembership.findMany.mockResolvedValue([{ siteId: "assigned-site", site: { organizationId: "customer-org" } }]);
    const service = await createService();

    await expect(service.listAccessibleSiteIds(admin)).resolves.toEqual(["customer-site"]);
    await expect(service.listAccessibleSiteIds(operator)).resolves.toEqual([]);
    await expect(service.listAccessibleSiteIds(viewer)).resolves.toEqual(["assigned-site"]);
  });

  it("filters cross-customer viewer memberships from the accessible site list", async () => {
    prisma.siteMembership.findMany.mockResolvedValue([
      { siteId: "assigned-site", site: { organizationId: "customer-org" } },
      { siteId: "foreign-site", site: { organizationId: "other-customer-org" } }
    ]);
    const service = await createService();

    await expect(service.listAccessibleSiteIds(viewer)).resolves.toEqual(["assigned-site"]);
  });

  it("queries the admin's direct assignment instead of organization-wide sites", async () => {
    prisma.site.findMany.mockResolvedValue([{ id: "customer-site" }]);
    const service = await createService();

    await expect(service.listAccessibleSiteIds(admin)).resolves.toEqual(["customer-site"]);
    expect(prisma.site.findMany).toHaveBeenCalledWith({
      where: { adminUserId: admin.id },
      select: { id: true }
    });
    expect(prisma.siteMembership.findMany).not.toHaveBeenCalled();
  });
});
