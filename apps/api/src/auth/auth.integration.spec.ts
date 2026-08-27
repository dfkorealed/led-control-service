import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("AuthService PostgreSQL viewer signup integration", () => {
  let prisma: PrismaService;
  let competingPrisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    competingPrisma = new PrismaService();
    await prisma.$connect();
    await competingPrisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await competingPrisma.$disconnect();
  });

  async function createViewerInvitation() {
    const organizationId = randomUUID();
    const siteId = randomUUID();
    const email = `viewer-${siteId}@example.com`;
    const rawToken = randomUUID();
    const service = new AuthService(prisma);
    await prisma.organization.create({ data: { id: organizationId, name: `Customer ${siteId.slice(0, 8)}`, type: "customer" } });
    await prisma.site.create({
      data: { id: siteId, organizationId, name: "Customer site", address: "Seoul", tariffKwhRate: "123.45" }
    });
    const invitation = await prisma.invitation.create({
      data: {
        organizationId,
        siteId,
        email,
        role: "viewer",
        tokenHash: service.hashToken(rawToken),
        expiresAt: new Date("2026-09-01T00:00:00.000Z")
      }
    });
    return { organizationId, siteId, email, rawToken, invitation };
  }

  it("stores loginId separately from the invitation contact email and grants viewer membership", async () => {
    const { siteId, email, rawToken, invitation } = await createViewerInvitation();
    const service = new AuthService(prisma);

    const result = await service.signup({
      token: rawToken,
      loginId: `viewer_${siteId.slice(0, 8)}`,
      email,
      name: "Viewer Member",
      password: "correct horse battery staple"
    });

    expect(result.user).toMatchObject({ loginId: `viewer_${siteId.slice(0, 8)}`, role: "viewer" });
    expect(result.user).not.toHaveProperty("email");
    await expect(prisma.siteMembership.findFirstOrThrow({ where: { userId: result.user.id, siteId } })).resolves.toBeTruthy();
    await expect(prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).resolves.toMatchObject({ acceptedAt: expect.any(Date) });
  });

  it("rolls back invitation consumption when a concurrent transaction wins the login id after prechecks", async () => {
    const { organizationId, siteId, email, rawToken, invitation } = await createViewerInvitation();
    const loginId = `viewer_${siteId.slice(0, 8)}`;
    let injected = false;
    const racingPrisma = prisma.$extends({
      query: {
        user: {
          async findUnique({ args, query }) {
            const result = await query(args);
            if (!injected && !result && args.where?.loginId === loginId) {
              injected = true;
              await competingPrisma.user.create({
                data: {
                  organizationId,
                  loginId,
                  email: `winner-${siteId}@example.com`,
                  name: "Concurrent Winner",
                  passwordHash: "scrypt$hash",
                  role: "viewer",
                  status: "active"
                }
              });
            }
            return result;
          }
        }
      }
    });
    const service = new AuthService(racingPrisma as unknown as PrismaService);

    await expect(service.signup({
      token: rawToken,
      loginId,
      email,
      name: "Race Loser",
      password: "correct horse battery staple"
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(injected).toBe(true);
    await expect(prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).resolves.toMatchObject({ acceptedAt: null });
    await expect(prisma.siteMembership.count({ where: { siteId } })).resolves.toBe(0);
    await expect(prisma.user.findUnique({ where: { loginId } })).resolves.toMatchObject({ name: "Concurrent Winner" });
  });

  it("changes a password without revoking the current session and revokes every other session", async () => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const loginId = `admin_${userId.slice(0, 8)}`;
    const passwords = new PasswordService();
    const oldPassword = "  old password for integration  ";
    const newPassword = "  new password for integration  ";
    await prisma.organization.create({ data: { id: organizationId, name: `Password ${userId}`, type: "customer" } });
    await prisma.user.create({
      data: {
        id: userId,
        organizationId,
        loginId,
        email: null,
        name: "Password Admin",
        passwordHash: await passwords.hash(oldPassword),
        role: "admin",
        status: "active"
      }
    });
    const service = new AuthService(prisma);
    const current = await service.login({ loginId, password: oldPassword, rememberMe: false });
    const other = await service.login({ loginId, password: oldPassword, rememberMe: true });

    await service.changePassword(current.user, current.sessionToken, {
      currentPassword: oldPassword,
      newPassword,
      newPasswordConfirmation: newPassword
    });

    await expect(service.login({ loginId, password: oldPassword, rememberMe: false })).rejects.toEqual(
      new UnauthorizedException("Invalid login id or password")
    );
    await expect(service.login({ loginId, password: newPassword, rememberMe: false })).resolves.toMatchObject({ user: { loginId } });
    await expect(service.getUserBySessionToken(current.sessionToken)).resolves.toMatchObject({ id: userId, loginId });
    await expect(prisma.session.findUniqueOrThrow({ where: { tokenHash: service.hashToken(other.sessionToken) } })).resolves.toMatchObject({ revokedAt: expect.any(Date) });
    await expect(prisma.session.findUniqueOrThrow({ where: { tokenHash: service.hashToken(current.sessionToken) } })).resolves.toMatchObject({ revokedAt: null });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actorId: userId, action: "auth.password_changed" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/password|old password|new password/i);
  });

  it("leaves passwords, sessions, and audit logs untouched when the current password is wrong", async () => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const loginId = `wrong_${userId.slice(0, 8)}`;
    const passwords = new PasswordService();
    const password = "valid password for integration";
    await prisma.organization.create({ data: { id: organizationId, name: `Wrong ${userId}`, type: "customer" } });
    const user = await prisma.user.create({
      data: { id: userId, organizationId, loginId, email: null, name: "Wrong Password", passwordHash: await passwords.hash(password), role: "admin", status: "active" }
    });
    const service = new AuthService(prisma);
    const current = await service.login({ loginId, password, rememberMe: false });
    const other = await service.login({ loginId, password, rememberMe: false });
    const auditsBefore = await prisma.auditLog.count({ where: { actorId: userId, action: "auth.password_changed" } });

    await expect(service.changePassword(current.user, current.sessionToken, {
      currentPassword: "not the current password",
      newPassword: "new password for integration",
      newPasswordConfirmation: "new password for integration"
    })).rejects.toEqual(new UnauthorizedException("Current password is incorrect"));

    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({ passwordHash: user.passwordHash });
    await expect(prisma.session.findUniqueOrThrow({ where: { tokenHash: service.hashToken(current.sessionToken) } })).resolves.toMatchObject({ revokedAt: null });
    await expect(prisma.session.findUniqueOrThrow({ where: { tokenHash: service.hashToken(other.sessionToken) } })).resolves.toMatchObject({ revokedAt: null });
    await expect(prisma.auditLog.count({ where: { actorId: userId, action: "auth.password_changed" } })).resolves.toBe(auditsBefore);
  });
});
