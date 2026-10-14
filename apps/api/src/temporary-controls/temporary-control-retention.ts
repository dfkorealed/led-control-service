import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class TemporaryControlRetention implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TemporaryControlRetention.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private stopped = false;
  constructor(private readonly prisma: PrismaService) {}
  onModuleInit() {
    if (this.timer || this.stopped || process.env.NODE_ENV === "test" || process.env.COMMAND_DETAIL_REDACTION_ENABLED !== "1") return;
    this.timer = setInterval(() => { void this.runBatch().catch(() => this.logger.warn("temporary detail retention unavailable")); }, 60_000);
    this.timer.unref();
  }
  async onModuleDestroy() { this.stopped = true; clearInterval(this.timer); this.timer = undefined; await this.running?.catch(() => {}); }
  async runBatch(limit = 100): Promise<number> {
    if (this.stopped || process.env.COMMAND_DETAIL_REDACTION_ENABLED !== "1") return 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid temporary retention batch limit");
    if (!this.running) this.running = this.sweep(limit).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async sweep(limit: number) {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "TemporaryControlSession"
        WHERE "detailsRedacted"=false AND "terminalAt" < date_trunc('milliseconds', transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '3 months'
          AND NOT EXISTS (SELECT 1 FROM "TemporaryControlLease" l WHERE l."ownerSessionId"="TemporaryControlSession"."id")
          AND NOT EXISTS (SELECT 1 FROM "TemporaryControlTarget" t WHERE t."sessionId"="TemporaryControlSession"."id" AND t."resolvedAt" IS NULL)
        ORDER BY "terminalAt", "id" LIMIT ${limit} FOR UPDATE SKIP LOCKED`);
      for (const { id } of rows) {
        await tx.temporaryControlSession.update({ where: { id }, data: { detailsRedacted: true, brightness: null, reason: null } });
        // Settled evidence is never rewritten; only these nullable details are
        // cleared after the session's terminal redaction guard has been set.
        await tx.temporaryControlTarget.updateMany({ where: { sessionId: id }, data: { configurationReadback: Prisma.DbNull, reason: null } });
        await tx.temporaryControlResultReceipt.updateMany({ where: { sessionId: id }, data: { result: Prisma.DbNull } });
        await tx.temporaryControlOutbox.updateMany({ where: { sessionId: id, completedAt: { not: null } }, data: { payload: Prisma.DbNull } });
      }
      return rows.length;
    }, { timeout: 30_000 });
  }
}
