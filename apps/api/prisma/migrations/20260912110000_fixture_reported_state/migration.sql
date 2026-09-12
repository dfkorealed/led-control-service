BEGIN;

ALTER TABLE "Fixture"
  ADD COLUMN "reportedStatus" "FixtureStatus",
  ADD COLUMN "reportedStatusReason" TEXT;

-- Prior freshness sweeps may already have overwritten the original report.
-- Preserve the available state conservatively; only a new accepted device
-- report can restore information that was never retained by earlier versions.
UPDATE "Fixture"
SET "reportedStatus" = "status", "reportedStatusReason" = "statusReason";

ALTER TABLE "Fixture"
  ALTER COLUMN "reportedStatus" SET NOT NULL,
  ALTER COLUMN "reportedStatus" SET DEFAULT 'offline'::"FixtureStatus";

COMMIT;
