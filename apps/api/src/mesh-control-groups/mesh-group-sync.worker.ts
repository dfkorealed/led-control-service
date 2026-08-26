import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "../mqtt/mqtt.service";
import { MeshControlGroupService } from "./mesh-control-group.service";

const GROUP_SYNC_INTERVAL_MS = 10_000;

@Injectable()
export class MeshGroupSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeshGroupSyncWorker.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqttService: MqttService,
    private readonly meshControlGroups: MeshControlGroupService
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
      // A retiring group must keep publishing its empty cloud desired set until
      // the gateway confirms every subscription delete for this exact version.
      where: { status: { in: ["configuring", "retiring"] } },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        gatewayId: true,
        configurationVersion: true
      }
    });

    for (const group of groups) {
      try {
        const payload = await this.prisma.$transaction((tx) => this.meshControlGroups.prepareSubscriptionSync(tx, {
          groupId: group.id,
          gatewayId: group.gatewayId,
          configurationVersion: group.configurationVersion,
          requestedAt: new Date().toISOString()
        }));
        if (payload) await this.mqttService.publishMeshGroupSubscriptionSync(payload);
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
