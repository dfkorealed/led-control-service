BEGIN;

ALTER TABLE "Site" ALTER COLUMN "fixtureStaleAfterSeconds" SET DEFAULT 1200;
UPDATE "Site" SET "fixtureStaleAfterSeconds" = 1200 WHERE "fixtureStaleAfterSeconds" = 180;

ALTER TABLE "Fixture"
  ADD COLUMN "bioControlMode" TEXT,
  ADD COLUMN "bioConfiguredBrightness" INTEGER,
  ADD COLUMN "bioRawHighBrightness" INTEGER,
  ADD COLUMN "lastPresenceEventId" TEXT,
  ADD COLUMN "lastPresenceSequence" BIGINT,
  ADD COLUMN "lastPresenceOccurredAt" TIMESTAMP(3),
  ADD CONSTRAINT "Fixture_bioControlMode_check" CHECK (
    "bioControlMode" IS NULL OR "bioControlMode" IN ('sensor', 'force-off', 'force-on')
  ),
  ADD CONSTRAINT "Fixture_bioConfiguredBrightness_check" CHECK (
    "bioConfiguredBrightness" IS NULL OR "bioConfiguredBrightness" BETWEEN 0 AND 100
  ),
  ADD CONSTRAINT "Fixture_bioRawHighBrightness_check" CHECK (
    "bioRawHighBrightness" IS NULL OR "bioRawHighBrightness" BETWEEN 0 AND 255
  ),
  ADD CONSTRAINT "Fixture_presenceCheckpoint_check" CHECK (
    ("lastPresenceEventId" IS NULL AND "lastPresenceSequence" IS NULL AND "lastPresenceOccurredAt" IS NULL) OR
    ("lastPresenceEventId" IS NOT NULL AND "lastPresenceSequence" IS NOT NULL AND "lastPresenceOccurredAt" IS NOT NULL)
  );

CREATE UNIQUE INDEX "Fixture_lastPresenceEventId_key" ON "Fixture"("lastPresenceEventId");

COMMIT;
