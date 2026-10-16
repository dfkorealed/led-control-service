import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { fixtureRegistrationRemovalAckSchema, fixtureRegistrationRemovalCommandSchema,
  fixtureRegistrationRemovalTerminalSchema, fixtureRegistrationRemovalTopics } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { FixtureRegistrationRemovalsService } from "../fixtures/fixture-registration-removals.service";
import { FixtureRegistrationRemovalCleanupService } from "../fixtures/fixture-registration-removal-cleanup.service";
import { CommandDbClockHealth } from "./command-db-clock-health.service";
import { MqttService } from "./mqtt.service";

@Injectable()
export class FixtureRegistrationRemovalPublisherService implements OnModuleInit {
  private readonly logger = new Logger(FixtureRegistrationRemovalPublisherService.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  constructor(private readonly prisma: PrismaService, private readonly mqtt: MqttService,
    private readonly operations: FixtureRegistrationRemovalsService,
    private readonly cleanup: FixtureRegistrationRemovalCleanupService, private readonly clock: CommandDbClockHealth) {}

  onModuleInit() {
    this.timer = setInterval(() => { void this.processBatch().catch(() => this.logger.error("registration removal worker failed")); }, 500);
  }
  async stopAndDrain() { this.stopped = true; clearInterval(this.timer); await this.active; }
  processBatch(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.active) this.active = this.runBatch().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async runBatch() {
    await this.prisma.fixtureRegistrationRemovalOperation.updateMany({ where: { status: "pending",
      expiresAt: { lte: new Date() } }, data: { status: "reconcile_required", errorCode: "REMOVAL_DELIVERY_UNCERTAIN",
      lockedBy: null, leaseExpiresAt: null } });
    const finals = await this.prisma.fixtureRegistrationRemovalOperation.findMany({ where: { status: "gateway_confirmed" }, take: 10 });
    for (const row of finals) {
      if (this.stopped) return;
      // A failed DB finalization retains Gateway evidence. Do not downgrade it or
      // return the fixture to active; a future batch retries the same transaction.
      try { await this.operations.finalize(row.operationId); } catch { this.logger.warn("registration removal finalization deferred"); }
    }
    const claims = await this.prisma.$transaction(async tx => {
      // The UPDATE statement trigger also takes this serializer. Acquire it
      // before SELECT FOR UPDATE so concurrent ingestion cannot invert locks.
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      const rows = await tx.$queryRaw<Array<{ operationId: string }>>`
        SELECT "operationId" FROM "FixtureRegistrationRemovalOperation" WHERE status IN ('pending','reconcile_required')
          AND ("resultHash" IS NULL OR result->>'status'='reconcile_required')
          AND "nextAttemptAt"<=(clock_timestamp() AT TIME ZONE 'UTC')
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt"<=(clock_timestamp() AT TIME ZONE 'UTC'))
        ORDER BY "createdAt","operationId" LIMIT 10 FOR UPDATE SKIP LOCKED`;
      const claims: Array<{ operationId: string; leaseId: string }> = [];
      for (const row of rows) {
        const leaseId = randomUUID();
        await tx.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET "lockedBy"=${leaseId},
          "leaseExpiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')+INTERVAL '10 seconds', "attempts"="attempts"+1
          WHERE "operationId"=${row.operationId}`;
        claims.push({ operationId: row.operationId, leaseId });
      }
      return claims;
    });
    for (const claim of claims) { if (this.stopped) return; await this.deliver(claim); }
    const acknowledgements = await this.prisma.fixtureRegistrationRemovalOperation.findMany({ where: {
      applicationAckHash: { not: null }, ackPublishedAt: null, ackNextAttemptAt: { lte: new Date() } }, take: 10 });
    for (const row of acknowledgements) {
      if (this.stopped) return;
      try {
        const ack = await this.prisma.$transaction(async tx => {
          const now = await this.clock.assertHealthy(tx);
          await this.operations.lockCurrent(tx, row, now);
          const ack = fixtureRegistrationRemovalAckSchema.parse(row.applicationAck);
          if (canonicalPayloadHash(ack) !== row.applicationAckHash || ack.resultHash !== row.resultHash ||
            ack.commandHash !== row.commandHash || ack.eventId !== row.resultEventId) throw new Error("removal ACK mismatch");
          return ack;
        }, { timeout: 15_000 });
        await this.mqtt.publishTopic(fixtureRegistrationRemovalTopics.ack(row.siteId, row.gatewayId), ack,
          { retain: false, timeoutMs: 2_000 });
        await this.prisma.fixtureRegistrationRemovalOperation.updateMany({ where: { operationId: row.operationId,
          applicationAckHash: row.applicationAckHash }, data: { ackPublishedAt: new Date(), ackAttempts: { increment: 1 } } });
      } catch {
        await this.prisma.fixtureRegistrationRemovalOperation.updateMany({ where: { operationId: row.operationId,
          applicationAckHash: row.applicationAckHash }, data: { ackNextAttemptAt: new Date(Date.now() + 2_000), ackAttempts: { increment: 1 } } });
      }
    }
  }

  async deliver(claim: { operationId: string; leaseId: string }) {
    let prepared;
    try {
      prepared = await this.prisma.$transaction(async tx => {
        const initial = await tx.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId: claim.operationId } });
        await this.operations.lockCurrent(tx, initial, await this.clock.assertHealthy(tx));
        await tx.$queryRaw`SELECT "operationId" FROM "FixtureRegistrationRemovalOperation" WHERE "operationId"=${claim.operationId} FOR UPDATE`;
        const row = await tx.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId: claim.operationId } });
        const checkedAt = performance.now(), now = await this.clock.assertHealthy(tx);
        const prior = fixtureRegistrationRemovalTerminalSchema.safeParse(row.result);
        if (row.lockedBy !== claim.leaseId || !["pending", "reconcile_required"].includes(row.status) ||
          (row.resultHash && (!prior.success || prior.data.status !== "reconcile_required")) ||
          !row.leaseExpiresAt || row.leaseExpiresAt <= now) return null;
        const expired = row.expiresAt <= now;
        if (!expired) {
          await this.cleanup.prepare(tx, row, now);
          const current = await tx.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId: claim.operationId } });
          if (!await this.cleanup.isApplied(tx, current)) return null;
        }
        const command = fixtureRegistrationRemovalCommandSchema.parse(row.payload);
        if (canonicalPayloadHash(command) !== row.commandHash) throw new Error("removal command hash mismatch");
        // An expired envelope is an exact result probe, not new deletion
        // authority. Gateway replays its journal or returns no-mutation rejection.
        // Only the MQTT transport lifetime is fresh; payload TTL never changes.
        return { command, checkedAt, remaining: Math.min(expired ? now.getTime() + 2_000 : row.expiresAt.getTime(), row.leaseExpiresAt.getTime()) - now.getTime() };
      }, { timeout: 15_000 });
    } catch {
      await this.prisma.fixtureRegistrationRemovalOperation.updateMany({ where: { operationId: claim.operationId,
        lockedBy: claim.leaseId, status: "pending", resultHash: null }, data: { status: "reconcile_required",
        errorCode: "REMOVAL_PUBLICATION_UNCERTAIN", lockedBy: null, leaseExpiresAt: null } });
      return;
    }
    let publishedAt: Date | undefined;
    if (prepared && !this.stopped) {
      const remaining = prepared.remaining - (performance.now() - prepared.checkedAt);
      if (remaining >= 1) {
        try {
          await this.mqtt.publishTopic(fixtureRegistrationRemovalTopics.command(prepared.command.siteId, prepared.command.gatewayId),
            prepared.command, { retain: false, timeoutMs: Math.min(2_000, Math.floor(remaining)),
              messageExpiryInterval: Math.max(1, Math.floor(remaining / 1_000)) });
          publishedAt = new Date();
        } catch { /* Retry identical bytes only while their original TTL remains. */ }
      }
    }
    await this.prisma.fixtureRegistrationRemovalOperation.updateMany({ where: { operationId: claim.operationId,
      lockedBy: claim.leaseId, status: { in: ["pending", "reconcile_required"] },
      OR: [{ resultHash: null }, { result: { path: ["status"], equals: "reconcile_required" } }] }, data: { ...(publishedAt ? { publishedAt } : {}),
      lockedBy: null, leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + 500) } });
  }
}
