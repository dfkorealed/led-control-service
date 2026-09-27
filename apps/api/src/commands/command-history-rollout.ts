import { Prisma } from "@prisma/client";
import { threeCalendarMonthsBefore } from "../retention/calendar-month-window";

type CommandReadinessDb = Pick<Prisma.TransactionClient, "$queryRaw">;

/** GET-only preparation. The shared host-clock helper below still serves POST/Set callers. */
export function commandHistoryGetDbClockRequested() {
  return process.env.COMMAND_HISTORY_RETENTION_ENABLED === "1";
}

export async function commandHistoryGetReadBoundary(db: CommandReadinessDb, siteId: string) {
  const [clock] = await db.$queryRaw<Array<{ generatedAt: Date; retainedFrom: Date }>>(Prisma.sql`
    SELECT transaction_timestamp() AT TIME ZONE 'UTC' AS "generatedAt",
      (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '3 months' AS "retainedFrom"
  `);
  if (!(clock?.generatedAt instanceof Date) || Number.isNaN(clock.generatedAt.getTime())
    || !(clock.retainedFrom instanceof Date) || Number.isNaN(clock.retainedFrom.getTime())) {
    throw new Error("command history DB clock unavailable");
  }
  return { ...clock, retentionEnabled: commandHistoryGetDbClockRequested() };
}

/** Read-only activation audit. The sample contains opaque Command IDs only. */
export async function inspectCommandHistoryReadiness(db: CommandReadinessDb) {
  const [result] = await db.$queryRaw<Array<{
    generatedAt: Date; retainedFrom: Date; unheldCount: bigint; sampleIds: string[]
  }>>(Prisma.sql`
    WITH boundary AS (
      SELECT transaction_timestamp() AT TIME ZONE 'UTC' AS "generatedAt",
        (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '3 months' AS "retainedFrom"
    ), candidates AS (
      SELECT command."id" FROM "Command" AS command CROSS JOIN boundary
      WHERE command."createdAt" < boundary."retainedFrom"
        AND (command."outcome" IS NULL OR command."outcome" IN ('pending', 'unknown'))
        AND NOT EXISTS (SELECT 1 FROM "UnresolvedCommandHold" AS hold
          WHERE hold."originalCommandId" = command."id" AND hold."siteId" = command."siteId")
    )
    SELECT boundary."generatedAt", boundary."retainedFrom",
      (SELECT count(*) FROM candidates) AS "unheldCount",
      (SELECT coalesce(array_agg(sample."id"), ARRAY[]::text[]) FROM
        (SELECT "id" FROM candidates ORDER BY "id" LIMIT 20) AS sample) AS "sampleIds"
    FROM boundary
  `);
  if (!(result?.generatedAt instanceof Date) || Number.isNaN(result.generatedAt.getTime())
    || !(result.retainedFrom instanceof Date) || Number.isNaN(result.retainedFrom.getTime())
    || typeof result.unheldCount !== "bigint" || result.unheldCount < 0n
    || !Array.isArray(result.sampleIds)) throw new Error("command history preflight evidence unavailable");
  if (result.unheldCount > 0n) {
    throw new Error(`unheld old commands: ${result.unheldCount} (${result.sampleIds.join(",")})`);
  }
  return { generatedAt: result.generatedAt, retainedFrom: result.retainedFrom,
    unheldCount: Number(result.unheldCount), sampleIds: result.sampleIds };
}

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
