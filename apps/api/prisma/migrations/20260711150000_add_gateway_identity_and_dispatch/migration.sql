CREATE TYPE "CommandDispatchStatus" AS ENUM ('pending', 'published', 'accepted', 'completed', 'failed', 'timed_out');
CREATE TYPE "CommandFixtureResultStatus" AS ENUM ('pending', 'succeeded', 'failed', 'timed_out');

ALTER TABLE "Fixture"
ADD COLUMN "lastStateEventId" TEXT,
ADD COLUMN "lastStateOccurredAt" TIMESTAMP(3),
ADD COLUMN "lastStateSequence" BIGINT,
ADD COLUMN "statusReason" TEXT;

ALTER TABLE "Gateway"
ADD COLUMN "assignmentVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "certificateFingerprint" TEXT,
ADD COLUMN "claimedAt" TIMESTAMP(3),
ADD COLUMN "lastHeartbeatEventId" TEXT,
ADD COLUMN "lastHeartbeatOccurredAt" TIMESTAMP(3),
ADD COLUMN "lastHeartbeatSequence" BIGINT;

CREATE TABLE "GatewayInventory" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "claimCodeHash" TEXT,
    "certificateFingerprint" TEXT NOT NULL,
    "claimedGatewayId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GatewayInventory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GatewayClaimAudit" (
    "id" TEXT NOT NULL,
    "inventoryId" TEXT,
    "siteId" TEXT,
    "requestedBy" TEXT,
    "serialNumber" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GatewayClaimAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommandDispatch" (
    "id" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "status" "CommandDispatchStatus" NOT NULL DEFAULT 'pending',
    "publishedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommandDispatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommandFixtureResult" (
    "dispatchId" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "status" "CommandFixtureResultStatus" NOT NULL DEFAULT 'pending',
    "brightness" INTEGER,
    "faultCode" TEXT,
    "errorMessage" TEXT,
    "rssi" INTEGER,
    "hopCount" INTEGER,
    "occurredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommandFixtureResult_pkey" PRIMARY KEY ("dispatchId", "fixtureId")
);

CREATE TABLE "MqttOutbox" (
    "id" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MqttOutbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProcessedGatewayEvent" (
    "eventId" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProcessedGatewayEvent_pkey" PRIMARY KEY ("eventId")
);

CREATE UNIQUE INDEX "GatewayInventory_serialNumber_key" ON "GatewayInventory"("serialNumber");
CREATE UNIQUE INDEX "GatewayInventory_certificateFingerprint_key" ON "GatewayInventory"("certificateFingerprint");
CREATE UNIQUE INDEX "GatewayInventory_claimedGatewayId_key" ON "GatewayInventory"("claimedGatewayId");
CREATE INDEX "GatewayClaimAudit_serialNumber_createdAt_idx" ON "GatewayClaimAudit"("serialNumber", "createdAt");
CREATE INDEX "GatewayClaimAudit_siteId_createdAt_idx" ON "GatewayClaimAudit"("siteId", "createdAt");
CREATE UNIQUE INDEX "CommandDispatch_idempotencyKey_key" ON "CommandDispatch"("idempotencyKey");
CREATE INDEX "CommandDispatch_commandId_idx" ON "CommandDispatch"("commandId");
CREATE INDEX "CommandDispatch_gatewayId_status_idx" ON "CommandDispatch"("gatewayId", "status");
CREATE UNIQUE INDEX "CommandDispatch_gatewayId_sequence_key" ON "CommandDispatch"("gatewayId", "sequence");
CREATE INDEX "CommandFixtureResult_fixtureId_status_idx" ON "CommandFixtureResult"("fixtureId", "status");
CREATE UNIQUE INDEX "MqttOutbox_dispatchId_key" ON "MqttOutbox"("dispatchId");
CREATE INDEX "MqttOutbox_publishedAt_nextAttemptAt_idx" ON "MqttOutbox"("publishedAt", "nextAttemptAt");
CREATE INDEX "ProcessedGatewayEvent_gatewayId_occurredAt_idx" ON "ProcessedGatewayEvent"("gatewayId", "occurredAt");
CREATE UNIQUE INDEX "ProcessedGatewayEvent_gatewayId_sequence_eventType_key" ON "ProcessedGatewayEvent"("gatewayId", "sequence", "eventType");
CREATE INDEX "Command_siteId_createdAt_idx" ON "Command"("siteId", "createdAt");
CREATE UNIQUE INDEX "Fixture_lastStateEventId_key" ON "Fixture"("lastStateEventId");
CREATE INDEX "Fixture_floorId_status_idx" ON "Fixture"("floorId", "status");
CREATE INDEX "Floor_siteId_idx" ON "Floor"("siteId");
CREATE UNIQUE INDEX "Gateway_certificateFingerprint_key" ON "Gateway"("certificateFingerprint");
CREATE UNIQUE INDEX "Gateway_lastHeartbeatEventId_key" ON "Gateway"("lastHeartbeatEventId");
CREATE INDEX "Gateway_siteId_idx" ON "Gateway"("siteId");
CREATE INDEX "MeshNode_gatewayId_idx" ON "MeshNode"("gatewayId");
CREATE INDEX "Site_organizationId_idx" ON "Site"("organizationId");

ALTER TABLE "GatewayInventory" ADD CONSTRAINT "GatewayInventory_claimedGatewayId_fkey" FOREIGN KEY ("claimedGatewayId") REFERENCES "Gateway"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GatewayClaimAudit" ADD CONSTRAINT "GatewayClaimAudit_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "GatewayInventory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GatewayClaimAudit" ADD CONSTRAINT "GatewayClaimAudit_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GatewayClaimAudit" ADD CONSTRAINT "GatewayClaimAudit_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommandDispatch" ADD CONSTRAINT "CommandDispatch_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "Command"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommandDispatch" ADD CONSTRAINT "CommandDispatch_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommandFixtureResult" ADD CONSTRAINT "CommandFixtureResult_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "CommandDispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommandFixtureResult" ADD CONSTRAINT "CommandFixtureResult_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MqttOutbox" ADD CONSTRAINT "MqttOutbox_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "CommandDispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProcessedGatewayEvent" ADD CONSTRAINT "ProcessedGatewayEvent_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;
