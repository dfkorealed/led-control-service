import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          ? error.code
          : "UNEXPECTED_ERROR";
        this.logger.error(`fixture freshness sweep failed (error=${code})`);
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
        const gatewayCutoff = new Date(now.getTime() - site.gatewayOfflineAfterSeconds * 1000);
        const fixtureCutoff = new Date(now.getTime() - site.fixtureStaleAfterSeconds * 1000);
        const observedFixture = { OR: [
          { statusReason: { not: "provisioning_waiting_state" } }, { statusReason: null }
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
      });
      totals.gatewayOffline += counts.gatewayOffline;
      totals.fixtureStale += counts.fixtureStale;
    }
    return totals;
  }
}
