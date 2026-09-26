import { Prisma } from "@prisma/client";
import { retireManualExecutionDetailsForCommand, pruneRetiredManualApplicationAcks } from
  "../automation/manual-execution-retirement";
import { rekeyCommandOutcomeActivities } from "../monitoring-activity/command-outcome-activity";
import { threeCalendarMonthsBefore } from "../retention/calendar-month-window";
import { inspectCommandPurgeCandidate } from "./command-purge-preflight";
import { stageLateSetReceiptsForHold } from "./command-late-set-receipt";
import { stageLegacyGetSafetyForCommand } from "./command-legacy-get-safety";
import { CommandSafetyDigest } from "./command-safety-digest";

export class CommandPurgeCandidateBlocked extends Error {
  constructor(readonly blockers: string[]) { super("command purge candidate is not safely staged"); }
}

/** Internal stage shared with the separately gated, protected worker proof. */
export async function stageExpiredCommandCandidate(
  tx: Prisma.TransactionClient, commandId: string, now: Date, digest: CommandSafetyDigest
): Promise<Date> {
  await tx.$executeRaw(Prisma.sql`SELECT "lock_automation_membership_mutation"()`);
  const cutoff = threeCalendarMonthsBefore(now);
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Command" WHERE "id" = ${commandId}
      AND "createdAt" < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
    FOR UPDATE SKIP LOCKED
  `);
  if (locked.length !== 1) throw new CommandPurgeCandidateBlocked(["command_missing_or_not_expired"]);
  const command = await tx.command.findUniqueOrThrow({ where: { id: commandId },
    include: { dispatches: true, manualOverride: true } });
  // Legacy Set retry prevention is staged before any raw row can disappear.
  const domain = command.requestedBy ? "set-replay" : "set-replay-orphan";
  const principalSnapshot = command.requestedBy ?? "__unattributed__";
  const parts = command.requestedBy
    ? [command.siteId, command.requestedBy, command.clientRequestId]
    : [command.siteId, command.clientRequestId];
  const versions = digest.signAll(domain, parts);
  const fence = await tx.commandReplayFence.findFirst({ where: { siteId: command.siteId,
    principalSnapshot, domain,
    OR: versions.map(row => ({ keyDigest: row.value, keyVersion: row.keyVersion }))
  } });
  if (!fence) {
    const signed = digest.sign(domain, parts);
    await tx.commandReplayFence.create({ data: { siteId: command.siteId,
      principalSnapshot, domain,
      keyDigest: signed.value, keyVersion: signed.keyVersion } });
  }

  const legacyGetAttempts = await stageLegacyGetSafetyForCommand(tx, command.id,
    command.siteId, digest);

  if (["pending", "unknown"].includes(command.outcome ?? "pending")) {
    if (command.outcome !== "unknown" || command.dispatches.filter(row => row.kind === "dimming").length !== 1) {
      throw new CommandPurgeCandidateBlocked(["unresolved_outcome_unstaged"]);
    }
    const dispatch = command.dispatches.find(row => row.kind === "dimming")!;
    const targets = command.targetFixtureIds;
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 1000
      || targets.some(id => typeof id !== "string") || new Set(targets).size !== targets.length) {
      throw new CommandPurgeCandidateBlocked(["hold_targets_mismatched"]);
    }
    const fixtureIds = targets as string[];
    const live = await tx.fixture.count({ where: { id: { in: fixtureIds },
      siteId: command.siteId, gatewayId: dispatch.gatewayId } });
    if (live !== fixtureIds.length) throw new CommandPurgeCandidateBlocked(["hold_targets_mismatched"]);
    const oldHold = await tx.unresolvedCommandHold.findUnique({ where: { originalCommandId: command.id } });
    const hold = oldHold ?? await tx.unresolvedCommandHold.create({ data: {
      siteId: command.siteId, gatewayId: dispatch.gatewayId,
      originalCommandId: command.id, originalCreatedAt: command.createdAt,
      reasonCode: "outcome_unknown", targets: { createMany: { data: fixtureIds.map(fixtureId => ({
        fixtureId, expectedBrightness: command.brightness
      })) } }
    } });
    if (legacyGetAttempts > hold.verificationAttemptCount) {
      await tx.unresolvedCommandHold.update({ where: { id: hold.id }, data: {
        verificationAttemptCount: legacyGetAttempts
      } });
    }
    await stageLateSetReceiptsForHold(tx, hold.id, digest);
  }

  // A raw command UUID in a customer activity must not outlive the Command
  // merely because that activity has its own later recordedAt/3-month window.
  const legacyActivities = await tx.monitoringActivity.findMany({ where: { siteId: command.siteId,
    sourceType: "command", sourceKey: { startsWith: `${command.id}:` }
  }, select: { floorId: true, commandOutcome: true } });
  const byOutcome = new Map<"applied" | "not_applied" | "partially_applied" | "unknown", Set<string>>();
  for (const row of legacyActivities) {
    if (!row.commandOutcome || !["applied", "not_applied", "partially_applied", "unknown"].includes(row.commandOutcome)) {
      throw new CommandPurgeCandidateBlocked(["monitoring_activity_raw_source"]);
    }
    const outcome = row.commandOutcome as "applied" | "not_applied" | "partially_applied" | "unknown";
    const floors = byOutcome.get(outcome) ?? new Set<string>();
    floors.add(row.floorId);
    byOutcome.set(outcome, floors);
  }
  for (const [outcome, floorIds] of byOutcome) {
    await rekeyCommandOutcomeActivities(tx, command.siteId, command.id, outcome,
      [...floorIds], false);
  }

  // B detail+child removal and exact ACK fingerprint cleanup occur before
  // detaching the Override's live Command FK. The replay receipt survives.
  await retireManualExecutionDetailsForCommand(tx, command.id, now, digest);
  await pruneRetiredManualApplicationAcks(tx, digest, 1000);
  if (command.manualOverride) {
    const result = await tx.$queryRaw<Array<{ detached: boolean }>>(Prisma.sql`
      SELECT command_protected.detach_expired_manual_source(${command.manualOverride.id}) AS detached
    `);
    if (result[0]?.detached !== true) throw new CommandPurgeCandidateBlocked(["manual_source_detach_unverified"]);
  }

  const inspected = await inspectCommandPurgeCandidate(tx, command.id, now, digest);
  if (inspected.blockers.length) throw new CommandPurgeCandidateBlocked(inspected.blockers);
  return cutoff;
}
