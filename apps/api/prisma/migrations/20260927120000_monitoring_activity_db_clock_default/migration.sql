-- Reaffirm the existing UTC DB default for clients that now delegate
-- recordedAt to PostgreSQL. This does not rewrite historical activity.
ALTER TABLE "MonitoringActivity"
  ALTER COLUMN "recordedAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
