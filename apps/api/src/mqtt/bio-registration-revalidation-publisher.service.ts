import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { bioRegistrationRevalidationCommandSchema, bioRegistrationRevalidationTopics } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { BioRegistrationRevalidationService } from "../registration/bio-registration-revalidation.service";
import { authorizeBioRegistrationGateway, bioRegistrationRevalidationHash } from "../registration/bio-registration-revalidation-binding";
import { CommandDbClockHealth } from "./command-db-clock-health.service";
import { MqttService } from "./mqtt.service";

/** Short DB leases precede canonical validation; MQTT I/O never retains DB locks. */
@Injectable()
export class BioRegistrationRevalidationPublisherService implements OnModuleInit {
  private readonly logger = new Logger(BioRegistrationRevalidationPublisherService.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  constructor(private readonly prisma: PrismaService, private readonly mqtt: MqttService,
    private readonly operations: BioRegistrationRevalidationService, private readonly clock: CommandDbClockHealth) {}

  onModuleInit() {
    this.timer = setInterval(() => { void this.processBatch().catch(() => this.logger.error("BIO registration query delivery failed")); }, 1_000);
  }
  async stopAndDrain(): Promise<void> { this.stopped = true; clearInterval(this.timer); await this.active; }

  processBatch(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) return this.active;
    const batch = this.runBatch();
    this.active = batch.finally(() => { this.active = undefined; });
    return this.active;
  }

  private async runBatch() {
    await this.operations.expire();
    if (this.stopped) return;
    const claims = await this.prisma.$transaction(async tx => {
      const candidates = await tx.$queryRaw<Array<{ commandId: string }>>`
        SELECT "commandId" FROM "BioRegistrationRevalidationOperation"
        WHERE "status"='pending' AND "supersededAt" IS NULL AND "resultHash" IS NULL
          AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') AND "nextAttemptAt"<=(clock_timestamp() AT TIME ZONE 'UTC')
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt"<=(clock_timestamp() AT TIME ZONE 'UTC'))
        ORDER BY "createdAt", "commandId" LIMIT 10 FOR UPDATE SKIP LOCKED`;
      const claims: Array<{ commandId: string; leaseId: string }> = [];
      for (const row of candidates) {
        const leaseId = randomUUID();
        await tx.$executeRaw`UPDATE "BioRegistrationRevalidationOperation" SET "lockedBy"=${leaseId},
          "leaseExpiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')+INTERVAL '10 seconds',
          "attempts"="attempts"+1, "updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC') WHERE "commandId"=${row.commandId}`;
        claims.push({ commandId: row.commandId, leaseId });
      }
      return claims;
    });
    for (const claim of claims) {
      if (this.stopped) return;
      let prepared;
      try {
        prepared = await this.prisma.$transaction(async tx => {
          const initial = await tx.bioRegistrationRevalidationOperation.findUniqueOrThrow({ where: { commandId: claim.commandId } });
          await this.clock.assertHealthy(tx);
          if (!await this.operations.lockCurrentContext(tx, initial)) throw new Error("BIO publication binding changed");
          await tx.$queryRaw`SELECT "commandId" FROM "BioRegistrationRevalidationOperation" WHERE "commandId"=${claim.commandId} FOR UPDATE`;
          const row = await tx.bioRegistrationRevalidationOperation.findUniqueOrThrow({ where: { commandId: claim.commandId } });
          // Sample trusted time after canonical locks: queued DB work cannot prolong TTL.
          // Anchor before the sample: subtracting the entire clock/authorization/
          // commit round trip is conservative even when the DB samples time later.
          const checkedAt = performance.now();
          const dispatchAt = await this.clock.assertHealthy(tx);
          await authorizeBioRegistrationGateway(tx, { siteId: row.siteId, gatewayId: row.gatewayId,
            expectedAssignmentVersion: row.assignmentVersion }, dispatchAt);
          if (row.lockedBy !== claim.leaseId || row.status !== "pending" || row.resultHash || row.supersededAt ||
            row.expiresAt <= dispatchAt || !row.leaseExpiresAt || row.leaseExpiresAt <= dispatchAt) return null;
          const command = bioRegistrationRevalidationCommandSchema.parse(row.payload);
          if (row.payloadHash !== bioRegistrationRevalidationHash(command)) throw new Error("BIO publication payload changed");
          return { command, checkedAt, remainingMs: Math.min(row.expiresAt.getTime(), row.leaseExpiresAt.getTime()) - dispatchAt.getTime() };
        }, { timeout: 10_000 });
      } catch {
        // Failed validation is terminal unknown; a successor lease/result is never overwritten.
        await this.prisma.bioRegistrationRevalidationOperation.updateMany({ where: { commandId: claim.commandId,
          lockedBy: claim.leaseId, status: "pending", resultHash: null }, data: { status: "unknown", lockedBy: null, leaseExpiresAt: null } });
        continue;
      }
      if (!prepared) continue;
      const remainingMs = prepared.remainingMs - (performance.now() - prepared.checkedAt);
      if (this.stopped || remainingMs < 1) continue;
      let publishedAt: Date | undefined;
      try {
        await this.mqtt.publishTopic(bioRegistrationRevalidationTopics.command(prepared.command.siteId, prepared.command.gatewayId), prepared.command,
          { timeoutMs: Math.min(2_000, Math.floor(remainingMs)), messageExpiryInterval: Math.max(1, Math.floor(remainingMs / 1_000)), retain: false });
        publishedAt = new Date();
      } catch { /* Retry the identical query; PUBACK loss says nothing about device observation. */ }
      await this.prisma.bioRegistrationRevalidationOperation.updateMany({ where: { commandId: claim.commandId,
        lockedBy: claim.leaseId, leaseExpiresAt: { gt: new Date() }, status: "pending", resultHash: null }, data: { ...(publishedAt ? { publishedAt } : {}),
        lockedBy: null, leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + 2_000) } });
    }
  }
}
