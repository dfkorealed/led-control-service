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
        const observedFixture = { OR: [
          { reportedStatusReason: { not: "provisioning_waiting_state" } }, { reportedStatusReason: null }
        ] };
        const gatewayOffline = await tx.fixture.updateMany({
          where: { siteId, ...observedFixture,
            meshNode: { gateway: { OR: [{ lastHeartbeatAt: { lt: gatewayCutoff } }, { lastHeartbeatAt: null }] } } },
          data: { status: "offline", statusReason: "gateway_offline" }
        });
        const fixtureStale = await tx.fixture.updateMany({
          where: { siteId,
            // A recovered gateway can leave an already-offline fixture stale.
            // Require an online gateway instead of excluding offline fixtures.
            meshNode: { gateway: { lastHeartbeatAt: { gte: gatewayCutoff } } },
            AND: [observedFixture, { OR: [{ lastSeenAt: { lt: fixtureCutoff } }, { lastSeenAt: null }] }]
          },
          data: { status: "offline", statusReason: "fixture_stale" }
        });
        await this.reconciler.reconcile(tx, site, now);
        return { gatewayOffline: gatewayOffline.count, fixtureStale: fixtureStale.count };
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
