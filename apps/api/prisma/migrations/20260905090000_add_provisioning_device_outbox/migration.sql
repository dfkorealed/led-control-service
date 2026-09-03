BEGIN;

CREATE TABLE "ProvisioningDeviceOutbox" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
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
  CONSTRAINT "ProvisioningDeviceOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProvisioningDeviceOutbox_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "ProvisioningSession"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProvisioningDeviceOutbox_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "DiscoveredMeshNode"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ProvisioningDeviceOutbox_nodeId_idx"
  ON "ProvisioningDeviceOutbox"("nodeId");
CREATE INDEX "ProvisioningDeviceOutbox_publishedAt_deadLetteredAt_nextAttemptAt_leaseExpiresAt_idx"
  ON "ProvisioningDeviceOutbox"("publishedAt", "deadLetteredAt", "nextAttemptAt", "leaseExpiresAt");
CREATE INDEX "ProvisioningDeviceOutbox_sessionId_idx"
  ON "ProvisioningDeviceOutbox"("sessionId");

COMMIT;
