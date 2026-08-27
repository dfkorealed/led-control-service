import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

export type SiteCapability = "read" | "manage" | "commission";

@Injectable()
export class SiteAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assert(user: AuthenticatedUser, siteId: string, capability: SiteCapability) {
    if (!this.hasValidOrganizationType(user)) {
      throw new NotFoundException("site not found");
    }

    const usesMembership = user.role === "viewer";
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        organizationId: true,
        adminUserId: true,
        ...(usesMembership ? { memberships: { where: { userId: user.id }, select: { id: true } } } : {})
      }
    });
    if (!site) throw new NotFoundException("site not found");

    const assignedViewer = "memberships" in site && site.memberships.length > 0;
    const assignedAdmin = user.role === "admin"
      && user.status === "active"
      && site.adminUserId === user.id
      && site.organizationId === user.organizationId;
    const validViewerMembership = user.role === "viewer" && site.organizationId === user.organizationId;
    const canRead = assignedAdmin || (usesMembership && assignedViewer && validViewerMembership);
    const canManage = assignedAdmin;
    const canCommission = assignedAdmin;
    const permitted = capability === "read" ? canRead : capability === "manage" ? canManage : canCommission;

    if (!permitted) {
      if (!canRead) throw new NotFoundException("site not found");
      throw new ForbiddenException("site capability denied");
    }
    return site;
  }

  async assertCommissionInTransaction(
    tx: Pick<Prisma.TransactionClient, "$queryRaw" | "site">,
    user: AuthenticatedUser,
    siteId: string
  ) {
    if (!this.isActiveCustomerAdmin(user)) throw new NotFoundException("site not found");

    // Claiming mutates inventory, so authorization is read only after the target site lock.
    // This prevents a reassigned or disabled admin from completing a stale claim request.
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE
    `);
    if (locked.length === 0) throw new NotFoundException("site not found");

    const site = await tx.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        organizationId: true,
        adminUserId: true,
        admin: {
          select: {
            id: true,
            organizationId: true,
            role: true,
            status: true,
            organization: { select: { type: true } }
          }
        }
      }
    });
    if (!site || !this.isAssignedActiveCustomerAdmin(site, user)) {
      throw new NotFoundException("site not found");
    }
    return site;
  }

  async listAccessibleSiteIds(user: AuthenticatedUser) {
    if (!this.hasValidOrganizationType(user)) {
      return [];
    }

    if (user.role === "admin") {
      const sites = await this.prisma.site.findMany({
        where: { adminUserId: user.id },
        select: { id: true }
      });
      return sites.map((site) => site.id);
    }

    if (user.role === "operator") return [];

    const memberships = await this.prisma.siteMembership.findMany({
      where: { userId: user.id },
      select: { siteId: true, site: { select: { organizationId: true } } }
    });
    return memberships
      .filter((membership) => user.role !== "viewer" || membership.site.organizationId === user.organizationId)
      .map((membership) => membership.siteId);
  }

  private hasValidOrganizationType(user: AuthenticatedUser) {
    return user.status === "active"
      && ((user.role === "operator" && user.organizationType === "service_provider") ||
        ((user.role === "admin" || user.role === "viewer") && user.organizationType === "customer"));
  }

  private isActiveCustomerAdmin(user: AuthenticatedUser) {
    return user.role === "admin" && user.status === "active" && user.organizationType === "customer";
  }

  private isAssignedActiveCustomerAdmin(
    site: {
      organizationId: string;
      adminUserId: string | null;
      admin: { id: string; organizationId: string; role: string; status: string; organization: { type: string } } | null;
    },
    user: AuthenticatedUser
  ) {
    return this.isActiveCustomerAdmin(user)
      && site.adminUserId === user.id
      && site.organizationId === user.organizationId
      && site.admin?.id === user.id
      && site.admin.organizationId === user.organizationId
      && site.admin.role === "admin"
      && site.admin.status === "active"
      && site.admin.organization.type === "customer";
  }
}
