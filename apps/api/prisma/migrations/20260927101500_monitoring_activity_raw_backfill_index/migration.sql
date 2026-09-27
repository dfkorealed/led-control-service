-- Default-OFF rekey work reads only visible legacy Command activity rows.
-- The raw-key predicate must match the bounded helper's candidate query;
-- keyed rows must not consume its scan budget as the table grows.
CREATE INDEX "MonitoringActivity_raw_command_backfill_idx"
  ON "MonitoringActivity"("recordedAt", "id")
  INCLUDE ("siteId", "sourceKey", "floorId")
  WHERE "sourceType" = 'command'
    AND "sourceKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(applied|not_applied|partially_applied|unknown)$';
