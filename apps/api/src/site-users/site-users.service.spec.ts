import "reflect-metadata";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { rolesMetadataKey } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PasswordService } from "../auth/password.service";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { SiteUsersController } from "./site-users.controller";
import { SiteUsersService } from "./site-users.service";

const admin: AuthenticatedUser = {
  id: "admin", organizationId: "org", organizationType: "customer",
  loginId: "admin", name: "관리자", role: "admin", status: "active"
};
const now = new Date("2026-09-10T00:00:00.000Z");
const input = { name: "사용자", loginId: " Member.One ", temporaryPassword: "Temp-pass-123", accessLevel: "control", status: "active" };
const row = {
  id: "member", name: "사용자", loginId: "member.one", status: "active", createdAt: now, updatedAt: now,
  siteMemberships: [{ siteId: "site", accessLevel: "control" }], sessions: [{ createdAt: now }]
};
const update = { name: "수정", loginId: "member.new", accessLevel: "read", status: "active", expectedUpdatedAt: now.toISOString() };

function setup() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1), $queryRaw: jest.fn().mockResolvedValue([{ id: "member" }]),
    user: {
      findMany: jest.fn().mockResolvedValue([row]), findFirst: jest.fn().mockResolvedValue(row),
      count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(row), delete: jest.fn().mockResolvedValue({ id: "member" })
    },
    siteMembership: { create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    session: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
  };
  const prisma = { $transaction: jest.fn().mockImplementation((fn) => fn(tx)) };
  const access = {
    assert: jest.fn().mockResolvedValue({ id: "site", organizationId: "org" }),
    assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site", organizationId: "org" })
  };
  const passwords = new PasswordService();
  const hash = jest.spyOn(passwords, "hash");
  const audit = new AuditService(prisma as unknown as PrismaService);
  const service = new SiteUsersService(prisma as unknown as PrismaService, access as unknown as SiteAccessService, passwords, audit);
  return { tx, prisma, access, passwords, hash, service };
}

describe("SiteUsersController admin guard contract", () => {
  it("requires a session and the admin role on every endpoint", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SiteUsersController)).toEqual([SessionAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(rolesMetadataKey, SiteUsersController)).toEqual(["admin"]);
    expect(Reflect.getMetadata(PATH_METADATA, SiteUsersController)).toBe("sites/:siteId/users");
    for (const method of ["list", "create", "update", "resetPassword", "remove"] as const) {
      expect(typeof SiteUsersController.prototype[method]).toBe("function");
      expect(Reflect.getMetadata(rolesMetadataKey, SiteUsersController.prototype[method])).toBeUndefined();
      const context = {
        getClass: () => SiteUsersController, getHandler: () => SiteUsersController.prototype[method],
        switchToHttp: () => ({ getRequest: () => ({ user: { ...admin, role: "viewer" } }) })
      };
      expect(() => new RolesGuard(new Reflector()).canActivate(context as any)).toThrow(ForbiddenException);
      try {
        new RolesGuard(new Reflector()).canActivate(context as any);
      } catch (error) {
        expect((error as ForbiddenException).getResponse()).toMatchObject({ code: "SITE_CAPABILITY_DENIED" });
      }
    }
  });

  it("delegates site, target and body without returning extra fields", async () => {
    const service = Object.fromEntries(["list", "create", "update", "resetPassword", "remove"].map((name) => [name, jest.fn().mockResolvedValue({ ok: true })]));
    const controller = new SiteUsersController(service as any);
    await expect(controller.list(admin, "site")).resolves.toEqual({ ok: true });
    await controller.create(admin, "site", input);
    await controller.update(admin, "site", "member", update);
    await controller.resetPassword(admin, "site", "member", { temporaryPassword: input.temporaryPassword });
    await controller.remove(admin, "site", "member", { confirmationLoginId: row.loginId });
    expect(service.create).toHaveBeenCalledWith(admin, "site", input);
    expect(service.update).toHaveBeenCalledWith(admin, "site", "member", update);
    expect(service.resetPassword).toHaveBeenCalledWith(admin, "site", "member", { temporaryPassword: input.temporaryPassword });
    expect(service.remove).toHaveBeenCalledWith(admin, "site", "member", { confirmationLoginId: row.loginId });
  });
});

describe("SiteUsersService", () => {
  it("lists only same-site viewers with safe projection, stable order and latest session timestamp", async () => {
    const { service, tx } = setup();
    expect(await service.list(admin, "site")).toEqual({ users: [{
      id: row.id, name: row.name, loginId: row.loginId, status: row.status, accessLevel: "control",
      createdAt: now, updatedAt: now, lastLoginAt: now
    }], count: 1, limit: 100 });
    const query = tx.user.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({ role: "viewer", organizationId: "org", siteMemberships: { some: { siteId: "site" } } });
    expect(query.where.status).toBeUndefined();
    expect(query.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(query.select.passwordHash).toBeUndefined();
    expect(query.select.sessions).toEqual({ select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 });
    expect(query.select.siteMemberships.where).toEqual({ siteId: "site" });
  });

  it("returns null lastLoginAt for a user without sessions", async () => {
    const { service, tx } = setup();
    tx.user.findMany.mockResolvedValue([{ ...row, sessions: [] }] as any);
    expect((await service.list(admin, "site")).users[0].lastLoginAt).toBeNull();
  });

  it.each(["viewer", "operator"] as const)("rejects %s even if service is called without controller", async (role) => {
    const { service, prisma } = setup();
    await expect(service.list({ ...admin, role }, "site")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.create({ ...admin, role }, "site", input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("normalizes login ID, hashes the temporary password and sets forced change, without exposing secrets", async () => {
    const { service, tx, passwords } = setup();
    const result = await service.create(admin, "site", input);
    const data = tx.user.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ loginId: "member.one", role: "viewer", organizationId: "org", mustChangePassword: true, status: "active" });
    expect(await passwords.verify(input.temporaryPassword, data.passwordHash)).toBe(true);
    expect(tx.user.create.mock.calls[0][0].select.passwordHash).toBeUndefined();
    expect(tx.siteMembership.create).toHaveBeenCalledWith(expect.objectContaining({ data: { userId: "member", siteId: "site", accessLevel: "control" } }));
    for (const value of [result, tx.auditLog.create.mock.calls]) {
      expect(JSON.stringify(value)).not.toContain(input.temporaryPassword);
      expect(JSON.stringify(value)).not.toContain(data.passwordHash);
    }
  });

  it("waits for Site authorization/lock before counting active and disabled viewers", async () => {
    const { service, tx, access, prisma } = setup();
    let release!: (value: any) => void;
    access.assertManageInTransaction.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = service.create(admin, "site", input);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(tx.user.count).not.toHaveBeenCalled();
    release({ id: "site", organizationId: "org" });
    await pending;
    expect(tx.user.count.mock.calls[0][0].where).toMatchObject({ role: "viewer", siteMemberships: { some: { siteId: "site" } } });
    expect(tx.user.count.mock.calls[0][0].where.status).toBeUndefined();
    expect(prisma.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });

  it("rejects the 101st user before writing any account data", async () => {
    const { service, tx } = setup();
    tx.user.count.mockResolvedValue(100);
    await expect(service.create(admin, "site", input)).rejects.toMatchObject({ response: { code: "USER_LIMIT_REACHED" } });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    null, [], { ...input, name: " " }, { ...input, loginId: "bad id" },
    { ...input, accessLevel: "manage" }, { ...input, status: "deleted" },
    { ...input, temporaryPassword: "short" }, { ...input, role: "admin" },
    { ...input, temporaryPassword: "a".repeat(1025) }
  ])("rejects invalid create payload without writes: %j", async (payload) => {
    const { service, tx } = setup();
    await expect(service.create(admin, "site", payload)).rejects.toMatchObject({ response: { code: "INVALID_INPUT" } });
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it("maps unique login conflicts and bounded transaction conflicts without leaking DB details", async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValueOnce({ code: "P2002", message: input.temporaryPassword });
    await expect(service.create(admin, "site", input)).rejects.toMatchObject({ response: { code: "LOGIN_ID_ALREADY_EXISTS" } });
    prisma.$transaction.mockRejectedValue({ code: "P2034" });
    await expect(service.create(admin, "site", input)).rejects.toMatchObject({ response: { code: "SITE_USER_CHANGED" } });
    expect(prisma.$transaction.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("updates profile and access after Site then User lock, without changing a password", async () => {
    const { service, tx, access } = setup();
    await service.update(admin, "site", "member", update);
    expect(access.assertManageInTransaction.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.user.findFirst.mock.invocationCallOrder[0]);
    const query = tx.user.findFirst.mock.calls[0][0];
    expect(query.where).toMatchObject({ id: "member", role: "viewer", organizationId: "org", siteMemberships: { some: { siteId: "site" } } });
    expect(query.select.passwordHash).toBeUndefined();
    expect(tx.user.update.mock.calls[0][0].data).toMatchObject({ name: "수정", loginId: "member.new", status: "active" });
    expect(tx.user.update.mock.calls[0][0].data.passwordHash).toBeUndefined();
    expect(tx.siteMembership.update).toHaveBeenCalledWith(expect.objectContaining({ data: { accessLevel: "read" } }));
  });

  it.each(["update", "resetPassword", "remove"] as const)("%s rejects targets outside the site/viewer scope", async (method) => {
    const { service, tx } = setup();
    tx.user.findFirst.mockResolvedValue(null as any);
    const body = method === "update" ? update : method === "resetPassword" ? { temporaryPassword: input.temporaryPassword } : { confirmationLoginId: row.loginId };
    await expect(service[method](admin, "site", "other", body)).rejects.toMatchObject({ response: { code: "SITE_USER_NOT_FOUND" } });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("rejects stale or malformed expectedUpdatedAt without mutations", async () => {
    const { service, tx } = setup();
    await expect(service.update(admin, "site", "member", { ...update, expectedUpdatedAt: "2026-09-09T00:00:00.000Z" })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.update(admin, "site", "member", { ...update, expectedUpdatedAt: "yesterday" })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("disables and revokes every live session in the same transaction", async () => {
    const { service, tx } = setup();
    await service.update(admin, "site", "member", { ...update, status: "disabled" });
    expect(tx.session.updateMany).toHaveBeenCalledWith({ where: { userId: "member", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });

  it("reactivates without revoking again or resetting the existing password", async () => {
    const { service, tx, hash } = setup();
    tx.user.findFirst.mockResolvedValue({ ...row, status: "disabled" });
    await service.update(admin, "site", "member", update);
    expect(hash).not.toHaveBeenCalled();
    expect(tx.user.update.mock.calls[0][0].data.passwordHash).toBeUndefined();
    expect(tx.user.update.mock.calls[0][0].data.mustChangePassword).toBeUndefined();
    expect(tx.session.updateMany).not.toHaveBeenCalled();
  });

  it("resets a password, forces change and revokes sessions without returning password fields", async () => {
    const { service, tx, passwords } = setup();
    expect(await service.resetPassword(admin, "site", "member", { temporaryPassword: "New-temp-123" })).toEqual({ ok: true });
    const data = tx.user.update.mock.calls[0][0].data;
    expect(await passwords.verify("New-temp-123", data.passwordHash)).toBe(true);
    expect(data.mustChangePassword).toBe(true);
    expect(tx.session.updateMany).toHaveBeenCalled();
    expect(tx.user.update.mock.calls[0][0].select).toEqual({ id: true });
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toMatch(/New-temp-123|scrypt\$/);
  });

  it("requires exact current login ID confirmation for permanent deletion", async () => {
    const { service, tx } = setup();
    await expect(service.remove(admin, "site", "member", { confirmationLoginId: "MEMBER.ONE" })).rejects.toMatchObject({ response: { code: "INVALID_INPUT" } });
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("deletes the account and anonymizes audits while deletion audit omits target PII", async () => {
    const { service, tx } = setup();
    expect(await service.remove(admin, "site", "member", { confirmationLoginId: row.loginId })).toEqual({ ok: true });
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: "member" }, select: { id: true } });
    expect(tx.auditLog.updateMany).toHaveBeenCalled();
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ actorId: "admin", action: "site_user.deleted", targetType: "Site", targetId: "site" });
    expect(JSON.stringify(audit)).not.toContain(row.id);
    expect(JSON.stringify(audit)).not.toContain(row.name);
    expect(JSON.stringify(audit)).not.toContain(row.loginId);
  });

  it("propagates audit failure so the transaction rolls back, never accepting a partial write", async () => {
    const { service, tx } = setup();
    tx.auditLog.create.mockRejectedValue(new Error("audit unavailable"));
    await expect(service.create(admin, "site", input)).rejects.toThrow("site user operation failed");
  });
});
