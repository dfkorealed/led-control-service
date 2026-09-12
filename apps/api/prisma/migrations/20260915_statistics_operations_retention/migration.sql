BEGIN;
SET LOCAL lock_timeout = '10s';

-- Run after stopping old API/worker writers. The barrier keeps preflight and
-- backfill on one stable set; a failed preflight rolls this migration back.
LOCK TABLE "ProcessedGatewayEvent", "Fixture", "Gateway", "MeshNode", "ProvisioningSession"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ProcessedGatewayEvent"
    GROUP BY "gatewayId", "eventType",
      CASE WHEN "eventType" = 'vehicle_sensor_capability' THEN "meshNodeId" ELSE '' END,
      "sequence"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'gateway_event_sequence_conflict: repair conflicting legacy events before migration';
  END IF;
END $$;

ALTER TABLE "ProcessedGatewayEvent" ADD COLUMN "scopeKey" TEXT;
UPDATE "ProcessedGatewayEvent" SET "scopeKey" = CASE
  WHEN "eventType" = 'fixture_state' THEN "fixtureId"
  WHEN "eventType" = 'vehicle_sensor_capability' THEN "meshNodeId"
  WHEN "eventType" = 'gateway_heartbeat' THEN ''
  ELSE NULL
END;

-- Scan PGE rows did not store sessionId or complete payload. Do not guess
-- scope/hash from matching timestamps or ACKs; these legacy rows stay retained.
ALTER TABLE "ProvisioningSession"
  ADD COLUMN "scanTerminalEventId" TEXT,
  ADD COLUMN "scanTerminalSequence" BIGINT,
  ADD COLUMN "scanTerminalEventType" TEXT,
  ADD COLUMN "scanTerminalPayloadHash" TEXT,
  ADD COLUMN "scanTerminalIngestedAt" TIMESTAMP(3),
  ADD CONSTRAINT "ProvisioningSession_scan_terminal_identity_check" CHECK (
    num_nonnulls("scanTerminalEventId", "scanTerminalSequence", "scanTerminalEventType", "scanTerminalPayloadHash", "scanTerminalIngestedAt") = 0
    OR (
      num_nonnulls("scanTerminalEventId", "scanTerminalSequence", "scanTerminalEventType", "scanTerminalPayloadHash", "scanTerminalIngestedAt") = 5
      AND "scanTerminalSequence" > 0
      AND "scanTerminalEventType" IN ('provisioning_scan_completed', 'provisioning_scan_failed')
      AND "scanTerminalPayloadHash" ~ '^sha256:[0-9a-f]{64}$'
    )
  );

CREATE TABLE "GatewayEventWatermark" (
  "gatewayId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL DEFAULT '',
  "lastSequence" BIGINT NOT NULL,
  "lastEventId" TEXT NOT NULL,
  "lastPayloadHash" TEXT,
  "lastOccurredAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GatewayEventWatermark_pkey" PRIMARY KEY ("gatewayId", "eventType", "scopeKey"),
  CONSTRAINT "GatewayEventWatermark_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GatewayEventWatermark_sequence_check" CHECK ("lastSequence" > 0),
  CONSTRAINT "GatewayEventWatermark_hash_check" CHECK ("lastPayloadHash" IS NULL OR "lastPayloadHash" ~ '^sha256:[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "GatewayEventWatermark_lastEventId_key" ON "GatewayEventWatermark"("lastEventId");
CREATE INDEX "GatewayEventWatermark_gatewayId_eventType_lastSequence_idx" ON "GatewayEventWatermark"("gatewayId", "eventType", "lastSequence");

-- Fixture and capability ordering is local to the fixture/node. Existing scan
-- ordering is gateway-wide per event type and remains scopeKey='', including
-- new scans. Immutable PGE.scopeKey still records the session for safe retention.
CREATE TEMP TABLE gateway_event_watermark_candidates ON COMMIT DROP AS
SELECT "gatewayId", "eventType",
  CASE WHEN "eventType" IN ('fixture_state', 'vehicle_sensor_capability') THEN "scopeKey" ELSE '' END AS "scopeKey",
  "sequence", "eventId", "payloadHash", "occurredAt"
FROM "ProcessedGatewayEvent"
WHERE "eventType" IN ('gateway_heartbeat', 'fixture_state', 'vehicle_sensor_capability',
  'provisioning_scan_found', 'provisioning_scan_completed', 'provisioning_scan_failed')
  AND ("eventType" NOT IN ('fixture_state', 'vehicle_sensor_capability') OR "scopeKey" IS NOT NULL)
UNION ALL
SELECT node."gatewayId", 'fixture_state', fixture."id", fixture."lastStateSequence",
  fixture."lastStateEventId", NULL, fixture."lastStateOccurredAt"
FROM "Fixture" fixture JOIN "MeshNode" node ON node."id" = fixture."meshNodeId"
WHERE fixture."lastStateSequence" IS NOT NULL AND fixture."lastStateEventId" IS NOT NULL AND fixture."lastStateOccurredAt" IS NOT NULL
UNION ALL
SELECT "id", 'gateway_heartbeat', '', "lastHeartbeatSequence", "lastHeartbeatEventId", NULL, "lastHeartbeatOccurredAt"
FROM "Gateway"
WHERE "lastHeartbeatSequence" IS NOT NULL AND "lastHeartbeatEventId" IS NOT NULL AND "lastHeartbeatOccurredAt" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM gateway_event_watermark_candidates
    GROUP BY "gatewayId", "eventType", "scopeKey", "sequence"
    HAVING count(DISTINCT ("eventId", "occurredAt")) > 1 OR count(DISTINCT "payloadHash") > 1
  ) OR EXISTS (
    SELECT 1 FROM gateway_event_watermark_candidates
    WHERE "eventType" <> 'vehicle_sensor_capability'
    GROUP BY "gatewayId", "eventType", "sequence"
    HAVING count(DISTINCT ("scopeKey", "eventId")) > 1
  ) THEN
    RAISE EXCEPTION 'gateway_event_snapshot_conflict: repair legacy cursor/event identities before migration';
  END IF;
END $$;

INSERT INTO "GatewayEventWatermark" ("gatewayId", "eventType", "scopeKey", "lastSequence", "lastEventId", "lastPayloadHash", "lastOccurredAt")
SELECT DISTINCT ON ("gatewayId", "eventType", "scopeKey")
  "gatewayId", "eventType", "scopeKey", "sequence", "eventId", "payloadHash", "occurredAt"
FROM gateway_event_watermark_candidates
ORDER BY "gatewayId", "eventType", "scopeKey", "sequence" DESC, "payloadHash" NULLS LAST;

CREATE INDEX "ProcessedGatewayEvent_eventType_createdAt_eventId_idx" ON "ProcessedGatewayEvent"("eventType", "createdAt", "eventId");
CREATE INDEX "Session_expiresAt_id_idx" ON "Session"("expiresAt", "id");
CREATE INDEX "Session_revokedAt_id_idx" ON "Session"("revokedAt", "id");
CREATE INDEX "FloorMapRevision_createdAt_id_idx" ON "FloorMapRevision"("createdAt", "id");
COMMIT;
