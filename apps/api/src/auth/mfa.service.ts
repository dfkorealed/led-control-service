import { BadRequestException, ConflictException, ForbiddenException, Injectable, Optional, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuthChallengeStore } from "./auth-challenge.store";
import type { AuthenticatedUser } from "./auth.types";
import { LoginRateLimitService } from "./login-rate-limit.service";
import { MfaCryptoService } from "./mfa-crypto.service";
import { PasswordService } from "./password.service";
import { TotpService } from "./totp.service";

const ENROLLMENT_TTL_SECONDS = 10 * 60;
const LOGIN_CHALLENGE_TTL_SECONDS = 5 * 60;
const NORMAL_SESSION_DAYS = 1;
const REMEMBER_ME_SESSION_DAYS = 30;

interface EnrollmentChallenge {
  userId: string;
  secretCiphertext: string;
}

export interface LoginMfaChallenge {
  userId: string;
  userUpdatedAt: string;
  rememberMe: boolean;
  ipAddress: string;
  userAgent?: string;
}

interface VerificationInput {
  code?: string;
  recoveryCode?: string;
}

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly challenges: AuthChallengeStore,
    private readonly crypto: MfaCryptoService,
    private readonly totp: TotpService,
    @Optional() private readonly loginRateLimit?: LoginRateLimitService
  ) {}

  async status(user: AuthenticatedUser) {
    this.assertEligible(user);
    const mfa = await this.db().userMfa.findUnique({ where: { userId: user.id }, select: { enabledAt: true } });
    return { enabled: Boolean(mfa), enabledAt: mfa?.enabledAt ?? null };
  }

  async startEnrollment(user: AuthenticatedUser) {
    this.assertEligible(user);
    const existing = await this.db().userMfa.findUnique({ where: { userId: user.id }, select: { userId: true } });
    if (existing) throw new ConflictException({ code: "MFA_ALREADY_ENABLED", message: "MFA is already enabled" });
    const secret = this.totp.generateSecret();
    const challenge = await this.challenges.create("enrollment", {
      userId: user.id,
      secretCiphertext: this.crypto.encrypt(secret)
    }, ENROLLMENT_TTL_SECONDS);
    return {
      enrollmentToken: challenge.token,
      secret,
      otpauthUri: this.totp.buildUri(secret, user.loginId),
      expiresAt: challenge.expiresAt
    };
  }

  async createLoginChallenge(
    user: { id: string; updatedAt: Date },
    input: { rememberMe: boolean; ipAddress: string; userAgent?: string }
  ) {
    const challenge = await this.challenges.create("login", {
      userId: user.id,
      userUpdatedAt: user.updatedAt.toISOString(),
      rememberMe: input.rememberMe,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent
    }, LOGIN_CHALLENGE_TTL_SECONDS);
    return { mfaRequired: true as const, challengeToken: challenge.token, expiresAt: challenge.expiresAt };
  }

  async confirmEnrollment(
    user: AuthenticatedUser,
    currentSessionToken: string,
    input: { enrollmentToken: string; code: string }
  ) {
    this.assertEligible(user);
    const challenge = await this.challenges.take<EnrollmentChallenge>("enrollment", this.required(input.enrollmentToken));
    if (!challenge || challenge.userId !== user.id) throw this.invalidMfa();
    const secret = this.crypto.decrypt(challenge.secretCiphertext);
    if (!this.totp.verify(secret, this.required(input.code))) throw this.invalidMfa();
    const recoveryCodes = Array.from({ length: 10 }, () => this.generateRecoveryCode());
    const result = await this.db().$transaction(async (tx: Prisma.TransactionClient) => {
      const { storedUser, currentSession } = await this.lockCurrentSession(tx, user, currentSessionToken);
      if (storedUser.mfa) throw new ConflictException({ code: "MFA_ALREADY_ENABLED", message: "MFA is already enabled" });
      await tx.userMfa.create({
        data: {
          userId: user.id,
          secretCiphertext: challenge.secretCiphertext,
          recoveryCodeHashes: recoveryCodes.map((code) => this.hashRecoveryCode(code))
        }
      });
      const rotated = await this.rotateCurrentSession(tx, currentSession, true);
      await this.audit.record({
        transaction: tx, organizationId: user.organizationId, actorId: user.id,
        action: "auth.mfa_enabled", targetType: "User", targetId: user.id, outcome: "success",
        metadata: { revokedSessionCount: rotated.revokedCount }
      });
      return rotated;
    });
    return { mfaEnabled: true, recoveryCodes, ...result };
  }

  async completeLogin(input: { challengeToken: string } & VerificationInput, ipAddress: string, userAgent?: string) {
    const challenge = await this.challenges.take<LoginMfaChallenge>("login", this.required(input.challengeToken));
    if (!challenge || challenge.ipAddress !== ipAddress || (challenge.userAgent ?? "") !== (userAgent ?? "")) throw this.invalidMfa();
    let organizationId = "";
    let loginId = "";
    const result = await this.db().$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${challenge.userId} FOR UPDATE`);
      const storedUser = await tx.user.findUnique({
        where: { id: challenge.userId },
        include: { organization: { select: { type: true } }, mfa: true }
      });
      if (!storedUser || storedUser.status !== "active" || !storedUser.mfa
        || storedUser.updatedAt.toISOString() !== challenge.userUpdatedAt
        || (storedUser.role !== "operator" && storedUser.role !== "admin")) throw this.invalidMfa();
      const verification = this.verifyFactor(storedUser.mfa, input);
      if (!verification.valid) throw this.invalidMfa();
      if (verification.recoveryCodeUsed) {
        await tx.userMfa.update({
          where: { userId: storedUser.id },
          data: { recoveryCodeHashes: verification.remainingRecoveryCodeHashes }
        });
      }
      const session = await this.createSession(tx, storedUser.id, {
        rememberMe: challenge.rememberMe,
        userAgent: challenge.userAgent,
        ipAddress: challenge.ipAddress,
        mfaVerified: true
      });
      await this.audit.record({
        transaction: tx, organizationId: storedUser.organizationId, actorId: storedUser.id,
        action: "auth.login_succeeded", targetType: "User", targetId: storedUser.id, outcome: "success",
        ipAddress: challenge.ipAddress, userAgent: challenge.userAgent,
        metadata: { mfa: true }
      });
      if (verification.recoveryCodeUsed) {
        await this.audit.record({
          transaction: tx, organizationId: storedUser.organizationId, actorId: storedUser.id,
          action: "auth.mfa_recovery_code_used", targetType: "User", targetId: storedUser.id, outcome: "success"
        });
      }
      organizationId = storedUser.organizationId;
      loginId = storedUser.loginId;
      return { user: this.publicUser(storedUser), recoveryCodeUsed: verification.recoveryCodeUsed, ...session };
    });
    if (this.loginRateLimit) {
      try {
        await this.loginRateLimit.resetAfterSuccess({
          ipAddress, loginId, organizationId, userId: result.user.id, userAgent
        });
      } catch (error) {
        await this.db().session.updateMany({
          where: { tokenHash: this.hashToken(result.sessionToken), revokedAt: null },
          data: { revokedAt: new Date() }
        });
        throw error;
      }
    }
    return result;
  }

  async disable(
    user: AuthenticatedUser,
    currentSessionToken: string,
    input: { currentPassword: string } & VerificationInput
  ) {
    this.assertEligible(user);
    return this.db().$transaction(async (tx: Prisma.TransactionClient) => {
      const { storedUser, currentSession } = await this.lockCurrentSession(tx, user, currentSessionToken);
      if (!storedUser.passwordHash || !(await this.passwords.verify(this.required(input.currentPassword), storedUser.passwordHash))) {
        throw new UnauthorizedException("Current password is incorrect");
      }
      if (!storedUser.mfa) throw new ConflictException({ code: "MFA_NOT_ENABLED", message: "MFA is not enabled" });
      const verification = this.verifyFactor(storedUser.mfa, input);
      if (!verification.valid) throw this.invalidMfa();
      if (verification.recoveryCodeUsed) {
        await this.audit.record({
          transaction: tx, organizationId: user.organizationId, actorId: user.id,
          action: "auth.mfa_recovery_code_used", targetType: "User", targetId: user.id, outcome: "success"
        });
      }
      await tx.userMfa.delete({ where: { userId: user.id } });
      const rotated = await this.rotateCurrentSession(tx, currentSession, false);
      await this.audit.record({
        transaction: tx, organizationId: user.organizationId, actorId: user.id,
        action: "auth.mfa_disabled", targetType: "User", targetId: user.id, outcome: "success",
        metadata: { revokedSessionCount: rotated.revokedCount }
      });
      return { mfaEnabled: false, ...rotated };
    });
  }

  hashRecoveryCode(code: string) {
    return createHash("sha256").update(code).digest("hex");
  }

  private verifyFactor(mfa: { secretCiphertext: string; recoveryCodeHashes: string[] }, input: VerificationInput) {
    const hasCode = typeof input.code === "string" && input.code.length > 0;
    const hasRecovery = typeof input.recoveryCode === "string" && input.recoveryCode.length > 0;
    if (hasCode === hasRecovery) return { valid: false, recoveryCodeUsed: false, remainingRecoveryCodeHashes: mfa.recoveryCodeHashes };
    if (hasCode) {
      return {
        valid: this.totp.verify(this.crypto.decrypt(mfa.secretCiphertext), input.code!),
        recoveryCodeUsed: false,
        remainingRecoveryCodeHashes: mfa.recoveryCodeHashes
      };
    }
    const hash = this.hashRecoveryCode(input.recoveryCode!);
    const index = mfa.recoveryCodeHashes.indexOf(hash);
    return {
      valid: index >= 0,
      recoveryCodeUsed: index >= 0,
      remainingRecoveryCodeHashes: index >= 0
        ? mfa.recoveryCodeHashes.filter((_, candidateIndex) => candidateIndex !== index)
        : mfa.recoveryCodeHashes
    };
  }

  private async lockCurrentSession(tx: Prisma.TransactionClient, user: AuthenticatedUser, currentSessionToken: string) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`);
    const storedUser = await tx.user.findUnique({
      where: { id: user.id },
      include: { organization: { select: { type: true } }, mfa: true }
    });
    const currentSession = await tx.session.findUnique({ where: { tokenHash: this.hashToken(currentSessionToken) } });
    if (!storedUser || storedUser.status !== "active" || storedUser.organizationId !== user.organizationId
      || (storedUser.role !== "operator" && storedUser.role !== "admin")
      || !currentSession || currentSession.userId !== user.id || currentSession.revokedAt || currentSession.expiresAt <= new Date()) {
      throw new UnauthorizedException("Authentication required");
    }
    return { storedUser, currentSession };
  }

  private async rotateCurrentSession(tx: Prisma.TransactionClient, currentSession: any, mfaVerified: boolean) {
    const revoked = await tx.session.updateMany({
      where: { userId: currentSession.userId, revokedAt: null }, data: { revokedAt: new Date() }
    });
    const sessionToken = randomBytes(32).toString("base64url");
    await tx.session.create({
      data: {
        userId: currentSession.userId,
        tokenHash: this.hashToken(sessionToken),
        rememberMe: currentSession.rememberMe,
        userAgent: currentSession.userAgent,
        ipAddress: currentSession.ipAddress,
        expiresAt: currentSession.expiresAt,
        mfaVerifiedAt: mfaVerified ? new Date() : null
      }
    });
    return { sessionToken, expiresAt: currentSession.expiresAt, revokedCount: revoked.count };
  }

  private async createSession(
    tx: Prisma.TransactionClient,
    userId: string,
    input: { rememberMe: boolean; userAgent?: string; ipAddress?: string; mfaVerified: boolean }
  ) {
    const expiresAt = this.addDays(new Date(), input.rememberMe ? REMEMBER_ME_SESSION_DAYS : NORMAL_SESSION_DAYS);
    const sessionToken = randomBytes(32).toString("base64url");
    await tx.session.create({
      data: {
        userId,
        tokenHash: this.hashToken(sessionToken),
        rememberMe: input.rememberMe,
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
        expiresAt,
        mfaVerifiedAt: input.mfaVerified ? new Date() : null
      }
    });
    return { sessionToken, expiresAt };
  }

  private assertEligible(user: AuthenticatedUser) {
    if (user.status !== "active" || (user.role !== "operator" && user.role !== "admin")) {
      throw new ForbiddenException({ code: "MFA_ROLE_DENIED", message: "MFA is available to operator and admin accounts" });
    }
  }

  private publicUser(user: any): AuthenticatedUser {
    return {
      id: user.id, organizationId: user.organizationId, organizationType: user.organization.type,
      loginId: user.loginId, name: user.name, role: user.role, status: user.status,
      mustChangePassword: user.mustChangePassword
    };
  }

  private generateRecoveryCode() {
    return randomBytes(16).toString("base64url");
  }

  private hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  private addDays(date: Date, days: number) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  private required(value: unknown) {
    if (typeof value !== "string" || !value.trim()) throw new BadRequestException("Invalid MFA request");
    return value;
  }

  private invalidMfa() {
    return new UnauthorizedException({ code: "MFA_INVALID", message: "MFA verification failed" });
  }

  private db() {
    return this.prisma as any;
  }
}
