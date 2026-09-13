import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { mqttTopicsV2, provisioningDeviceCommandV2Schema } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "./mqtt.service";

const LEASE_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 10;
const MAX_AGE_MS = 15 * 60_000;
const IDENTIFY_RESULT_TIMEOUT_MS = 15_000;
const IDENTIFY_TIMEOUT_MESSAGE = "조명 식별 뒤 센서 모드 복원을 확인하지 못했습니다.";
const PUBLISH_FAILURE_MESSAGE = "조명 등록 명령을 전송하지 못했습니다. 장비 상태를 확인해 주세요.";

type PublisherOptions = {
  workerId?: string;
  random?: () => number;
  pollMs?: number;
  clock?: () => Date;
  publishTimeoutMs?: number;
};

@Injectable()
export class ProvisioningDeviceOutboxPublisherService implements OnModuleInit {
  private readonly logger = new Logger(ProvisioningDeviceOutboxPublisherService.name);
  private readonly workerId: string;
  private readonly random: () => number;
  private readonly pollMs: number;
  private readonly clock: () => Date;
  private readonly publishTimeoutMs: number;
  private timer: NodeJS.Timeout | null = null;
  private activeBatch: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    @Optional() options: PublisherOptions = {}
  ) {
    this.workerId = options.workerId ?? randomUUID();
    this.random = options.random ?? Math.random;
    this.pollMs = options.pollMs ?? Number(process.env.PROVISIONING_DEVICE_OUTBOX_POLL_MS ?? 1000);
    this.clock = options.clock ?? (() => new Date());
    this.publishTimeoutMs = options.publishTimeoutMs
      ?? Number(process.env.PROVISIONING_DEVICE_OUTBOX_PUBLISH_TIMEOUT_MS ?? PUBLISH_TIMEOUT_MS);
    if (!Number.isInteger(this.publishTimeoutMs) || this.publishTimeoutMs <= 0 || this.publishTimeoutMs >= LEASE_MS) {
      throw new Error(`PROVISIONING_DEVICE_OUTBOX_PUBLISH_TIMEOUT_MS must be a positive integer below ${LEASE_MS}`);
    }
  }

  onModuleInit() {
    this.stopped = false;
    void this.runScheduledBatch();
    this.timer = setInterval(() => void this.runScheduledBatch(), this.pollMs);
  }

  stopAndDrain() {
    if (!this.stopPromise) {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.stopPromise = this.activeBatch ?? Promise.resolve();
    }
    return this.stopPromise;
  }

  private runScheduledBatch() {
    if (this.stopped || this.activeBatch) return this.activeBatch ?? Promise.resolve();
    const batch = this.processBatch()
      .catch((error) => {
        this.logger.error(`mqtt provisioning device outbox batch failed (worker=${this.workerId}, error=${this.errorKind(error)})`);
      })
      .finally(() => {
        this.activeBatch = null;
      });
    this.activeBatch = batch;
    return batch;
  }

  private errorKind(error: unknown) {
    if (
      typeof error === "object" && error !== null && "code" in error
      && typeof error.code === "string" && /^P\d{4}$/.test(error.code)
    ) return error.code;
    return "UNEXPECTED_ERROR";
  }

  async claimBatch(now = this.clock()) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "ProvisioningDeviceOutbox"
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
      await tx.provisioningDeviceOutbox.updateMany({
        where: { id: { in: ids }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        data: { lockedBy: this.workerId, lockedAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }
      });
      return tx.provisioningDeviceOutbox.findMany({
        where: { id: { in: ids }, lockedBy: this.workerId },
        orderBy: { createdAt: "asc" }
      });
    });
  }

  async processBatch(now = this.clock()) {
    await this.expirePublishedIdentifies(now);
    const records = await this.claimBatch(now);
    for (const record of records) {
      if (this.stopped) return;
      await this.publishClaimed(record);
    }
  }

  async expirePublishedIdentifies(now = this.clock()) {
    const cutoff = new Date(now.getTime() - IDENTIFY_RESULT_TIMEOUT_MS);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; nodeId: string; sessionId: string }>>(Prisma.sql`
        SELECT outbox."id", outbox."nodeId", outbox."sessionId"
        FROM "ProvisioningDeviceOutbox" AS outbox
        INNER JOIN "DiscoveredMeshNode" AS node ON node."id" = outbox."nodeId"
        INNER JOIN "ProvisioningSession" AS session ON session."id" = outbox."sessionId"
        WHERE outbox."publishedAt" IS NOT NULL
          AND outbox."publishedAt" <= ${cutoff}
          AND outbox."payload"->>'operation' = 'identify'
          AND NOT EXISTS (
            SELECT 1
            FROM "ProvisioningDeviceOutbox" AS newer
            WHERE newer."sessionId" = outbox."sessionId"
              AND newer."nodeId" = outbox."nodeId"
              AND newer."deadLetteredAt" IS NULL
              AND newer."payload"->>'operation' = 'identify'
              AND (
                newer."createdAt" > outbox."createdAt"
                OR (newer."createdAt" = outbox."createdAt" AND newer."id" > outbox."id")
              )
          )
          AND node."status" = 'identifying'
          AND node."identifyState" IN ('pending', 'running')
          AND session."status" = 'active'
        ORDER BY outbox."publishedAt" ASC
        FOR UPDATE OF outbox, node SKIP LOCKED
        LIMIT 50
      `);
      for (const row of rows) {
        // MQTT PUBACK only proves broker receipt. A successful BIO identify
        // requires the terminal event emitted after the fixed force-on period
        // and verified sensor-mode restoration, so silence is explicit failure.
        const failed = await tx.discoveredMeshNode.updateMany({
          where: { id: row.nodeId, sessionId: row.sessionId, status: "identifying", identifyState: { in: ["pending", "running"] } },
          data: { status: "discovered", identifyState: "failed", errorMessage: IDENTIFY_TIMEOUT_MESSAGE }
        });
        if (failed.count === 1) {
          await tx.provisioningDeviceOutbox.updateMany({
            where: { id: row.id, sessionId: row.sessionId, nodeId: row.nodeId },
            data: { lastError: "identify_result_timeout" }
          });
        }
      }
      return rows.length;
    });
  }

  async publishClaimed(record: {
    id: string;
    sessionId: string;
    nodeId: string;
    topic: string;
    payload: Prisma.JsonValue;
    attempts: number;
    createdAt: Date;
  }) {
    try {
      const payload = provisioningDeviceCommandV2Schema.parse(record.payload);
      const operation = payload.operation ?? "provision";
      const expectedTopic = mqttTopicsV2.gatewayCommand(
        payload.siteId,
        payload.gatewayId,
        operation === "identify" ? "provisioning/identify-device" : "provisioning/provision-device"
      );
      if (
        record.id !== payload.commandId
        || record.sessionId !== payload.sessionId
        || record.nodeId !== payload.nodeId
        || record.topic !== expectedTopic
      ) {
        await this.deadLetterTerminal(record, {
          attempts: record.attempts,
          terminalAt: this.clock(),
          message: "provisioning command identity conflict",
          operation
        });
        return;
      }
      const prepared = await this.prisma.$transaction(async (tx) => {
        const checkedAt = this.clock();
        await tx.$queryRaw`SELECT "id" FROM "DiscoveredMeshNode" WHERE "id" = ${record.nodeId} FOR UPDATE`;
        const node = await tx.discoveredMeshNode.findUnique({
          where: { id: record.nodeId },
          include: { session: { select: { siteId: true, gatewayId: true, status: true } } }
        });
        const current = node
          && (operation === "identify"
            ? node.status === "identifying" && ["pending", "running"].includes(node.identifyState)
            : node.status === "provisioning" && "meshAddress" in payload && node.meshAddress === payload.meshAddress)
          && node.sessionId === payload.sessionId
          && node.deviceUuid === payload.deviceUuid
          && node.session.siteId === payload.siteId
          && node.session.gatewayId === payload.gatewayId
          && node.session.status === "active";
        if (checkedAt.getTime() - record.createdAt.getTime() >= MAX_AGE_MS) {
          await this.deadLetterTerminalInTransaction(tx, record, {
            attempts: record.attempts,
            terminalAt: checkedAt,
            message: operation === "identify" ? "identify command expired before publish" : "provisioning command expired before publish",
            operation
          });
          return false;
        }
        if (!current) {
          await this.deadLetterTerminalInTransaction(tx, record, {
            attempts: record.attempts,
            terminalAt: checkedAt,
            message: operation === "identify" ? "node is no longer awaiting identify" : "node is no longer awaiting provisioning",
            operation
          });
          return false;
        }
        const renewed = await tx.provisioningDeviceOutbox.updateMany({
          where: {
            id: record.id,
            lockedBy: this.workerId,
            publishedAt: null,
            deadLetteredAt: null,
            leaseExpiresAt: { gt: checkedAt }
          },
          data: { leaseExpiresAt: new Date(checkedAt.getTime() + LEASE_MS) }
        });
        return renewed.count === 1;
      });
      if (!prepared) return;

      const publishCheckedAt = this.clock();
      const publishable = await this.prisma.provisioningDeviceOutbox.count({
        where: {
          id: record.id,
          lockedBy: this.workerId,
          publishedAt: null,
          deadLetteredAt: null,
          leaseExpiresAt: { gt: publishCheckedAt }
        }
      });
      if (publishable !== 1) return;

      await this.publishWithTimeout(record.topic, payload);
      const publishedAt = this.clock();
      const published = await this.prisma.provisioningDeviceOutbox.updateMany({
        where: {
          id: record.id,
          lockedBy: this.workerId,
          publishedAt: null,
          deadLetteredAt: null,
          leaseExpiresAt: { gt: publishedAt }
        },
        data: { publishedAt, lastError: null, lockedBy: null, lockedAt: null, leaseExpiresAt: null }
      });
      if (operation === "identify" && published.count === 1) {
        await this.prisma.discoveredMeshNode.updateMany({
          where: { id: record.nodeId, sessionId: record.sessionId, status: "identifying", identifyState: "pending" },
          data: { identifyState: "running" }
        });
      }
    } catch (error) {
      await this.handleFailure(record, error);
    }
  }

  private async publishWithTimeout(
    topic: string,
    payload: ReturnType<typeof provisioningDeviceCommandV2Schema.parse>
  ) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(
        () => finish(new Error(`provisioning device publish timed out after ${this.publishTimeoutMs}ms`)),
        this.publishTimeoutMs
      );
      void this.mqtt.publishTopic(topic, payload, { timeoutMs: this.publishTimeoutMs }).then(
        () => finish(),
        (error) => finish(error)
      );
    });
  }

  private async handleFailure(
    record: { id: string; sessionId: string; nodeId: string; attempts: number; createdAt: Date; payload: Prisma.JsonValue },
    error: unknown
  ) {
    const failedAt = this.clock();
    const attempts = record.attempts + 1;
    const message = error instanceof Error ? error.message : "unknown MQTT publish error";
    const exhausted = attempts >= MAX_ATTEMPTS || failedAt.getTime() - record.createdAt.getTime() >= MAX_AGE_MS;
    if (exhausted) {
      await this.deadLetterTerminal(record, {
        attempts,
        terminalAt: failedAt,
        message,
        operation: identifyOperation(record.payload)
      });
      return;
    }

    const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
    const jitter = Math.floor(delay * 0.2 * this.random());
    await this.prisma.provisioningDeviceOutbox.updateMany({
      where: {
        id: record.id,
        lockedBy: this.workerId,
        publishedAt: null,
        deadLetteredAt: null,
        leaseExpiresAt: { gt: failedAt }
      },
      data: {
        attempts,
        nextAttemptAt: new Date(failedAt.getTime() + delay + jitter),
        lastError: message,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null
      }
    });
  }

  private async deadLetterTerminal(
    record: { id: string; sessionId: string; nodeId: string },
    terminal: { attempts: number; terminalAt: Date; message: string; operation: "identify" | "provision" }
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "DiscoveredMeshNode" WHERE "id" = ${record.nodeId} FOR UPDATE`;
      return this.deadLetterTerminalInTransaction(tx, record, terminal);
    });
  }

  private async deadLetterTerminalInTransaction(
    tx: Prisma.TransactionClient,
    record: { id: string; sessionId: string; nodeId: string },
    terminal: { attempts: number; terminalAt: Date; message: string; operation: "identify" | "provision" }
  ) {
    const deadLettered = await tx.provisioningDeviceOutbox.updateMany({
      where: {
        id: record.id,
        lockedBy: this.workerId,
        publishedAt: null,
        deadLetteredAt: null,
        leaseExpiresAt: { gt: terminal.terminalAt }
      },
      data: {
        attempts: terminal.attempts,
        deadLetteredAt: terminal.terminalAt,
        lastError: terminal.message,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null
      }
    });
    if (deadLettered.count !== 1) return false;
    if (terminal.operation === "identify") {
      await tx.discoveredMeshNode.updateMany({
        where: { id: record.nodeId, sessionId: record.sessionId, status: "identifying", session: { status: "active" } },
        data: { status: "discovered", identifyState: "failed", errorMessage: PUBLISH_FAILURE_MESSAGE }
      });
    } else {
      await tx.discoveredMeshNode.updateMany({
        where: { id: record.nodeId, sessionId: record.sessionId, status: "provisioning", session: { status: "active" } },
        data: { status: "reconcile_required", errorMessage: PUBLISH_FAILURE_MESSAGE }
      });
    }
    return true;
  }
}

function identifyOperation(payload: Prisma.JsonValue): "identify" | "provision" {
  const parsed = provisioningDeviceCommandV2Schema.safeParse(payload);
  return parsed.success && parsed.data.operation === "identify" ? "identify" : "provision";
}
