-- Customer-visible operational activity is a distinct, allowlisted projection.
-- Only explicit site deletion cascades; floor/fixture/gateway changes retain snapshots.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TYPE "MonitoringActivityKind" AS ENUM (
  'fixture_status_changed', 'fixture_brightness_changed', 'fixture_health_changed',
  'fixture_offline', 'fixture_online', 'monitoring_refresh_result', 'command_result'
);

CREATE TABLE "MonitoringActivity" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "floorId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "kind" "MonitoringActivityKind" NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "observedAt" TIMESTAMP(3),
  "fixtureId" TEXT,
  "displayName" TEXT,
  "status" "FixtureStatus",
  "brightnessPercent" INTEGER,
  "commandOutcome" "CommandOutcome",
  "refreshStatus" "MonitoringRefreshStatus",
  CONSTRAINT "MonitoringActivity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonitoringActivity_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringActivity_brightness_check" CHECK ("brightnessPercent" IS NULL OR "brightnessPercent" BETWEEN 0 AND 100),
  CONSTRAINT "MonitoringActivity_terminal_check" CHECK (
    ("commandOutcome" IS NULL OR "commandOutcome" <> 'pending') AND
    ("refreshStatus" IS NULL OR "refreshStatus" <> 'pending')
  )
);

CREATE UNIQUE INDEX "MonitoringActivity_siteId_sourceType_sourceKey_floorId_key"
  ON "MonitoringActivity"("siteId", "sourceType", "sourceKey", "floorId");
CREATE INDEX "MonitoringActivity_siteId_floorId_recordedAt_id_idx"
  ON "MonitoringActivity"("siteId", "floorId", "recordedAt" DESC, "id" DESC);
CREATE INDEX "MonitoringActivity_recordedAt_id_idx"
  ON "MonitoringActivity"("recordedAt", "id");

COMMIT;
