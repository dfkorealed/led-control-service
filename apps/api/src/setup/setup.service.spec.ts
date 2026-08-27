import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { SitesService } from "../sites/sites.service";
import { SetupService } from "./setup.service";

describe("SetupService", () => {
  const dashboard = {
    site: { id: "site-1", name: "A 주차장" },
    summary: {
      totalFixtures: 0,
      onlineFixtures: 0,
      faultFixtures: 0,
      averageBrightness: 0
    },
    floors: [],
    groups: [],
    gateways: []
  };

  function createModule(prismaOverrides = {}) {
    const prisma: any = {
      site: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({ id: "site-1", organizationId: "organization-1" }),
        create: jest.fn().mockResolvedValue({
          id: "site-1",
          name: "A 주차장",
          address: "서울시 강남구",
          tariffKwhRate: "160.00"
        })
      },
      organization: {
        create: jest.fn().mockResolvedValue({ id: "customer-organization-1", name: "고객사 A", type: "customer" })
      },
      siteMembership: {
        create: jest.fn().mockResolvedValue({ id: "membership-1" })
      },
      floor: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        create: jest.fn(),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: "floor-1" })
      },
      floorPlan: {
        create: jest.fn().mockResolvedValue({ id: "floor-plan-1" })
      },
      gateway: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "gateway-1",
          siteId: "site-1",
          name: "B2 게이트웨이",
          serialNumber: "GW-001",
          firmwareVersion: "manual-unknown"
        })
      },
      ...prismaOverrides
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma));

    const sitesService = {
      getDashboardById: jest.fn().mockResolvedValue(dashboard)
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };

    return Test.createTestingModule({
      providers: [
        SetupService,
        { provide: PrismaService, useValue: prisma },
        { provide: SitesService, useValue: sitesService },
        { provide: SiteAccessService, useValue: siteAccess }
      ]
    }).compile().then((moduleRef) => ({
      service: moduleRef.get(SetupService),
      prisma,
      sitesService,
      siteAccess
    }));
  }

  function transactionConflictError() {
    return Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), {
      code: "P2034",
      name: "PrismaClientKnownRequestError"
    });
  }

  const initialSiteInput = {
    customerOrganizationName: "고객사 A",
    siteName: "A 주차장",
    address: "서울시 강남구",
    tariffKwhRate: 160,
    floors: [{ name: "B2", level: -2 }]
  };

  const operator: AuthenticatedUser = {
    id: "operator-1",
    organizationId: "provider-organization-1",
    organizationType: "service_provider",
    loginId: "fixture_user",
    email: "operator@example.com",
    name: "Operator",
    role: "operator",
    status: "active"
  };
  const admin: AuthenticatedUser = {
    ...operator,
    organizationId: "customer-organization-1",
    organizationType: "customer",
    loginId: "fixture_user",
    role: "admin"
  };

  it("rejects initial site creation by a customer admin", async () => {
    const { service } = await createModule();

    await expect((service as any).createInitialSite(admin, initialSiteInput)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("creates a customer organization, initial site, floors, and operator membership atomically", async () => {
    const { service, prisma } = await createModule();

    await (service as any).createInitialSite(operator, initialSiteInput);

    expect(prisma.organization.create).toHaveBeenCalledWith({
      data: { name: "고객사 A", type: "customer" }
    });
    expect(prisma.siteMembership.create).toHaveBeenCalledWith({
      data: { userId: operator.id, siteId: "site-1" }
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
  });

  it("creates the initial site and floors without bypassing the gateway claim flow", async () => {
    const { service, prisma, sitesService } = await createModule();

    const result = await service.createInitialSite(operator, {
      customerOrganizationName: "고객사 A",
      siteName: " A 주차장 ",
      address: " 서울시 강남구 ",
      tariffKwhRate: 160,
      floors: [
        { name: " B2 ", level: -2 },
        { name: "B1", level: -1 }
      ]
    });

    expect(prisma.organization.create).toHaveBeenCalledWith({ data: { name: "고객사 A", type: "customer" } });
    expect(prisma.site.create).toHaveBeenCalledWith({
      data: {
        organizationId: "customer-organization-1",
        name: "A 주차장",
        address: "서울시 강남구",
        tariffKwhRate: "160.00"
      }
    });
    expect(prisma.floor.createMany).toHaveBeenCalledWith({
      data: [
        { siteId: "site-1", name: "B2", level: -2 },
        { siteId: "site-1", name: "B1", level: -1 }
      ]
    });
    expect(prisma.gateway.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
    expect(sitesService.getDashboardById).toHaveBeenCalledWith("site-1");
    expect(result).toBe(dashboard);
  });

  it("accepts initial setup without a gateway so it can be claimed from manufacturing inventory", async () => {
    const { service, prisma } = await createModule();

    await expect(service.createInitialSite(operator, initialSiteInput)).resolves.toBe(dashboard);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.gateway.create).not.toHaveBeenCalled();
  });

  it("persists a validated IANA timezone when the installation specifies one", async () => {
    const { service, prisma } = await createModule();

    await service.createInitialSite(operator, { ...initialSiteInput, timeZone: "America/New_York" });

    expect(prisma.site.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ timeZone: "America/New_York" })
    });
    await expect(service.createInitialSite(operator, { ...initialSiteInput, timeZone: "Invalid/Zone" })).rejects.toThrow(
      "timeZone must be a valid IANA timezone"
    );
  });

  it("rejects duplicate floor names and levels in the same request", async () => {
    const { service } = await createModule();

    await expect(
      service.createInitialSite(operator, {
        ...initialSiteInput,
        floors: [
          { name: " B2 ", level: -2 },
          { name: "B2", level: -1 }
        ]
      })
    ).rejects.toThrow("floor names must be unique");

    await expect(
      service.createInitialSite(operator, {
        ...initialSiteInput,
        floors: [
          { name: "B2", level: -2 },
          { name: "지하2층", level: -2 }
        ]
      })
    ).rejects.toThrow("floor levels must be unique");
  });

  it("rejects malformed initial site payloads with BadRequestException", async () => {
    const { service } = await createModule();

    await expect(service.createInitialSite(operator, null as any)).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.createInitialSite(operator, {
        address: "서울시 강남구",
        tariffKwhRate: 160,
        floors: [{ name: "B2", level: -2 }],
      } as any)
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.createInitialSite(operator, {
        siteName: 123,
        address: "서울시 강남구",
        tariffKwhRate: 160,
        floors: [{ name: "B2", level: -2 }],
      } as any)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects malformed floor payloads with BadRequestException", async () => {
    const { service } = await createModule();

    await expect(
      service.createInitialSite(operator, {
        ...initialSiteInput,
        floors: [{ name: 123, level: -2 }]
      } as any)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects tariff rates outside the Decimal(10,2) setup range", async () => {
    const { service } = await createModule();

    await expect(service.createInitialSite(operator, { ...initialSiteInput, tariffKwhRate: 0 })).rejects.toThrow(
      "tariffKwhRate must be greater than 0 and less than or equal to 100000"
    );

    await expect(service.createInitialSite(operator, { ...initialSiteInput, tariffKwhRate: 100000.01 })).rejects.toThrow(
      "tariffKwhRate must be greater than 0 and less than or equal to 100000"
    );
  });

  it("rejects floor levels that are zero or outside the setup range", async () => {
    const { service } = await createModule();

    await expect(
      service.createInitialSite(operator, { ...initialSiteInput, floors: [{ name: "0F", level: 0 }] })
    ).rejects.toThrow("floor level must be between -100 and 100 and cannot be 0");

    await expect(
      service.addFloors(operator, {
        siteId: "site-1",
        floors: [{ name: "B101", level: -101 }]
      })
    ).rejects.toThrow("floor level must be between -100 and 100 and cannot be 0");

    await expect(
      service.addFloors(operator, {
        siteId: "site-1",
        floors: [{ name: "101F", level: 101 }]
      })
    ).rejects.toThrow("floor level must be between -100 and 100 and cannot be 0");
  });

  it("rejects malformed add floors identifiers with BadRequestException", async () => {
    const { service } = await createModule();

    await expect(
      service.addFloors(operator, {
        siteId: 123,
        floors: [{ name: "B1", level: -1 }]
      } as any)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects invalid floor plan dimensions", async () => {
    const { service } = await createModule();

    await expect(
      service.addFloors(operator, {
        siteId: "site-1",
        floors: [{ name: "B1", level: -1, floorPlan: { imageUrl: "   ", width: 1200, height: 800 } }]
      })
    ).rejects.toThrow("floorPlan imageUrl is required");

    await expect(
      service.addFloors(operator, {
        siteId: "site-1",
        floors: [{ name: "B1", level: -1, floorPlan: "/b1.svg" }]
      } as any)
    ).rejects.toThrow("floorPlan must be an object");

    await expect(
      service.addFloors(operator, {
        siteId: "site-1",
        floors: [{ name: "B1", level: -1, floorPlan: { imageUrl: "/b1.svg", width: 1200.5, height: 800 } }]
      })
    ).rejects.toThrow("floorPlan width must be a positive integer");

    await expect(
      service.addFloors(operator, {
        siteId: "site-1",
        floors: [{ name: "B1", level: -1, floorPlan: { imageUrl: "/b1.svg", width: 1200, height: 0 } }]
      })
    ).rejects.toThrow("floorPlan height must be a positive integer");
  });

  it("maps initial site serializable transaction conflicts to ConflictException", async () => {
    const { service, prisma } = await createModule();
    prisma.$transaction.mockRejectedValueOnce(transactionConflictError());

    let caught: unknown;
    try {
      await service.createInitialSite(operator, {
        ...initialSiteInput
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as Error).message).toBe("setup transaction conflicted, please retry");
    await expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("adds floors only to a site in the current organization and rejects existing duplicates", async () => {
    const { service, prisma, sitesService } = await createModule({
      floor: {
        findMany: jest.fn().mockResolvedValue([{ name: "B2", level: -2 }]),
        createMany: jest.fn(),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: "floor-1" })
      }
    });

    await expect(
      service.addFloors(operator, {
        siteId: "site-1",
        floors: [{ name: " B2 ", level: -1 }]
      })
    ).rejects.toThrow("floor names must be unique");

    await expect(
      service.addFloors(operator, {
        siteId: "site-1",
        floors: [{ name: "B1", level: -2 }]
      })
    ).rejects.toThrow("floor levels must be unique");

    prisma.floor.findMany.mockResolvedValue([]);
    const result = await service.addFloors(operator, {
      siteId: "site-1",
      floors: [{ name: " B1 ", level: -1, floorPlan: { imageUrl: "/b1.svg", width: 1200, height: 800 } }]
    });

    expect(prisma.floor.createMany).toHaveBeenCalledWith({
      data: [{ siteId: "site-1", name: "B1", level: -1 }]
    });
    expect(prisma.floorPlan.create).toHaveBeenCalledWith({
      data: { floorId: "floor-1", imageUrl: "/b1.svg", width: 1200, height: 800 }
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
    expect(sitesService.getDashboardById).toHaveBeenCalledWith("site-1");
    expect(result).toBe(dashboard);
  });

  it("maps add floors serializable transaction conflicts to ConflictException", async () => {
    const { service, prisma } = await createModule();
    prisma.$transaction.mockRejectedValueOnce(transactionConflictError());

    let caught: unknown;
    try {
      await service.addFloors(operator, {
        siteId: "site-1",
        floors: [{ name: "B1", level: -1 }]
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as Error).message).toBe("setup transaction conflicted, please retry");
    await expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

});
