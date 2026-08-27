import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "./auth.service";

describe("AuthService", () => {
  const now = new Date("2026-08-27T00:00:00.000Z");

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("creates a viewer from an invitation email and separate normalized login id", async () => {
    const invitation = {
      id: "invitation-1",
      organizationId: "customer-org-1",
      siteId: "site-1",
      email: "viewer-contact@example.com",
      role: "viewer",
      organization: { type: "customer" },
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      acceptedAt: null
    };
    const transaction = {
      invitation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      site: { findUnique: jest.fn().mockResolvedValue({ id: "site-1", organizationId: "customer-org-1" }) },
      user: {
        create: jest.fn().mockResolvedValue({
          id: "viewer-1",
          organizationId: "customer-org-1",
          loginId: "viewer_01",
          email: "viewer-contact@example.com",
          name: "Viewer",
          role: "viewer",
          status: "active"
        })
      },
      siteMembership: { create: jest.fn() }
    };
    const prisma = {
      invitation: { findUnique: jest.fn().mockResolvedValue(invitation) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction))
    };
    const passwordService = { hash: jest.fn().mockResolvedValue("scrypt$hash") };
    const service = new (AuthService as any)(prisma as unknown as PrismaService, passwordService);

    await service.signup({
      token: "viewer-token",
      loginId: " VIEWER_01 ",
      email: invitation.email,
      name: "Viewer",
      password: "correct horse battery staple"
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { loginId: "viewer_01" } });
    expect(transaction.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ loginId: "viewer_01", email: invitation.email, role: "viewer" })
    });
    expect(transaction.siteMembership.create).toHaveBeenCalledWith({ data: { userId: "viewer-1", siteId: "site-1" } });
  });

  it.each(["operator", "admin"])("rejects %s invitation signup", async (role) => {
    const prisma = {
      invitation: {
        findUnique: jest.fn().mockResolvedValue({
          id: "invitation-1",
          organizationId: "organization-1",
          email: "contact@example.com",
          role,
          organization: { type: role === "operator" ? "service_provider" : "customer" },
          expiresAt: new Date("2026-09-01T00:00:00.000Z"),
          acceptedAt: null
        })
      },
      user: { findUnique: jest.fn() }
    };
    const service = new AuthService(prisma as unknown as PrismaService);

    await expect(service.signup({
      token: "invitation-token",
      loginId: "person_01",
      email: "contact@example.com",
      name: "Person",
      password: "correct horse battery staple"
    } as any)).rejects.toThrow("only viewer invitations support signup");
  });

  it("logs in with a normalized login id", async () => {
    const prisma = {
      user: { findUnique: jest.fn() },
      session: { create: jest.fn().mockResolvedValue({ id: "session-1" }) }
    };
    const passwordService = { verify: jest.fn().mockResolvedValue(true) };
    const service = new (AuthService as any)(prisma as unknown as PrismaService, passwordService);
    prisma.user.findUnique.mockResolvedValue({
      id: "admin-1",
      organizationId: "organization-1",
      loginId: "admin_01",
      email: null,
      name: "Admin",
      role: "admin",
      status: "active",
      organization: { type: "customer" },
      passwordHash: "scrypt$hash"
    });

    await service.login({ loginId: " ADMIN_01 ", password: "correct horse battery staple", rememberMe: false });

    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { loginId: "admin_01" } }));
  });

  it("uses the same authentication error for an unknown login id", async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      session: { create: jest.fn() }
    };
    const service = new AuthService(prisma as unknown as PrismaService);

    await expect(service.login({ loginId: "missing_01", password: "wrong-password", rememberMe: false } as any))
      .rejects.toEqual(new UnauthorizedException("Invalid login id or password"));
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it("changes a password, retains the current session, and records non-sensitive audit metadata", async () => {
    const currentToken = "current-token";
    const user = {
      id: "admin-1",
      organizationId: "organization-1",
      organizationType: "customer",
      loginId: "admin_01",
      email: null,
      name: "Admin",
      role: "admin" as const,
      status: "active" as const
    };
    const transaction = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ passwordHash: "old-hash" }),
        update: jest.fn().mockResolvedValue({ id: user.id })
      },
      session: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) }
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ ...user, passwordHash: "old-hash" }) },
      $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction))
    };
    const passwordService = { verify: jest.fn().mockResolvedValue(true), hash: jest.fn().mockResolvedValue("new-hash") };
    const auditService = { record: jest.fn(async ({ transaction: auditTransaction, ...input }) => auditTransaction.auditLog.create({ data: input })) };
    const service = new (AuthService as any)(prisma as unknown as PrismaService, passwordService, auditService);

    await service.changePassword(user, currentToken, {
      currentPassword: "old password",
      newPassword: "new password",
      newPasswordConfirmation: "new password"
    });

    expect(transaction.user.update).toHaveBeenCalledWith({ where: { id: user.id }, data: { passwordHash: "new-hash" } });
    expect(transaction.session.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id, revokedAt: null, tokenHash: { not: service.hashToken(currentToken) } },
      data: { revokedAt: now }
    });
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      actorId: user.id,
      action: "auth.password_changed",
      targetType: "User",
      targetId: user.id,
      metadata: expect.not.objectContaining({ password: expect.anything(), currentPassword: expect.anything(), newPassword: expect.anything() }),
      transaction
    }));
  });

  it("rejects a password change when confirmation differs", async () => {
    const service = new AuthService({} as PrismaService);
    await expect((service as any).changePassword({ id: "admin-1" }, "current-token", {
      currentPassword: "old password",
      newPassword: "new password",
      newPasswordConfirmation: "different password"
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});
