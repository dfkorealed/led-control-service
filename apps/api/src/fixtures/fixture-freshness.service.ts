import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { gatewayHeartbeatFreshSince } from "@led-control/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class FixtureFreshnessService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.markStaleFixtures(), Number(process.env.FIXTURE_FRESHNESS_POLL_MS ?? 30_000));
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async markStaleFixtures(now = new Date()) {
    const gatewayCutoff = gatewayHeartbeatFreshSince(now);
    // Three 60-second Mesh publication windows tolerate a delayed radio publication without masking a real outage.
    const fixtureCutoff = new Date(now.getTime() - 180_000);
    const gatewayOffline = await this.prisma.fixture.updateMany({
      where: {
        // A newly provisioned fixture has no observed state yet, so gateway freshness must not relabel it as a confirmed outage.
        OR: [{ statusReason: { not: "provisioning_waiting_state" } }, { statusReason: null }],
        meshNode: {
          gateway: { OR: [{ lastHeartbeatAt: { lt: gatewayCutoff } }, { lastHeartbeatAt: null }] }
        }
      },
      data: { status: "offline", statusReason: "gateway_offline" }
    });
    const fixtureStale = await this.prisma.fixture.updateMany({
      where: {
        // A waiting fixture has no observed state; after the first state event clears this reason it re-enters normal freshness checks.
        AND: [
          // Preserve a more specific offline reason set earlier in this run, especially gateway_offline.
          { status: { not: "offline" } },
          { OR: [{ statusReason: { not: "provisioning_waiting_state" } }, { statusReason: null }] },
          { OR: [{ lastStateOccurredAt: { lt: fixtureCutoff } }, { lastStateOccurredAt: null }] }
        ]
      },
      data: { status: "offline", statusReason: "fixture_stale" }
    });
    return { gatewayOffline: gatewayOffline.count, fixtureStale: fixtureStale.count };
  }
}
