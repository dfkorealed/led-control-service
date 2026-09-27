import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CommandDetailRedactionBlocked, redactSettledCommandDetails } from "./command-detail-redaction";

type BatchResult = { examined: number; redacted: number; skippedByReason: Record<string, number>; overdueCount: number };
const emptyResult = (): BatchResult => ({ examined: 0, redacted: 0, skippedByReason: {}, overdueCount: 0 });

@Injectable()
export class CommandDetailRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommandDetailRetentionService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<BatchResult>;
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (this.timer || process.env.NODE_ENV === "test" || process.env.COMMAND_DETAIL_REDACTION_ENABLED !== "1") return;
    this.timer = setInterval(() => {
      void this.runBatch().catch(() => { /* sweep logs only sanitized operational metadata. */ });
    }, 60_000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => { /* Drain failures during shutdown too. */ });
  }

  async runBatch(maxCandidates = 100): Promise<BatchResult> {
    if (process.env.COMMAND_DETAIL_REDACTION_ENABLED !== "1") return emptyResult();
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 1000) {
      throw new Error("maxCandidates must be an integer between 1 and 1000");
    }
    if (!this.running) this.running = this.sweep(maxCandidates).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async sweep(budget: number): Promise<BatchResult> {
    const result = emptyResult();
    try {
      // Command timestamps and JS Date have millisecond precision. Freeze one
      // DB UTC boundary per batch, independent of the API host/session clock.
      const [clock] = await this.prisma.$queryRaw<Array<{ retainedFrom: Date }>>(Prisma.sql`
        SELECT date_trunc('milliseconds', transaction_timestamp() AT TIME ZONE 'UTC')
          - INTERVAL '3 months' AS "retainedFrom"`);
      if (!clock || !Number.isFinite(clock.retainedFrom.getTime())) throw new Error("DB retention clock unavailable");
      const cutoff = Prisma.sql`(${clock.retainedFrom}::timestamptz AT TIME ZONE 'UTC')`;
      for (let i = 0; i < budget; i++) {
        let commandId: string | undefined;
        try {
          const outcome = await this.prisma.$transaction(async tx => {
            const [candidate] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              SELECT command."id" FROM "Command" command
              WHERE command."contentRedactedAt" IS NULL AND command."createdAt" < ${cutoff}
                AND NOT EXISTS (SELECT 1 FROM "CommandRetentionAttempt" attempt
                  WHERE attempt."commandId" = command."id" AND left(attempt."reasonCode", 7) = 'detail_'
                    AND attempt."retryAfterAt" > (transaction_timestamp() AT TIME ZONE 'UTC'))
              ORDER BY command."createdAt", command."id" LIMIT 1 FOR UPDATE OF command SKIP LOCKED`);
            if (!candidate) return null;
            commandId = candidate.id;
            const redaction = await redactSettledCommandDetails(tx, candidate.id, clock.retainedFrom);
            await tx.commandRetentionAttempt.deleteMany({ where: { commandId: candidate.id, reasonCode: { startsWith: "detail_" } } });
            return redaction;
          });
          if (outcome === null) break;
          result.examined++;
          if (outcome === "redacted") result.redacted++;
        } catch (error) {
          if (!commandId) throw error;
          // The helper transaction has fully rolled back before retry metadata
          // is written. Re-lock/recheck prevents a stale attempt after another
          // worker completes in this gap. No raw error/SQL enters stored reasons.
          const reason = error instanceof CommandDetailRedactionBlocked ? error.reasonCode : "transaction_failed";
          result.examined++;
          result.skippedByReason[reason] = (result.skippedByReason[reason] ?? 0) + 1;
          await this.defer(commandId, reason);
        }
      }
      const backlog = await this.prisma.$queryRaw<Array<{ reasonCode: string | null; count: bigint; oldestAgeSeconds: number }>>(Prisma.sql`
        SELECT attempt."reasonCode", count(*) AS count,
          max(EXTRACT(EPOCH FROM ((transaction_timestamp() AT TIME ZONE 'UTC') - command."createdAt")))::float8 AS "oldestAgeSeconds"
        FROM "Command" command LEFT JOIN "CommandRetentionAttempt" attempt ON attempt."commandId" = command."id"
        WHERE command."contentRedactedAt" IS NULL AND command."createdAt" < ${cutoff}
        GROUP BY attempt."reasonCode"`);
      const blockedByReason: Record<string, number> = {};
      let oldestAgeSeconds = 0;
      for (const group of backlog) {
        result.overdueCount += Number(group.count);
        oldestAgeSeconds = Math.max(oldestAgeSeconds, group.oldestAgeSeconds);
        if (group.reasonCode?.startsWith("detail_")) blockedByReason[group.reasonCode.slice(7)] = Number(group.count);
      }
      this.logger.log({ event: "command_detail_retention_batch", status: "completed", ...result, blockedByReason, oldestAgeSeconds });
      return result;
    } catch (error) {
      this.logger.warn({ event: "command_detail_retention_batch", status: "failed", ...result });
      throw error;
    }
  }

  private async defer(commandId: string, reason: string) {
    await this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Command"
        WHERE "id" = ${commandId} AND "contentRedactedAt" IS NULL FOR UPDATE SKIP LOCKED`);
      if (!rows.length) return;
      await tx.$executeRaw(Prisma.sql`INSERT INTO "CommandRetentionAttempt"
        ("commandId", "reasonCode", "attemptCount", "lastTriedAt", "retryAfterAt")
        VALUES (${commandId}, ${`detail_${reason}`}, 1, transaction_timestamp() AT TIME ZONE 'UTC',
          (transaction_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 hour')
        ON CONFLICT ("commandId") DO UPDATE SET "reasonCode" = EXCLUDED."reasonCode",
          "attemptCount" = "CommandRetentionAttempt"."attemptCount" + 1,
          "lastTriedAt" = EXCLUDED."lastTriedAt", "retryAfterAt" = EXCLUDED."retryAfterAt"`);
    });
  }
}
