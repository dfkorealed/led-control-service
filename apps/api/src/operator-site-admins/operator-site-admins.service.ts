import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { normalizeLoginId, type AuthenticatedUser } from "../auth/auth.types";
import { PasswordService } from "../auth/password.service";
import { lockUserForPasswordMutation } from "../auth/user-password-lock";
import { PrismaService } from "../prisma/prisma.service";
import { SiteDeletionCleanupService } from "./site-deletion-cleanup.service";

export interface CreateSiteAdminInput {
  customerName: string;
  siteName: string;
  adminName: string;
  loginId: string;
  initialPassword: string;
}

export interface CreateReplacementAdminInput {
  adminName: string;
  loginId: string;
  initialPassword: string;
}

export interface UpdateSiteAdminInput {
  adminName: string;
  loginId: string;
}

export interface SiteAdminSummary {
  siteId: string;
  customerName: string;
  siteName: string;
  installationStatus: "pending" | "installed";
  admin: {
    id: string;
    loginId: string;
    name: string;
    status: "active" | "disabled";
    updatedAt: Date;
  } | null;
}

const managedAdminSelect = {
  id: true,
  organizationId: true,
  administeredSite: {
    select: {
      id: true,
      name: true,
      gateways: {
        select: {
          id: true,
          inventory: { select: { id: true } },
          certificates: {
            select: { inventory: { select: { id: true, claimedGatewayId: true } } }
          }
        }
      },
      floors: { select: { assets: { select: { objectKey: true } } } }
    }
  }
} as const;

@Injectable()
export class OperatorSiteAdminsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly deletionCleanup: SiteDeletionCleanupService
  ) {}

  async list(user: AuthenticatedUser): Promise<SiteAdminSummary[]> {
    this.assertOperator(user);
    const sites = await this.prisma.site.findMany({
      where: { organization: { type: "customer" } },
      select: {
        id: true,
        name: true,
        address: true,
        tariffKwhRate: true,
        organization: { select: { name: true } },
        admin: { select: { id: true, loginId: true, name: true, status: true, updatedAt: true } },
        _count: { select: { floors: true } }
      },
      orderBy: [{ organization: { name: "asc" } }, { name: "asc" }]
    });
    return sites.map((site) => this.toSummary(site));
  }

  async createSiteAdmin(user: AuthenticatedUser, input: CreateSiteAdminInput): Promise<SiteAdminSummary> {
    this.assertOperator(user);
    const validated = this.validateCreateInput(input);
    const passwordHash = await this.passwords.hash(validated.initialPassword);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({ data: { name: validated.customerName, type: "customer" } });
        const admin = await tx.user.create({
          data: {
            organizationId: organization.id,
            loginId: validated.loginId,
            email: null,
            name: validated.adminName,
            passwordHash,
            role: "admin",
            status: "active"
          },
          select: { id: true, loginId: true, name: true, status: true, updatedAt: true }
        });
        const site = await tx.site.create({
          data: {
            organizationId: organization.id,
            adminUserId: admin.id,
            name: validated.siteName,
            address: null,
            tariffKwhRate: null
          },
          select: { id: true, name: true, address: true, tariffKwhRate: true, _count: { select: { floors: true } } }
        });
        await this.audit.record({
          transaction: tx,
          organizationId: organization.id,
          siteId: site.id,
          actorId: user.id,
          action: "operator.site_admin_created",
          targetType: "User",
          targetId: admin.id,
          outcome: "success",
          metadata: { loginId: admin.loginId }
        });
        return this.toSummary({ ...site, organization: { name: organization.name }, admin });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.throwMappedPrismaError(error);
    }
  }

  async createReplacementAdmin(
    user: AuthenticatedUser,
    siteId: string,
    input: CreateReplacementAdminInput
  ): Promise<SiteAdminSummary> {
    this.assertOperator(user);
    const targetSiteId = this.requiredString(siteId, "siteId");
    const validated = this.validateReplacementInput(input);
    const passwordHash = await this.passwords.hash(validated.initialPassword);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const site = await tx.site.findFirst({
          where: { id: targetSiteId, adminUserId: null, organization: { type: "customer" } },
          select: {
            id: true,
            organizationId: true,
            name: true,
            address: true,
            tariffKwhRate: true,
            organization: { select: { name: true } },
            _count: { select: { floors: true } }
          }
        });
        if (!site) throw new NotFoundException("unassigned customer site not found");
        const admin = await tx.user.create({
          data: {
            organizationId: site.organizationId,
            loginId: validated.loginId,
            email: null,
            name: validated.adminName,
            passwordHash,
            role: "admin",
            status: "active"
          },
          select: { id: true, loginId: true, name: true, status: true, updatedAt: true }
        });
        await tx.site.update({ where: { id: site.id }, data: { adminUserId: admin.id } });
        await this.audit.record({
          transaction: tx,
          organizationId: site.organizationId,
          siteId: site.id,
          actorId: user.id,
          action: "operator.site_admin_replaced",
          targetType: "User",
          targetId: admin.id,
          outcome: "success",
          metadata: { loginId: admin.loginId }
        });
        return this.toSummary({ ...site, admin });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.throwMappedPrismaError(error);
    }
  }

  async update(user: AuthenticatedUser, userId: string, input: UpdateSiteAdminInput) {
    this.assertOperator(user);
    const adminId = this.requiredString(userId, "userId");
    const validated = this.validateUpdateInput(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const admin = await this.findManagedAdmin(tx, adminId);
        const updated = await tx.user.update({
          where: { id: admin.id },
          data: { name: validated.adminName, loginId: validated.loginId },
          select: { id: true, loginId: true, name: true, status: true, updatedAt: true }
        });
        await this.audit.record({
          transaction: tx,
          organizationId: admin.organizationId,
          siteId: admin.administeredSite!.id,
          actorId: user.id,
          action: "operator.site_admin_updated",
          targetType: "User",
          targetId: admin.id,
          outcome: "success",
          metadata: { loginId: updated.loginId }
        });
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.throwMappedPrismaError(error);
    }
  }

  async resetPassword(user: AuthenticatedUser, userId: string, newPassword: unknown) {
    this.assertOperator(user);
    const adminId = this.requiredString(userId, "userId");
    const passwordHash = await this.passwords.hash(this.requiredPassword(newPassword, "newPassword"));
    try {
      // READ COMMITTED refreshes the snapshot after a blocked login releases the
      // User row, so the session created immediately before reset is revoked too.
      return await this.prisma.$transaction(async (tx) => {
        if (!await lockUserForPasswordMutation(tx, adminId)) {
          throw new NotFoundException("active assigned site admin not found");
        }
        const admin = await this.findManagedAdmin(tx, adminId);
        await tx.user.update({ where: { id: admin.id }, data: { passwordHash } });
        const revokedSessions = await tx.session.updateMany({
          where: { userId: admin.id, revokedAt: null },
          data: { revokedAt: new Date() }
        });
        await this.audit.record({
          transaction: tx,
          organizationId: admin.organizationId,
          siteId: admin.administeredSite!.id,
          actorId: user.id,
          action: "operator.site_admin_password_reset",
          targetType: "User",
          targetId: admin.id,
          outcome: "success",
          metadata: { revokedSessionCount: revokedSessions.count }
        });
        return { ok: true };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      this.throwMappedPrismaError(error);
    }
  }

  async deleteSiteAdmin(user: AuthenticatedUser, userId: string, confirmationSiteName: unknown) {
    this.assertOperator(user);
    const adminId = this.requiredString(userId, "userId");
    const confirmedName = this.exactConfirmationName(confirmationSiteName);
    try {
      const deletionTarget = await this.findManagedAdmin(this.prisma, adminId);
      const targetSite = deletionTarget.administeredSite!;
      if (targetSite.name !== confirmedName) {
        throw new BadRequestException("confirmationSiteName does not match the site name");
      }

      const assetKeys = this.assetKeys(targetSite.floors ?? []);
      const inventoryIds = this.inventoryIds(targetSite.gateways);
      const deletion = await this.prisma.$transaction(async (tx) => {
        const admin = await this.findManagedAdmin(tx, adminId);
        const site = admin.administeredSite!;
        const currentInventoryIds = this.inventoryIds(site.gateways);
        const currentAssetKeys = this.assetKeys(site.floors ?? []);
        if (
          site.id !== targetSite.id
          || site.name !== confirmedName
          || !this.sameIds(inventoryIds, currentInventoryIds)
          || !this.sameIds(assetKeys, currentAssetKeys)
        ) {
          throw new ConflictException("site changed during deletion, please retry");
        }

        const gatewayIds = site.gateways.map((gateway) => gateway.id);
        await tx.gatewayInventory.updateMany({
          where: {
            OR: [
              { claimedGatewayId: { in: gatewayIds } },
              { id: { in: inventoryIds } }
            ]
          },
          data: { disabledAt: new Date() }
        });
        const organizationSiteCount = await tx.site.count({ where: { organizationId: admin.organizationId } });
        if (organizationSiteCount === 1) {
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "User"
            WHERE "organizationId" = ${admin.organizationId}
            ORDER BY "id" FOR UPDATE
          `);
        } else {
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "User" WHERE "id" = ${admin.id} FOR UPDATE
          `);
        }
        const cleanup = await tx.siteDeletionCleanup.create({
          data: { siteId: site.id, inventoryIds, objectKeys: assetKeys }
        });
        await tx.site.delete({ where: { id: site.id } });

        if (organizationSiteCount === 1) {
          await tx.session.deleteMany({ where: { user: { organizationId: admin.organizationId } } });
          await tx.invitation.deleteMany({ where: { organizationId: admin.organizationId } });
          await tx.user.deleteMany({ where: { organizationId: admin.organizationId } });
          await tx.organization.delete({ where: { id: admin.organizationId } });
        } else {
          await tx.session.deleteMany({ where: { userId: admin.id } });
          await tx.user.delete({ where: { id: admin.id } });
        }

        await this.audit.record({
          transaction: tx,
          organizationId: user.organizationId,
          actorId: user.id,
          action: "operator.site_deleted",
          targetType: "Site",
          targetId: site.id,
          outcome: "success",
          metadata: {
            siteName: site.name,
            customerOrganizationId: admin.organizationId,
            gatewayCount: site.gateways.length
          }
        });
        return { cleanupId: cleanup.id };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      // The committed cleanup row is the authority. Immediate processing keeps the
      // common path fast; startup/polling retries preserve eventual cleanup on failure.
      await this.deletionCleanup.processNow(deletion.cleanupId).catch(() => undefined);
      return { ok: true };
    } catch (error) {
      this.throwMappedPrismaError(error);
    }
  }

  private async findManagedAdmin(tx: Pick<Prisma.TransactionClient, "user">, userId: string) {
    const admin = await tx.user.findFirst({
      where: {
        id: userId,
        role: "admin",
        status: "active",
        organization: { type: "customer" },
        administeredSite: { isNot: null }
      },
      select: managedAdminSelect
    });
    if (!admin?.administeredSite) throw new NotFoundException("active assigned site admin not found");
    return admin;
  }

  private inventoryIds(gateways: ReadonlyArray<{
    id: string;
    inventory: { id: string } | null;
    certificates?: ReadonlyArray<{ inventory: { id: string; claimedGatewayId: string | null } }>;
  }>) {
    const inventoryIds = new Set<string>();
    for (const gateway of gateways) {
      if (gateway.inventory) inventoryIds.add(gateway.inventory.id);
      for (const certificate of gateway.certificates ?? []) {
        if (certificate.inventory.claimedGatewayId && certificate.inventory.claimedGatewayId !== gateway.id) {
          throw new ConflictException("gateway certificate inventory ownership mismatch");
        }
        inventoryIds.add(certificate.inventory.id);
      }
    }
    return [...inventoryIds].sort();
  }

  private assetKeys(floors: ReadonlyArray<{ assets: ReadonlyArray<{ objectKey: string }> }>) {
    return floors.flatMap((floor) => floor.assets.map((asset) => asset.objectKey)).sort();
  }

  private sameIds(left: string[], right: string[]) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  private toSummary(site: {
    id: string;
    name: string;
    address: unknown;
    tariffKwhRate: unknown;
    organization: { name: string };
    _count: { floors: number };
    admin: { id: string; loginId: string; name: string; status: "active" | "disabled"; updatedAt: Date } | null;
  }): SiteAdminSummary {
    return {
      siteId: site.id,
      customerName: site.organization.name,
      siteName: site.name,
      installationStatus: site.address !== null && site.tariffKwhRate !== null && site._count.floors > 0 ? "installed" : "pending",
      admin: site.admin
    };
  }

  private validateCreateInput(input: CreateSiteAdminInput) {
    if (!this.isRecord(input)) throw new BadRequestException("site admin payload must be an object");
    return {
      customerName: this.requiredString(input.customerName, "customerName"),
      siteName: this.requiredString(input.siteName, "siteName"),
      adminName: this.requiredString(input.adminName, "adminName"),
      loginId: normalizeLoginId(input.loginId),
      initialPassword: this.requiredPassword(input.initialPassword, "initialPassword")
    };
  }

  private validateReplacementInput(input: CreateReplacementAdminInput) {
    if (!this.isRecord(input)) throw new BadRequestException("site admin payload must be an object");
    return {
      adminName: this.requiredString(input.adminName, "adminName"),
      loginId: normalizeLoginId(input.loginId),
      initialPassword: this.requiredPassword(input.initialPassword, "initialPassword")
    };
  }

  private validateUpdateInput(input: UpdateSiteAdminInput) {
    if (!this.isRecord(input)) throw new BadRequestException("site admin payload must be an object");
    return { adminName: this.requiredString(input.adminName, "adminName"), loginId: normalizeLoginId(input.loginId) };
  }

  private assertOperator(user: AuthenticatedUser) {
    if (user.role !== "operator" || user.status !== "active" || user.organizationType !== "service_provider") {
      throw new ForbiddenException("operator site admin management requires an active service-provider operator");
    }
  }

  private requiredString(value: unknown, name: string) {
    if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
    return value.trim();
  }

  private exactConfirmationName(value: unknown) {
    if (typeof value !== "string" || !value) {
      throw new BadRequestException("confirmationSiteName is required");
    }
    return value;
  }

  private requiredPassword(value: unknown, name: string) {
    if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
    return value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private throwMappedPrismaError(error: unknown): never {
    if (this.isPrismaError(error, "P2002")) throw new ConflictException("loginId already exists");
    if (this.isPrismaError(error, "P2034") || this.isPrismaError(error, "40001")) {
      throw new ConflictException("operator site admin transaction conflicted, please retry");
    }
    throw error;
  }

  private isPrismaError(error: unknown, code: string) {
    return (error instanceof Prisma.PrismaClientKnownRequestError && error.code === code)
      || (typeof error === "object" && error !== null && (
        (error as { code?: unknown }).code === code
        || (error as { meta?: { code?: unknown } }).meta?.code === code
      ));
  }
}
