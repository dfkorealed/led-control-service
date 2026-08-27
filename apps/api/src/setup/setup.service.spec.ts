import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { SitesService } from "../sites/sites.service";
import { SetupService } from "./setup.service";

describe("SetupService", () => {
  const dashboard = {
    site: { id: "site-1", name: "A 주차장" },
    summary: { totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, averageBrightness: 0 },
    floors: [], groups: [], gateways: []
  };
  const admin: AuthenticatedUser = {
    id: "admin-1", organizationId: "customer-organization-1", organizationType: "customer",
    loginId: "admin_1", name: "Admin", role: "admin", status: "active"
  };
  const operator: AuthenticatedUser = {
    id: "operator-1", organizationId: "provider-organization-1", organizationType: "service_provider",
    loginId: "operator_1", name: "Operator", role: "operator", status: "active"
  };
  const initialSiteInput = {
    siteId: "site-1", address: "서울시 강남구", tariffKwhRate: 160,
    floors: [{ name: "B2", level: -2 }]
  };

  function pendingSite(overrides = {}) {
    return {
      id: "site-1", organizationId: admin.organizationId, adminUserId: admin.id,
      address: null, tariffKwhRate: null, timeZone: "Asia/Seoul",
      admin: { id: admin.id, organizationId: admin.organizationId, role: "admin", status: "active", organization: { type: "customer" } },
      floors: [],
      ...overrides
    };
  }

  function createModule(prismaOverrides: Record<string, unknown> = {}) {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "site-1" }]),
      site: {
        findUnique: jest.fn().mockResolvedValue(pendingSite()),
        update: jest.fn().mockResolvedValue({ id: "site-1" }),
        create: jest.fn()
      },
      organization: { create: jest.fn() },
      floor: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: "floor-1" })
      },
      floorPlan: { create: jest.fn().mockResolvedValue({ id: "floor-plan-1" }) },
      ...prismaOverrides
    };
    prisma.$transaction = jest.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
    const sitesService = { getDashboardById: jest.fn().mockResolvedValue(dashboard) };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };

    return Test.createTestingModule({
      providers: [
        SetupService,
        { provide: PrismaService, useValue: prisma },
        { provide: SitesService, useValue: sitesService },
        { provide: SiteAccessService, useValue: siteAccess }
      ]
    }).compile().then((moduleRef) => ({ service: moduleRef.get(SetupService), prisma, sitesService, siteAccess }));
  }

  function transactionConflictError() {
    return Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), {
      code: "P2034", name: "PrismaClientKnownRequestError"
    });
  }

  it("completes the assigned pending site without creating another organization or site", async () => {
    const { service, prisma, sitesService } = await createModule();

    const result = await service.completeInitialSite(admin, initialSiteInput);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.site.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: initialSiteInput.siteId } }));
    expect(prisma.site.update).toHaveBeenCalledWith({
      where: { id: initialSiteInput.siteId },
      data: { address: "서울시 강남구", tariffKwhRate: "160.00" }
    });
    expect(prisma.floor.createMany).toHaveBeenCalledWith({
      data: [{ siteId: initialSiteInput.siteId, name: "B2", level: -2 }]
    });
    expect(prisma.organization.create).not.toHaveBeenCalled();
    expect(prisma.site.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
    expect(sitesService.getDashboardById).toHaveBeenCalledWith(initialSiteInput.siteId);
    expect(result).toBe(dashboard);
  });

  it("revalidates the assigned active customer admin under the site row lock", async () => {
    const { service, prisma } = await createModule({
      site: {
        findUnique: jest.fn().mockResolvedValue(pendingSite({
          admin: { id: admin.id, organizationId: admin.organizationId, role: "admin", status: "disabled", organization: { type: "customer" } }
        })), update: jest.fn(), create: jest.fn()
      }
    });

    await expect(service.completeInitialSite(admin, initialSiteInput)).rejects.toThrow("site not found");
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.site.update).not.toHaveBeenCalled();
  });

  it("rejects an operator and a different admin before any setup writes", async () => {
    const { service, prisma } = await createModule();

    await expect(service.completeInitialSite(operator, initialSiteInput)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.completeInitialSite({ ...admin, id: "other-admin" }, initialSiteInput)).rejects.toThrow("site not found");
    expect(prisma.site.update).not.toHaveBeenCalled();
  });

  it("rejects reinstallation of an already installed site", async () => {
    const { service, prisma } = await createModule({
      site: {
        findUnique: jest.fn().mockResolvedValue(pendingSite({ address: "서울", tariffKwhRate: "160.00", floors: [{ id: "floor-1" }] })),
        update: jest.fn(), create: jest.fn()
      }
    });

    await expect(service.completeInitialSite(admin, initialSiteInput)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.site.update).not.toHaveBeenCalled();
  });

  it("preserves initial setup validation for site id, tariff, timezone, and floors", async () => {
    const { service } = await createModule();

    await expect(service.completeInitialSite(admin, { ...initialSiteInput, siteId: " " })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.completeInitialSite(admin, { ...initialSiteInput, tariffKwhRate: 0 })).rejects.toThrow(
      "tariffKwhRate must be greater than 0 and less than or equal to 100000"
    );
    await expect(service.completeInitialSite(admin, { ...initialSiteInput, timeZone: "Invalid/Zone" })).rejects.toThrow(
      "timeZone must be a valid IANA timezone"
    );
    await expect(service.completeInitialSite(admin, { ...initialSiteInput, floors: [{ name: "0F", level: 0 }] })).rejects.toThrow(
      "floor level must be between -100 and 100 and cannot be 0"
    );
  });

  it("maps initial setup serializable transaction conflicts to ConflictException", async () => {
    const { service, prisma } = await createModule();
    prisma.$transaction.mockRejectedValueOnce(transactionConflictError());

    await expect(service.completeInitialSite(admin, initialSiteInput)).rejects.toMatchObject({
      message: "setup transaction conflicted, please retry"
    });
  });

  it("maps PostgreSQL row-lock serialization errors wrapped as P2010 to ConflictException", async () => {
    const { service, prisma } = await createModule();
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("Raw query failed. Code: `40001`. Message: `could not serialize access due to concurrent update`"), {
      code: "P2010", name: "PrismaClientKnownRequestError"
    }));

    await expect(service.completeInitialSite(admin, initialSiteInput)).rejects.toMatchObject({
      message: "setup transaction conflicted, please retry"
    });
  });

  it("allows the assigned admin to add non-duplicate floors with commission capability", async () => {
    const { service, prisma, siteAccess } = await createModule();

    await service.addFloors(admin, {
      siteId: "site-1",
      floors: [{ name: "B1", level: -1, floorPlan: { imageUrl: "/b1.svg", width: 1200, height: 800 } }]
    });

    expect(siteAccess.assert).toHaveBeenCalledWith(admin, "site-1", "commission");
    expect(prisma.floor.createMany).toHaveBeenCalledWith({ data: [{ siteId: "site-1", name: "B1", level: -1 }] });
    expect(prisma.floorPlan.create).toHaveBeenCalledWith({
      data: { floorId: "floor-1", imageUrl: "/b1.svg", width: 1200, height: 800 }
    });
  });
});
