BEGIN;

ALTER TABLE "AutomationExecution"
  ADD COLUMN "payloadHash" TEXT,
  ADD CONSTRAINT "AutomationExecution_payload_hash_check"
    CHECK ("payloadHash" IS NULL OR "payloadHash" ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE "MqttOutbox"
  ADD COLUMN "supersededAt" TIMESTAMP(3);

CREATE INDEX "MqttOutbox_automation_delivery_idx"
  ON "MqttOutbox"("nextAttemptAt", "createdAt")
  WHERE "dispatchId" IS NULL
    AND "publishedAt" IS NULL
    AND "deadLetteredAt" IS NULL
    AND "supersededAt" IS NULL;

COMMIT;
