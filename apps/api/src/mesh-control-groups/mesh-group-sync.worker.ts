import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "../mqtt/mqtt.service";
import { MeshControlGroupService } from "./mesh-control-group.service";

const GROUP_SYNC_INTERVAL_MS = 10_000;

@Injectable()
export class MeshGroupSyncWorker implements OnModuleInit {
  private readonly logger = new Logger(MeshGroupSyncWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqttService: MqttService,
    private readonly meshControlGroups: MeshControlGroupService
  ) {}

  onModuleInit() {
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.runScheduledSync();
    }, GROUP_SYNC_INTERVAL_MS);
  }

  stopAndDrain() {
    if (!this.stopPromise) {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.stopPromise = this.activeRun ?? Promise.resolve();
    }
    return this.stopPromise;
  }

  private runScheduledSync() {
    if (this.stopped || this.activeRun) return this.activeRun ?? Promise.resolve();

    const run = this.runOnce()
      .catch((error) => {
        this.logger.error(`mesh control group sync failed (error=${this.errorKind(error)})`);
      })
      .finally(() => {
        this.activeRun = null;
      });
    this.activeRun = run;
    return run;
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
      if (this.stopped) return;
      try {
        const payload = await this.prisma.$transaction((tx) => this.meshControlGroups.prepareSubscriptionSync(tx, {
          groupId: group.id,
          gatewayId: group.gatewayId,
          configurationVersion: group.configurationVersion,
          requestedAt: new Date().toISOString()
        }));
        if (this.stopped) return;
        if (payload) await this.mqttService.publishMeshGroupSubscriptionSync(payload);
      } catch (error) {
        this.logger.error("mesh control group sync publish failed", {
          groupId: group.id,
          gatewayId: group.gatewayId,
          version: group.configurationVersion,
          error: this.errorKind(error)
        });
      }
    }
  }

  private errorKind(error: unknown) {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^P\d{4}$/.test(error.code)
    ) return error.code;
    return "UNEXPECTED_ERROR";
  }
}
