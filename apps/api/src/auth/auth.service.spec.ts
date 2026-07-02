import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "./auth.service";

describe("AuthService", () => {
  const now = new Date("2026-07-02T00:00:00.000Z");

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("creates a user from a valid invitation and marks the invitation accepted", async () => {
    const invitation = {
      id: "invitation-1",
      organizationId: "organization-1",
      siteId: "site-1",
      email: "admin@example.com",
      role: "admin",
      expiresAt: new Date("2026-07-09T00:00:00.000Z"),
      acceptedAt: null
    };
    const createdUser = {
      id: "user-1",
      organizationId: invitation.organizationId,
      email: invitation.email,
      name: "관리자",
      role: invitation.role,
      status: "active"
    };
    const prisma: {
      invitation: {
        findUnique: jest.Mock;
        update: jest.Mock;
      };
      user: {
        findUnique: jest.Mock;
        create: jest.Mock;
      };
      $transaction: jest.Mock;
    } = {
      invitation: {
        findUnique: jest.fn().mockResolvedValue(invitation),
        update: jest.fn().mockResolvedValue({ ...invitation, acceptedAt: now })
      },
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(createdUser)
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma))
    };
    const service = new AuthService(prisma as unknown as PrismaService);
    const token = "plain-invitation-token";

    const result = await service.signup({
      token,
      email: "admin@example.com",
      name: "관리자",
      password: "correct horse battery staple"
    });

    expect(result.user).toEqual(createdUser);
    expect(prisma.invitation.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: service.hashToken(token) }
    });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: invitation.organizationId,
        email: invitation.email,
        name: "관리자",
        role: invitation.role,
        status: "active",
        passwordHash: expect.any(String)
      })
    });
    expect(prisma.invitation.update).toHaveBeenCalledWith({
      where: { id: invitation.id },
      data: { acceptedAt: now }
    });
  });

  it("rejects signup when the invitation email does not match", async () => {
    const prisma = {
      invitation: {
        findUnique: jest.fn().mockResolvedValue({
          id: "invitation-1",
          organizationId: "organization-1",
          email: "admin@example.com",
          role: "admin",
          expiresAt: new Date("2026-07-09T00:00:00.000Z"),
          acceptedAt: null
        })
      },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn()
    };
    const service = new AuthService(prisma as unknown as PrismaService);

    await expect(
      service.signup({
        token: "plain-invitation-token",
        email: "other@example.com",
        name: "관리자",
        password: "correct horse battery staple"
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("logs in with email and password and creates a longer session when rememberMe is true", async () => {
    const prisma = {
      user: {
        findUnique: jest.fn()
      },
      session: {
        create: jest.fn()
      }
    };
    const service = new AuthService(prisma as unknown as PrismaService);
    const passwordHash = await service.hashPassword("correct horse battery staple");
    const user = {
      id: "user-1",
      organizationId: "organization-1",
      email: "admin@example.com",
      name: "관리자",
      role: "admin",
      status: "active",
      passwordHash
    };
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.session.create.mockImplementation(async ({ data }) => ({
      id: "session-1",
      ...data
    }));

    const result = await service.login({
      email: "admin@example.com",
      password: "correct horse battery staple",
      rememberMe: true,
      userAgent: "vitest",
      ipAddress: "127.0.0.1"
    });

    expect(result.user).toEqual({
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status
    });
    expect(result.sessionToken).toEqual(expect.any(String));
    expect(result.expiresAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(prisma.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: user.id,
        tokenHash: service.hashToken(result.sessionToken),
        rememberMe: true,
        userAgent: "vitest",
        ipAddress: "127.0.0.1",
        expiresAt: new Date("2026-08-01T00:00:00.000Z")
      })
    });
  });

  it("rejects login with the same error for unknown email or wrong password", async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null)
      },
      session: {
        create: jest.fn()
      }
    };
    const service = new AuthService(prisma as unknown as PrismaService);

    await expect(
      service.login({
        email: "missing@example.com",
        password: "wrong-password",
        rememberMe: false
      })
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.session.create).not.toHaveBeenCalled();
  });
});
