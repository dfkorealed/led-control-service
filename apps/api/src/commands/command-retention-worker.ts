import { Prisma, PrismaClient } from "@prisma/client";
import { stageExpiredCommandCandidate, CommandPurgeCandidateBlocked } from "./command-purge-staging";
import { CommandSafetyDigest } from "./command-safety-digest";
import { CommandPurgeBarrier, storeDisposableBarrierEvidence } from "./command-purge-barrier.service";

const MAX_BATCH = 25;
const RETRY_DELAY_MS = 60 * 60 * 1000;
const REASON_CODES = new Set([
  "drain_evidence_unavailable", "drain_wait_pending", "publish_members_unfenced",
  "clock_continuity_unavailable", "publish_attempt_envelope_unavailable", "barrier_continuity_reset",
  "barrier_state_unavailable",
  "candidate_unverified", "protected_delete_rejected", "command_missing_or_not_expired",
  "command_delete_lost_race", "command_not_expired", "command_outbox_not_settled",
  "dispatch_targets_missing", "hold_missing_or_mismatched", "hold_targets_mismatched",
  "late_set_key_unavailable", "late_set_receipt_mismatched", "late_set_receipt_missing",
  "legacy_status_check_ack_owner_missing", "legacy_status_check_attempt_count_unstaged",
  "legacy_status_check_key_shape_invalid", "legacy_status_check_key_unavailable",
  "legacy_status_check_replay_unstaged", "legacy_status_check_shape_invalid",
  "manual_execution_raw_copy", "manual_override_fk_attached", "manual_source_detach_unverified",
  "monitoring_activity_raw_source", "orphan_replay_fence_missing", "recommission_job_active",
  "recommission_job_backlog_unbounded", "recommission_snapshot_raw_copy", "replay_fence_missing",
  "replay_key_unavailable", "set_dispatch_shape_unverified", "set_outbox_missing",
  "terminal_command_has_active_hold", "unresolved_outcome_unstaged"
]);

type WorkerOptions = { maxCandidates: number; disposableToken: string;
  barrier?: { generation: number; service: CommandPurgeBarrier;
    signer: { workerId: string; keyVersion: number; secret: Buffer } } };
export type RetentionBatchResult = {
  examined: number;
  deleted: number;
  blockedByReason: Record<string, number>;
  overdueCount: number;
  oldestOverdueAt: Date | null;
};

/**
 * Dormant software proof. It is not a Nest provider/scheduler or production
 * CLI; its CLI entry point is disposable-test-only. The API startup guard rejects the purge flag. The dedicated DB
 * role cannot DELETE Command directly; only the final DB-clock revalidator
 * can do so. Gateway clock/broker/publisher generation is not proven here.
 */
export async function runDisposableProtectedCommandRetentionBatch(
  prisma: PrismaClient, digest: CommandSafetyDigest, options: WorkerOptions
): Promise<RetentionBatchResult> {
  if (process.env.NODE_ENV !== "test" || process.env.COMMAND_RETENTION_TEST !== "1"
    || process.env.COMMAND_RETENTION_PURGE_ENABLED === "1") {
    throw new Error("disposable protected retention only");
  }
  if (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1
    || options.maxCandidates > MAX_BATCH) throw new RangeError("invalid retention batch limit");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.disposableToken)
    || !process.env.COMMAND_RUNTIME_DB_ROLE) {
    throw new Error("disposable protected retention unavailable");
  }
  await assertDisposableRoleBoundary(prisma, options.disposableToken, process.env.COMMAND_RUNTIME_DB_ROLE);

  const blockedByReason: Record<string, number> = {};
  let deleted = 0;
  let examined = 0;
  for (let index = 0; index < options.maxCandidates; index += 1) {
    // Broker/Gateway challenges finish before opening any SQL transaction.
    await options.barrier?.service.refresh(options.barrier.generation);
    const outcome = await prisma.$transaction(async tx => {
      // Existing mutation writers take this advisory lock before Command and
      // dispatch locks. The candidate row lock is acquired before SAVEPOINT,
      // so a stage rollback cannot let a second worker race the defer marker.
      await tx.$executeRaw(Prisma.sql`SELECT "lock_automation_membership_mutation"()`);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(8052026092501::bigint)`;
      const clock = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
        SELECT transaction_timestamp() AT TIME ZONE 'UTC' AS "now"`);
      const now = clock[0]?.now;
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("DB clock unavailable");
      const candidates = await tx.$queryRaw<Array<{ id: string; createdAt: Date }>>(Prisma.sql`
        SELECT command."id", command."createdAt" FROM "Command" AS command
        WHERE command."createdAt" <
          command_protected.three_calendar_months_before_utc(transaction_timestamp())
          AND NOT EXISTS (SELECT 1 FROM "CommandRetentionAttempt" AS attempt
            WHERE attempt."commandId" = command."id"
              AND attempt."retryAfterAt" > (transaction_timestamp() AT TIME ZONE 'UTC'))
        ORDER BY command."createdAt", command."id" LIMIT 1
        FOR UPDATE OF command SKIP LOCKED`);
      const candidate = candidates[0];
      if (!candidate) return null;
      // Preserve the Override alias for the final DB raw-copy check before
      // staging detaches its Command FK. No alias leaves this transaction.
      const original = await tx.command.findUniqueOrThrow({ where: { id: candidate.id },
        select: { manualOverride: { select: { id: true } } } });
      await tx.$executeRawUnsafe("SAVEPOINT command_retention_stage");
      try {
        const barrier = options.barrier;
        if (!barrier) throw new CommandPurgeCandidateBlocked(["drain_evidence_unavailable"]);
        const admission = await barrier.service.assertReady(tx, barrier.generation);
        if (!admission.ready) throw new CommandPurgeCandidateBlocked([admission.reason]);
        await stageExpiredCommandCandidate(tx, candidate.id, now, digest);
        // Staging may take time. Recheck same-primary clock, generation, all
        // attempts and fresh broker/Gateway certificates immediately before SQL.
        const final = await barrier.service.assertReady(tx, barrier.generation);
        if (!final.ready) throw new CommandPurgeCandidateBlocked([final.reason]);
        const evidenceId = await storeDisposableBarrierEvidence(tx, final.evidence.proof, barrier.signer);
        await tx.$queryRaw(Prisma.sql`SELECT
          set_config('command.purge_evidence', ${evidenceId}, true),
          set_config('command.purge_generation', ${String(barrier.generation)}, true),
          set_config('command.purge_boot', ${barrier.service.workerBootId}, true)`);
        const removed = await tx.$queryRaw<Array<{ deleted: boolean }>>(Prisma.sql`
          SELECT command_protected.delete_expired_command_candidate(
            ${candidate.id}, ${original.manualOverride?.id ?? null}) AS "deleted"`);
        if (removed[0]?.deleted !== true) {
          throw new CommandPurgeCandidateBlocked(["protected_delete_rejected"]);
        }
        await tx.$executeRawUnsafe("RELEASE SAVEPOINT command_retention_stage");
        return { deleted: true as const };
      } catch (error) {
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT command_retention_stage");
        if (!(error instanceof CommandPurgeCandidateBlocked)) throw error;
        const reasonCode = safeReason(error);
        await tx.commandRetentionAttempt.upsert({ where: { commandId: candidate.id },
          create: { commandId: candidate.id, reasonCode, lastTriedAt: now,
            retryAfterAt: new Date(now.getTime() + RETRY_DELAY_MS) },
          update: { reasonCode, lastTriedAt: now,
            retryAfterAt: new Date(now.getTime() + RETRY_DELAY_MS),
            attemptCount: { increment: 1 } } });
        return { deleted: false as const, reasonCode };
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
    if (!outcome) break;
    examined += 1;
    if (outcome.deleted) deleted += 1;
    else blockedByReason[outcome.reasonCode] = (blockedByReason[outcome.reasonCode] ?? 0) + 1;
  }
  const backlog = await prisma.$queryRaw<Array<{ overdueCount: bigint; oldestOverdueAt: Date | null }>>(Prisma.sql`
    SELECT count(*) AS "overdueCount", min(command."createdAt") AS "oldestOverdueAt"
    FROM "Command" AS command
    WHERE command."createdAt" < (
      command_protected.three_calendar_months_before_utc(transaction_timestamp())
      - INTERVAL '1 hour')`);
  return { examined, deleted, blockedByReason,
    overdueCount: Number(backlog[0]?.overdueCount ?? 0n),
    oldestOverdueAt: backlog[0]?.oldestOverdueAt ?? null };
}

function safeReason(error: unknown): string {
  const offered = error instanceof CommandPurgeCandidateBlocked ? error.blockers[0] : undefined;
  return offered && REASON_CODES.has(offered) ? offered : "candidate_unverified";
}

async function assertDisposableRoleBoundary(prisma: PrismaClient, token: string, runtimeRole: string) {
  let row: Array<{ databaseName: string; roleName: string; member: boolean; directDelete: boolean;
    functionExecute: boolean; runtimeDelete: boolean; keyRead: boolean;
    replayKeyRead: boolean; superuser: boolean;
    authorized: boolean }>;
  try {
    row = await prisma.$queryRaw(Prisma.sql`
      SELECT current_database() AS "databaseName", current_user AS "roleName",
        pg_has_role(current_user, 'command_retention_worker', 'member') AS "member",
        has_table_privilege(current_user, 'public."Command"', 'DELETE') AS "directDelete",
        has_function_privilege(current_user,
          'command_protected.delete_expired_command_candidate(text,text)', 'EXECUTE') AS "functionExecute",
        has_table_privilege(${runtimeRole}, 'public."Command"', 'DELETE') AS "runtimeDelete",
        has_table_privilege(current_user, 'command_protected.manual_source_key', 'SELECT') AS "keyRead",
        has_table_privilege(current_user, 'command_protected.command_safety_verify_key', 'SELECT')
          AS "replayKeyRead",
        (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS "superuser",
        EXISTS (SELECT 1 FROM command_protected.disposable_purge_proof
          WHERE "token" = ${token}) AS "authorized"`);
  } catch {
    throw new Error("disposable protected retention unavailable");
  }
  const proof = row[0];
  if (!proof || !/^watermark_[0-9]+$/.test(proof.databaseName)
    || proof.roleName === runtimeRole || proof.member !== true || proof.directDelete !== false
    || proof.runtimeDelete !== false || proof.functionExecute !== true || proof.keyRead !== false
    || proof.replayKeyRead !== false
    || proof.superuser !== false || proof.authorized !== true) {
    throw new Error("disposable protected retention unavailable");
  }
}
