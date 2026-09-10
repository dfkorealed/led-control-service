import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { assertSiteUserCapacity, runSiteUserTransaction, SITE_USER_LIMIT } from "../access/site-user-policy";
import { AuditService } from "../audit/audit.service";
import { normalizeLoginId, type AuthenticatedUser } from "../auth/auth.types";
import { PasswordService } from "../auth/password.service";
import { PrismaService } from "../prisma/prisma.service";

const profileShape = {
  name: z.string().trim().min(1).max(100),
  loginId: z.string().trim().toLowerCase().regex(/^[a-z0-9._@-]{4,100}$/),
  accessLevel: z.enum(["read", "control"]), status: z.enum(["active", "disabled"])
};
const temporaryPassword = z.string().min(8).max(1024).refine((value) => value.trim().length > 0);
const createSchema = z.object({ ...profileShape, temporaryPassword }).strict();
const updateSchema = z.object({ ...profileShape, expectedUpdatedAt: z.string().datetime() }).strict();
const resetSchema = z.object({ temporaryPassword }).strict();
const deleteSchema = z.object({ confirmationLoginId: z.string().min(1).max(100) }).strict();

export interface SiteUserSummary {
  id: string;
  name: string;
  loginId: string;
  accessLevel: "read" | "control";
  status: "active" | "disabled";
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Explicit projections also apply to write return values. Never ask Prisma to
// return the whole User, even when only its ID is needed after a mutation.
const summarySelect = (siteId: string) => ({
  id: true, name: true, loginId: true, status: true, createdAt: true, updatedAt: true,
  siteMemberships: { where: { siteId }, select: { accessLevel: true } },
  sessions: { select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 }
}) satisfies Prisma.UserSelect;
type SummaryRow = Prisma.UserGetPayload<{ select: ReturnType<typeof summarySelect> }>;

@Injectable()
export class SiteUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SiteAccessService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService
  ) {}

  async list(user: AuthenticatedUser, siteId: string) {
    this.assertAdmin(user);
    return this.transaction(user, siteId, async (tx, organizationId) => {
      const users = await tx.user.findMany({
        where: this.memberWhere(siteId, organizationId), select: summarySelect(siteId),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      });
      return { users: users.map((row) => this.summary(row)), count: users.length, limit: SITE_USER_LIMIT };
    });
  }

  async create(user: AuthenticatedUser, siteId: string, input: unknown): Promise<SiteUserSummary> {
    this.assertAdmin(user);
    const body = this.parse(createSchema, input);
    await this.access.assert(user, siteId, "manage");
    const passwordHash = await this.passwords.hash(body.temporaryPassword);
    return this.transaction(user, siteId, async (tx, organizationId) => {
      await assertSiteUserCapacity(tx, siteId, organizationId);
      const created = await tx.user.create({
        data: {
          organizationId, loginId: normalizeLoginId(body.loginId), name: body.name,
          passwordHash, role: "viewer", status: body.status, mustChangePassword: true
        }, select: { id: true }
      });
      await tx.siteMembership.create({ data: { userId: created.id, siteId, accessLevel: body.accessLevel } });
      await this.record(tx, user, siteId, "created", created.id);
      return this.summary(await this.member(tx, siteId, organizationId, created.id));
    }, Prisma.TransactionIsolationLevel.Serializable);
  }

  async update(user: AuthenticatedUser, siteId: string, userId: string, input: unknown): Promise<SiteUserSummary> {
    this.assertAdmin(user);
    const body = this.parse(updateSchema, input);
    return this.transaction(user, siteId, async (tx, organizationId) => {
      const current = await this.lockMember(tx, siteId, organizationId, userId);
      if (current.updatedAt.getTime() !== new Date(body.expectedUpdatedAt).getTime()) throw this.changed();
      await tx.user.update({
        where: { id: current.id },
        data: {
          name: body.name, loginId: normalizeLoginId(body.loginId), status: body.status,
          // Membership-only changes must invalidate a previously loaded form too.
          updatedAt: this.nextUpdatedAt(current.updatedAt)
        }, select: { id: true }
      });
      await tx.siteMembership.update({ where: { userId_siteId: { userId, siteId } }, data: { accessLevel: body.accessLevel } });
      if (body.status === "disabled") await this.revokeSessions(tx, userId);
      await this.record(tx, user, siteId, "updated", userId);
      return this.summary(await this.member(tx, siteId, organizationId, userId));
    });
  }

  async resetPassword(user: AuthenticatedUser, siteId: string, userId: string, input: unknown) {
    this.assertAdmin(user);
    const body = this.parse(resetSchema, input);
    await this.access.assert(user, siteId, "manage");
    const passwordHash = await this.passwords.hash(body.temporaryPassword);
    return this.transaction(user, siteId, async (tx, organizationId) => {
      const current = await this.lockMember(tx, siteId, organizationId, userId);
      await tx.user.update({
        where: { id: userId }, data: { passwordHash, mustChangePassword: true, updatedAt: this.nextUpdatedAt(current.updatedAt) },
        select: { id: true }
      });
      await this.revokeSessions(tx, userId);
      await this.record(tx, user, siteId, "password_reset", userId);
      return { ok: true as const };
    });
  }

  async remove(user: AuthenticatedUser, siteId: string, userId: string, input: unknown) {
    this.assertAdmin(user);
    const body = this.parse(deleteSchema, input);
    return this.transaction(user, siteId, async (tx, organizationId) => {
      const current = await this.lockMember(tx, siteId, organizationId, userId);
      if (body.confirmationLoginId !== current.loginId) throw this.invalidInput();
      const deletionIdentity = await tx.user.findUnique({
        where: { id: userId },
        select: { email: true }
      });
      await tx.$executeRaw(Prisma.sql`
        UPDATE "MqttOutbox" AS outbox
        SET
          "payload" = outbox."payload" - 'requestedBy',
          "updatedAt" = CURRENT_TIMESTAMP
        FROM "CommandDispatch" AS dispatch
        JOIN "Command" AS command ON command."id" = dispatch."commandId"
        WHERE outbox."dispatchId" = dispatch."id"
          AND command."requestedBy" = ${userId}
          AND jsonb_typeof(outbox."payload") = 'object'
          AND outbox."payload" ? 'requestedBy'
      `);
      if (deletionIdentity?.email) {
        const normalizedEmail = deletionIdentity.email.trim().toLowerCase();
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM "Invitation"
          WHERE "organizationId" = ${organizationId}
            AND "siteId" = ${siteId}
            AND "acceptedAt" IS NOT NULL
            AND "email" IS NOT NULL
            AND LOWER(BTRIM("email")) = ${normalizedEmail}
        `);
      }
      // AuditLog has no User FK. Clear linked PII explicitly while retaining
      // technical event rows; the deletion event itself records only the site.
      await tx.auditLog.updateMany({
        where: { actorId: userId },
        data: { actorId: null, metadata: Prisma.DbNull, ipAddress: null, userAgent: null }
      });
      await tx.auditLog.updateMany({
        where: { targetType: { in: ["User", "SiteUser"] }, targetId: userId },
        data: { targetId: null, metadata: Prisma.DbNull, ipAddress: null, userAgent: null }
      });
      // Task 1 FKs cascade sessions/memberships and SET NULL on command/override
      // requesters. Active overrides and device history must stay intact.
      await tx.user.delete({ where: { id: userId }, select: { id: true } });
      await this.record(tx, user, siteId, "deleted");
      return { ok: true as const };
    });
  }

  private async transaction<T>(
    user: AuthenticatedUser, siteId: string,
    operation: (tx: Prisma.TransactionClient, organizationId: string) => Promise<T>,
    isolationLevel: Prisma.TransactionIsolationLevel = Prisma.TransactionIsolationLevel.ReadCommitted
  ): Promise<T> {
    try {
      return await runSiteUserTransaction(this.prisma, async (tx) => {
        const site = await this.access.assertManageInTransaction(tx, user, siteId);
        return operation(tx, site.organizationId);
      }, isolationLevel);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (this.errorCode(error) === "P2002") {
        throw new ConflictException({ code: "LOGIN_ID_ALREADY_EXISTS", message: "login ID already exists" });
      }
      // Prisma errors can embed mutation arguments, including hashes. Never
      // pass these errors/causes to Nest's unhandled-error logger or clients.
      throw new InternalServerErrorException({ code: "SITE_USER_OPERATION_FAILED", message: "site user operation failed" });
    }
  }

  private memberWhere(siteId: string, organizationId: string): Prisma.UserWhereInput {
    return { role: "viewer", organizationId, siteMemberships: { some: { siteId } } };
  }
  private async member(tx: Prisma.TransactionClient, siteId: string, organizationId: string, userId: string) {
    const row = await tx.user.findFirst({ where: { ...this.memberWhere(siteId, organizationId), id: userId }, select: summarySelect(siteId) });
    if (!row) throw new NotFoundException({ code: "SITE_USER_NOT_FOUND", message: "site user not found" });
    return row;
  }
  private async lockMember(tx: Prisma.TransactionClient, siteId: string, organizationId: string, userId: string) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`);
    return this.member(tx, siteId, organizationId, userId);
  }
  private summary(row: SummaryRow): SiteUserSummary {
    return {
      id: row.id, name: row.name, loginId: row.loginId, accessLevel: row.siteMemberships[0].accessLevel,
      status: row.status, lastLoginAt: row.sessions[0]?.createdAt ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt
    };
  }
  private revokeSessions(tx: Prisma.TransactionClient, userId: string) {
    return tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  private record(tx: Prisma.TransactionClient, user: AuthenticatedUser, siteId: string, action: string, targetId?: string) {
    return this.audit.record({
      transaction: tx, organizationId: user.organizationId, siteId, actorId: user.id,
      action: `site_user.${action}`, targetType: targetId ? "User" : "Site", targetId: targetId ?? siteId, outcome: "success"
    });
  }
  private nextUpdatedAt(previous: Date) { return new Date(Math.max(Date.now(), previous.getTime() + 1)); }
  private changed() { return new ConflictException({ code: "SITE_USER_CHANGED", message: "site user changed; reload and retry" }); }
  private invalidInput() { return new BadRequestException({ code: "INVALID_INPUT", message: "invalid site user input" }); }
  private parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw this.invalidInput();
    return parsed.data;
  }
  private assertAdmin(user: AuthenticatedUser) {
    if (user.role !== "admin" || user.status !== "active" || user.organizationType !== "customer") {
      throw new ForbiddenException({ code: "SITE_CAPABILITY_DENIED", message: "site user management requires admin" });
    }
  }
  private errorCode(error: unknown) {
    return typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
  }
}
