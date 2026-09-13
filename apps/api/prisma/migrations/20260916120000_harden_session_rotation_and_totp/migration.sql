-- Existing sessions become independent families. This avoids coupling unrelated
-- browser sessions during the first family-aware logout after upgrade.
ALTER TABLE "Session"
  ADD COLUMN "familyId" TEXT,
  ADD COLUMN "rotatedFromSessionId" TEXT;

UPDATE "Session"
SET "familyId" = "id"
WHERE "familyId" IS NULL;

ALTER TABLE "Session"
  ALTER COLUMN "familyId" SET NOT NULL;

CREATE UNIQUE INDEX "Session_rotatedFromSessionId_key"
  ON "Session"("rotatedFromSessionId");

CREATE INDEX "Session_userId_familyId_revokedAt_idx"
  ON "Session"("userId", "familyId", "revokedAt");

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_rotatedFromSessionId_fkey"
  FOREIGN KEY ("rotatedFromSessionId") REFERENCES "Session"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- No historical TOTP counter is available for existing enrollments. The next
-- successful verification advances this sentinel and becomes replay-safe.
ALTER TABLE "UserMfa"
  ADD COLUMN "lastUsedTotpCounter" INTEGER NOT NULL DEFAULT -1;
