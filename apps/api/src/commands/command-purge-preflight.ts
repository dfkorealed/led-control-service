import { Prisma } from "@prisma/client";
import { threeCalendarMonthsBefore } from "../retention/calendar-month-window";
import { CommandSafetyDigest } from "./command-safety-digest";

export type CommandPurgeCandidateInspection = {
  /** Diagnostic codes only. This read-only result is never a purge permit. */
  blockers: string[];
};

/**
 * Per-Command central-copy inspection for a future *protected* purge worker.
 * It deliberately does not mutate, acquire a publisher generation, or claim
 * that empty blockers alone authorizes deletion. The caller must use the same
 * DB transaction/locks as its eventual sweep and rerun every check after
 * staging, while global Gateway clock, broker and role gates remain separate.
 */
export async function inspectCommandPurgeCandidate(
  tx: Prisma.TransactionClient, commandId: string, now: Date, digest: CommandSafetyDigest
): Promise<CommandPurgeCandidateInspection> {
  const blockers = new Set<string>();
  const cutoff = threeCalendarMonthsBefore(now);
  const command = await tx.command.findUnique({ where: { id: commandId }, include: {
    dispatches: { include: { fixtureResults: true, outbox: true } },
    manualOverride: { include: { fixtures: true } }
  } });
  if (!command) return { blockers: ["command_missing"] };
  if (command.createdAt >= cutoff) blockers.add("command_not_expired");

  if (!command.requestedBy) {
    // A deleted User turns requestedBy NULL. The original actor is not
    // recoverable, so require a separate site-wide collision fence rather
    // than inventing a principal from a coincidental marker.
    try {
      const versions = digest.signAll("set-replay-orphan", [command.siteId,
        command.clientRequestId]);
      const fence = await tx.commandReplayFence.findFirst({ where: {
        siteId: command.siteId, principalSnapshot: "__unattributed__", domain: "set-replay-orphan",
        OR: versions.map(row => ({ keyDigest: row.value, keyVersion: row.keyVersion }))
      }, select: { id: true } });
      if (!fence) blockers.add("orphan_replay_fence_missing");
    } catch {
      blockers.add("replay_key_unavailable");
    }
  } else {
    try {
      const versions = digest.signAll("set-replay", [command.siteId, command.requestedBy,
        command.clientRequestId]);
      const fence = await tx.commandReplayFence.findFirst({ where: { siteId: command.siteId,
        principalSnapshot: command.requestedBy, domain: "set-replay",
        OR: versions.map(row => ({ keyDigest: row.value, keyVersion: row.keyVersion }))
      }, select: { id: true } });
      if (!fence) blockers.add("replay_fence_missing");
    } catch {
      blockers.add("replay_key_unavailable");
    }
  }

  const setDispatches = command.dispatches.filter(row => row.kind === "dimming");
  if (setDispatches.length !== 1) blockers.add("set_dispatch_shape_unverified");
  const oldChecks = command.dispatches.filter(row => row.kind === "status_check");
  const attempts = new Map<number, typeof oldChecks>();
  for (const dispatch of oldChecks) {
    if (!dispatch.verificationAttempt || dispatch.verificationAttempt < 1
      || dispatch.verificationAttempt > 3) blockers.add("legacy_status_check_shape_invalid");
    else attempts.set(dispatch.verificationAttempt,
      [...(attempts.get(dispatch.verificationAttempt) ?? []), dispatch]);
    try {
      const versions = digest.signAll("legacy-status-check-dispatch", [dispatch.id]);
      const owner = await tx.legacyStatusCheckDispatchFence.findFirst({ where: {
        siteId: command.siteId,
        OR: versions.map(row => ({ dispatchDigest: row.value, keyVersion: row.keyVersion }))
      }, select: { id: true } });
      if (!owner) blockers.add("legacy_status_check_ack_owner_missing");
    } catch {
      blockers.add("legacy_status_check_key_unavailable");
    }
  }
  for (const group of attempts.values()) {
    const owners = group.filter(row => row.clientRequestId);
    if (owners.length !== 1) {
      blockers.add("legacy_status_check_key_shape_invalid");
      continue;
    }
    try {
      const versions = digest.signAll("legacy-status-check-global", [owners[0].clientRequestId!]);
      const fence = await tx.commandReplayFence.findFirst({ where: {
        siteId: command.siteId, domain: "legacy-status-check-global",
        principalSnapshot: "__legacy_global__",
        OR: versions.map(row => ({ keyDigest: row.value, keyVersion: row.keyVersion }))
      }, select: { id: true } });
      if (!fence) blockers.add("legacy_status_check_replay_unstaged");
    } catch {
      blockers.add("legacy_status_check_key_unavailable");
    }
  }
  for (const dispatch of command.dispatches) {
    const outbox = dispatch.outbox;
    if (!outbox) blockers.add("set_outbox_missing");
    else if (!outbox.publishedAt || outbox.lockedBy || outbox.lockedAt || outbox.leaseExpiresAt
      || outbox.deadLetteredAt || outbox.supersededAt) blockers.add("command_outbox_not_settled");
    if (dispatch.fixtureResults.length === 0) blockers.add("dispatch_targets_missing");
  }

  const hold = await tx.unresolvedCommandHold.findUnique({ where: { originalCommandId: command.id },
    include: { targets: true, lateSetReceipts: true } });
  if (command.outcome === "unknown" || command.outcome === "pending" || command.outcome === null) {
    if (command.outcome !== "unknown") blockers.add("unresolved_outcome_unstaged");
    if (!hold || hold.siteId !== command.siteId || hold.originalCreatedAt.getTime() !== command.createdAt.getTime()
      || setDispatches.length !== 1 || hold.gatewayId !== setDispatches[0]?.gatewayId) {
      blockers.add("hold_missing_or_mismatched");
    } else {
      const targets = hold.targets.map(row => row.fixtureId).sort();
      const dispatched = setDispatches[0].fixtureResults.map(row => row.fixtureId).sort();
      if (targets.length === 0 || targets.length !== dispatched.length
        || targets.some((id, index) => id !== dispatched[index])
        || hold.targets.some(row => row.expectedBrightness !== command.brightness)) {
        blockers.add("hold_targets_mismatched");
      }
      const receipt = hold.lateSetReceipts.find(row =>
        row.originalDispatchId === setDispatches[0].id);
      if (!receipt || hold.lateSetReceipts.length !== 1) {
        blockers.add("late_set_receipt_missing");
      } else {
        try {
          if (!digest.verify("late-set-wire", [command.siteId, hold.gatewayId,
            command.id, setDispatches[0].id, setDispatches[0].idempotencyKey,
            String(setDispatches[0].sequence)],
          { keyVersion: receipt.keyVersion, value: receipt.wireDigest })) {
            blockers.add("late_set_receipt_mismatched");
          }
        } catch {
          blockers.add("late_set_key_unavailable");
        }
      }
      if (oldChecks.length && hold.verificationAttemptCount < Math.max(...attempts.keys())) {
        blockers.add("legacy_status_check_attempt_count_unstaged");
      }
    }
  } else if (hold) blockers.add("terminal_command_has_active_hold");

  if (command.manualOverride?.commandId === command.id) blockers.add("manual_override_fk_attached");
  const manualCopies = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT execution."id" FROM "AutomationExecution" AS execution
    WHERE execution."siteId" = ${command.siteId} AND execution."kind" = 'action_result'
      AND (execution."manualOverrideId" = ${command.manualOverride?.id ?? null}
        OR (execution."payload"->>'sourceType' = 'manual_override'
          AND execution."payload"->>'sourceId' IN (${command.id}, ${command.manualOverride?.id ?? null})))
    LIMIT 1
  `);
  if (manualCopies.length) blockers.add("manual_execution_raw_copy");
  const rawActivity = await tx.monitoringActivity.findFirst({ where: { siteId: command.siteId,
    sourceType: "command", sourceKey: { startsWith: `${command.id}:` }
  }, select: { id: true } });
  if (rawActivity) blockers.add("monitoring_activity_raw_source");

  const jobs = await tx.gatewayRecommissionJob.findMany({ where: { siteId: command.siteId },
    select: { status: true, targetSnapshot: true }, take: 1001 });
  if (jobs.length > 1000) blockers.add("recommission_job_backlog_unbounded");
  for (const job of jobs) {
    if (["prepared", "mqtt_revocation_pending", "mqtt_revoked"].includes(job.status)) {
      blockers.add("recommission_job_active");
    }
    const snapshot = JSON.stringify(job.targetSnapshot);
    if (snapshot.includes(command.id)
      || command.dispatches.some(row => snapshot.includes(row.id))) {
      blockers.add("recommission_snapshot_raw_copy");
    }
  }

  return { blockers: [...blockers].sort() };
}
