ALTER TABLE "MqttOutbox"
  ADD COLUMN "lockedBy" TEXT,
  ADD COLUMN "lockedAt" TIMESTAMP(3),
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "MqttOutbox_publishedAt_nextAttemptAt_idx";
CREATE INDEX "MqttOutbox_publishedAt_deadLetteredAt_nextAttemptAt_leaseExpiresAt_idx"
  ON "MqttOutbox"("publishedAt", "deadLetteredAt", "nextAttemptAt", "leaseExpiresAt");
