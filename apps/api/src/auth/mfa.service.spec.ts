import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuthChallengeStore } from "./auth-challenge.store";
import { MfaCryptoService } from "./mfa-crypto.service";
import { MfaService } from "./mfa.service";
import { LoginRateLimitService } from "./login-rate-limit.service";
import { PasswordService } from "./password.service";
import { TotpService } from "./totp.service";

const admin = {
  id: "admin-1", organizationId: "org-1", organizationType: "customer" as const, loginId: "admin_01",
  name: "Admin", role: "admin" as const, status: "active" as const, mustChangePassword: false
};

describe("MfaService", () => {
  function fixture() {
    const currentSession = {
      id: "session-old", userId: admin.id, familyId: "family-1", tokenHash: "old-hash", rememberMe: true, userAgent: "browser",
      ipAddress: "203.0.113.7", expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null
    };
    const storedUser = {
      ...admin, organization: { type: "customer" }, passwordHash: "password-hash", updatedAt: new Date("2026-09-12T00:00:00Z"),
      mfa: null as null | { secretCiphertext: string; recoveryCodeHashes: string[]; lastUsedTotpCounter: number }
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: admin.id }]),
      user: { findUnique: jest.fn().mockResolvedValue(storedUser) },
      userMfa: { create: jest.fn(), delete: jest.fn(), update: jest.fn() },
      session: {
        findUnique: jest.fn().mockResolvedValue(currentSession), updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        create: jest.fn().mockResolvedValue({ id: "session-new" })
      },
      auditLog: { create: jest.fn() }
    };
    const prisma = {
      userMfa: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    };
    const challenges = {
      create: jest.fn().mockResolvedValue({ token: "challenge", expiresAt: new Date("2026-09-12T00:10:00Z") }),
      take: jest.fn(), delete: jest.fn()
    };
    const crypto = { encrypt: jest.fn((value: string) => `enc:${value}`), decrypt: jest.fn((value: string) => value.slice(4)) };
    const totp = {
      generateSecret: jest.fn(() => "BASE32SECRET"), buildUri: jest.fn(() => "otpauth://uri"),
      verify: jest.fn().mockReturnValue(true), matchingCounter: jest.fn().mockReturnValue(100)
    };
    const passwords = { verify: jest.fn().mockResolvedValue(true) };
    const audit = { record: jest.fn().mockResolvedValue({ id: "audit" }) };
    const rateLimit = { consumeMfaCompletion: jest.fn(), resetAfterSuccess: jest.fn() };
    const service = new MfaService(
      prisma as unknown as PrismaService,
      passwords as unknown as PasswordService,
      audit as unknown as AuditService,
      challenges as unknown as AuthChallengeStore,
      crypto as unknown as MfaCryptoService,
      totp as unknown as TotpService,
      rateLimit as unknown as LoginRateLimitService
    );
    jest.spyOn(service as any, "hashToken").mockReturnValue("old-hash");
    return { service, prisma, tx, storedUser, currentSession, challenges, crypto, totp, passwords, audit, rateLimit };
  }

  it.each(["viewer", "disabled"])("allows only active operator/admin enrollment, rejecting %s", async (kind) => {
    const { service } = fixture();
    const user = kind === "viewer" ? { ...admin, role: "viewer" as const } : { ...admin, status: "disabled" as const };
    await expect(service.startEnrollment(user, "current-token", "203.0.113.7", "browser")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("starts an encrypted, expiring enrollment and returns the secret only for initial setup", async () => {
    const { service, challenges, crypto } = fixture();
    await expect(service.startEnrollment(admin, "current-token", "203.0.113.7", "browser")).resolves.toEqual({
      enrollmentToken: "challenge", secret: "BASE32SECRET", otpauthUri: "otpauth://uri", expiresAt: new Date("2026-09-12T00:10:00Z")
    });
    expect(challenges.create).toHaveBeenCalledWith("enrollment", {
      userId: admin.id, secretCiphertext: "enc:BASE32SECRET", sessionTokenHash: "old-hash",
      ipAddress: "203.0.113.7", userAgent: "browser"
    }, 600);
    expect(crypto.encrypt).toHaveBeenCalledWith("BASE32SECRET");
  });

  it("creates a password-verified login challenge bound to auth version, IP, agent and remember-me", async () => {
    const { service, challenges, storedUser } = fixture();
    await expect(service.createLoginChallenge(storedUser, {
      rememberMe: true, ipAddress: "203.0.113.7", userAgent: "browser"
    })).resolves.toEqual({ mfaRequired: true, challengeToken: "challenge", expiresAt: new Date("2026-09-12T00:10:00Z") });
    expect(challenges.create).toHaveBeenCalledWith("login", {
      userId: admin.id,
      userUpdatedAt: storedUser.updatedAt.toISOString(),
      rememberMe: true,
      ipAddress: "203.0.113.7",
      userAgent: "browser"
    }, 300);
  });

  it("confirms enrollment, stores only hashes, revokes all old sessions and rotates the current session", async () => {
    const { service, challenges, tx } = fixture();
    challenges.take.mockResolvedValue({
      userId: admin.id, secretCiphertext: "enc:BASE32SECRET", sessionTokenHash: "old-hash",
      ipAddress: "203.0.113.7", userAgent: "browser"
    });

    const result = await service.confirmEnrollment(
      admin, "current-token", { enrollmentToken: "challenge", code: "123456" }, "203.0.113.7", "browser"
    );

    expect(result.recoveryCodes).toHaveLength(10);
    expect(tx.userMfa.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: admin.id, secretCiphertext: "enc:BASE32SECRET", lastUsedTotpCounter: 100,
      recoveryCodeHashes: expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)])
    }) });
    expect(tx.session.updateMany).toHaveBeenCalledWith({ where: { userId: admin.id, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(tx.session.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: admin.id, mfaVerifiedAt: expect.any(Date) }) });
    expect(result).toEqual(expect.objectContaining({ sessionToken: expect.any(String), expiresAt: expect.any(Date), mfaEnabled: true }));
  });

  it("rejects an enrollment challenge from a different session, IP, or user agent before mutation", async () => {
    const { service, challenges, prisma, tx } = fixture();
    challenges.take.mockResolvedValue({
      userId: admin.id, secretCiphertext: "enc:BASE32SECRET", sessionTokenHash: "old-hash",
      ipAddress: "198.51.100.10", userAgent: "other-browser"
    });

    await expect(service.confirmEnrollment(
      admin, "current-token", { enrollmentToken: "challenge", code: "123456" }, "203.0.113.7", "browser"
    )).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.userMfa.create).not.toHaveBeenCalled();
  });

  it("completes MFA login with TOTP without accepting a stale or differently bound challenge", async () => {
    const { service, challenges, storedUser, tx, rateLimit } = fixture();
    storedUser.mfa = { secretCiphertext: "enc:BASE32SECRET", recoveryCodeHashes: [], lastUsedTotpCounter: 99 };
    challenges.take.mockResolvedValue({
      userId: admin.id, userUpdatedAt: storedUser.updatedAt.toISOString(), rememberMe: false,
      ipAddress: "203.0.113.7", userAgent: "browser"
    });

    const result = await service.completeLogin({ challengeToken: "challenge", code: "123456" }, "203.0.113.7", "browser");
    expect(rateLimit.consumeMfaCompletion).toHaveBeenCalledWith({ ipAddress: "203.0.113.7", userAgent: "browser" });
    expect(rateLimit.consumeMfaCompletion.mock.invocationCallOrder[0]).toBeLessThan(challenges.take.mock.invocationCallOrder[0]);
    expect(result.user).toMatchObject({ id: admin.id });
    expect(tx.session.create).toHaveBeenCalledWith({ data: expect.objectContaining({ mfaVerifiedAt: expect.any(Date), rememberMe: false }) });
    expect(tx.userMfa.update).toHaveBeenCalledWith({
      where: { userId: admin.id }, data: { lastUsedTotpCounter: 100 }
    });

    challenges.take.mockResolvedValue({
      userId: admin.id, userUpdatedAt: storedUser.updatedAt.toISOString(), rememberMe: false,
      ipAddress: "198.51.100.1", userAgent: "browser"
    });
    await expect(service.completeLogin({ challengeToken: "challenge", code: "123456" }, "203.0.113.7", "browser"))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a TOTP counter that is not strictly newer while holding the user lock", async () => {
    const { service, challenges, storedUser, tx, totp } = fixture();
    storedUser.mfa = { secretCiphertext: "enc:BASE32SECRET", recoveryCodeHashes: [], lastUsedTotpCounter: 100 };
    totp.matchingCounter.mockReturnValue(100);
    challenges.take.mockResolvedValue({
      userId: admin.id, userUpdatedAt: storedUser.updatedAt.toISOString(), rememberMe: false,
      ipAddress: "203.0.113.7", userAgent: "browser"
    });

    await expect(service.completeLogin(
      { challengeToken: "challenge", code: "123456" }, "203.0.113.7", "browser"
    )).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.session.create).not.toHaveBeenCalled();
  });

  it.each([
    ["TOTP", { code: "000000" }],
    ["recovery code", { recoveryCode: "invalid-recovery-code" }]
  ])("audits a failed %s login outside the rolled-back success transaction", async (_factor, verification) => {
    const { service, challenges, storedUser, tx, totp, audit } = fixture();
    storedUser.mfa = { secretCiphertext: "enc:BASE32SECRET", recoveryCodeHashes: [], lastUsedTotpCounter: 99 };
    challenges.take.mockResolvedValue({
      userId: admin.id, userUpdatedAt: storedUser.updatedAt.toISOString(), rememberMe: false,
      ipAddress: "203.0.113.7", userAgent: "browser"
    });
    totp.matchingCounter.mockReturnValue(null);

    await expect(service.completeLogin({ challengeToken: "challenge", ...verification }, "203.0.113.7", "browser"))
      .rejects.toBeInstanceOf(UnauthorizedException);

    expect(tx.session.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith({
      organizationId: admin.organizationId,
      actorId: undefined,
      action: "auth.login_failed",
      targetType: "User",
      targetId: admin.id,
      outcome: "failure",
      metadata: { mfa: true },
      ipAddress: "203.0.113.7",
      userAgent: "browser"
    });
  });

  it("audits a user-state rejection with the identity found before transaction rollback", async () => {
    const { service, challenges, storedUser, tx, audit } = fixture();
    (storedUser as { status: string }).status = "disabled";
    storedUser.mfa = { secretCiphertext: "enc:BASE32SECRET", recoveryCodeHashes: [], lastUsedTotpCounter: 99 };
    challenges.take.mockResolvedValue({
      userId: admin.id, userUpdatedAt: storedUser.updatedAt.toISOString(), rememberMe: false,
      ipAddress: "203.0.113.7", userAgent: "browser"
    });

    await expect(service.completeLogin({ challengeToken: "challenge", code: "123456" }, "203.0.113.7", "browser"))
      .rejects.toBeInstanceOf(UnauthorizedException);

    expect(tx.session.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: admin.organizationId,
      actorId: undefined,
      targetId: admin.id,
      action: "auth.login_failed",
      outcome: "failure"
    }));
    expect(audit.record.mock.calls[0][0]).not.toHaveProperty("transaction");
  });

  it.each([
    ["missing", null],
    ["binding mismatch", {
      userId: admin.id,
      userUpdatedAt: "2026-09-12T00:00:00.000Z",
      rememberMe: false,
      ipAddress: "198.51.100.1",
      userAgent: "browser"
    }]
  ])("audits a %s challenge failure with request context only", async (_kind, challenge) => {
    const { service, challenges, tx, audit } = fixture();
    challenges.take.mockResolvedValue(challenge);

    await expect(service.completeLogin({ challengeToken: "challenge", code: "123456" }, "203.0.113.7", "browser"))
      .rejects.toBeInstanceOf(UnauthorizedException);

    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith({
      action: "auth.login_failed",
      targetType: "User",
      outcome: "failure",
      metadata: { mfa: true },
      ipAddress: "203.0.113.7",
      userAgent: "browser"
    });
  });

  it("fails closed when recording an MFA login failure is unavailable", async () => {
    const { service, challenges, storedUser, tx, totp, audit } = fixture();
    const auditFailure = new Error("audit database unavailable");
    storedUser.mfa = { secretCiphertext: "enc:BASE32SECRET", recoveryCodeHashes: [], lastUsedTotpCounter: 99 };
    challenges.take.mockResolvedValue({
      userId: admin.id, userUpdatedAt: storedUser.updatedAt.toISOString(), rememberMe: false,
      ipAddress: "203.0.113.7", userAgent: "browser"
    });
    totp.matchingCounter.mockReturnValue(null);
    audit.record.mockRejectedValue(auditFailure);

    await expect(service.completeLogin({ challengeToken: "challenge", code: "000000" }, "203.0.113.7", "browser"))
      .rejects.toBe(auditFailure);
    expect(tx.session.create).not.toHaveBeenCalled();
  });

  it("consumes a recovery code once in the same transaction", async () => {
    const { service, challenges, storedUser, tx, totp, audit } = fixture();
    const code = "recovery-code";
    storedUser.mfa = {
      secretCiphertext: "enc:BASE32SECRET", recoveryCodeHashes: [service.hashRecoveryCode(code), "another"], lastUsedTotpCounter: 99
    };
    challenges.take.mockResolvedValue({
      userId: admin.id, userUpdatedAt: storedUser.updatedAt.toISOString(), rememberMe: false,
      ipAddress: "203.0.113.7", userAgent: "browser"
    });

    const result = await service.completeLogin({ challengeToken: "challenge", recoveryCode: code }, "203.0.113.7", "browser");

    expect(totp.matchingCounter).not.toHaveBeenCalled();
    expect(tx.userMfa.update).toHaveBeenCalledWith({ where: { userId: admin.id }, data: { recoveryCodeHashes: ["another"] } });
    expect(result.recoveryCodeUsed).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.mfa_recovery_code_used", transaction: tx }));
  });

  it("disables MFA only with current password and a second factor, then rotates sessions", async () => {
    const { service, storedUser, tx } = fixture();
    storedUser.mfa = { secretCiphertext: "enc:BASE32SECRET", recoveryCodeHashes: [], lastUsedTotpCounter: 99 };

    const result = await service.disable(admin, "current-token", { currentPassword: "password", code: "123456" });

    expect(tx.userMfa.delete).toHaveBeenCalledWith({ where: { userId: admin.id } });
    expect(tx.session.updateMany).toHaveBeenCalledWith({ where: { userId: admin.id, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(result).toEqual(expect.objectContaining({ mfaEnabled: false, sessionToken: expect.any(String) }));
  });
});
