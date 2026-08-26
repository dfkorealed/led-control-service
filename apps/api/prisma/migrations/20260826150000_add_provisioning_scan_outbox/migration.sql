BEGIN;

DROP INDEX IF EXISTS "ProvisioningSession_single_scanning_gateway_key";

CREATE UNIQUE INDEX "ProvisioningSession_single_scanning_gateway_key"
  ON "ProvisioningSession"("gatewayId")
  WHERE "scanStatus" IN ('pending', 'scanning');

CREATE TABLE "ProvisioningScanOutbox" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "scanAttempt" INTEGER NOT NULL,
  "topic" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "lockedAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "deadLetteredAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProvisioningScanOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProvisioningScanOutbox_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "ProvisioningSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProvisioningScanOutbox_sessionId_scanAttempt_key"
  ON "ProvisioningScanOutbox"("sessionId", "scanAttempt");
CREATE INDEX "ProvisioningScanOutbox_publishedAt_deadLetteredAt_nextAttemptAt_leaseExpiresAt_idx"
  ON "ProvisioningScanOutbox"("publishedAt", "deadLetteredAt", "nextAttemptAt", "leaseExpiresAt");

COMMIT;
