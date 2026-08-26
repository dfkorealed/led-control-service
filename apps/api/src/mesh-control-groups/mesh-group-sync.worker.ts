import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "../mqtt/mqtt.service";

const GROUP_SYNC_INTERVAL_MS = 10_000;

@Injectable()
export class MeshGroupSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeshGroupSyncWorker.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqttService: MqttService
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.logger.error("mesh control group sync failed", error instanceof Error ? error.stack : undefined);
      });
    }, GROUP_SYNC_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce() {
    const groups = await this.prisma.meshControlGroup.findMany({
      where: { status: "configuring" },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        gatewayId: true,
        groupAddress: true,
        configurationVersion: true,
        gateway: { select: { siteId: true } },
        members: {
          where: { desired: true },
          orderBy: [{ meshNodeId: "asc" }],
          select: {
            meshNodeId: true,
            meshNode: { select: { meshAddress: true } }
          }
        }
      }
    });

    for (const group of groups) {
      try {
        await this.mqttService.publishMeshGroupSubscriptionSync({
          siteId: group.gateway.siteId,
          gatewayId: group.gatewayId,
          groupId: group.id,
          version: group.configurationVersion,
          groupAddress: group.groupAddress,
          desiredMembers: group.members.map((member) => ({
            meshNodeId: member.meshNodeId,
            meshAddress: member.meshNode.meshAddress
          })),
          requestedAt: new Date().toISOString()
        });
      } catch (error) {
        this.logger.error("mesh control group sync publish failed", {
          groupId: group.id,
          gatewayId: group.gatewayId,
          version: group.configurationVersion,
          error: error instanceof Error ? error.message : "unknown publish error"
        });
      }
    }
  }
}
