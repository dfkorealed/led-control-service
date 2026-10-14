import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS, GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS, mqttTopics,
  temporaryControlCommandSchema, type TemporaryControlCommand } from "@led-control/shared";
import { Prisma, type TemporaryControlOutbox } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "../mqtt/mqtt.service";
import { CommandDbClockHealth } from "../mqtt/command-db-clock-health.service";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { loadAutomationProtocolSupport, lockAutomationProtocolIdentity } from "../automation/automation-protocol-support";
import { ensureTemporaryRelease, loadTemporaryAdmission, temporaryControlNow } from "./temporary-controls.service";

// Same bounded transport values as the existing automation publisher. These
// bound one observation batch, never the lifetime of an accepted release intent.
const LEASE_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 10;
const MAX_AGE_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 60_000;

export function temporaryDeliveryEnvelope(command: TemporaryControlCommand, now: Date, deliveryGeneration: string) {
  const deliveryWindowMs = command.kind === "start" ? Math.min(GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS, Date.parse(command.endsAt)-now.getTime()) : GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS;
  if (deliveryWindowMs <= GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS) return null;
  const body = { ...command, deliveryGeneration, deliveryGeneratedAt: now.toISOString(), deliveryWindowMs,
    expiresAt: new Date(now.getTime()+deliveryWindowMs).toISOString() };
  return { ...body, deliveryPayloadHash: canonicalPayloadHash(body) };
}

@Injectable()
export class TemporaryControlPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TemporaryControlPublisher.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  constructor(private readonly prisma: PrismaService, private readonly mqtt: MqttService,
    private readonly clockHealth: CommandDbClockHealth) {}

  onModuleInit() {
    if (this.timer || this.stopped || process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => {
      if (!this.active && !this.stopped) this.active = this.processBatch().catch(() => {
        this.logger.warn("temporary control delivery batch unavailable");
      }).finally(() => { this.active = undefined; });
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() { this.stopped = true; clearInterval(this.timer); this.timer = undefined; await this.active; }

  async claimBatch(): Promise<TemporaryControlOutbox[]> {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      const now = await temporaryControlNow(tx);
      // Expiry uses the persisted end; clock failure never discards the intent.
      // Actual RF still requires Gateway clock trust/current recovery evidence.
      const expired = await tx.temporaryControlSession.findMany({ where: { terminalAt: null, releaseIntentAt: null, endsAt: { lte: now } }, take: 50, orderBy: { endsAt: "asc" } });
      for (const session of expired) await ensureTemporaryRelease(tx, session, now);
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "TemporaryControlOutbox"
        WHERE "completedAt" IS NULL AND "nextAttemptAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
          AND ("leaseUntil" IS NULL OR "leaseUntil" <= (${now}::timestamptz AT TIME ZONE 'UTC')) ORDER BY "createdAt", "id" LIMIT 50 FOR UPDATE SKIP LOCKED`);
      if (!rows.length) return [];
      const token = randomUUID();
      await tx.temporaryControlOutbox.updateMany({ where: { id: { in: rows.map(r => r.id) }, completedAt: null }, data: { leaseToken: token, leaseUntil: new Date(now.getTime()+LEASE_MS) } });
      return tx.temporaryControlOutbox.findMany({ where: { id: { in: rows.map(r => r.id) }, leaseToken: token }, orderBy: { createdAt: "asc" } });
    }, { timeout: 30_000 });
  }

  async processBatch() {
    for (const row of await this.claimBatch()) { if (this.stopped) return; await this.publishClaimed(row); }
  }

  async publishClaimed(row: TemporaryControlOutbox): Promise<void> {
    if (this.stopped || !row.leaseToken) return;
    const prepared = await this.prepare(row);
    if (!prepared || this.stopped) return;
    const fenced = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      const now = await temporaryControlNow(tx);
      return tx.temporaryControlOutbox.count({ where: { ...owned(row, now), leaseUntil: { gt: new Date(now.getTime()+PUBLISH_TIMEOUT_MS) },
        ...(row.kind === "start" ? { session: { releaseIntentAt: null, terminalAt: null, endsAt: { gt: new Date(now.getTime()+GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS) } } } : {}) } });
    });
    if (fenced !== 1 || this.stopped) return;
    let succeeded = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      // Bound even a non-cooperative transport. Late completion has no state
      // callback; the final CAS below is the only delivery mutation path.
      await Promise.race([this.mqtt.publishTopic(prepared.topic, prepared.payload, { timeoutMs: PUBLISH_TIMEOUT_MS,
        messageExpiryInterval: prepared.messageExpiryInterval }), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("temporary publish timeout")), PUBLISH_TIMEOUT_MS);
      })]);
      succeeded = true;
    } catch { /* Raw transport errors must not enter logs or recovery reasons. */ }
    finally { clearTimeout(timeout); }
    await this.finish(row, succeeded);
  }

  private async prepare(row: TemporaryControlOutbox) {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      let now = await temporaryControlNow(tx);
      const current = await tx.temporaryControlOutbox.findFirst({ where: owned(row, now), include: { session: true } });
      if (!current || !current.payload) return null;
      await tx.temporaryControlOutbox.updateMany({ where: owned(row, now), data: { leaseUntil: new Date(now.getTime()+LEASE_MS) } });
      if (row.kind === "ingested") return { topic: mqttTopics.temporaryControlIngested(row.siteId, row.gatewayId), payload: current.payload, messageExpiryInterval: null };
      const session = current.session;
      if (session.terminalAt || (row.kind === "start" && (session.releaseIntentAt || session.state === "holding"))) {
        await tx.temporaryControlOutbox.updateMany({ where: owned(row, now), data: { completedAt: now, leaseToken: null, leaseUntil: null } }); return null;
      }
      const parsed = temporaryControlCommandSchema.safeParse(current.payload);
      if (!parsed.success) { await this.defer(tx, row, now); return null; }
      const { payloadHash, ...body } = parsed.data;
      if (canonicalPayloadHash(body) !== payloadHash || payloadHash !== current.payloadHash) { await this.defer(tx, row, now); return null; }
      const identity = await lockAutomationProtocolIdentity(tx, { siteId: row.siteId, gatewayId: row.gatewayId });
      if (!identity || identity.assignmentVersion !== session.assignmentVersion) { await this.defer(tx, row, now); return null; }
      const targets = await tx.temporaryControlTarget.findMany({ where: { sessionId: session.id }, include: { lease: { include: { liveFixture: { include: { meshNode: true } } } } } });
      if (targets.some(t => !t.resolvedAt && (t.lease.ownerSessionId !== session.id || t.lease.lastGeneration !== t.releaseGeneration
        || t.lease.liveFixture?.meshNodeId !== t.meshNodeId || t.lease.liveFixture?.meshNode?.deviceUuid !== `bio:${t.nativeUuid}`
        || t.lease.liveFixture?.meshNode?.meshAddress !== t.logicalAddress))) { await this.defer(tx, row, now); return null; }
      if (row.kind === "start") {
        try {
          now = await this.clockHealth.assertHealthy(tx);
          if (await loadAutomationProtocolSupport(tx, { siteId: row.siteId, gatewayId: row.gatewayId }) !== 3) throw new Error("unsupported");
          const config = await loadTemporaryAdmission(tx, { siteId: row.siteId, gatewayId: row.gatewayId });
          if (config.desiredRevision !== session.admissionRevision) throw new Error("changed admission");
        } catch { await this.defer(tx, row, now); return null; }
      }
      const payload = temporaryDeliveryEnvelope(parsed.data, now, randomUUID());
      if (!payload) {
        await ensureTemporaryRelease(tx, session, now);
        await tx.temporaryControlOutbox.updateMany({ where: owned(row, now), data: { completedAt: now, leaseToken: null, leaseUntil: null } }); return null;
      }
      const updated = await tx.temporaryControlOutbox.updateMany({ where: owned(row, now), data: { deliveryGeneration: payload.deliveryGeneration,
        deliveryPayloadHash: payload.deliveryPayloadHash, deliveryGeneratedAt: now, deliveryWindowMs: payload.deliveryWindowMs, expiresAt: new Date(payload.expiresAt) } });
      if (updated.count !== 1) return null;
      if (row.kind === "start" && session.state === "pending") await tx.temporaryControlSession.update({ where: { id: session.id }, data: { state: "applying" } });
      return { topic: mqttTopics.temporaryControlCommand(row.siteId, row.gatewayId), payload, messageExpiryInterval: Math.max(1, Math.floor(payload.deliveryWindowMs/1000)) };
    }, { timeout: 30_000 });
  }

  private async defer(tx: Prisma.TransactionClient, row: TemporaryControlOutbox, now: Date) {
    await tx.temporaryControlOutbox.updateMany({ where: owned(row, now), data: { leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(now.getTime()+MAX_BACKOFF_MS) } });
  }

  private async finish(row: TemporaryControlOutbox, succeeded: boolean) {
    await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      const now = await temporaryControlNow(tx);
      const current = await tx.temporaryControlOutbox.findFirst({ where: owned(row, now), include: { session: true } });
      if (!current) return;
      const attempts = current.attempts+1;
      const exhausted = attempts >= MAX_ATTEMPTS || now.getTime()-current.createdAt.getTime() >= MAX_AGE_MS;
      const completed = (succeeded && row.kind === "ingested") || exhausted;
      const delay = Math.min(MAX_BACKOFF_MS, 1000*2**Math.min(attempts-1, 6));
      await tx.temporaryControlOutbox.updateMany({ where: owned(row, now), data: { attempts, leaseToken: null, leaseUntil: null,
        nextAttemptAt: new Date(now.getTime()+delay), ...(succeeded ? { publishedAt: now } : {}), ...(completed ? { completedAt: now } : {}) } });
      if (!exhausted) return;
      if (row.kind === "start" && !current.session.terminalAt) {
        await ensureTemporaryRelease(tx, current.session, now);
        await tx.temporaryControlSession.update({ where: { id: row.sessionId }, data: { state: "recovery_pending", reason: "delivery_unconfirmed" } });
      } else if ((row.kind === "end" && !current.session.terminalAt) || (row.kind === "ingested" && !succeeded)) {
        // Terminal delivery batch != resolved fixture. A new durable batch
        // carries the same immutable release/receipt and never extends endsAt.
        await tx.temporaryControlOutbox.create({ data: { sessionId: row.sessionId, siteId: row.siteId, gatewayId: row.gatewayId,
          kind: row.kind, sessionRevision: row.sessionRevision, deduplicationKey: `${row.kind}:${row.sessionId}:retry:${randomUUID()}`,
          payload: current.payload as Prisma.InputJsonValue, payloadHash: row.payloadHash, nextAttemptAt: new Date(now.getTime()+MAX_BACKOFF_MS) } });
      }
    });
  }
}

function owned(row: TemporaryControlOutbox, now: Date): Prisma.TemporaryControlOutboxWhereInput {
  return { id: row.id, leaseToken: row.leaseToken, leaseUntil: { gt: now }, completedAt: null };
}
