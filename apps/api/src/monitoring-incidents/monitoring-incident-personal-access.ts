import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";

/** Called inside runSiteUserTransaction after its advisory gate. Keep the same
 * Site -> User -> membership order as assignment and account revocation writes. */
export async function lockIncidentPersonalAccess(tx: Prisma.TransactionClient, user: AuthenticatedUser,
  siteId: string, access: SiteAccessService): Promise<void> {
  const sites = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`);
  if (!sites.length) throw new NotFoundException("site not found");
  // SHARE blocks status/password changes too, unlike KEY SHARE.
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR SHARE`);
  const actor = await tx.user.findUnique({ where: { id: user.id }, select: {
    id: true, organizationId: true, role: true, status: true, mustChangePassword: true,
    organization: { select: { type: true } }
  } });
  if (!actor || actor.status !== "active" || actor.role !== user.role || actor.organizationId !== user.organizationId
    || actor.organization.type !== user.organizationType) throw new NotFoundException("site not found");
  if (actor.mustChangePassword) throw new ForbiddenException({ code: "PASSWORD_CHANGE_REQUIRED", message: "Password change required" });
  if (actor.role === "viewer") {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SiteMembership" WHERE "siteId" = ${siteId} AND "userId" = ${user.id} FOR SHARE`);
  }
  await access.assertReadInTransaction(tx, user, siteId);
}
