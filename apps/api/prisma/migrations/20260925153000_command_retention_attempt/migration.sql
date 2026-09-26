-- Additive only. The protected worker is unregistered and physical Command
-- deletion remains disabled. A failed candidate defers its own retry without
-- repeatedly occupying the first bounded batch slot.
CREATE TABLE "CommandRetentionAttempt" (
  "commandId" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 1,
  "lastTriedAt" TIMESTAMP(3) NOT NULL,
  "retryAfterAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommandRetentionAttempt_pkey" PRIMARY KEY ("commandId"),
  CONSTRAINT "CommandRetentionAttempt_reason_check"
    CHECK ("reasonCode" ~ '^[a-z][a-z0-9_]{0,63}$' AND "attemptCount" > 0),
  CONSTRAINT "CommandRetentionAttempt_commandId_fkey"
    FOREIGN KEY ("commandId") REFERENCES "Command"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CommandRetentionAttempt_retryAfterAt_idx"
  ON "CommandRetentionAttempt" ("retryAfterAt");
