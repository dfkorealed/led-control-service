import { CommandOutcome, Prisma } from "@prisma/client";
import { recordMonitoringActivities } from "./monitoring-activity.projection";
import { CommandSafetyDigest } from "../commands/command-safety-digest";

/** Caller must first win the Command outcome compare-and-set in the same transaction. */
export async function recordCommandOutcomeActivity(
  tx: Prisma.TransactionClient,
  commandId: string,
  previousOutcome: CommandOutcome | null,
  outcome: CommandOutcome
) {
  if (outcome === "pending" || previousOutcome === outcome) return;
  const command = await tx.command.findUnique({ where: { id: commandId },
    select: { siteId: true, targetFixtureIds: true } });
  if (!command) throw new Error("command outcome source disappeared");
  const targets = command.targetFixtureIds;
  if (!Array.isArray(targets) || targets.some(id => typeof id !== "string")) {
    throw new Error("command target snapshot is invalid");
  }
  if (!targets.length) return;
  const fixtures = await tx.fixture.findMany({ where: { siteId: command.siteId, id: { in: targets as string[] } },
    select: { floorId: true }, orderBy: { floorId: "asc" } });
  // Deleted targets have no reliable current floor. Do not invent a historical
  // floor from an ID alone; keep Command outcome state without a false activity.
  const floorIds = [...new Set(fixtures.map(fixture => fixture.floorId))].sort();
  if (process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED === "1") {
    await rekeyCommandOutcomeActivities(tx, command.siteId, commandId, outcome, floorIds, true);
    return;
  }
  await recordMonitoringActivities(tx, floorIds.map(floorId => ({
    siteId: command.siteId, floorId, sourceType: "command", sourceKey: `${commandId}:${outcome}`,
    kind: "command_result", commandOutcome: outcome
  })));
}

/** Shared by the producer and the bounded legacy backfill under one DB lock order. */
export async function rekeyCommandOutcomeActivities(tx: Prisma.TransactionClient,
  siteId: string, commandId: string, outcome: Exclude<CommandOutcome, "pending">,
  floorIds: string[], createMissing: boolean) {
  if (floorIds.length === 0) return 0;
  const rawKey = `${commandId}:${outcome}`;
  const digest = new CommandSafetyDigest();
  const parts = [siteId, commandId, outcome];
  const preferred = digest.sign("monitoring-activity", parts);
  const keyed = digest.signAll("monitoring-activity", parts)
    .map(({ keyVersion, value }) => `v${keyVersion}:${value}`);
  const preferredKey = `v${preferred.keyVersion}:${preferred.value}`;
  // All new producers and the backfill acquire this before touching an activity
  // row. Old binaries do not; rollout must stop/drain them before purge cutover.
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(780140,
    hashtext(${siteId + ":" + commandId + ":" + outcome}))::text AS "locked"`);
  const rows = await tx.monitoringActivity.findMany({ where: { siteId,
    sourceType: "command", sourceKey: { in: [rawKey, ...keyed] },
    floorId: { in: floorIds } },
    select: { id: true, floorId: true, sourceKey: true, recordedAt: true } });
  const missing: string[] = [];
  let rekeyed = 0;
  for (const floorId of floorIds) {
    const floorRows = rows.filter(row => row.floorId === floorId);
    const legacy = floorRows.find(row => row.sourceKey === rawKey);
    const signed = floorRows.filter(row => row.sourceKey !== rawKey);
    if (signed.length > 1) throw new Error("command activity has conflicting keyed source versions");
    if (legacy && signed.length === 1) {
      if (legacy.recordedAt < signed[0].recordedAt) {
        await tx.monitoringActivity.update({ where: { id: signed[0].id },
          data: { recordedAt: legacy.recordedAt } });
      }
      await tx.monitoringActivity.delete({ where: { id: legacy.id } });
      rekeyed += 1;
    } else if (legacy) {
      await tx.monitoringActivity.update({ where: { id: legacy.id },
        data: { sourceKey: preferredKey } });
      rekeyed += 1;
    } else if (signed.length === 0 && createMissing) {
      missing.push(floorId);
    }
  }
  await recordMonitoringActivities(tx, missing.map(floorId => ({
    siteId, floorId, sourceType: "command", sourceKey: preferredKey,
    kind: "command_result", commandOutcome: outcome
  })));
  return rekeyed;
}
