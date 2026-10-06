import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type MonitoringIncidentDismissalRequest } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { runSiteUserTransaction } from "../access/site-user-policy";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { lockIncidentPersonalAccess } from "./monitoring-incident-personal-access";
import { parseDismissAllIncidents, parseIncidentReadTarget, type DismissAllIncidentsResponse, type DismissIncidentResponse } from "./monitoring-incidents.dto";

@Injectable()
export class MonitoringIncidentDismissalService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService) {}

  async dismiss(user: AuthenticatedUser, siteId: string, incidentId: string): Promise<DismissIncidentResponse> {
    parseIncidentReadTarget(siteId, incidentId);
    await this.access.assert(user, siteId, "read");
    return runSiteUserTransaction(this.prisma, async tx => {
      await lockIncidentPersonalAccess(tx, user, siteId, this.access);
      const targets = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MonitoringIncident"
        WHERE "siteId"=${siteId} AND "id"=${incidentId} FOR KEY SHARE`;
      if (!targets.length) throw new NotFoundException("incident not found");
      const saved = await tx.monitoringIncidentDismissal.upsert({
        where: { incidentId_userId: { incidentId, userId: user.id } },
        create: { incidentId, userId: user.id }, update: {}
      });
      return { incidentId, isDismissed: true, dismissedAt: saved.dismissedAt.toISOString() };
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }

  async dismissAll(user: AuthenticatedUser, siteId: string, input: unknown): Promise<DismissAllIncidentsResponse> {
    const { clientRequestId } = parseDismissAllIncidents(siteId, input);
    await this.access.assert(user, siteId, "read");
    // Commit the entire frozen set before any effect. A post-commit failure must
    // leave a retryable pending reservation, never a new target selection.
    await runSiteUserTransaction(this.prisma, async tx => {
      await lockIncidentPersonalAccess(tx, user, siteId, this.access);
      await tx.$executeRaw`WITH targets AS MATERIALIZED (
        SELECT i."id" FROM "MonitoringIncident" i WHERE i."siteId"=${siteId}
        AND NOT EXISTS (SELECT 1 FROM "MonitoringIncidentDismissal" d WHERE d."incidentId"=i."id" AND d."userId"=${user.id})
        AND NOT EXISTS (SELECT 1 FROM "MonitoringIncidentDismissalRequest" r
          WHERE r."siteId"=${siteId} AND r."userId"=${user.id} AND r."clientRequestId"=${clientRequestId}::uuid)
      ) INSERT INTO "MonitoringIncidentDismissalRequest" ("siteId", "userId", "clientRequestId", "snapshotAt", "targetIncidentIds")
        SELECT ${siteId}, ${user.id}, ${clientRequestId}::uuid, statement_timestamp() AT TIME ZONE 'UTC',
          COALESCE(array_agg("id" ORDER BY "id"), ARRAY[]::text[]) FROM targets
        ON CONFLICT ("siteId", "userId", "clientRequestId") DO NOTHING`;
    }, Prisma.TransactionIsolationLevel.ReadCommitted);

    return runSiteUserTransaction(this.prisma, async tx => {
      // Authorization is independently refreshed after reservation commit.
      await lockIncidentPersonalAccess(tx, user, siteId, this.access);
      const [request] = await tx.$queryRaw<MonitoringIncidentDismissalRequest[]>`SELECT * FROM "MonitoringIncidentDismissalRequest"
        WHERE "siteId"=${siteId} AND "userId"=${user.id} AND "clientRequestId"=${clientRequestId}::uuid FOR UPDATE`;
      if (!request) throw new NotFoundException("dismissal request not found");
      let dismissedCount = request.dismissedCount;
      if (request.completedAt === null) {
        // Lock surviving parents before FK insertion. IDs removed or moved out
        // of this site since acceptance are skipped; the stored set stays intact.
        const [effect] = await tx.$queryRaw<{ count: number }[]>`WITH targets AS MATERIALIZED (
          SELECT i."id" FROM "MonitoringIncident" i WHERE i."siteId"=${siteId}
            AND i."id"=ANY(${request.targetIncidentIds}::text[]) FOR KEY SHARE
        ), inserted AS (
          INSERT INTO "MonitoringIncidentDismissal" ("incidentId", "userId") SELECT "id", ${user.id} FROM targets
          ON CONFLICT ("incidentId", "userId") DO NOTHING RETURNING "incidentId"
        ) SELECT count(*)::integer AS count FROM inserted`;
        dismissedCount = effect.count;
        await tx.$executeRaw`UPDATE "MonitoringIncidentDismissalRequest" SET "dismissedCount"=${dismissedCount},
          "completedAt"=statement_timestamp() AT TIME ZONE 'UTC'
          WHERE "siteId"=${siteId} AND "userId"=${user.id} AND "clientRequestId"=${clientRequestId}::uuid`;
      }
      // PostgreSQL UUID identity ignores casing; replay the stored canonical key
      // too, so equivalent spellings cannot change an already accepted response.
      return { siteId: request.siteId, clientRequestId: request.clientRequestId,
        snapshotAt: request.snapshotAt.toISOString(), dismissedCount: dismissedCount! };
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }
}
