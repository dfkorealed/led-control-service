BEGIN;

SET LOCAL lock_timeout = '10s';

-- Refresh ingestion acquires existing rows in Site → Gateway → Fixture order.
-- Taking compatible DDL locks in that order prevents this migration from
-- inverting the runtime lock order while the aggregate is introduced.
LOCK TABLE "Site", "Gateway", "Fixture", "MqttOutbox" IN SHARE ROW EXCLUSIVE MODE;

CREATE TYPE "MonitoringRefreshStatus" AS ENUM ('pending', 'completed', 'partial', 'failed', 'expired');
CREATE TYPE "MonitoringRefreshBatchStatus" AS ENUM ('pending', 'published', 'completed', 'failed', 'expired');
CREATE TYPE "MonitoringRefreshFixtureStatus" AS ENUM ('pending', 'online', 'offline', 'unverified');

ALTER TABLE "Fixture" ADD COLUMN "lastUnreachableAt" TIMESTAMP(3);

CREATE TABLE "MonitoringRefresh" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "floorId" TEXT NOT NULL,
  "requestedById" TEXT,
  "clientRequestId" TEXT NOT NULL,
  "status" "MonitoringRefreshStatus" NOT NULL DEFAULT 'pending',
  "totalFixtures" INTEGER NOT NULL,
  "onlineFixtures" INTEGER NOT NULL DEFAULT 0,
  "offlineFixtures" INTEGER NOT NULL DEFAULT 0,
  "unverifiedFixtures" INTEGER NOT NULL DEFAULT 0,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonitoringRefresh_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonitoringRefresh_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefresh_floorId_siteId_fkey"
    FOREIGN KEY ("floorId", "siteId") REFERENCES "Floor"("id", "siteId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefresh_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefresh_counters_check" CHECK (
    "totalFixtures" >= 0 AND "onlineFixtures" >= 0 AND "offlineFixtures" >= 0 AND "unverifiedFixtures" >= 0 AND
    "onlineFixtures" + "offlineFixtures" + "unverifiedFixtures" <= "totalFixtures"
  ),
  CONSTRAINT "MonitoringRefresh_status_check" CHECK (
    ("status" = 'pending' AND "completedAt" IS NULL) OR
    ("status" IN ('completed', 'partial', 'failed', 'expired') AND "completedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "MonitoringRefresh_siteId_requestedById_clientRequestId_key"
ON "MonitoringRefresh"("siteId", "requestedById", "clientRequestId");
CREATE UNIQUE INDEX "MonitoringRefresh_id_siteId_key"
ON "MonitoringRefresh"("id", "siteId");
CREATE UNIQUE INDEX "MonitoringRefresh_id_siteId_floorId_key"
ON "MonitoringRefresh"("id", "siteId", "floorId");
CREATE INDEX "MonitoringRefresh_siteId_floorId_status_idx"
ON "MonitoringRefresh"("siteId", "floorId", "status");
CREATE INDEX "MonitoringRefresh_createdAt_idx" ON "MonitoringRefresh"("createdAt");

CREATE TABLE "MonitoringRefreshRequest" (
  "siteId" TEXT NOT NULL,
  "floorId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "refreshId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonitoringRefreshRequest_pkey"
    PRIMARY KEY ("siteId", "requestedById", "clientRequestId"),
  CONSTRAINT "MonitoringRefreshRequest_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefreshRequest_floorId_siteId_fkey"
    FOREIGN KEY ("floorId", "siteId") REFERENCES "Floor"("id", "siteId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefreshRequest_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefreshRequest_refreshId_siteId_floorId_fkey"
    FOREIGN KEY ("refreshId", "siteId", "floorId")
    REFERENCES "MonitoringRefresh"("id", "siteId", "floorId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefreshRequest_identity_check" CHECK (
    length("requestedById") > 0 AND length("clientRequestId") > 0 AND length("refreshId") > 0
  )
);

CREATE INDEX "MonitoringRefreshRequest_refreshId_idx"
ON "MonitoringRefreshRequest"("refreshId");
CREATE INDEX "MonitoringRefreshRequest_requestedById_siteId_floorId_createdAt_idx"
ON "MonitoringRefreshRequest"("requestedById", "siteId", "floorId", "createdAt");

CREATE TABLE "MonitoringRefreshBatch" (
  "id" TEXT NOT NULL,
  "refreshId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "sequence" BIGINT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "targetFixtureIds" JSONB NOT NULL,
  "status" "MonitoringRefreshBatchStatus" NOT NULL DEFAULT 'pending',
  "errorCode" TEXT,
  "publishedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonitoringRefreshBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonitoringRefreshBatch_refreshId_siteId_fkey"
    FOREIGN KEY ("refreshId", "siteId") REFERENCES "MonitoringRefresh"("id", "siteId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefreshBatch_gatewayId_siteId_fkey"
    FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefreshBatch_targetFixtureIds_check" CHECK (
    jsonb_typeof("targetFixtureIds") = 'array'
  ),
  CONSTRAINT "MonitoringRefreshBatch_status_check" CHECK (
    ("status" = 'pending' AND "publishedAt" IS NULL AND "completedAt" IS NULL) OR
    ("status" = 'published' AND "publishedAt" IS NOT NULL AND "completedAt" IS NULL) OR
    ("status" = 'completed' AND "publishedAt" IS NOT NULL AND "completedAt" IS NOT NULL) OR
    ("status" IN ('failed', 'expired') AND "completedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "MonitoringRefreshBatch_gatewayId_sequence_key"
ON "MonitoringRefreshBatch"("gatewayId", "sequence");
CREATE UNIQUE INDEX "MonitoringRefreshBatch_id_refreshId_key"
ON "MonitoringRefreshBatch"("id", "refreshId");
CREATE UNIQUE INDEX "MonitoringRefreshBatch_idempotencyKey_key"
ON "MonitoringRefreshBatch"("idempotencyKey");
CREATE INDEX "MonitoringRefreshBatch_refreshId_status_idx"
ON "MonitoringRefreshBatch"("refreshId", "status");

CREATE TABLE "MonitoringRefreshFixture" (
  "refreshId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "fixtureId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "status" "MonitoringRefreshFixtureStatus" NOT NULL DEFAULT 'pending',
  "errorCode" TEXT,
  "observedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonitoringRefreshFixture_pkey" PRIMARY KEY ("refreshId", "fixtureId"),
  CONSTRAINT "MonitoringRefreshFixture_refreshId_siteId_fkey"
    FOREIGN KEY ("refreshId", "siteId") REFERENCES "MonitoringRefresh"("id", "siteId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefreshFixture_batchId_refreshId_fkey"
    FOREIGN KEY ("batchId", "refreshId") REFERENCES "MonitoringRefreshBatch"("id", "refreshId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefreshFixture_fixtureId_siteId_fkey"
    FOREIGN KEY ("fixtureId", "siteId") REFERENCES "Fixture"("id", "siteId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringRefreshFixture_status_check" CHECK (
    ("status" = 'pending' AND "observedAt" IS NULL AND "errorCode" IS NULL) OR
    ("status" IN ('online', 'offline', 'unverified') AND "observedAt" IS NOT NULL)
  )
);

CREATE INDEX "MonitoringRefreshFixture_batchId_status_idx"
ON "MonitoringRefreshFixture"("batchId", "status");
CREATE INDEX "MonitoringRefreshFixture_fixtureId_idx"
ON "MonitoringRefreshFixture"("fixtureId");

ALTER TABLE "MqttOutbox"
  ADD COLUMN "monitoringRefreshBatchId" TEXT,
  DROP CONSTRAINT "MqttOutbox_row_shape_check",
  -- A row has exactly one durable owner. Refresh publishers resolve the Gateway
  -- through MonitoringRefreshBatch, so their outbox rows keep all command and
  -- automation-only fields null.
  ADD CONSTRAINT "MqttOutbox_row_shape_check" CHECK (
    (
      "dispatchId" IS NOT NULL
      AND "monitoringRefreshBatchId" IS NULL
      AND "gatewayId" IS NULL
      AND "applicationAckKey" IS NULL
      AND "revision" IS NULL
      AND "payloadHash" IS NULL
    )
    OR
    (
      "dispatchId" IS NULL
      AND "monitoringRefreshBatchId" IS NULL
      AND "gatewayId" IS NOT NULL
      AND "applicationAckKey" IS NULL
      AND "revision" IS NOT NULL
      AND "payloadHash" IS NOT NULL
    )
    OR
    (
      "dispatchId" IS NULL
      AND "monitoringRefreshBatchId" IS NULL
      AND "gatewayId" IS NOT NULL
      AND "applicationAckKey" IS NOT NULL
      AND "revision" IS NULL
      AND "payloadHash" IS NOT NULL
    )
    OR
    (
      "dispatchId" IS NULL
      AND "monitoringRefreshBatchId" IS NOT NULL
      AND "gatewayId" IS NULL
      AND "applicationAckKey" IS NULL
      AND "revision" IS NULL
      AND "payloadHash" IS NULL
    )
  ),
  ADD CONSTRAINT "MqttOutbox_monitoringRefreshBatchId_fkey"
    FOREIGN KEY ("monitoringRefreshBatchId") REFERENCES "MonitoringRefreshBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "MqttOutbox_monitoringRefreshBatchId_key"
ON "MqttOutbox"("monitoringRefreshBatchId");

COMMIT;
