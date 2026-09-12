BEGIN;
SET LOCAL lock_timeout = '10s';

-- Historical counts cannot be reconstructed from lastCleanedAt. Start counters
-- at zero while preserving the successful-pass marker for future late PUTs.
ALTER TABLE "EnergyReportObjectCleanup"
  ADD COLUMN "deleteAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deleteRetryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deleteFailureCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastObservedObjectCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastObservedBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "deletedObjectCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deletedBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "latePutObjectCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "latePutBytes" BIGINT NOT NULL DEFAULT 0,
  ALTER COLUMN "nextAttemptAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  ADD CONSTRAINT "EnergyReportObjectCleanup_metrics_nonnegative" CHECK (
    "deleteAttemptCount" >= 0 AND "deleteRetryCount" BETWEEN 0 AND "deleteAttemptCount"
    AND "deleteFailureCount" BETWEEN 0 AND "deleteAttemptCount"
    AND "lastObservedObjectCount" BETWEEN 0 AND 3 AND "lastObservedBytes" >= 0
    AND "deletedObjectCount" >= 0 AND "deletedBytes" >= 0
    AND "latePutObjectCount" BETWEEN 0 AND "deletedObjectCount"
    AND "latePutBytes" BETWEEN 0 AND "deletedBytes"
  );

COMMIT;
