import { CommandOutcome, Prisma, PrismaClient } from "@prisma/client";
import { rekeyCommandOutcomeActivities } from "./command-outcome-activity";

const LEGACY_SOURCE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(applied|not_applied|partially_applied|unknown)$/;

/**
 * Bounded, repeatable source-key rewrite. Run only after every Command
 * producer binary supports keyed keys; old producers can otherwise recreate
 * raw UUIDs after this pass. It does not delete any actual activity.
 */
export async function backfillLegacyCommandActivitySources(
  prisma: PrismaClient, limit = 1000, retainedOnly = false
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("invalid command activity backfill limit");
  }
  const visible = retainedOnly
    ? Prisma.sql`AND "recordedAt" >= ((transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '3 months')`
    : Prisma.empty;
  const candidates = await prisma.$queryRaw<Array<{ siteId: string; sourceKey: string; floorId: string }>>(Prisma.sql`
    SELECT "siteId", "sourceKey", "floorId"
    FROM "MonitoringActivity"
    WHERE "sourceType" = 'command'
      AND "sourceKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(applied|not_applied|partially_applied|unknown)$'
      ${visible}
    ORDER BY "recordedAt", "id"
    LIMIT ${limit}
  `);
  // Bound legacy row work, not source groups. One Command outcome may span
  // more floors than one page; only its selected floors are rewritten.
  const groups = new Map<string, { siteId: string; commandId: string;
    outcome: Exclude<CommandOutcome, "pending">; floorIds: string[] }>();
  for (const candidate of candidates) {
    const parsed = LEGACY_SOURCE.exec(candidate.sourceKey);
    if (!parsed) throw new Error("invalid legacy command activity source");
    const [, commandId, outcome] = parsed;
    const groupKey = `${candidate.siteId}:${candidate.sourceKey}`;
    const group = groups.get(groupKey) ?? { siteId: candidate.siteId, commandId,
      outcome: outcome as Exclude<CommandOutcome, "pending">, floorIds: [] };
    group.floorIds.push(candidate.floorId);
    groups.set(groupKey, group);
  }
  let rekeyed = 0;
  for (const group of groups.values()) {
    rekeyed += await prisma.$transaction(async tx => {
      return rekeyCommandOutcomeActivities(tx, group.siteId, group.commandId,
        group.outcome, group.floorIds, false);
    });
  }
  return { scanned: candidates.length, rekeyed };
}
