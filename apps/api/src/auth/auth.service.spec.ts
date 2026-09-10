import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";

function createAuthService(
  prisma: PrismaService,
  passwords: PasswordService = new PasswordService(),
  audit: AuditService = new AuditService(prisma)
) {
  return new AuthService(prisma, passwords, audit);
}

describe("AuthService", () => {
  const now = new Date("2026-08-27T00:00:00.000Z");

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it.each([true, false])("exposes mustChangePassword=%s in login and session public users without secrets", async (mustChangePassword) => {
    const stored = {
      id: "viewer-1", organizationId: "org-1", loginId: "viewer_01", name: "Viewer", email: null,
      role: "viewer", status: "active", organization: { type: "customer" },
      passwordHash: "secret-hash", mustChangePassword
    };
    const { prisma } = createLoginPrisma(stored);
    const service = createAuthService({ ...prisma, session: { findUnique: jest.fn().mockResolvedValue({
      user: stored, revokedAt: null, expiresAt: new Date("2026-09-01")
    }) } } as unknown as PrismaService, { verify: jest.fn().mockResolvedValue(true) } as unknown as PasswordService);
    const login = await service.login({ loginId: stored.loginId, password: "temporary password", rememberMe: false });
    const sessionUser = await service.getUserBySessionToken(login.sessionToken);
    for (const publicUser of [login.user, sessionUser]) {
      expect(publicUser).toMatchObject({ mustChangePassword });
      expect(publicUser).not.toHaveProperty("passwordHash");
      expect(publicUser).not.toHaveProperty("email");
    }
  });

  it("keeps disabled-account login errors indistinguishable from invalid credentials", async () => {
    const { prisma, transaction } = createLoginPrisma({ id: "disabled", status: "disabled", passwordHash: "hash", mustChangePassword: true });
    const service = createAuthService(prisma as unknown as PrismaService);
    await expect(service.login({ loginId: "disabled", password: "temporary password", rememberMe: false }))
      .rejects.toEqual(new UnauthorizedException("Invalid login id or password"));
    expect(transaction.session.create).not.toHaveBeenCalled();
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
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ id: "site-1" }]),
      invitation: { findUnique: jest.fn().mockResolvedValue(invitation), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      site: { findUnique: jest.fn().mockResolvedValue({ id: "site-1", organizationId: "customer-org-1" }) },
      user: {
        count: jest.fn().mockResolvedValue(0),
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
    const service = createAuthService(
      prisma as unknown as PrismaService,
      passwordService as unknown as PasswordService
    );

    await service.signup({
      token: "viewer-token",
      loginId: " VIEWER_01 ",
      email: invitation.email,
      name: "Viewer",
      password: "correct horse battery staple"
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { loginId: "viewer_01" } }));
    expect(transaction.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ loginId: "viewer_01", email: invitation.email, role: "viewer" })
    }));
    expect(transaction.siteMembership.create).toHaveBeenCalledWith({ data: { userId: "viewer-1", siteId: "site-1" } });
    expect(transaction.user.count).toHaveBeenCalledWith({ where: {
      role: "viewer", organizationId: "customer-org-1", siteMemberships: { some: { siteId: "site-1" } }
    } });
    expect(transaction.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(transaction.$queryRaw.mock.invocationCallOrder[0]);
    expect(transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(transaction.user.count.mock.invocationCallOrder[0]);
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
    const service = createAuthService(prisma as unknown as PrismaService);

    await expect(service.signup({
      token: "invitation-token",
      loginId: "person_01",
      email: "contact@example.com",
      name: "Person",
      password: "correct horse battery staple"
    } as any)).rejects.toThrow("only viewer invitations support signup");
  });

  it("logs in with a normalized login id", async () => {
    const { prisma, transaction } = createLoginPrisma();
    const passwordService = { verify: jest.fn().mockResolvedValue(true) };
    const service = createAuthService(
      prisma as unknown as PrismaService,
      passwordService as unknown as PasswordService
    );
    transaction.user.findUnique.mockResolvedValue({
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

    expect(transaction.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { loginId: "admin_01" } }));
  });

  it("locks and re-reads the user before password verification and session creation in one transaction", async () => {
    const storedUser = {
      id: "admin-1", organizationId: "organization-1", loginId: "admin_01", email: null, name: "Admin",
      role: "admin", status: "active", organization: { type: "customer" }, passwordHash: "stored-hash"
    };
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: storedUser.id }]),
      user: { findUnique: jest.fn().mockResolvedValue(storedUser) },
      session: { create: jest.fn().mockResolvedValue({ id: "session-1" }) }
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(storedUser) },
      session: { create: jest.fn().mockResolvedValue({ id: "outside-session" }) },
      $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction))
    };
    const passwords = { verify: jest.fn().mockResolvedValue(true) };
    const service = createAuthService(prisma as unknown as PrismaService, passwords as unknown as PasswordService);

    await service.login({ loginId: "ADMIN_01", password: "old password", rememberMe: false });

    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { loginId: "admin_01" } }));
    expect(transaction.session.create).toHaveBeenCalledTimes(1);
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it("keeps exhausted login transaction conflicts on the generic unauthorized contract", async () => {
    const storedUser = {
      id: "admin-1", organizationId: "organization-1", loginId: "admin_01", email: null, name: "Admin",
      role: "admin", status: "active", organization: { type: "customer" }, passwordHash: "stored-hash"
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(storedUser) },
      session: { create: jest.fn().mockResolvedValue({ id: "outside-session" }) },
      $transaction: jest.fn().mockRejectedValue({ code: "P2034" })
    };
    const service = createAuthService(
      prisma as unknown as PrismaService,
      { verify: jest.fn().mockResolvedValue(true) } as unknown as PasswordService
    );

    await expect(service.login({ loginId: "admin_01", password: "old password", rememberMe: false }))
      .rejects.toEqual(new UnauthorizedException("Invalid login id or password"));
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it("uses the same authentication error for an unknown login id", async () => {
    const { prisma, transaction } = createLoginPrisma();
    transaction.$queryRaw.mockResolvedValue([]);
    const service = createAuthService(prisma as unknown as PrismaService);

    await expect(service.login({ loginId: "missing_01", password: "wrong-password", rememberMe: false } as any))
      .rejects.toEqual(new UnauthorizedException("Invalid login id or password"));
    expect(transaction.session.create).not.toHaveBeenCalled();
  });

  it("uses the same authentication error for an unknown login id and a wrong password", async () => {
    const user = {
      id: "admin-1", organizationId: "organization-1", loginId: "admin_01", email: null, name: "Admin",
      role: "admin", status: "active", organization: { type: "customer" }, passwordHash: "stored-hash"
    };
    const missingPrisma = createLoginPrisma();
    missingPrisma.transaction.$queryRaw.mockResolvedValue([]);
    const missing = createAuthService(
      missingPrisma.prisma as unknown as PrismaService,
      { verify: jest.fn() } as unknown as PasswordService
    );
    const wrongPasswordPrisma = createLoginPrisma(user);
    const wrongPassword = createAuthService(
      wrongPasswordPrisma.prisma as unknown as PrismaService,
      { verify: jest.fn().mockResolvedValue(false) } as unknown as PasswordService
    );

    const missingError = await missing.login({ loginId: "missing_01", password: "wrong-password", rememberMe: false }).catch((error: unknown) => error);
    const wrongPasswordError = await wrongPassword.login({ loginId: "admin_01", password: "wrong-password", rememberMe: false }).catch((error: unknown) => error);
    expect(missingError).toEqual(new UnauthorizedException("Invalid login id or password"));
    expect(wrongPasswordError).toEqual(new UnauthorizedException("Invalid login id or password"));
  });

  it("creates a remember-me session with a public login id but no contact email", async () => {
    const { prisma, transaction } = createLoginPrisma();
    const passwords = { verify: jest.fn().mockResolvedValue(true) };
    const service = createAuthService(
      prisma as unknown as PrismaService,
      passwords as unknown as PasswordService
    );
    transaction.user.findUnique.mockResolvedValue({
      id: "admin-1", organizationId: "organization-1", loginId: "admin_01", email: null, name: "Admin",
      role: "admin", status: "active", organization: { type: "customer" }, passwordHash: "stored-hash"
    });

    const result = await service.login({ loginId: "ADMIN_01", password: "correct horse battery staple", rememberMe: true });

    expect(result.user).toMatchObject({ loginId: "admin_01" });
    expect(result.user).not.toHaveProperty("email");
    expect(result.expiresAt.toISOString()).toBe("2026-09-26T00:00:00.000Z");
    expect(transaction.session.create).toHaveBeenCalledWith({ data: expect.objectContaining({ rememberMe: true, expiresAt: new Date("2026-09-26T00:00:00.000Z") }) });
  });

  it("rejects missing, invalid, and cross-organization viewer invitation sites before consuming the invitation", async () => {
    const cases = [
      { label: "missing", siteId: null, site: null },
      { label: "invalid", siteId: "missing-site", site: null },
      { label: "cross-organization", siteId: "foreign-site", site: { id: "foreign-site", organizationId: "customer-org-2" } }
    ];

    for (const fixture of cases) {
      const transaction = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        $queryRaw: jest.fn().mockResolvedValue(fixture.site ? [{ id: fixture.site.id }] : []),
        invitation: { updateMany: jest.fn() },
        site: { findUnique: jest.fn().mockResolvedValue(fixture.site) },
        user: { create: jest.fn() },
        siteMembership: { create: jest.fn() }
      };
      const prisma = {
        invitation: { findUnique: jest.fn().mockResolvedValue({
          id: fixture.label, organizationId: "customer-org-1", siteId: fixture.siteId, email: "viewer@example.com", role: "viewer",
          organization: { type: "customer" }, expiresAt: new Date("2026-09-01T00:00:00.000Z"), acceptedAt: null
        }) },
        user: { findUnique: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction))
      };
      const service = createAuthService(
        prisma as unknown as PrismaService,
        { hash: jest.fn().mockResolvedValue("hash") } as unknown as PasswordService
      );

      await expect(service.signup({ token: "token", loginId: `viewer_${fixture.label}`, email: "viewer@example.com", name: "Viewer", password: "correct horse battery staple" }))
        .rejects.toThrow("viewer invitations require a valid customer site assignment");
      expect(transaction.invitation.updateMany).not.toHaveBeenCalled();
      expect(transaction.user.create).not.toHaveBeenCalled();
      expect(transaction.siteMembership.create).not.toHaveBeenCalled();
    }
  });

  it("rejects a viewer signup when the invitation email does not match", async () => {
    const prisma = {
      invitation: { findUnique: jest.fn().mockResolvedValue({
        id: "invitation-1", organizationId: "customer-org-1", siteId: "site-1", email: "viewer@example.com", role: "viewer",
        organization: { type: "customer" }, expiresAt: new Date("2026-09-01T00:00:00.000Z"), acceptedAt: null
      }) },
      user: { findUnique: jest.fn() }
    };
    const service = createAuthService(prisma as unknown as PrismaService);

    await expect(service.signup({ token: "token", loginId: "viewer_01", email: "other@example.com", name: "Viewer", password: "correct horse battery staple" } as any))
      .rejects.toThrow("Invitation email does not match");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects malformed service inputs with controlled auth errors", async () => {
    const service = createAuthService({} as PrismaService);

    await expect(service.login({ loginId: null, password: "password", rememberMe: false } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.signup({ token: "token", loginId: "viewer_01", email: null, name: "Viewer", password: "password" } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("changes a password, retains the current session, and records non-sensitive audit metadata", async () => {
    const currentToken = "current-token";
    const user = {
      id: "admin-1",
      organizationId: "organization-1",
      organizationType: "customer",
      loginId: "admin_01",
      name: "Admin",
      role: "admin" as const,
      status: "active" as const,
      mustChangePassword: true
    };
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ id: user.id }]),
      user: {
        findUnique: jest.fn().mockResolvedValue({ ...user, organization: { type: "customer" }, passwordHash: "old-hash" }),
        update: jest.fn().mockResolvedValue({ ...user, organization: { type: "customer" }, mustChangePassword: false })
      },
      session: {
        findUnique: jest.fn().mockResolvedValue({ userId: user.id, revokedAt: null, expiresAt: new Date("2026-09-01") }),
        updateMany: jest.fn().mockResolvedValue({ count: 2 })
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) }
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ ...user, passwordHash: "old-hash" }) },
      $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction))
    };
    const passwordService = { verify: jest.fn().mockResolvedValue(true), hash: jest.fn().mockResolvedValue("new-hash") };
    const auditService = { record: jest.fn(async ({ transaction: auditTransaction, ...input }) => auditTransaction.auditLog.create({ data: input })) };
    const service = createAuthService(
      prisma as unknown as PrismaService,
      passwordService as unknown as PasswordService,
      auditService as unknown as AuditService
    );

    const result = await service.changePassword(user, currentToken, {
      currentPassword: "old password",
      newPassword: "new password",
      newPasswordConfirmation: "new password"
    });

    expect(result).toMatchObject({ ok: true, user: { id: user.id, mustChangePassword: false } });
    expect(result).not.toHaveProperty("user.passwordHash");
    expect(transaction.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: user.id }, data: { passwordHash: "new-hash", mustChangePassword: false } }));
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

  it("preserves leading and trailing password whitespace when changing a password", async () => {
    const currentToken = "current-token";
    const currentPassword = "  existing password  ";
    const newPassword = "  replacement password  ";
    const user = { id: "admin-1", organizationId: "organization-1" };
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ id: user.id }]),
      user: {
        findUnique: jest.fn().mockResolvedValue({ ...user, status: "active", passwordHash: "old-hash" }),
        update: jest.fn().mockResolvedValue({ ...user, organization: { type: "customer" }, mustChangePassword: false })
      },
      session: {
        findUnique: jest.fn().mockResolvedValue({ userId: user.id, revokedAt: null, expiresAt: new Date("2026-09-01") }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      auditLog: { create: jest.fn() }
    };
    const prisma = { $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) };
    const passwords = { verify: jest.fn().mockResolvedValue(true), hash: jest.fn().mockResolvedValue("new-hash") };
    const audit = { record: jest.fn() };
    const service = createAuthService(
      prisma as unknown as PrismaService,
      passwords as unknown as PasswordService,
      audit as unknown as AuditService
    );

    await service.changePassword(user, currentToken, {
      currentPassword,
      newPassword,
      newPasswordConfirmation: newPassword
    });

    expect(passwords.verify).toHaveBeenCalledWith(currentPassword, "old-hash");
    expect(passwords.hash).toHaveBeenCalledWith(newPassword);
  });

  it("rejects a password change when confirmation differs", async () => {
    const service = createAuthService({} as PrismaService);
    await expect((service as any).changePassword({ id: "admin-1" }, "current-token", {
      currentPassword: "old password",
      newPassword: "new password",
      newPasswordConfirmation: "different password"
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(["revoked", "expired", "foreign", "missing", "disabled"])("rejects a %s session/account re-read after the password lock", async (reason) => {
    const user = { id: "viewer-1", organizationId: "org-1" };
    const session = {
      userId: reason === "foreign" ? "other-user" : user.id,
      revokedAt: reason === "revoked" ? now : null,
      expiresAt: reason === "expired" ? now : new Date("2026-09-01")
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1), $queryRaw: jest.fn().mockResolvedValue([{ id: user.id }]),
      user: {
        findUnique: jest.fn().mockResolvedValue({ ...user, passwordHash: "hash", status: reason === "disabled" ? "disabled" : "active" }),
        update: jest.fn()
      },
      session: { findUnique: jest.fn().mockResolvedValue(reason === "missing" ? null : session), updateMany: jest.fn().mockResolvedValue({ count: 0 }) }
    };
    const audit = { record: jest.fn() };
    const service = createAuthService({ $transaction: async (callback: (tx: unknown) => unknown) => callback(tx) } as unknown as PrismaService,
      { verify: jest.fn().mockResolvedValue(true), hash: jest.fn().mockResolvedValue("new-hash") } as unknown as PasswordService,
      audit as unknown as AuditService);
    await expect(service.changePassword(user, "current-token", {
      currentPassword: "temporary password", newPassword: "replacement password", newPasswordConfirmation: "replacement password"
    })).rejects.toEqual(new UnauthorizedException("Authentication required"));
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.session.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("rejects using the temporary password again without clearing the requirement", async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1), $queryRaw: jest.fn().mockResolvedValue([{ id: "viewer-1" }]),
      user: { findUnique: jest.fn().mockResolvedValue({ passwordHash: "hash" }), update: jest.fn() },
      session: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }
    };
    const service = createAuthService({ $transaction: async (callback: (tx: unknown) => unknown) => callback(tx) } as unknown as PrismaService,
      { verify: jest.fn().mockResolvedValue(true), hash: jest.fn().mockResolvedValue("hash") } as unknown as PasswordService,
      { record: jest.fn() } as unknown as AuditService);
    await expect(service.changePassword({ id: "viewer-1", organizationId: "org-1" }, "token", {
      currentPassword: "temporary password", newPassword: "temporary password", newPasswordConfirmation: "temporary password"
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});

function createLoginPrisma(storedUser: Record<string, unknown> | null = null) {
  const transaction = {
    $queryRaw: jest.fn().mockResolvedValue(storedUser ? [{ id: storedUser.id }] : [{ id: "admin-1" }]),
    user: { findUnique: jest.fn().mockResolvedValue(storedUser) },
    session: { create: jest.fn().mockResolvedValue({ id: "session-1" }) }
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction))
  };
  return { prisma, transaction };
}
