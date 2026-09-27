import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { FIXTURE_OPERATIONAL_FRESHNESS_MS, gatewayHeartbeatFreshSince } from "@led-control/shared";
import { MonitoringIncidentReconcilerService } from "../monitoring-incidents/monitoring-incident-reconciler.service";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class FixtureFreshnessService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FixtureFreshnessService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciler: MonitoringIncidentReconcilerService
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.markStaleFixtures().catch((error) => {
        this.logFailure(error, "sweep");
      }).finally(() => { this.running = false; });
    }, Number(process.env.FIXTURE_FRESHNESS_POLL_MS ?? 30_000));
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async markStaleFixtures(observedAt?: Date) {
    const sites = await this.prisma.site.findMany({ select: { id: true }, orderBy: { id: "asc" } });
    const totals = { gatewayOffline: 0, fixtureStale: 0 };
    for (const { id: siteId } of sites) {
      const counts = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE
        `);
        if (!locked.length) return { gatewayOffline: 0, fixtureStale: 0 };
        const site = await tx.site.findUnique({ where: { id: siteId }, select: {
          id: true, gatewayOfflineAfterSeconds: true, fixtureStaleAfterSeconds: true
        } });
        if (!site) return { gatewayOffline: 0, fixtureStale: 0 };
        // Match manual recovery and target deletion: Site → Gateway → Fixture →
        // Incident. NO KEY UPDATE blocks heartbeat writes but permits ingestion's
        // Gateway FK KEY SHARE while it owns Fixture, avoiding an inverse wait.
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "Gateway" WHERE "siteId" = ${siteId} ORDER BY "id" FOR NO KEY UPDATE
        `);
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "Fixture" WHERE "siteId" = ${siteId} ORDER BY "id" FOR UPDATE
        `);
        // Sample after lock waits. An explicit observation time is used by
        // deterministic callers; scheduled sweeps always use the current clock.
        const now = observedAt ?? new Date();
        // Persisted operational status is consumed by Commands/Identify. Never
        // let a monitoring preference alter their fixed 90초/20분 safety policy.
        const gatewayCutoff = gatewayHeartbeatFreshSince(now);
        const fixtureCutoff = new Date(now.getTime() - FIXTURE_OPERATIONAL_FRESHNESS_MS);
        const applyOffline = async (condition: Prisma.Sql, statusReason: "gateway_offline" | "fixture_stale") => {
          // The Site → Gateway → Fixture locks above serialize state writers. A
          // materialized snapshot retains each row's *previous* status while one
          // UPDATE and INSERT project the entire Site atomically. Looping Prisma
          // 500-row batches here exceeded the 5s transaction budget at 6000 rows.
          const [result] = await tx.$queryRaw<{ changed: bigint }[]>(Prisma.sql`
            WITH candidates AS MATERIALIZED (
              SELECT f."id", f."floorId", f."name", f."status"
              FROM "Fixture" f
              WHERE f."siteId" = ${siteId}
                AND f."reportedStatusReason" IS DISTINCT FROM 'provisioning_waiting_state'
                AND (f."status" <> 'offline'::"FixtureStatus" OR f."statusReason" IS DISTINCT FROM ${statusReason})
                AND EXISTS (
                  SELECT 1 FROM "MeshNode" n
                  JOIN "Gateway" g ON g."id" = n."gatewayId"
                  WHERE n."id" = f."meshNodeId" AND n."gatewayId" = f."gatewayId" AND ${condition}
                )
            ), updated AS (
              UPDATE "Fixture" f
              SET "status" = 'offline'::"FixtureStatus", "statusReason" = ${statusReason},
                  "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
              FROM candidates c WHERE f."id" = c."id"
              RETURNING c."id", c."floorId", c."name", c."status"
            ), activity AS (
              INSERT INTO "MonitoringActivity" ("id", "siteId", "floorId", "sourceType", "sourceKey",
                "kind", "fixtureId", "displayName", "status")
              SELECT gen_random_uuid()::text, ${siteId}, u."floorId", 'gateway_freshness', gen_random_uuid()::text,
                'fixture_offline'::"MonitoringActivityKind", u."id", u."name", 'offline'::"FixtureStatus"
              FROM updated u WHERE u."status" <> 'offline'::"FixtureStatus"
              RETURNING "id"
            )
            SELECT count(*)::bigint AS "changed" FROM updated
          `);
          return Number(result.changed);
        };
        const gatewayOffline = await applyOffline(Prisma.sql`
          (g."lastHeartbeatAt" < ${gatewayCutoff} OR g."lastHeartbeatAt" IS NULL)
        `, "gateway_offline");
        // A recovered gateway can leave an already-offline fixture stale. Compare
        // receipt clocks, not a wall cutoff, for manual verification failures.
        const fixtureStale = await applyOffline(Prisma.sql`
          g."lastHeartbeatAt" >= ${gatewayCutoff} AND (
            f."lastSeenAt" < ${fixtureCutoff} OR f."lastSeenAt" IS NULL OR
            f."lastUnreachableAt" > f."lastSeenAt"
          )
        `, "fixture_stale");
        await this.reconciler.reconcile(tx, site, now);
        return { gatewayOffline, fixtureStale };
      }, { maxWait: 2000, timeout: 5000 }).catch((error) => {
        // One unavailable Site must not starve later Sites. The transaction
        // rolls back, and the next scheduled sweep retries the same Site.
        this.logFailure(error, "site sweep");
        return { gatewayOffline: 0, fixtureStale: 0 };
      });
      totals.gatewayOffline += counts.gatewayOffline;
      totals.fixtureStale += counts.fixtureStale;
    }
    return totals;
  }

  private logFailure(error: unknown, scope: "sweep" | "site sweep") {
    // Error messages and arbitrary code strings can contain tenant identifiers.
    // Only a canonical Prisma error code is safe to include in worker logs.
    const code = typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^P\d{4}$/.test(error.code) ? error.code : "UNEXPECTED_ERROR";
    this.logger.error(`fixture freshness ${scope} failed (error=${code})`);
  }
}
