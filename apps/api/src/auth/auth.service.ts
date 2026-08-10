import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { PrismaService } from "../prisma/prisma.service";
import type { OrganizationType, UserRole } from "./auth.types";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE_NAME = "led_session";
const PASSWORD_KEY_LENGTH = 64;
const NORMAL_SESSION_DAYS = 1;
const REMEMBER_ME_SESSION_DAYS = 30;

interface SignupInput {
  token: string;
  email: string;
  name: string;
  password: string;
}

interface LoginInput {
  email: string;
  password: string;
  rememberMe: boolean;
  userAgent?: string;
  ipAddress?: string;
}

type StoredUser = {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: UserRole;
  status: "active" | "disabled";
  organization: { type: OrganizationType };
  passwordHash?: string | null;
};

@Injectable()
export class AuthService {
  static readonly sessionCookieName = SESSION_COOKIE_NAME;

  constructor(private readonly prisma: PrismaService) {}

  async signup(input: SignupInput) {
    const email = this.normalizeEmail(input.email);
    const invitation = await this.db().invitation.findUnique({
      where: { tokenHash: this.hashToken(input.token) },
      include: { organization: { select: { type: true } } }
    });

    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
      throw new BadRequestException("Invitation is invalid or expired");
    }

    if (invitation.email && this.normalizeEmail(invitation.email) !== email) {
      throw new BadRequestException("Invitation email does not match");
    }

    if (invitation.organization.type === "service_provider" && invitation.role !== "operator") {
      throw new BadRequestException("service provider invitations require operator role");
    }
    if (invitation.organization.type === "customer" && invitation.role === "operator") {
      throw new BadRequestException("customer invitations cannot grant operator role");
    }

    const existingUser = await this.db().user.findUnique({ where: { email } });
    if (existingUser) {
      throw new BadRequestException("User already exists");
    }

    const passwordHash = await this.hashPassword(input.password);
    const user = await this.db().$transaction(async (tx: any) => {
      const assignment = await this.validateInvitationAssignment(tx, invitation);
      const consumedInvitation = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null },
        data: { acceptedAt: new Date() }
      });
      if (consumedInvitation.count !== 1) {
        throw new BadRequestException("Invitation is invalid or expired");
      }

      const createdUser = await tx.user.create({
        data: {
          organizationId: invitation.organizationId,
          email,
          name: input.name.trim(),
          role: invitation.role,
          status: "active",
          passwordHash
        }
      });
      if (assignment) {
        await tx.siteMembership.create({
          data: { userId: createdUser.id, siteId: assignment.id }
        });
      }
      return createdUser;
    });

    return { user: this.publicUser({ ...user, organization: invitation.organization }) };
  }

  async login(input: LoginInput) {
    const user = await this.db().user.findUnique({
      where: { email: this.normalizeEmail(input.email) },
      include: { organization: { select: { type: true } } }
    });

    if (!user || user.status !== "active" || !user.passwordHash) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const passwordMatches = await this.verifyPassword(input.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException("Invalid email or password");
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

    return {
      user: this.publicUser(user),
      sessionToken,
      expiresAt
    };
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
      where: {
        tokenHash: this.hashToken(sessionToken),
        revokedAt: null
      },
      data: { revokedAt: new Date() }
    });
  }

  async hashPassword(password: string) {
    if (password.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters");
    }

    const salt = randomBytes(16).toString("hex");
    const derivedKey = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
    return `scrypt$${salt}$${derivedKey.toString("hex")}`;
  }

  async verifyPassword(password: string, passwordHash: string) {
    const [algorithm, salt, storedKey] = passwordHash.split("$");
    if (algorithm !== "scrypt" || !salt || !storedKey) return false;

    const derivedKey = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
    const storedBuffer = Buffer.from(storedKey, "hex");
    if (derivedKey.length !== storedBuffer.length) return false;
    return timingSafeEqual(derivedKey, storedBuffer);
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
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status
    };
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private async validateInvitationAssignment(tx: any, invitation: {
    siteId?: string | null;
    role: UserRole;
    organizationId: string;
    organization: { type: OrganizationType };
  }) {
    if (invitation.role === "admin") return null;
    if (!invitation.siteId) {
      throw new BadRequestException(`${invitation.role} invitations require a valid customer site assignment`);
    }
    const site = await tx.site.findUnique({
      where: { id: invitation.siteId },
      select: { id: true, organizationId: true }
    });
    if (!site) {
      throw new BadRequestException(`${invitation.role} invitations require a valid customer site assignment`);
    }
    if (invitation.role === "viewer" && site.organizationId !== invitation.organizationId) {
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
}
