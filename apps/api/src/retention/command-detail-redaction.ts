import { Prisma } from "@prisma/client";
import { CommandSafetyDigest } from "../commands/command-safety-digest";
import { backfillManualExecutionReceiptsForCommand, type VerifiedManualRetirementCandidate } from "../automation/manual-execution-receipt-backfill";

export class CommandDetailRedactionBlocked extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "CommandDetailRedactionBlocked";
  }
}

/** The caller owns the Command row lock and the enclosing transaction. */
export async function redactSettledCommandDetails(
  tx: Prisma.TransactionClient, commandId: string, retainedFromUtc: Date
): Promise<"redacted" | "already_redacted"> {
  try { return await redactLockedCommand(tx, commandId, retainedFromUtc); }
  catch (error) {
    if (error instanceof CommandDetailRedactionBlocked) throw error;
    // Never swallow a partial mutation or expose raw SQL/data in diagnostics.
    // The caller must roll back this transaction before recording the reason.
    throw new CommandDetailRedactionBlocked("raw_copy_cleanup_failed");
  }
}

async function redactLockedCommand(
  tx: Prisma.TransactionClient, commandId: string, retainedFromUtc: Date
): Promise<"redacted" | "already_redacted"> {
  // The caller already owns Command. Try rather than wait for the established
  // global membership lock, avoiding inversion with existing Set/ACK writers.
  const mutex = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(1279607873, 1296387394) AS locked`);
  if (!mutex[0]?.locked) throw new CommandDetailRedactionBlocked("producer_locked");
  const command = await tx.command.findUnique({ where: { id: commandId }, include: {
    dispatches: { include: { outbox: true } }, manualOverride: true
  } });
  if (!command) throw new CommandDetailRedactionBlocked("command_missing");
  if (command.contentRedactedAt) return "already_redacted";
  if (!Number.isFinite(retainedFromUtc.getTime()) || command.createdAt >= retainedFromUtc) {
    throw new CommandDetailRedactionBlocked("command_not_expired");
  }
  if (!command.outcome || ["pending", "unknown"].includes(command.outcome)) {
    throw new CommandDetailRedactionBlocked("command_unresolved");
  }
  if (await tx.unresolvedCommandHold.findUnique({ where: { originalCommandId: commandId } })) {
    throw new CommandDetailRedactionBlocked("command_hold_exists");
  }
  if (!command.dispatches.length || command.dispatches.some(row =>
    !["completed", "failed", "timed_out"].includes(row.status))) {
    throw new CommandDetailRedactionBlocked("dispatch_unsettled");
  }
  if (await tx.commandFixtureResult.findFirst({ where: { dispatch: { commandId }, status: "pending" } })) {
    throw new CommandDetailRedactionBlocked("fixture_result_unsettled");
  }
  // Keep publisher lease validation and deletion under the same row locks.
  // NOWAIT avoids reversing the publisher's outbox -> Command lock order.
  try {
    await tx.$queryRaw(Prisma.sql`SELECT outbox."id" FROM "MqttOutbox" outbox
      JOIN "CommandDispatch" dispatch ON dispatch."id" = outbox."dispatchId"
      WHERE dispatch."commandId" = ${commandId} FOR UPDATE OF outbox NOWAIT`);
  } catch { throw new CommandDetailRedactionBlocked("outbox_locked"); }
  const outboxes = await tx.mqttOutbox.findMany({ where: { dispatch: { commandId } } });
  if (outboxes.length !== command.dispatches.length || outboxes.some(row => !row.publishedAt
    || row.lockedBy || row.lockedAt || row.leaseExpiresAt || row.deadLetteredAt || row.supersededAt)) {
    throw new CommandDetailRedactionBlocked("outbox_unsettled");
  }
  const clocks = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT transaction_timestamp() AT TIME ZONE 'UTC' AS now`);
  if (command.manualOverride && (!command.manualOverride.endedAt || command.manualOverride.endedAt > clocks[0].now)) {
    throw new CommandDetailRedactionBlocked("manual_override_active");
  }
  const gatewayIds = [...new Set(command.dispatches.map(row => row.gatewayId))];
  try {
    // Manual ingestion owns Gateway before looking up its source. A NOWAIT lock
    // establishes the same exclusion without waiting in the reverse order.
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Gateway"
      WHERE "id" IN (${Prisma.join(gatewayIds)}) ORDER BY "id" FOR UPDATE NOWAIT`);
  } catch { throw new CommandDetailRedactionBlocked("gateway_locked"); }
  // Legacy ACK ledger sequences are allocated independently of Command sequence:
  // guessing their owner could erase another unresolved command's evidence.
  if (await tx.processedGatewayEvent.findFirst({ where: { gatewayId: { in: gatewayIds },
    eventType: "device_status_ack", payloadHash: { not: null } } })) {
    throw new CommandDetailRedactionBlocked("legacy_ack_attribution_unverifiable");
  }
  const digest = new CommandSafetyDigest();
  const verified: VerifiedManualRetirementCandidate[] = [];
  const orphaned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT execution."id" FROM "AutomationExecution" execution
    WHERE execution."siteId" = ${command.siteId} AND execution."contentRedactedAt" IS NULL
      AND execution."payload"->>'sourceType' = 'manual_override'
      AND NOT EXISTS (SELECT 1 FROM "ManualOverride" source JOIN "Command" owner ON owner."id" = source."commandId"
        WHERE source."id" = execution."manualOverrideId" AND source."siteId" = execution."siteId"
          AND source."gatewayId" = execution."gatewayId" AND owner."siteId" = execution."siteId"
          AND execution."payload"->>'sourceId' IN (source."id", source."commandId")) LIMIT 1`);
  if (orphaned.length) throw new CommandDetailRedactionBlocked("manual_source_attribution_unverifiable");
  const rawManual = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "AutomationExecution" WHERE "contentRedactedAt" IS NULL
      AND ("manualOverrideId" = ${command.manualOverride?.id ?? null}
        OR "payload"->>'sourceId' IN (${command.id}, ${command.manualOverride?.id ?? null})) LIMIT 1001`);
  if (rawManual.length > 1000 || (!command.manualOverride && rawManual.length)) {
    throw new CommandDetailRedactionBlocked("manual_execution_unverifiable");
  }
  if (command.manualOverride) {
    try {
      // This verifier only creates keyed receipts. No protected purge/retirement
      // SQL is used; the live Command and all derived parent aliases remain.
      await backfillManualExecutionReceiptsForCommand(tx, commandId, clocks[0].now, digest, verified);
    } catch { throw new CommandDetailRedactionBlocked("manual_execution_unverifiable"); }
    if (verified.length !== rawManual.length) throw new CommandDetailRedactionBlocked("manual_execution_unverifiable");
    for (const candidate of verified) {
      const prefix = `automation-execution:${candidate.gatewayId}:${candidate.eventId}:${candidate.sequence}:`;
      try {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MqttOutbox"
          WHERE "applicationAckKey" LIKE ${prefix + "%"} FOR UPDATE NOWAIT`);
      } catch { throw new CommandDetailRedactionBlocked("manual_ack_locked"); }
      const acks = await tx.mqttOutbox.findMany({ where: { applicationAckKey: { startsWith: prefix } } });
      if (acks.length !== 1 || acks.some(row => !row.publishedAt || row.lockedBy || row.lockedAt
        || row.leaseExpiresAt || row.deadLetteredAt || row.supersededAt)) {
        throw new CommandDetailRedactionBlocked("manual_ack_unsettled");
      }
      await tx.automationExecutionFixtureResult.deleteMany({ where: { executionId: candidate.executionId } });
      await tx.mqttOutbox.deleteMany({ where: { id: { in: acks.map(row => row.id) } } });
      await tx.$executeRaw(Prisma.sql`UPDATE "AutomationExecution" SET "payload" = NULL,
        "payloadHash" = NULL, "occurrenceKey" = NULL,
        "contentRedactedAt" = transaction_timestamp() AT TIME ZONE 'UTC' WHERE "id" = ${candidate.executionId}`);
    }
    await tx.manualOverrideFixture.deleteMany({ where: { manualOverrideId: command.manualOverride.id } });
    await tx.$executeRaw(Prisma.sql`UPDATE "ManualOverride" SET "brightnessPercent" = NULL,
      "requestedById" = NULL, "sourceDigest" = NULL, "sourceKeyVersion" = NULL,
      "contentRedactedAt" = transaction_timestamp() AT TIME ZONE 'UTC' WHERE "id" = ${command.manualOverride.id}`);
  }
  // Customer activity has independent recordedAt, so removing only old rows
  // would leave late-created copies. Remove both raw and known keyed aliases.
  const sourceKeys = ["applied", "not_applied", "partially_applied", "unknown"].flatMap(outcome => {
    try { return digest.signAll("monitoring-activity", [command.siteId, commandId, outcome])
      .map(({ keyVersion, value }) => `v${keyVersion}:${value}`); }
    catch { return []; }
  });
  const supportedPrefixes = [...new Set(sourceKeys.map(key => `${key.split(":")[0]}:`))];
  if (await tx.monitoringActivity.findFirst({ where: {
    siteId: command.siteId, sourceType: "command", sourceKey: { startsWith: "v" },
    ...(supportedPrefixes.length ? { NOT: { OR: supportedPrefixes.map(prefix => ({ sourceKey: { startsWith: prefix } })) } } : {})
  } })) throw new CommandDetailRedactionBlocked("activity_source_key_unavailable");
  await tx.monitoringActivity.deleteMany({ where: { siteId: command.siteId, sourceType: "command",
    OR: [{ sourceKey: { startsWith: `${commandId}:` } }, { sourceKey: { in: sourceKeys } }] } });
  const jobs = await tx.gatewayRecommissionJob.findMany({ where: { siteId: command.siteId }, take: 1001 });
  if (jobs.length > 1000) throw new CommandDetailRedactionBlocked("recommission_job_backlog_unbounded");
  for (const job of jobs) {
    if (!["applied", "finalized"].includes(job.status)) {
      throw new CommandDetailRedactionBlocked("recommission_job_active");
    }
    const serialized = JSON.stringify(job.targetSnapshot);
    if (![command.id, ...command.dispatches.map(row => row.id), ...verified.map(row => row.executionId),
      ...(command.manualOverride ? [command.manualOverride.id] : [])].some(id => serialized.includes(id))) continue;
    const snapshot = job.targetSnapshot;
    if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object"
      || typeof snapshot.appliedClaimCodeHashDigest !== "string" || !job.appliedAt) {
      throw new CommandDetailRedactionBlocked("recommission_snapshot_unverifiable");
    }
    try { await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "GatewayRecommissionJob"
      WHERE "id" = ${job.id} FOR UPDATE NOWAIT`); }
    catch { throw new CommandDetailRedactionBlocked("recommission_job_locked"); }
    // Preserve the completed retry proof, matching today's completion producer.
    await tx.gatewayRecommissionJob.update({ where: { id: job.id }, data: {
      targetSnapshot: { appliedClaimCodeHashDigest: snapshot.appliedClaimCodeHashDigest }
    } });
  }
  await tx.commandFixtureResult.deleteMany({ where: { dispatch: { commandId } } });
  await tx.mqttOutbox.deleteMany({ where: { dispatch: { commandId } } });
  await tx.commandDispatch.updateMany({ where: { commandId }, data: {
    destinationAddress: null, meshControlGroupId: null, meshControlGroupVersion: null,
    errorCode: null, errorMessage: null
  } });
  await tx.$executeRaw(Prisma.sql`UPDATE "Command" SET
    "requestedBy" = NULL, "requestFingerprint" = NULL, "targetType" = NULL,
    "targetId" = NULL, "targetFixtureIds" = NULL, "brightness" = NULL,
    "errorMessage" = NULL, "contentRedactedAt" = transaction_timestamp() AT TIME ZONE 'UTC'
    WHERE "id" = ${commandId}`);
  return "redacted";
}
