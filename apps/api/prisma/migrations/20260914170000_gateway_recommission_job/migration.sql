-- No FK: this durable fence must outlive the Gateway/site rows deleted by reset.
CREATE TABLE "GatewayRecommissionJob" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "inventoryId" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "resetDigest" TEXT NOT NULL,
    "targetSnapshot" JSONB NOT NULL,
    "objectKeys" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "lastError" TEXT,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GatewayRecommissionJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GatewayRecommissionJob_status_check" CHECK ("status" IN ('prepared', 'mqtt_revocation_pending', 'mqtt_revoked', 'applied', 'finalized', 'failed'))
);

CREATE INDEX "GatewayRecommissionJob_inventoryId_createdAt_idx" ON "GatewayRecommissionJob"("inventoryId", "createdAt");
CREATE INDEX "GatewayRecommissionJob_status_updatedAt_idx" ON "GatewayRecommissionJob"("status", "updatedAt");

-- finalized/failed jobs are historical. Every non-terminal reset owns exactly one
-- inventory fence so a second caller cannot stage a conflicting deletion snapshot.
CREATE UNIQUE INDEX "GatewayRecommissionJob_inventoryId_active_key"
ON "GatewayRecommissionJob"("inventoryId")
WHERE "status" IN ('prepared', 'mqtt_revocation_pending', 'mqtt_revoked', 'applied');
