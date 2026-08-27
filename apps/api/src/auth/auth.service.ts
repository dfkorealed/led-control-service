import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { normalizeLoginId, type OrganizationType, type UserRole } from "./auth.types";
import { PasswordService } from "./password.service";

const SESSION_COOKIE_NAME = "led_session";
const NORMAL_SESSION_DAYS = 1;
const REMEMBER_ME_SESSION_DAYS = 30;

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
  organization: { type: OrganizationType };
  passwordHash?: string | null;
};

@Injectable()
export class AuthService {
  static readonly sessionCookieName = SESSION_COOKIE_NAME;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords = new PasswordService(),
    private readonly audit = new AuditService(prisma)
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
      this.db().user.findUnique({ where: { loginId } }),
      this.db().user.findUnique({ where: { email } })
    ]);
    if (loginIdUser || emailUser) throw new BadRequestException("User already exists");

    const passwordHash = await this.passwords.hash(input.password);
    let user;
    try {
      user = await this.db().$transaction(async (tx: any) => {
        const site = await this.validateViewerInvitationAssignment(tx, invitation);
        const consumedInvitation = await tx.invitation.updateMany({
          where: { id: invitation.id, acceptedAt: null },
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
          }
        });
        await tx.siteMembership.create({ data: { userId: createdUser.id, siteId: site.id } });
        return createdUser;
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) throw new BadRequestException("User already exists");
      throw error;
    }

    return { user: this.publicUser({ ...user, organization: invitation.organization }) };
  }

  async login(input: LoginInput) {
    if (typeof input?.rememberMe !== "boolean") throw new BadRequestException("rememberMe must be a boolean");
    const loginId = normalizeLoginId(input.loginId);
    const user = await this.db().user.findUnique({
      where: { loginId },
      include: { organization: { select: { type: true } } }
    });
    if (!user || user.status !== "active" || !user.passwordHash) {
      throw new UnauthorizedException("Invalid login id or password");
    }
    if (!(await this.passwords.verify(input.password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid login id or password");
    }

    const sessionToken = this.generateToken();
    const expiresAt = this.addDays(new Date(), input.rememberMe ? REMEMBER_ME_SESSION_DAYS : NORMAL_SESSION_DAYS);
    await this.db().session.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(sessionToken),
        rememberMe: input.rememberMe,
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
        expiresAt
      }
    });
    return { user: this.publicUser(user), sessionToken, expiresAt };
  }

  async changePassword(user: Pick<StoredUser, "id" | "organizationId">, currentSessionToken: string, input: ChangePasswordInput) {
    const currentPassword = this.requiredString(input?.currentPassword, "currentPassword");
    const newPassword = this.requiredString(input?.newPassword, "newPassword");
    const newPasswordConfirmation = this.requiredString(input?.newPasswordConfirmation, "newPasswordConfirmation");
    if (newPassword !== newPasswordConfirmation) {
      throw new BadRequestException("New password confirmation does not match");
    }

    const currentTokenHash = this.hashToken(currentSessionToken);
    await this.db().$transaction(async (tx: any) => {
      const storedUser = await tx.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
      if (!storedUser?.passwordHash || !(await this.passwords.verify(currentPassword, storedUser.passwordHash))) {
        throw new UnauthorizedException("Current password is incorrect");
      }

      const passwordHash = await this.passwords.hash(newPassword);
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      const revokedSessions = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, tokenHash: { not: currentTokenHash } },
        data: { revokedAt: new Date() }
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
    });
    return { ok: true };
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
    await this.db().session.updateMany({
      where: { tokenHash: this.hashToken(sessionToken), revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }

  hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  generateToken() {
    return randomBytes(32).toString("base64url");
  }

  private publicUser(user: StoredUser) {
    return {
      id: user.id,
      organizationId: user.organizationId,
      organizationType: user.organization.type,
      loginId: user.loginId,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status
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

  private async validateViewerInvitationAssignment(tx: any, invitation: { siteId?: string | null; organizationId: string }) {
    if (!invitation.siteId) throw new BadRequestException("viewer invitations require a valid customer site assignment");
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

  private db() {
    return this.prisma as any;
  }

  private isUniqueConstraintError(error: unknown) {
    return (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002");
  }
}
