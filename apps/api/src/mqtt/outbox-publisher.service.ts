import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createGatewayCommandExpiry, gatewayDimmingCommandDraftV2Schema, gatewayDimmingCommandV2Schema } from "@led-control/shared";
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
        include: { dispatch: { select: { commandId: true } } },
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
      dispatch: { commandId: string };
    },
    now = new Date()
  ) {
    try {
      const expiry = createGatewayCommandExpiry(now);
      const payload = gatewayDimmingCommandV2Schema.parse({
        ...gatewayDimmingCommandDraftV2Schema.parse(record.payload),
        expiresAt: expiry.expiresAt
      });
      const prepared = await this.prisma.mqttOutbox.updateMany({
        where: { id: record.id, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
        data: { payload }
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

  private async moveToDeadLetter(
    record: { id: string; dispatchId: string; dispatch: { commandId: string } },
    attempts: number,
    message: string,
    now: Date
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
        data: { status: "failed", completedAt: now, errorCode: "MQTT_DEAD_LETTER", errorMessage: message }
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
