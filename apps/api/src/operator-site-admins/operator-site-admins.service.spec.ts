import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { PasswordService } from "../auth/password.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { RolesGuard } from "../access/roles.guard";
import { rolesMetadataKey } from "../access/roles.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { OperatorSiteAdminsController } from "./operator-site-admins.controller";
import { OperatorSiteAdminsService } from "./operator-site-admins.service";

describe("OperatorSiteAdminsService", () => {
  const operator: AuthenticatedUser = {
    id: "operator-1",
    organizationId: "provider-1",
    organizationType: "service_provider",
    loginId: "operator_1",
    name: "Operator",
    role: "operator",
    status: "active"
  };

  const createInput = {
    customerName: "Customer One",
    siteName: "Pending Site",
    adminName: "Customer Admin",
    loginId: "Customer_Admin",
    initialPassword: "initial password"
  };

  it("creates a customer, pending site, and single admin atomically without a password response", async () => {
    const { service, prisma } = createService();

    const result = await service.createSiteAdmin(operator, createInput);

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(result).toEqual({
      siteId: "site-1",
      customerName: "Customer One",
      siteName: "Pending Site",
      installationStatus: "pending",
      admin: {
        id: "admin-1",
        loginId: "customer_admin",
        name: "Customer Admin",
        status: "active",
        updatedAt: new Date("2026-08-27T00:00:00.000Z")
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/password|passwordHash/i);
  });

  it("rejects an operator from a customer organization before any database write", async () => {
    const { service, prisma } = createService();

    await expect(service.createSiteAdmin({ ...operator, organizationType: "customer" }, createInput)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("maps a duplicate normalized login id to a conflict and rolls back the customer creation", async () => {
    const { service, prisma, transaction } = createService({
      userCreate: jest.fn().mockRejectedValue({ code: "P2002" })
    });

    await expect(service.createSiteAdmin(operator, createInput)).rejects.toEqual(new ConflictException("loginId already exists"));
    expect(transaction.site.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("deletes the confirmed site graph, customer accounts, and organization atomically", async () => {
    const order: string[] = [];
    const { service, transaction } = createService({
      userFindFirst: jest.fn().mockResolvedValue({
        id: "admin-1",
        organizationId: "customer-1",
        administeredSite: { id: "site-1", name: "Pending Site", gateways: [] }
      }),
      siteDelete: jest.fn().mockImplementation(async () => { order.push("site"); }),
      sessionDeleteMany: jest.fn().mockImplementation(async () => { order.push("sessions"); return { count: 2 }; }),
      userDeleteMany: jest.fn().mockImplementation(async () => { order.push("users"); return { count: 1 }; }),
      organizationDelete: jest.fn().mockImplementation(async () => { order.push("organization"); })
    });

    await expect(service.deleteSiteAdmin(operator, "admin-1", "Pending Site")).resolves.toEqual({ ok: true });

    expect(order).toEqual(["site", "sessions", "users", "organization"]);
    expect(transaction.gatewayInventory.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ claimedGatewayId: { in: [] } }, { id: { in: [] } }] },
      data: { disabledAt: expect.any(Date) }
    });
    expect(transaction.site.delete).toHaveBeenCalledWith({ where: { id: "site-1" } });
  });

  it("rejects site deletion when the confirmation name does not match", async () => {
    const { service, prisma } = createService({
      userFindFirst: jest.fn().mockResolvedValue({
        id: "admin-1", organizationId: "customer-1",
        administeredSite: { id: "site-1", name: "Pending Site", gateways: [] }
      })
    });

    await expect(service.deleteSiteAdmin(operator, "admin-1", "Other Site")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("requires an exact confirmation name without trimming", async () => {
    const { service, prisma } = createService({
      userFindFirst: jest.fn().mockResolvedValue({
        id: "admin-1", organizationId: "customer-1",
        administeredSite: { id: "site-1", name: "Pending Site", gateways: [], floors: [] }
      })
    });

    await expect(service.deleteSiteAdmin(operator, "admin-1", " Pending Site ")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("queues every inventory referenced by a gateway claim or certificate", async () => {
    const { service, transaction } = createService({
      userFindFirst: jest.fn().mockResolvedValue({
        id: "admin-1", organizationId: "customer-1",
        administeredSite: {
          id: "site-1", name: "Pending Site",
          gateways: [{
            id: "gateway-1",
            inventory: { id: "inventory-1" },
            certificates: [{ inventory: { id: "inventory-2", claimedGatewayId: null } }]
          }]
        }
      })
    });

    await service.deleteSiteAdmin(operator, "admin-1", "Pending Site");

    expect(transaction.siteDeletionCleanup.create).toHaveBeenCalledWith({
      data: { siteId: "site-1", inventoryIds: ["inventory-1", "inventory-2"], objectKeys: [] }
    });
  });

  it("rejects a certificate inventory claimed by another gateway", async () => {
    const { service, prisma } = createService({
      userFindFirst: jest.fn().mockResolvedValue({
        id: "admin-1", organizationId: "customer-1",
        administeredSite: {
          id: "site-1", name: "Pending Site", floors: [],
          gateways: [{
            id: "gateway-1", inventory: null,
            certificates: [{ inventory: { id: "inventory-2", claimedGatewayId: "other-gateway" } }]
          }]
        }
      })
    });

    await expect(service.deleteSiteAdmin(operator, "admin-1", "Pending Site")).rejects.toEqual(
      new ConflictException("gateway certificate inventory ownership mismatch")
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("queues floor assets before deleting their database records", async () => {
    const { service, transaction } = createService({
      userFindFirst: jest.fn().mockResolvedValue({
        id: "admin-1", organizationId: "customer-1",
        administeredSite: {
          id: "site-1", name: "Pending Site", gateways: [],
          floors: [{ assets: [{ objectKey: "floors/floor-1/map.png" }] }]
        }
      })
    });

    await service.deleteSiteAdmin(operator, "admin-1", "Pending Site");

    expect(transaction.siteDeletionCleanup.create).toHaveBeenCalledWith({
      data: { siteId: "site-1", inventoryIds: [], objectKeys: ["floors/floor-1/map.png"] }
    });
  });

  it("preserves a customer organization and its other users when another site remains", async () => {
    const { service, transaction } = createService({
      siteCount: jest.fn().mockResolvedValue(2),
      userFindFirst: jest.fn().mockResolvedValue({
        id: "admin-1", organizationId: "customer-1",
        administeredSite: { id: "site-1", name: "Pending Site", gateways: [], floors: [] }
      })
    });

    await service.deleteSiteAdmin(operator, "admin-1", "Pending Site");

    expect(transaction.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "admin-1" } });
    expect(transaction.user.delete).toHaveBeenCalledWith({ where: { id: "admin-1" } });
    expect(transaction.user.deleteMany).not.toHaveBeenCalled();
    expect(transaction.organization.delete).not.toHaveBeenCalled();
  });

  it("does not alter a missing or unassigned admin", async () => {
    const { service, transaction } = createService({ userFindFirst: jest.fn().mockResolvedValue(null) });

    await expect(service.deleteSiteAdmin(operator, "missing-admin", "Pending Site")).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction.site.delete).not.toHaveBeenCalled();
  });

  it("validates reset passwords through PasswordService before opening the write transaction", async () => {
    const { service, prisma } = createService();

    await expect(service.resetPassword(operator, "admin-1", "short")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("maps a reset-password serialization failure to the existing conflict contract", async () => {
    const { service } = createService({
      prismaTransaction: jest.fn().mockRejectedValue({ code: "P2034" })
    });

    await expect(service.resetPassword(operator, "admin-1", "replacement password")).rejects.toEqual(
      new ConflictException("operator site admin transaction conflicted, please retry")
    );
  });

  it("maps a delete serialization failure to the existing conflict contract", async () => {
    const { service } = createService({
      prismaTransaction: jest.fn().mockRejectedValue({ code: "P2034" }),
      userFindFirst: jest.fn().mockResolvedValue({
        id: "admin-1", organizationId: "customer-1",
        administeredSite: { id: "site-1", name: "Pending Site", gateways: [] }
      })
    });

    await expect(service.deleteSiteAdmin(operator, "admin-1", "Pending Site")).rejects.toEqual(
      new ConflictException("operator site admin transaction conflicted, please retry")
    );
  });

  it("maps a PostgreSQL raw-query serialization failure to the conflict contract", async () => {
    const { service } = createService({
      prismaTransaction: jest.fn().mockRejectedValue({ code: "P2010", meta: { code: "40001" } }),
      userFindFirst: jest.fn().mockResolvedValue({
        id: "admin-1", organizationId: "customer-1",
        administeredSite: { id: "site-1", name: "Pending Site", gateways: [], floors: [] }
      })
    });

    await expect(service.deleteSiteAdmin(operator, "admin-1", "Pending Site")).rejects.toEqual(
      new ConflictException("operator site admin transaction conflicted, please retry")
    );
  });

  it("keeps non-Prisma reset and delete errors unchanged", async () => {
    const resetError = new Error("reset dependency failed");
    const deleteError = new Error("delete dependency failed");
    const resetService = createService({ prismaTransaction: jest.fn().mockRejectedValue(resetError) }).service;
    const deleteService = createService({
      prismaTransaction: jest.fn().mockRejectedValue(deleteError),
      userFindFirst: jest.fn().mockResolvedValue({
        id: "admin-1", organizationId: "customer-1",
        administeredSite: { id: "site-1", name: "Pending Site", gateways: [] }
      })
    }).service;

    await expect(resetService.resetPassword(operator, "admin-1", "replacement password")).rejects.toBe(resetError);
    await expect(deleteService.deleteSiteAdmin(operator, "admin-1", "Pending Site")).rejects.toBe(deleteError);
  });

  it("returns the shared installed status for a site with address, tariff, and floors", async () => {
    const { service } = createService({
      siteFindMany: jest.fn().mockResolvedValue([{
        id: "site-installed",
        name: "Installed Site",
        address: "Seoul",
        tariffKwhRate: "160.00",
        organization: { name: "Customer One" },
        admin: null,
        _count: { floors: 1 }
      }])
    });

    await expect(service.list(operator)).resolves.toEqual([{
      siteId: "site-installed",
      customerName: "Customer One",
      siteName: "Installed Site",
      installationStatus: "installed",
      admin: null
    }]);
  });

  it("requires a session-authenticated operator role for every operator site-admin endpoint", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OperatorSiteAdminsController)).toEqual(
      expect.arrayContaining([SessionAuthGuard, RolesGuard])
    );
    expect(Reflect.getMetadata(rolesMetadataKey, OperatorSiteAdminsController)).toEqual(["operator"]);
  });
});

function createService(overrides: Record<string, jest.Mock> = {}) {
  const transaction = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([{ id: "admin-1" }]),
    organization: {
      create: jest.fn().mockResolvedValue({ id: "customer-1", name: "Customer One" }),
      delete: overrides.organizationDelete ?? jest.fn()
    },
    site: {
      create: jest.fn().mockResolvedValue({ id: "site-1", name: "Pending Site", address: null, tariffKwhRate: null, floors: [] }),
      update: jest.fn(),
      delete: overrides.siteDelete ?? jest.fn(),
      count: overrides.siteCount ?? jest.fn().mockResolvedValue(1)
    },
    user: {
      create: jest.fn().mockResolvedValue({
        id: "admin-1", loginId: "customer_admin", name: "Customer Admin", status: "active", updatedAt: new Date("2026-08-27T00:00:00.000Z")
      }),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: overrides.userDeleteMany ?? jest.fn().mockResolvedValue({ count: 0 })
    },
    session: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: overrides.sessionDeleteMany ?? jest.fn().mockResolvedValue({ count: 0 })
    },
    invitation: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    gatewayInventory: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    siteDeletionCleanup: {
      create: jest.fn().mockResolvedValue({ id: "cleanup-1" })
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) }
  };
  if (overrides.userCreate) transaction.user.create = overrides.userCreate;
  if (overrides.userFindFirst) transaction.user.findFirst = overrides.userFindFirst;
  if (overrides.siteUpdate) transaction.site.update = overrides.siteUpdate;
  if (overrides.userUpdate) transaction.user.update = overrides.userUpdate;
  if (overrides.sessionUpdateMany) transaction.session.updateMany = overrides.sessionUpdateMany;

  const prisma = {
    $transaction: overrides.prismaTransaction
      ?? jest.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    site: { findMany: overrides.siteFindMany ?? jest.fn() },
    user: { findFirst: overrides.userFindFirst ?? jest.fn() }
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: "audit-1" }) };
  const deletionCleanup = {
    processNow: overrides.processNow ?? jest.fn().mockResolvedValue({ status: "completed" })
  };
  const service = new OperatorSiteAdminsService(
    prisma as never,
    new PasswordService(),
    audit as never,
    deletionCleanup as never
  );
  return { service, prisma, transaction, audit };
}
