import { CommandOutcome, Prisma, PrismaClient } from "@prisma/client";
import { rekeyCommandOutcomeActivities } from "./command-outcome-activity";

const LEGACY_SOURCE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(applied|not_applied|partially_applied|unknown)$/;

/**
 * Bounded, repeatable source-key rewrite. Run only after every Command
 * producer binary supports keyed keys; old producers can otherwise recreate
 * raw UUIDs after this pass. It does not delete any actual activity.
 */
export async function backfillLegacyCommandActivitySources(prisma: PrismaClient, limit = 1000) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("invalid command activity backfill limit");
  }
  const candidates = await prisma.$queryRaw<Array<{ siteId: string; sourceKey: string }>>(Prisma.sql`
    SELECT DISTINCT "siteId", "sourceKey"
    FROM "MonitoringActivity"
    WHERE "sourceType" = 'command'
      AND "sourceKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(applied|not_applied|partially_applied|unknown)$'
    ORDER BY "siteId", "sourceKey"
    LIMIT ${limit}
  `);
  let rekeyed = 0;
  for (const candidate of candidates) {
    const parsed = LEGACY_SOURCE.exec(candidate.sourceKey);
    if (!parsed) throw new Error("invalid legacy command activity source");
    const [, commandId, outcome] = parsed;
    rekeyed += await prisma.$transaction(async tx => {
      const rows = await tx.monitoringActivity.findMany({ where: {
        siteId: candidate.siteId, sourceType: "command", sourceKey: candidate.sourceKey
      }, select: { floorId: true } });
      return rekeyCommandOutcomeActivities(tx, candidate.siteId, commandId,
        outcome as Exclude<CommandOutcome, "pending">,
        rows.map(row => row.floorId), false);
    });
  }
  return { scanned: candidates.length, rekeyed };
}
