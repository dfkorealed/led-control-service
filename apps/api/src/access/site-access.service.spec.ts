import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "./site-access.service";

describe("SiteAccessService", () => {
  const customerSiteId = "customer-site";
  const otherCustomerSiteId = "other-customer-site";
  const site = { id: customerSiteId, organizationId: "customer-org", memberships: [] as { id: string }[] };
  const prisma = {
    site: { findUnique: jest.fn(), findMany: jest.fn() },
    siteMembership: { findMany: jest.fn() }
  };
  const operator: AuthenticatedUser = {
    id: "operator-1", organizationId: "provider-org", organizationType: "service_provider", email: "operator@example.com",
    name: "Operator", role: "operator", status: "active"
  };
  const unassignedOperator: AuthenticatedUser = { ...operator, id: "operator-2" };
  const admin: AuthenticatedUser = {
    id: "admin-1", organizationId: "customer-org", organizationType: "customer", email: "admin@example.com",
    name: "Admin", role: "admin", status: "active"
  };
  const viewer: AuthenticatedUser = { ...admin, id: "viewer-1", role: "viewer" };

  beforeEach(() => {
    jest.clearAllMocks();
    site.memberships = [];
    prisma.site.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === customerSiteId) return Promise.resolve(site);
      if (where.id === otherCustomerSiteId) return Promise.resolve({ ...site, id: otherCustomerSiteId, organizationId: "other-customer-org" });
      return Promise.resolve(null);
    });
  });

  async function createService() {
    const moduleRef = await Test.createTestingModule({
      providers: [SiteAccessService, { provide: PrismaService, useValue: prisma }]
    }).compile();
    return moduleRef.get(SiteAccessService);
  }

  it("allows an assigned operator to commission a customer site", async () => {
    site.memberships = [{ id: "membership-1" }];
    const service = await createService();

    await expect(service.assert(operator, customerSiteId, "commission")).resolves.toMatchObject({ id: customerSiteId });
  });

  it("hides a site from an unassigned operator", async () => {
    site.memberships = [];
    const service = await createService();

    await expect(service.assert(unassignedOperator, customerSiteId, "read")).rejects.toThrow("site not found");
  });

  it("allows a customer admin to manage its own site", async () => {
    site.memberships = [];
    const service = await createService();

    await expect(service.assert(admin, customerSiteId, "manage")).resolves.toMatchObject({ id: customerSiteId });
  });

  it("forbids a customer admin from commissioning its own site", async () => {
    const service = await createService();

    await expect(service.assert(admin, customerSiteId, "commission")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("forbids a viewer from managing a readable site", async () => {
    site.memberships = [{ id: "membership-1" }];
    const service = await createService();

    await expect(service.assert(viewer, customerSiteId, "manage")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("hides other customer sites from a customer admin", async () => {
    site.memberships = [];
    const service = await createService();

    await expect(service.assert(admin, otherCustomerSiteId, "read")).rejects.toThrow("site not found");
  });

  it("lists customer organization sites for an admin and memberships for other roles", async () => {
    prisma.site.findMany.mockResolvedValue([{ id: "customer-site" }]);
    prisma.siteMembership.findMany.mockResolvedValue([{ siteId: "assigned-site" }]);
    const service = await createService();

    await expect(service.listAccessibleSiteIds(admin)).resolves.toEqual(["customer-site"]);
    await expect(service.listAccessibleSiteIds(operator)).resolves.toEqual(["assigned-site"]);
    await expect(service.listAccessibleSiteIds(viewer)).resolves.toEqual(["assigned-site"]);
  });
});
