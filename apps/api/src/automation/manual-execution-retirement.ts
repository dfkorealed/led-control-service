import { ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { automationExecutionIngestedAckV1Schema, mqttTopics } from "@led-control/shared";
import { CommandSafetyDigest } from "../commands/command-safety-digest";
import { threeCalendarMonthsBefore } from "../retention/calendar-month-window";
import { canonicalPayloadHash } from "./automation-payload-hash";
import {
  assertNoOrphanManualExecutionSources,
  backfillManualExecutionReceiptsForCommand,
  type VerifiedManualRetirementCandidate
} from "./manual-execution-receipt-backfill";

/**
 * Only a separately credentialed protected retention worker may call this.
 * The default API runtime has no EXECUTE grant on the private SQL function.
 * This helper does not delete Command, enable purge, or clean ACK outboxes.
 */
export async function retireManualExecutionDetailsForCommand(
  tx: Prisma.TransactionClient,
  commandId: string,
  now: Date,
  digest: CommandSafetyDigest
): Promise<number> {
  // An orphaned legacy row may carry an Override-ID alias no per-Command
  // search can attribute. Stop the entire transaction before changing data.
  await assertNoOrphanManualExecutionSources(tx);
  const verified: VerifiedManualRetirementCandidate[] = [];
  await backfillManualExecutionReceiptsForCommand(tx, commandId, now, digest, verified);
  const cutoff = threeCalendarMonthsBefore(now);
  let retired = 0;
  for (const candidate of verified) {
    let result: Array<{ retired: boolean }>;
    try {
      result = await tx.$queryRaw<Array<{ retired: boolean }>>(Prisma.sql`
        SELECT command_protected.retire_manual_execution_detail(
          ${candidate.executionId}, ${commandId}, ${cutoff}, ${candidate.reportHash}) AS retired`);
    } catch {
      // Do not expose event/Command identity, raw SQL, or key material to API
      // clients. The caller's transaction rolls back all prior candidates.
      throw new ServiceUnavailableException({ code: "manual_execution_retirement_unverifiable" });
    }
    if (result.length !== 1) {
      throw new ServiceUnavailableException({ code: "manual_execution_retirement_unverifiable" });
    }
    if (result[0]?.retired === true) {
      retired += 1;
      continue;
    }
    // A parallel protected worker can win the table lock after this worker's
    // preflight snapshot. Treat a missing row as idempotent only when its
    // exact keyed receipt now carries a durable retirement marker.
    const receipt = await tx.manualExecutionReplayReceipt.findUnique({ where: {
      gatewayId_eventId_sequence: { gatewayId: candidate.gatewayId,
        eventId: candidate.eventId, sequence: candidate.sequence }
    }, select: { sourceRetiredAt: true } });
    if (!receipt?.sourceRetiredAt) {
      throw new ServiceUnavailableException({ code: "manual_execution_retirement_unverifiable" });
    }
  }
  return retired;
}

type RetiredAckCandidate = {
  id: string; siteId: string; gatewayId: string; eventId: string;
  sequence: bigint; eventDigest: string; keyVersion: number;
  ackIngestedAt: Date; applicationAckKey: string; topic: string; payload: Prisma.JsonValue;
  payloadHash: string | null;
};

/** Bounded, fail-closed derived ACK cleanup for a protected retention worker.
 * It does not run from the default timer until role/key/publisher rollout is
 * proven. Replay creates the same ACK from the keyed receipt after deletion. */
export async function pruneRetiredManualApplicationAcks(
  tx: Prisma.TransactionClient,
  digest: CommandSafetyDigest,
  limit: number
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("invalid ACK cleanup limit");
  const rows = await tx.$queryRaw<RetiredAckCandidate[]>(Prisma.sql`
    SELECT outbox."id", receipt."siteId", receipt."gatewayId", receipt."eventId",
      receipt."sequence", receipt."eventDigest", receipt."keyVersion",
      receipt."ackIngestedAt", outbox."applicationAckKey", outbox."topic",
      outbox."payload", outbox."payloadHash"
    FROM "MqttOutbox" AS outbox
    JOIN "ManualExecutionReplayReceipt" AS receipt
      ON receipt."gatewayId" = outbox."gatewayId"
      AND receipt."eventId" = outbox."payload"->>'eventId'
      AND receipt."sequence"::text = outbox."payload"->>'sequence'
    WHERE receipt."sourceRetiredAt" IS NOT NULL
      AND outbox."applicationAckKey" IS NOT NULL
      AND outbox."publishedAt" IS NOT NULL AND outbox."lockedBy" IS NULL
      AND outbox."lockedAt" IS NULL AND outbox."leaseExpiresAt" IS NULL
      AND outbox."deadLetteredAt" IS NULL AND outbox."supersededAt" IS NULL
      AND outbox."dispatchId" IS NULL AND outbox."revision" IS NULL
    ORDER BY receipt."sourceRetiredAt", outbox."id" LIMIT ${limit}
  `);
  let deleted = 0;
  for (const row of rows) {
    const ack = automationExecutionIngestedAckV1Schema.safeParse(row.payload);
    if (!ack.success || row.payloadHash !== canonicalPayloadHash(ack.data)
      || ack.data.gatewayId !== row.gatewayId || ack.data.eventId !== row.eventId
      || ack.data.sequence !== Number(row.sequence)
      || new Date(ack.data.ingestedAt).getTime() !== row.ackIngestedAt.getTime()
      || row.applicationAckKey !== `automation-execution:${row.gatewayId}:${row.eventId}:${row.sequence}:${ack.data.reportPayloadHash}`
      || row.topic !== mqttTopics.automationExecutionIngested(row.siteId, row.gatewayId)) {
      throw new ServiceUnavailableException({ code: "manual_execution_ack_cleanup_unverifiable" });
    }
    let verified = false;
    try {
      verified = digest.verify("manual-execution-full-event", [row.siteId, row.gatewayId,
        row.eventId, String(row.sequence), ack.data.reportPayloadHash],
      { keyVersion: row.keyVersion, value: row.eventDigest });
    } catch {
      throw new ServiceUnavailableException({ code: "manual_execution_ack_cleanup_unverifiable" });
    }
    if (!verified) {
      throw new ServiceUnavailableException({ code: "manual_execution_ack_cleanup_unverifiable" });
    }
    let result: Array<{ removed: boolean }>;
    try {
      result = await tx.$queryRaw<Array<{ removed: boolean }>>(Prisma.sql`
        SELECT command_protected.cleanup_retired_manual_ack(
          ${row.id}, ${ack.data.reportPayloadHash}) AS removed`);
    } catch {
      throw new ServiceUnavailableException({ code: "manual_execution_ack_cleanup_unverifiable" });
    }
    if (result.length !== 1 || result[0]?.removed !== true) {
      throw new ServiceUnavailableException({ code: "manual_execution_ack_cleanup_unverifiable" });
    }
    deleted += 1;
  }
  return deleted;
}
