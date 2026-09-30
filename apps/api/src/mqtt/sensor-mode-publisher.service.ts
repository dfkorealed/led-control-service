import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { bioSensorModeCommandSchema, bioSensorModeTopics } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SensorModeOperationsService, lockFixture, sensorModeDeviceIdentityHash } from "../commands/sensor-mode-operations.service";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { lockAutomationProtocolIdentity } from "../automation/automation-protocol-support";
import { MqttService } from "./mqtt.service";

/** A bounded durable outbox shares its row with the operation; PUBACK is not a result. */
@Injectable()
export class SensorModePublisherService implements OnModuleInit {
  private readonly workerId = randomUUID();
  private readonly logger = new Logger(SensorModePublisherService.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  constructor(private readonly prisma: PrismaService, private readonly mqtt: MqttService,
    private readonly operations: SensorModeOperationsService, private readonly snapshots: AutomationSnapshotService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      if (this.stopped || this.active) return;
      this.active = this.processBatch().catch(() => this.logger.error("sensor mode outbox delivery failed"))
        .finally(() => { this.active = undefined; });
    }, 1_000);
  }
  async stopAndDrain() { this.stopped = true; clearInterval(this.timer); await this.active; }

  async processBatch() {
    await this.operations.expire();
    const candidates = await this.prisma.sensorModeOperation.findMany({ where: {
      status: "pending", supersededAt: null, expiresAt: { gt: new Date() }, nextAttemptAt: { lte: new Date() }
    }, orderBy: { createdAt: "asc" }, take: 10 });
    for (const candidate of candidates) {
      if (this.stopped) return;
      await this.prisma.$transaction(async (tx) => {
        // Match creation/result lock order and retain membership authorization
        // through the bounded publish, so reassignment cannot race dispatch.
        await this.snapshots.lockMutation(tx);
        const identity = await lockAutomationProtocolIdentity(tx, candidate);
        await lockFixture(tx, candidate.fixtureId);
        const fixture = await tx.fixture.findFirst({ where: { id: candidate.fixtureId, siteId: candidate.siteId,
          gatewayId: candidate.gatewayId, meshNodeId: candidate.nodeId }, include: { meshNode: true } });
        const now = new Date();
        const row = await tx.sensorModeOperation.findUniqueOrThrow({ where: { commandId: candidate.commandId } });
        if (row.status !== "pending" || row.supersededAt || row.expiresAt <= now || row.nextAttemptAt > now ||
            (row.leaseExpiresAt && row.leaseExpiresAt > now)) return;
        if (!identity || identity.assignmentVersion !== row.assignmentVersion || fixture?.meshNode?.vehicleSensorProtocol !== "bio_usb_pulse" ||
            Number.parseInt(fixture.meshNode.meshAddress.replace(/^0x/i, ""), 16) !== Number.parseInt(row.meshAddress.slice(2), 16)) {
          await tx.sensorModeOperation.update({ where: { commandId: row.commandId }, data: { status: "unknown" } });
          return;
        }
        const command = bioSensorModeCommandSchema.parse(row.payload);
        if (!fixture?.meshNode?.deviceUuid || sensorModeDeviceIdentityHash(fixture.meshNode.deviceUuid) !== command.deviceIdentityHash) {
          await tx.sensorModeOperation.update({ where: { commandId: row.commandId }, data: { status: "unknown" } });
          return;
        }
        const timeoutMs = Math.min(2_000, row.expiresAt.getTime() - now.getTime());
        await tx.sensorModeOperation.update({ where: { commandId: row.commandId }, data: {
          lockedBy: this.workerId, leaseExpiresAt: new Date(now.getTime() + 10_000), attempts: { increment: 1 }
        } });
        let publishedAt: Date | undefined;
        try {
          await this.mqtt.publishTopic(bioSensorModeTopics.command(command.siteId, command.gatewayId), command, {
            timeoutMs, messageExpiryInterval: Math.max(1, Math.floor(timeoutMs / 1_000))
          });
          publishedAt = new Date();
        } catch {
          // Retry the identical bounded identity. A failed PUBACK cannot prove
          // the Gateway did not receive it, so never allocate another SET here.
        }
        await tx.sensorModeOperation.update({ where: { commandId: row.commandId }, data: {
          ...(publishedAt ? { publishedAt } : {}), lockedBy: null, leaseExpiresAt: null,
          nextAttemptAt: new Date(Date.now() + 2_000)
        } });
      }, { timeout: 10_000 });
    }
  }
}
