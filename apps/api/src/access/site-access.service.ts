import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

export type SiteCapability = "read" | "control" | "manage" | "commission";

export interface SiteCapabilities {
  read: boolean;
  control: boolean;
  manage: boolean;
  commission: boolean;
}

@Injectable()
export class SiteAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assert(user: AuthenticatedUser, siteId: string, capability: SiteCapability) {
    return this.assertCapability(this.prisma, user, siteId, capability);
  }

  async capabilities(user: AuthenticatedUser, siteId: string): Promise<SiteCapabilities> {
    const { site, capabilities } = await this.loadCapabilities(this.prisma, user, siteId);
    if (!capabilities.read) {
      throw new NotFoundException("site not found");
    }
    return capabilities;
  }

  async assertReadInTransaction(
    tx: Pick<Prisma.TransactionClient, "site">,
    user: AuthenticatedUser,
    siteId: string
  ) {
    return this.assertCapability(tx, user, siteId, "read");
  }

  async assertControlInTransaction(
    tx: Pick<Prisma.TransactionClient, "$queryRaw" | "site">,
    user: AuthenticatedUser,
    siteId: string
  ) {
    if (user.role === "admin") {
      return this.assertAssignedAdminInTransaction(tx, user, siteId);
    }
    if (!this.isActiveCustomerViewer(user)) {
      throw new NotFoundException("site not found");
    }

    // Site is locked before membership/user reauthorization, matching admin writes.
    // This prevents a request prechecked before disable, reassignment, or membership
    // removal from authorizing an operation after the concurrent change commits.
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE
    `);
    if (locked.length === 0) throw new NotFoundException("site not found");

    const site = await tx.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        organizationId: true,
        memberships: {
          where: { userId: user.id },
          select: {
            accessLevel: true,
            user: {
              select: {
                id: true,
                organizationId: true,
                role: true,
                status: true,
                organization: { select: { type: true } }
              }
            }
          }
        }
      }
    });
    if (!site || !this.hasControlMembership(site.organizationId, site.memberships[0], user)) {
      throw new NotFoundException("site not found");
    }
    return site;
  }

  private async assertCapability(
    client: Pick<Prisma.TransactionClient, "site">,
    user: AuthenticatedUser,
    siteId: string,
    capability: SiteCapability
  ) {
    const { site, capabilities } = await this.loadCapabilities(client, user, siteId);
    if (!site || !capabilities.read) throw new NotFoundException("site not found");
    const permitted = capabilities[capability];

    if (!permitted) {
      throw new ForbiddenException("site capability denied");
    }
    return site;
  }

  private async loadCapabilities(
    client: Pick<Prisma.TransactionClient, "site">,
    user: AuthenticatedUser,
    siteId: string
  ) {
    const empty: SiteCapabilities = { read: false, control: false, manage: false, commission: false };
    if (!this.hasValidOrganizationType(user)) {
      return { site: null, capabilities: empty };
    }

    const usesMembership = user.role === "viewer";
    const site = await client.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        timeZone: true,
        organizationId: true,
        adminUserId: true,
        ...(usesMembership ? {
          memberships: { where: { userId: user.id }, select: { id: true, accessLevel: true } }
        } : {})
      }
    });
    if (!site) return { site: null, capabilities: empty };

    const assignedAdmin = user.role === "admin"
      && site.adminUserId === user.id
      && site.organizationId === user.organizationId;
    const membership = "memberships" in site ? site.memberships[0] : undefined;
    const validViewerMembership = user.role === "viewer" && site.organizationId === user.organizationId && Boolean(membership);
    const canControl = assignedAdmin || (validViewerMembership && membership?.accessLevel === "control");
    const canRead = assignedAdmin || validViewerMembership;
    return {
      site,
      capabilities: {
        read: canRead,
        control: canControl,
        manage: assignedAdmin,
        commission: assignedAdmin
      }
    };
  }

  async assertCommissionInTransaction(
    tx: Pick<Prisma.TransactionClient, "$queryRaw" | "site">,
    user: AuthenticatedUser,
    siteId: string
  ) {
    return this.assertAssignedAdminInTransaction(tx, user, siteId);
  }

  async assertManageInTransaction(
    tx: Pick<Prisma.TransactionClient, "$queryRaw" | "site">,
    user: AuthenticatedUser,
    siteId: string
  ) {
    return this.assertAssignedAdminInTransaction(tx, user, siteId);
  }

  private async assertAssignedAdminInTransaction(
    tx: Pick<Prisma.TransactionClient, "$queryRaw" | "site">,
    user: AuthenticatedUser,
    siteId: string
  ) {
    if (!this.isActiveCustomerAdmin(user)) throw new NotFoundException("site not found");

    // Production writes authorize only after locking Site. Assignment and User
    // status triggers share this lock order, blocking stale reassignment commits.
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

  private isActiveCustomerViewer(user: AuthenticatedUser) {
    return user.role === "viewer" && user.status === "active" && user.organizationType === "customer";
  }

  private hasControlMembership(
    siteOrganizationId: string,
    membership: {
      accessLevel: "read" | "control";
      user: { id: string; organizationId: string; role: string; status: string; organization: { type: string } };
    } | undefined,
    user: AuthenticatedUser
  ) {
    return membership?.accessLevel === "control"
      && membership.user.id === user.id
      && membership.user.organizationId === user.organizationId
      && membership.user.organizationId === siteOrganizationId
      && membership.user.role === "viewer"
      && membership.user.status === "active"
      && membership.user.organization.type === "customer";
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
