import { Prisma } from "@prisma/client";
import { threeCalendarMonthsBefore } from "../retention/calendar-month-window";

type CommandReadinessDb = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * The read cutoff is a joint rollout, not an environment toggle by itself.
 * If even one old uncertain/pending command has no recovery case, keep the
 * legacy path visible for that site until backfill or on-demand migration can
 * preserve its physical status-check route. This is a temporary retention
 * exception that must be surfaced as overdue backlog, never a purge permit.
 */
export async function commandHistoryRetentionReady(db: CommandReadinessDb, siteId: string, now: Date) {
  if (process.env.COMMAND_HISTORY_RETENTION_ENABLED !== "1"
    || process.env.COMMAND_RECOVERY_ACTIONS_ENABLED !== "1"
    || process.env.COMMAND_RECOVERY_PUBLISHER_READY !== "1") return false;
  const cutoff = threeCalendarMonthsBefore(now);
  const unheld = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT command."id" FROM "Command" AS command
    WHERE command."siteId" = ${siteId} AND command."createdAt" < ${cutoff}
      AND (command."outcome" IS NULL OR command."outcome" IN ('pending', 'unknown'))
      AND NOT EXISTS (SELECT 1 FROM "UnresolvedCommandHold" AS hold
        WHERE hold."originalCommandId" = command."id" AND hold."siteId" = command."siteId")
    LIMIT 1
  `);
  return unheld.length === 0;
}
