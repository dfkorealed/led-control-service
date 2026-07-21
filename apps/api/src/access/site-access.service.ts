import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

export type SiteCapability = "read" | "manage" | "commission";

@Injectable()
export class SiteAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assert(user: AuthenticatedUser, siteId: string, capability: SiteCapability) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        organizationId: true,
        memberships: { where: { userId: user.id }, select: { id: true } }
      }
    });
    if (!site) throw new NotFoundException("site not found");

    const assigned = site.memberships.length > 0;
    const customerAdmin = user.role === "admin" && site.organizationId === user.organizationId;
    const canRead = customerAdmin || assigned;
    const canManage = user.role === "admin" ? customerAdmin : user.role === "operator" && assigned;
    const canCommission = user.role === "operator" && assigned;
    const permitted = capability === "read" ? canRead : capability === "manage" ? canManage : canCommission;

    if (!permitted) {
      if (!canRead) throw new NotFoundException("site not found");
      throw new ForbiddenException("site capability denied");
    }
    return site;
  }

  async listAccessibleSiteIds(user: AuthenticatedUser) {
    if (user.role === "admin") {
      const sites = await this.prisma.site.findMany({
        where: { organizationId: user.organizationId },
        select: { id: true }
      });
      return sites.map((site) => site.id);
    }

    const memberships = await this.prisma.siteMembership.findMany({
      where: { userId: user.id },
      select: { siteId: true }
    });
    return memberships.map((membership) => membership.siteId);
  }
}
