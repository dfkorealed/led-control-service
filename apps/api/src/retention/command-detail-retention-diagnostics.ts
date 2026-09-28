// This list is the production log boundary, not a pass-through of database
// reason strings. New helper reasons require an explicit observability review.
const reasons = [
  "raw_copy_cleanup_failed", "producer_locked", "command_missing", "command_not_expired",
  "command_unresolved", "command_hold_exists", "dispatch_unsettled", "fixture_result_unsettled",
  "outbox_locked", "outbox_unsettled", "manual_override_active", "gateway_locked",
  "legacy_ack_attribution_unverifiable", "manual_source_attribution_unverifiable",
  "manual_execution_unverifiable", "manual_ack_locked", "manual_ack_unsettled",
  "activity_source_key_unavailable", "recommission_job_backlog_unbounded", "recommission_job_active",
  "recommission_snapshot_unverifiable", "recommission_job_locked", "transaction_failed"
] as const;

function counter(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function reasonCounts(value: unknown, maximum: number) {
  const result: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const reason of reasons) {
    const count = (value as Record<string, unknown>)[reason];
    if (Object.hasOwn(value, reason) && counter(count, maximum)) result[reason] = count;
  }
  return result;
}

export function safeCommandDetailRetentionFields(record: Record<string, unknown> | undefined, context?: string) {
  if (context !== "CommandDetailRetentionService" || record?.event !== "command_detail_retention_batch"
    || (record.status !== "completed" && record.status !== "failed")) return {};
  return {
    event: "command_detail_retention_batch", status: record.status,
    ...(counter(record.examined, 1000) ? { examined: record.examined } : {}),
    ...(counter(record.redacted, 1000) ? { redacted: record.redacted } : {}),
    ...(counter(record.overdueCount) ? { overdueCount: record.overdueCount } : {}),
    ...(typeof record.oldestAgeSeconds === "number" && Number.isFinite(record.oldestAgeSeconds)
      && record.oldestAgeSeconds >= 0 && record.oldestAgeSeconds <= Number.MAX_SAFE_INTEGER
      ? { oldestAgeSeconds: record.oldestAgeSeconds } : {}),
    skippedByReason: reasonCounts(record.skippedByReason, 1000),
    ...(Object.hasOwn(record, "blockedByReason")
      ? { blockedByReason: reasonCounts(record.blockedByReason, Number.MAX_SAFE_INTEGER) } : {})
  };
}
