-- Preserve existing rows. Future terminal summaries use the DB-host UTC clock
-- even when a direct writer connects with a non-UTC session TimeZone.
ALTER TABLE "ResolvedCommandRecovery"
  ALTER COLUMN "resolvedAt" SET DEFAULT (transaction_timestamp() AT TIME ZONE 'UTC');
