import { ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  automationExecutionActionResultPayloadV1Schema,
  automationExecutionEventV1Schema,
  automationExecutionIngestedAckV1Schema,
  mqttTopics
} from "@led-control/shared";
import { CommandSafetyDigest, CommandSafetyKeyUnavailableError } from "../commands/command-safety-digest";
import { threeCalendarMonthsBefore } from "../retention/calendar-month-window";
import { canonicalExecutionPayloadHash } from "./automation-mqtt-consumer.service";
import { canonicalPayloadHash } from "./automation-payload-hash";

const MAX_EXECUTIONS_PER_COMMAND = 1000;
export type VerifiedManualRetirementCandidate = {
  executionId: string; reportHash: string; gatewayId: string; eventId: string; sequence: bigint;
};

type LegacyManualRow = {
  id: string;
  siteId: string;
  gatewayId: string;
  eventId: string;
  sequence: bigint;
  revision: number;
  ruleId: string | null;
  manualOverrideId: string | null;
  occurrenceKey: string | null;
  kind: string;
  occurredAt: Date;
  payload: Prisma.JsonValue;
  payloadHash: string | null;
};

/**
 * A legacy manual result whose Override was already removed has no trustworthy
 * Command.createdAt attribution. A per-Command backfill cannot discover the
 * old Override-ID source alias in that state, so guarded cutover fails closed
 * until an operator resolves every such row. Call only under the global
 * producer stop/drain fence; this read alone is not a concurrent-writer lock.
 */
export async function assertNoOrphanManualExecutionSources(tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT execution."id"
    FROM "AutomationExecution" AS execution
    WHERE execution."kind" = 'action_result'
      AND (execution."manualOverrideId" IS NOT NULL
        OR execution."payload"->>'sourceType' = 'manual_override')
      AND NOT EXISTS (
        SELECT 1 FROM "ManualOverride" AS override
        JOIN "Command" AS command ON command."id" = override."commandId"
        WHERE override."id" = execution."manualOverrideId"
          AND override."siteId" = execution."siteId"
          AND override."gatewayId" = execution."gatewayId"
          AND command."siteId" = execution."siteId"
          AND execution."payload"->>'sourceType' = 'manual_override'
          AND execution."payload"->>'sourceId' IN (override."id", override."commandId")
      )
    LIMIT 1
  `);
  if (rows.length !== 0) throw unavailable();
}

/**
 * Backfill only exact replay/ACK evidence. This never deletes execution rows
 * or enables Command purge; the later B deletion must rerun attribution and
 * ACK checks inside its own fenced transaction before setting a retired mark.
 */
export async function backfillManualExecutionReceiptsForCommand(
  tx: Prisma.TransactionClient,
  commandId: string,
  now: Date,
  digest: CommandSafetyDigest,
  verifiedRetirementCandidates?: VerifiedManualRetirementCandidate[]
): Promise<number> {
  const command = await tx.command.findUnique({ where: { id: commandId },
    select: { id: true, siteId: true, createdAt: true,
      manualOverride: { select: { id: true, gatewayId: true } } } });
  if (!command) throw unavailable();
  if (command.createdAt >= threeCalendarMonthsBefore(now)) return 0;

  const overrideId = command.manualOverride?.id ?? null;
  const rows = await tx.$queryRaw<LegacyManualRow[]>(Prisma.sql`
    SELECT execution."id", execution."siteId", execution."gatewayId", execution."eventId",
      execution."sequence", execution."revision", execution."ruleId", execution."manualOverrideId",
      execution."occurrenceKey", execution."kind"::text AS "kind", execution."occurredAt",
      execution."payload", execution."payloadHash"
    FROM "AutomationExecution" AS execution
    WHERE execution."siteId" = ${command.siteId}
      AND execution."kind" = 'action_result'
      AND (execution."manualOverrideId" = ${overrideId}
        OR execution."payload"->>'sourceId' = ${commandId}
        OR execution."payload"->>'sourceId' = ${overrideId})
    ORDER BY execution."id"
    LIMIT ${MAX_EXECUTIONS_PER_COMMAND + 1}
    -- Backfill runs only after the producer stop/drain fence. The protected
    -- retirement function locks these tables and rechecks the exact evidence
    -- before deleting; the worker needs no direct UPDATE grant on raw rows.
  `);
  if (rows.length > MAX_EXECUTIONS_PER_COMMAND || (!command.manualOverride && rows.length > 0)) {
    throw unavailable();
  }
  let created = 0;
  for (const row of rows) {
    if (!command.manualOverride || row.siteId !== command.siteId
      || row.gatewayId !== command.manualOverride.gatewayId
      || row.manualOverrideId !== command.manualOverride.id) throw unavailable();
    const event = automationExecutionEventV1Schema.safeParse({
      schemaVersion: 1, eventId: row.eventId, sequence: Number(row.sequence),
      gatewayId: row.gatewayId, revision: row.revision, ruleId: row.ruleId,
      occurrenceKey: row.occurrenceKey, kind: row.kind,
      occurredAt: row.occurredAt.toISOString(), payload: row.payload
    });
    const manualPayload = event.success && event.data.kind === "action_result"
      ? automationExecutionActionResultPayloadV1Schema.safeParse(event.data.payload)
      : null;
    if (!event.success || event.data.kind !== "action_result"
      || !manualPayload?.success || manualPayload.data.sourceType !== "manual_override"
      || ![commandId, command.manualOverride.id].includes(manualPayload.data.sourceId)) {
      throw unavailable();
    }
    const reportHash = canonicalExecutionPayloadHash(event.data);
    if (row.payloadHash !== null && row.payloadHash !== reportHash) throw unavailable();
    const ackPrefix = `automation-execution:${row.gatewayId}:${row.eventId}:${row.sequence}:`;
    const ackKey = `${ackPrefix}${reportHash}`;
    // A second ACK for the same Gateway event identity but a different report
    // hash makes the original wire acknowledgement ambiguous. The later
    // guarded deletion must additionally stop/drain concurrent ACK producers.
    const ackRows = await tx.mqttOutbox.findMany({ where: {
      applicationAckKey: { startsWith: ackPrefix }
    },
      select: { gatewayId: true, dispatchId: true, revision: true,
        applicationAckKey: true, topic: true, payload: true, payloadHash: true } });
    const outbox = ackRows.length === 1 ? ackRows[0] : null;
    const ack = automationExecutionIngestedAckV1Schema.safeParse(outbox?.payload);
    if (!outbox || !ack.success || outbox.applicationAckKey !== ackKey
      || outbox.gatewayId !== row.gatewayId
      || outbox.dispatchId !== null || outbox.revision !== null
      || outbox.topic !== mqttTopics.automationExecutionIngested(command.siteId, row.gatewayId)
      || outbox.payloadHash !== canonicalPayloadHash(ack.data)
      || ack.data.gatewayId !== row.gatewayId || ack.data.eventId !== row.eventId
      || ack.data.sequence !== Number(row.sequence)
      || ack.data.reportPayloadHash !== reportHash) throw unavailable();
    let signed;
    try {
      signed = digest.sign("manual-execution-full-event", [command.siteId,
        row.gatewayId, row.eventId, String(row.sequence), reportHash]);
    } catch (error) {
      if (error instanceof CommandSafetyKeyUnavailableError) throw unavailable();
      throw error;
    }
    const existing = await tx.manualExecutionReplayReceipt.findUnique({ where: {
      gatewayId_eventId_sequence: { gatewayId: row.gatewayId, eventId: row.eventId, sequence: row.sequence }
    } });
    if (existing) {
      let same = false;
      try {
        same = existing.siteId === command.siteId
          && existing.ackIngestedAt.getTime() === new Date(ack.data.ingestedAt).getTime()
          && digest.verify("manual-execution-full-event", [command.siteId,
            row.gatewayId, row.eventId, String(row.sequence), reportHash],
          { keyVersion: existing.keyVersion, value: existing.eventDigest });
      } catch (error) {
        if (error instanceof CommandSafetyKeyUnavailableError) throw unavailable();
        throw error;
      }
      if (!same) throw unavailable();
      verifiedRetirementCandidates?.push({ executionId: row.id, reportHash,
        gatewayId: row.gatewayId, eventId: row.eventId, sequence: row.sequence });
      continue;
    }
    await tx.manualExecutionReplayReceipt.create({ data: {
      siteId: command.siteId, gatewayId: row.gatewayId, eventId: row.eventId,
      sequence: row.sequence, eventDigest: signed.value, keyVersion: signed.keyVersion,
      ackIngestedAt: new Date(ack.data.ingestedAt)
    } });
    verifiedRetirementCandidates?.push({ executionId: row.id, reportHash,
      gatewayId: row.gatewayId, eventId: row.eventId, sequence: row.sequence });
    created += 1;
  }
  return created;
}

function unavailable() {
  return new ServiceUnavailableException({ code: "manual_execution_backfill_unverifiable" });
}
