import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
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
    const gatewayCutoff = new Date(now.getTime() - 90_000);
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
        status: { not: "offline" },
        OR: [{ lastStateOccurredAt: { lt: fixtureCutoff } }, { lastStateOccurredAt: null }]
      },
      data: { status: "offline", statusReason: "fixture_stale" }
    });
    return { gatewayOffline: gatewayOffline.count, fixtureStale: fixtureStale.count };
  }
}
