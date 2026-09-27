-- Preserve the command identity and FK graph. No cleanup worker is activated here.
ALTER TABLE "Command"
  ADD COLUMN "contentRedactedAt" TIMESTAMP(3),
  ALTER COLUMN "requestFingerprint" DROP NOT NULL,
  ALTER COLUMN "targetType" DROP NOT NULL,
  ALTER COLUMN "targetFixtureIds" DROP NOT NULL,
  ALTER COLUMN "brightness" DROP NOT NULL,
  ADD CONSTRAINT "Command_content_state_check" CHECK (
    ("contentRedactedAt" IS NULL
      AND "requestFingerprint" IS NOT NULL AND "targetType" IS NOT NULL
      AND "targetFixtureIds" IS NOT NULL AND "brightness" IS NOT NULL)
    OR
    ("contentRedactedAt" IS NOT NULL
      AND "requestFingerprint" IS NULL AND "targetType" IS NULL AND "targetId" IS NULL
      AND "targetFixtureIds" IS NULL AND "brightness" IS NULL AND "errorMessage" IS NULL)
  );

-- The orphan guard cannot constrain requestedBy in the existing unique index.
CREATE INDEX "Command_siteId_clientRequestId_idx" ON "Command" ("siteId", "clientRequestId");
