import { BadRequestException, HttpException, Injectable, InternalServerErrorException, Optional, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { assertSiteUserCapacity, runSiteUserTransaction } from "../access/site-user-policy";
import { PrismaService } from "../prisma/prisma.service";
import { normalizeLoginId, type AuthenticatedUser, type OrganizationType, type UserRole } from "./auth.types";
import { PasswordService } from "./password.service";
import { lockUserForPasswordMutation } from "./user-password-lock";
import { LoginRateLimitService, type LoginRateLimitInput } from "./login-rate-limit.service";
import { MfaService } from "./mfa.service";

const SESSION_COOKIE_NAME = "led_session";
const NORMAL_SESSION_DAYS = 1;
const REMEMBER_ME_SESSION_DAYS = 30;
const LOGIN_TRANSACTION_ATTEMPTS = 2;

interface SignupInput {
  token: string;
  loginId: string;
  email: string;
  name: string;
  password: string;
}

interface LoginInput {
  loginId: string;
  password: string;
  rememberMe: boolean;
  userAgent?: string;
  ipAddress?: string;
}

interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  newPasswordConfirmation: string;
}

type StoredUser = {
  id: string;
  organizationId: string;
  loginId: string;
  email: string | null;
  name: string;
  role: UserRole;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  organization: { type: OrganizationType };
  passwordHash?: string | null;
};

@Injectable()
export class AuthService {
  static readonly sessionCookieName = SESSION_COOKIE_NAME;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    @Optional() private readonly loginRateLimit?: LoginRateLimitService,
    @Optional() private readonly mfa?: MfaService
  ) {}

  async signup(input: SignupInput) {
    const loginId = normalizeLoginId(input.loginId);
    const email = this.normalizeEmail(input.email);
    const token = this.requiredString(input.token, "token");
    const name = this.requiredString(input.name, "name");
    const invitation = await this.db().invitation.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { organization: { select: { type: true } } }
    });

    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
      throw new BadRequestException("Invitation is invalid or expired");
    }
    if (invitation.role !== "viewer") {
      throw new BadRequestException("only viewer invitations support signup");
    }
    if (invitation.organization.type !== "customer") {
      throw new BadRequestException("viewer invitations require a customer organization");
    }
    if (!invitation.email || this.normalizeEmail(invitation.email) !== email) {
      throw new BadRequestException("Invitation email does not match");
    }

    const [loginIdUser, emailUser] = await Promise.all([
      this.db().user.findUnique({ where: { loginId }, select: { id: true } }),
      this.db().user.findUnique({ where: { email }, select: { id: true } })
    ]);
    if (loginIdUser || emailUser) throw new BadRequestException("User already exists");

    const passwordHash = await this.passwords.hash(input.password);
    let user;
    try {
      user = await runSiteUserTransaction(this.prisma, async (tx) => {
        const site = await this.validateViewerInvitationAssignment(tx, invitation);
        // Re-read after the Site lock on every retry. A prechecked invitation
        // can be revoked, moved or expire while waiting for the shared gate.
        const current = await tx.invitation.findUnique({ where: { tokenHash: this.hashToken(token) }, include: { organization: { select: { type: true } } } });
        if (!current || current.acceptedAt || current.expiresAt <= new Date()
          || current.siteId !== site.id || current.organizationId !== site.organizationId
          || current.role !== "viewer" || current.organization.type !== "customer"
          || !current.email || this.normalizeEmail(current.email) !== email) {
          throw new BadRequestException("Invitation is invalid or expired");
        }
        await assertSiteUserCapacity(tx, site.id, site.organizationId);
        const consumedInvitation = await tx.invitation.updateMany({
          where: { id: current.id, acceptedAt: null, expiresAt: { gt: new Date() } },
          data: { acceptedAt: new Date() }
        });
        if (consumedInvitation.count !== 1) throw new BadRequestException("Invitation is invalid or expired");

        const createdUser = await tx.user.create({
          data: {
            organizationId: invitation.organizationId,
            loginId,
            email,
            name,
            role: "viewer",
            status: "active",
            passwordHash
          },
          select: { id: true, organizationId: true, loginId: true, email: true, name: true, role: true, status: true, mustChangePassword: true }
        });
        await tx.siteMembership.create({ data: { userId: createdUser.id, siteId: site.id } });
        return createdUser;
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) throw new BadRequestException("User already exists");
      if (error instanceof HttpException) throw error;
      // Avoid logging Prisma errors containing password-hash mutation arguments.
      throw new InternalServerErrorException("Signup could not be completed");
    }

    return { user: this.publicUser({ ...user, organization: invitation.organization }) };
  }

  async login(input: LoginInput): Promise<any> {
    if (typeof input?.rememberMe !== "boolean") throw new BadRequestException("rememberMe must be a boolean");
    const loginId = normalizeLoginId(input.loginId);
    const rateInput = await this.loginRateInput(loginId, input);
    if (this.loginRateLimit) await this.loginRateLimit.consume(rateInput);
    try {
      for (let attempt = 1; attempt <= LOGIN_TRANSACTION_ATTEMPTS; attempt += 1) {
        try {
          const result = await this.db().$transaction(async (tx: Prisma.TransactionClient) => {
          const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
            SELECT "id" FROM "User" WHERE "loginId" = ${loginId} FOR UPDATE
          `);
          if (locked.length === 0) throw this.invalidCredentials();

          const user = await tx.user.findUnique({
            where: { loginId },
            include: { organization: { select: { type: true } }, mfa: { select: { userId: true } } }
          });
          if (!user || user.status !== "active" || !user.passwordHash) throw this.invalidCredentials();
          if (!(await this.passwords.verify(input.password, user.passwordHash))) throw this.invalidCredentials();

          if (user.mfa) return { kind: "mfa" as const, user };

          const sessionToken = this.generateToken();
          const expiresAt = this.addDays(new Date(), input.rememberMe ? REMEMBER_ME_SESSION_DAYS : NORMAL_SESSION_DAYS);
          await tx.session.create({
            data: {
              userId: user.id,
              familyId: randomUUID(),
              tokenHash: this.hashToken(sessionToken),
              rememberMe: input.rememberMe,
              userAgent: input.userAgent ?? null,
              ipAddress: input.ipAddress ?? null,
              expiresAt
            }
          });
          await this.audit.record({
            transaction: tx,
            organizationId: user.organizationId,
            actorId: user.id,
            action: "auth.login_succeeded",
            targetType: "User",
            targetId: user.id,
            outcome: "success",
            ipAddress: input.ipAddress,
            userAgent: input.userAgent
          });
          return { kind: "session" as const, user: this.publicUser(user), sessionToken, expiresAt };
          });
          if (result.kind === "mfa") {
            if (!this.mfa) throw new InternalServerErrorException("MFA service is unavailable");
            return this.mfa.createLoginChallenge(result.user, {
              rememberMe: input.rememberMe,
              ipAddress: input.ipAddress ?? "unknown",
              userAgent: input.userAgent
            });
          }
          if (this.loginRateLimit) {
            try {
              await this.loginRateLimit.resetAfterSuccess(rateInput);
            } catch (error) {
              await this.logout(result.sessionToken);
              throw error;
            }
          }
          return { user: result.user, sessionToken: result.sessionToken, expiresAt: result.expiresAt };
        } catch (error) {
          if (!this.isTransactionConflictError(error)) throw error;
          if (attempt === LOGIN_TRANSACTION_ATTEMPTS) throw this.invalidCredentials();
        }
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        await this.audit.record({
          organizationId: rateInput.organizationId,
          actorId: undefined,
          action: "auth.login_failed",
          targetType: "User",
          targetId: rateInput.userId,
          outcome: "failure",
          ipAddress: input.ipAddress,
          userAgent: input.userAgent
        });
      }
      throw error;
    }
    throw this.invalidCredentials();
  }

  async changePassword(user: Pick<StoredUser, "id" | "organizationId">, currentSessionToken: string, input: ChangePasswordInput) {
    try {
      const currentPassword = this.requiredPassword(input?.currentPassword, "currentPassword");
      const newPassword = this.requiredPassword(input?.newPassword, "newPassword");
      const newPasswordConfirmation = this.requiredPassword(input?.newPasswordConfirmation, "newPasswordConfirmation");
      if (newPassword !== newPasswordConfirmation) {
        throw new BadRequestException("New password confirmation does not match");
      }
      if (newPassword === currentPassword) {
        throw new BadRequestException("New password must differ from current password");
      }

      const currentTokenHash = this.hashToken(currentSessionToken);
      const result = await this.db().$transaction(async (tx: Prisma.TransactionClient) => {
        if (!await lockUserForPasswordMutation(tx, user.id)) {
          throw new UnauthorizedException("Current password is incorrect");
        }
        const storedUser = await tx.user.findUnique({ where: { id: user.id } });
        // A reset/disable can revoke the guard-validated session while this request
        // waits for the User lock. Never clear the flag using that stale session.
        const session = await tx.session.findUnique({ where: { tokenHash: currentTokenHash } });
        if (!storedUser || storedUser.status !== "active" || storedUser.organizationId !== user.organizationId
          || !session || session.userId !== user.id || session.revokedAt || session.expiresAt <= new Date()) {
          throw new UnauthorizedException("Authentication required");
        }
        if (!storedUser?.passwordHash || !(await this.passwords.verify(currentPassword, storedUser.passwordHash))) {
          throw new UnauthorizedException("Current password is incorrect");
        }

        const passwordHash = await this.passwords.hash(newPassword);
        const updated = await tx.user.update({
          where: { id: user.id }, data: { passwordHash, mustChangePassword: false },
          include: { organization: { select: { type: true } } }
        });
        const revokedSessions = await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() }
        });
        const sessionToken = this.generateToken();
        await tx.session.create({
          data: {
            userId: user.id,
            familyId: session.familyId,
            rotatedFromSessionId: session.id,
            tokenHash: this.hashToken(sessionToken),
            rememberMe: session.rememberMe,
            userAgent: session.userAgent,
            ipAddress: session.ipAddress,
            expiresAt: session.expiresAt,
            mfaVerifiedAt: session.mfaVerifiedAt ?? null
          }
        });
        await this.audit.record({
          transaction: tx,
          organizationId: user.organizationId,
          actorId: user.id,
          action: "auth.password_changed",
          targetType: "User",
          targetId: user.id,
          outcome: "success",
          metadata: { revokedSessionCount: revokedSessions.count }
        });
        return { user: this.publicUser(updated), sessionToken, expiresAt: session.expiresAt };
      });
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // Prisma mutation errors may embed password hashes in their message/meta.
      // Do not forward or log the original error, including its cause or stack.
      throw new InternalServerErrorException({
        code: "PASSWORD_CHANGE_FAILED", message: "Password change could not be completed"
      });
    }
  }

  async getUserBySessionToken(sessionToken: string) {
    const session = await this.db().session.findUnique({
      where: { tokenHash: this.hashToken(sessionToken) },
      include: { user: { include: { organization: { select: { type: true } } } } }
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== "active") {
      throw new UnauthorizedException("Authentication required");
    }
    return this.publicUser(session.user);
  }

  async logout(sessionToken: string) {
    await this.db().$transaction(async (tx: Prisma.TransactionClient) => {
      const initial = await tx.session.findUnique({
        where: { tokenHash: this.hashToken(sessionToken) },
        include: { user: { select: { id: true, organizationId: true } } }
      });
      if (!initial) return;
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${initial.userId} FOR UPDATE`);
      const session = await tx.session.findUnique({
        where: { tokenHash: this.hashToken(sessionToken) },
        include: { user: { select: { id: true, organizationId: true } } }
      });
      if (!session) return;
      await tx.session.updateMany({
        where: { userId: session.userId, familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      await this.audit.record({
        transaction: tx,
        organizationId: session.user.organizationId,
        actorId: session.user.id,
        action: "auth.logout",
        targetType: "Session",
        targetId: session.id,
        outcome: "success"
      });
    });
  }

  hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  generateToken() {
    return randomBytes(32).toString("base64url");
  }

  private publicUser(user: StoredUser): AuthenticatedUser {
    return {
      id: user.id,
      organizationId: user.organizationId,
      organizationType: user.organization.type,
      loginId: user.loginId,
      name: user.name,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword
    };
  }

  private normalizeEmail(email: unknown) {
    if (typeof email !== "string" || !email.trim()) throw new BadRequestException("Invalid email");
    return email.trim().toLowerCase();
  }

  private requiredString(value: unknown, name: string) {
    if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
    return value.trim();
  }

  private requiredPassword(value: unknown, name: string) {
    if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
    return value;
  }

  private async validateViewerInvitationAssignment(tx: Prisma.TransactionClient, invitation: { siteId?: string | null; organizationId: string }) {
    if (!invitation.siteId) throw new BadRequestException("viewer invitations require a valid customer site assignment");
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Site" WHERE "id" = ${invitation.siteId} FOR UPDATE`);
    const site = await tx.site.findUnique({
      where: { id: invitation.siteId },
      select: { id: true, organizationId: true }
    });
    if (!site || site.organizationId !== invitation.organizationId) {
      throw new BadRequestException("viewer invitations require a valid customer site assignment");
    }
    return site;
  }

  private addDays(date: Date, days: number) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  private async loginRateInput(loginId: string, input: LoginInput): Promise<LoginRateLimitInput> {
    const base = { loginId, ipAddress: input.ipAddress ?? "unknown", userAgent: input.userAgent };
    if (!this.loginRateLimit) return base;
    const identity = await this.db().user.findUnique({
      where: { loginId },
      select: { id: true, organizationId: true }
    });
    return { ...base, userId: identity?.id, organizationId: identity?.organizationId };
  }

  private db() {
    return this.prisma as any;
  }

  private isUniqueConstraintError(error: unknown) {
    return (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002");
  }

  private isTransactionConflictError(error: unknown) {
    return (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")
      || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2034");
  }

  private invalidCredentials() {
    return new UnauthorizedException("Invalid login id or password");
  }
}
