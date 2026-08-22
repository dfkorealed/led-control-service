import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  createGatewayCommandExpiry,
  GatewayDimmingCommandDraftV2,
  gatewayDimmingCommandDraftV2Schema,
  gatewayDimmingCommandV2Schema
} from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "./mqtt.service";

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 10;
const MAX_AGE_MS = 15 * 60_000;

type PublisherOptions = {
  workerId?: string;
  random?: () => number;
  pollMs?: number;
};

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly workerId: string;
  private readonly random: () => number;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    @Optional() options: PublisherOptions = {}
  ) {
    this.workerId = options.workerId ?? randomUUID();
    this.random = options.random ?? Math.random;
    this.pollMs = options.pollMs ?? Number(process.env.MQTT_OUTBOX_POLL_MS ?? 1000);
  }

  onModuleInit() {
    void this.processBatch();
    this.timer = setInterval(() => void this.processBatch(), this.pollMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async claimBatch(now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "MqttOutbox"
        WHERE "publishedAt" IS NULL
          AND "deadLetteredAt" IS NULL
          AND "nextAttemptAt" <= ${now}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 50
      `);
      const ids = rows.map((row) => row.id);
      if (ids.length === 0) return [];

      await tx.mqttOutbox.updateMany({
        where: { id: { in: ids }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        data: { lockedBy: this.workerId, lockedAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }
      });
      return tx.mqttOutbox.findMany({
        where: { id: { in: ids }, lockedBy: this.workerId },
        include: {
          dispatch: {
            select: {
              commandId: true,
              gatewayId: true,
              deliveryMode: true,
              destinationAddress: true,
              meshControlGroupId: true,
              meshControlGroupVersion: true
            }
          }
        },
        orderBy: { createdAt: "asc" }
      });
    });
  }

  async processBatch(now = new Date()) {
    const records = await this.claimBatch(now);
    for (const record of records) await this.publishClaimed(record);
  }

  async publishClaimed(
    record: {
      id: string;
      dispatchId: string;
      topic: string;
      payload: Prisma.JsonValue;
      attempts: number;
      createdAt: Date;
      dispatch: {
        commandId: string;
        gatewayId: string;
        deliveryMode: string;
        destinationAddress: string | null;
        meshControlGroupId: string | null;
        meshControlGroupVersion: number | null;
      };
    },
    now = new Date()
  ) {
    try {
      const draft = gatewayDimmingCommandDraftV2Schema.parse(record.payload);
      const expiry = createGatewayCommandExpiry(now);
      const payload = gatewayDimmingCommandV2Schema.parse({
        ...draft,
        expiresAt: expiry.expiresAt
      });
      const prepared = await this.prisma.$transaction(async (tx) => {
        await this.assertMeshGroupSnapshot(tx, record, draft);
        return tx.mqttOutbox.updateMany({
          where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
          data: { payload }
        });
      });
      if (prepared.count !== 1) return;

      await this.mqtt.publishTopic(record.topic, payload, { messageExpiryInterval: expiry.messageExpiryInterval });
      await this.prisma.$transaction(async (tx) => {
        const released = await tx.mqttOutbox.updateMany({
          where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
          data: { publishedAt: now, lastError: null, lockedBy: null, lockedAt: null, leaseExpiresAt: null }
        });
        if (released.count !== 1) return;
        await tx.commandDispatch.updateMany({
          where: { id: record.dispatchId, status: "pending" },
          data: { status: "published", publishedAt: now }
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown MQTT publish error";
      const attempts = record.attempts + 1;
      if (error instanceof StaleMeshGroupError) {
        await this.moveToTerminalFailure(record, attempts, message, now, "MESH_GROUP_STALE");
        return;
      }
      const exhausted = attempts >= MAX_ATTEMPTS || now.getTime() - record.createdAt.getTime() >= MAX_AGE_MS;
      if (exhausted) {
        await this.moveToDeadLetter(record, attempts, message, now);
        return;
      }

      const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
      const jitter = Math.floor(delay * 0.2 * this.random());
      await this.prisma.mqttOutbox.updateMany({
        where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
        data: {
          attempts,
          nextAttemptAt: new Date(now.getTime() + delay + jitter),
          lastError: message,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null
        }
      });
    }
  }

  private async assertMeshGroupSnapshot(
    tx: Prisma.TransactionClient,
    record: {
      dispatch: {
        gatewayId: string;
        deliveryMode: string;
        destinationAddress: string | null;
        meshControlGroupId: string | null;
        meshControlGroupVersion: number | null;
      };
    },
    draft: GatewayDimmingCommandDraftV2
  ) {
    if (draft.deliveryMode !== "mesh_group") return;

    const dispatch = record.dispatch;
    if (
      dispatch.deliveryMode !== draft.deliveryMode ||
      dispatch.gatewayId !== draft.gatewayId ||
      dispatch.destinationAddress !== draft.destinationAddress ||
      dispatch.meshControlGroupId !== draft.meshControlGroupId ||
      dispatch.meshControlGroupVersion !== draft.meshControlGroupVersion
    ) {
      throw new StaleMeshGroupError("dispatch snapshot mismatch");
    }

    const group = await tx.meshControlGroup.findUnique({
      where: { id: draft.meshControlGroupId },
      select: { gatewayId: true, groupAddress: true, configurationVersion: true, status: true }
    });
    if (!group) throw new StaleMeshGroupError("group missing");
    if (group.gatewayId !== draft.gatewayId) throw new StaleMeshGroupError("gateway mismatch");
    if (group.groupAddress !== draft.destinationAddress) throw new StaleMeshGroupError("address mismatch");
    if (group.configurationVersion !== draft.meshControlGroupVersion) {
      throw new StaleMeshGroupError("configuration version mismatch");
    }
    if (group.status === "configuring") throw new MeshGroupConfiguringError();
    if (group.status !== "ready") throw new StaleMeshGroupError("group is not ready");
  }

  private async moveToDeadLetter(
    record: { id: string; dispatchId: string; dispatch: { commandId: string } },
    attempts: number,
    message: string,
    now: Date
  ) {
    await this.moveToTerminalFailure(record, attempts, message, now, "MQTT_DEAD_LETTER");
  }

  private async moveToTerminalFailure(
    record: { id: string; dispatchId: string; dispatch: { commandId: string } },
    attempts: number,
    message: string,
    now: Date,
    errorCode: "MQTT_DEAD_LETTER" | "MESH_GROUP_STALE"
  ) {
    await this.prisma.$transaction(async (tx) => {
      const released = await tx.mqttOutbox.updateMany({
        where: { id: record.id, lockedBy: this.workerId, publishedAt: null },
        data: {
          attempts,
          deadLetteredAt: now,
          lastError: message,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null
        }
      });
      if (released.count !== 1) return;
      await tx.commandDispatch.updateMany({
        where: { id: record.dispatchId, status: { in: ["pending", "published"] } },
        data: { status: "failed", completedAt: now, errorCode, errorMessage: message }
      });
      await tx.commandFixtureResult.updateMany({
        where: { dispatchId: record.dispatchId, status: "pending" },
        data: { status: "failed", occurredAt: now, errorMessage: message }
      });
      await tx.command.updateMany({
        where: { id: record.dispatch.commandId, status: "pending" },
        data: { status: "failed", errorMessage: message }
      });
    });
  }
}

class MeshGroupConfiguringError extends Error {
  constructor() {
    super("mesh control group configuration is not ready");
  }
}

class StaleMeshGroupError extends Error {
  constructor(reason: string) {
    super(`Mesh 그룹 명령 스냅샷이 만료되었습니다: ${reason}`);
  }
}
