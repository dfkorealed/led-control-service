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

  it("disables an assigned admin by unassigning the site before status update and revoking sessions", async () => {
    const order: string[] = [];
    const { service, transaction } = createService({
      userFindFirst: jest.fn().mockResolvedValue({
        id: "admin-1",
        organizationId: "customer-1",
        administeredSite: { id: "site-1" }
      }),
      siteUpdate: jest.fn().mockImplementation(async () => { order.push("unassign"); }),
      userUpdate: jest.fn().mockImplementation(async () => { order.push("disable"); }),
      sessionUpdateMany: jest.fn().mockImplementation(async () => { order.push("revoke"); return { count: 2 }; })
    });

    await expect(service.disable(operator, "admin-1")).resolves.toEqual({ ok: true });

    expect(order).toEqual(["unassign", "disable", "revoke"]);
    expect(transaction.site.update).toHaveBeenCalledWith({ where: { id: "site-1" }, data: { adminUserId: null } });
  });

  it("does not alter a missing or unassigned admin", async () => {
    const { service, transaction } = createService({ userFindFirst: jest.fn().mockResolvedValue(null) });

    await expect(service.disable(operator, "missing-admin")).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction.site.update).not.toHaveBeenCalled();
    expect(transaction.user.update).not.toHaveBeenCalled();
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

  it("maps a disable serialization failure to the existing conflict contract", async () => {
    const { service } = createService({
      prismaTransaction: jest.fn().mockRejectedValue({ code: "P2034" })
    });

    await expect(service.disable(operator, "admin-1")).rejects.toEqual(
      new ConflictException("operator site admin transaction conflicted, please retry")
    );
  });

  it("keeps non-Prisma reset and disable errors unchanged", async () => {
    const resetError = new Error("reset dependency failed");
    const disableError = new Error("disable dependency failed");
    const resetService = createService({ prismaTransaction: jest.fn().mockRejectedValue(resetError) }).service;
    const disableService = createService({ prismaTransaction: jest.fn().mockRejectedValue(disableError) }).service;

    await expect(resetService.resetPassword(operator, "admin-1", "replacement password")).rejects.toBe(resetError);
    await expect(disableService.disable(operator, "admin-1")).rejects.toBe(disableError);
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
    organization: { create: jest.fn().mockResolvedValue({ id: "customer-1", name: "Customer One" }) },
    site: { create: jest.fn().mockResolvedValue({ id: "site-1", name: "Pending Site", address: null, tariffKwhRate: null, floors: [] }), update: jest.fn() },
    user: {
      create: jest.fn().mockResolvedValue({
        id: "admin-1", loginId: "customer_admin", name: "Customer Admin", status: "active", updatedAt: new Date("2026-08-27T00:00:00.000Z")
      }),
      findFirst: jest.fn(),
      update: jest.fn()
    },
    session: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
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
    site: { findMany: overrides.siteFindMany ?? jest.fn() }
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: "audit-1" }) };
  const service = new OperatorSiteAdminsService(prisma as never, new PasswordService(), audit as never);
  return { service, prisma, transaction, audit };
}
