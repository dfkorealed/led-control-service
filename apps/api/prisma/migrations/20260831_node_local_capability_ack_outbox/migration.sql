BEGIN;

SELECT "lock_automation_membership_mutation"();

ALTER TABLE "ProcessedGatewayEvent"
  ADD COLUMN "meshNodeId" TEXT;

ALTER TABLE "MqttOutbox"
  ADD COLUMN "applicationAckKey" TEXT;

UPDATE "ProcessedGatewayEvent" AS event
SET "meshNodeId" = fixture."meshNodeId"
FROM "Fixture" AS fixture
WHERE event."eventType" = 'vehicle_sensor_capability'
  AND event."fixtureId" = fixture."id"
  AND fixture."meshNodeId" IS NOT NULL
  AND fixture."gatewayId" = event."gatewayId";

DO $$
DECLARE
  invalid_event RECORD;
BEGIN
  SELECT
    event."eventId",
    event."gatewayId",
    event."fixtureId",
    event."sequence"
  INTO invalid_event
  FROM "ProcessedGatewayEvent" AS event
  WHERE event."eventType" = 'vehicle_sensor_capability'
    AND event."meshNodeId" IS NULL
  ORDER BY event."createdAt", event."eventId"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot backfill vehicle sensor capability ledger eventId=%s gatewayId=%s fixtureId=%s sequence=%s. Operator remediation required before migration: restore the event Fixture-to-MeshNode ownership mapping or remove the invalid ledger after audit. No rows were modified.',
        invalid_event."eventId",
        invalid_event."gatewayId",
        COALESCE(invalid_event."fixtureId", '<null>'),
        invalid_event."sequence"
      );
  END IF;
END;
$$;

ALTER TABLE "MeshNode"
  DROP CONSTRAINT "MeshNode_vehicle_sensor_capability_check",
  ADD CONSTRAINT "MeshNode_vehicle_sensor_capability_check" CHECK (
    (
      "vehicleSensorCapabilityStatus" = 'unknown'
      AND "vehicleSensorCapabilityVerifiedAt" IS NULL
      AND "vehicleSensorCapabilityRevision" = 0
      AND NOT "vehicleSensorServerBound"
      AND NOT "vehicleVendorEventModelBound"
    )
    OR
    (
      "vehicleSensorCapabilityStatus" = 'supported'
      AND "vehicleSensorCapabilityVerifiedAt" IS NOT NULL
      AND "vehicleSensorCapabilityRevision" > 0
      AND "vehicleSensorServerBound"
      AND "vehicleVendorEventModelBound"
    )
    OR
    (
      "vehicleSensorCapabilityStatus" = 'unsupported'
      AND "vehicleSensorCapabilityRevision" > 0
      AND (
        NOT "vehicleSensorServerBound"
        OR NOT "vehicleVendorEventModelBound"
      )
    )
  );

ALTER TABLE "ProcessedGatewayEvent"
  ADD CONSTRAINT "ProcessedGatewayEvent_capability_mesh_node_check" CHECK (
    "eventType" <> 'vehicle_sensor_capability' OR "meshNodeId" IS NOT NULL
  ),
  ADD CONSTRAINT "ProcessedGatewayEvent_meshNodeId_gatewayId_fkey"
    FOREIGN KEY ("meshNodeId", "gatewayId")
    REFERENCES "MeshNode"("id", "gatewayId")
    ON DELETE RESTRICT
    ON UPDATE RESTRICT;

DROP INDEX "ProcessedGatewayEvent_gatewayId_sequence_eventType_key";

CREATE UNIQUE INDEX "ProcessedGatewayEvent_legacy_sequence_key"
  ON "ProcessedGatewayEvent"("gatewayId", "sequence", "eventType")
  WHERE "eventType" <> 'vehicle_sensor_capability';

CREATE UNIQUE INDEX "ProcessedGatewayEvent_capability_node_sequence_key"
  ON "ProcessedGatewayEvent"("gatewayId", "meshNodeId", "sequence", "eventType")
  WHERE "eventType" = 'vehicle_sensor_capability';

CREATE INDEX "ProcessedGatewayEvent_meshNodeId_idx"
  ON "ProcessedGatewayEvent"("meshNodeId");

ALTER TABLE "MqttOutbox"
  DROP CONSTRAINT "MqttOutbox_automation_identity_check",
  ADD CONSTRAINT "MqttOutbox_row_shape_check" CHECK (
    (
      "dispatchId" IS NOT NULL
      AND "gatewayId" IS NULL
      AND "applicationAckKey" IS NULL
      AND "revision" IS NULL
      AND "payloadHash" IS NULL
    )
    OR
    (
      "dispatchId" IS NULL
      AND "gatewayId" IS NOT NULL
      AND "applicationAckKey" IS NULL
      AND "revision" IS NOT NULL
      AND "payloadHash" IS NOT NULL
    )
    OR
    (
      "dispatchId" IS NULL
      AND "gatewayId" IS NOT NULL
      AND "applicationAckKey" IS NOT NULL
      AND "revision" IS NULL
      AND "payloadHash" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX "MqttOutbox_applicationAckKey_key"
  ON "MqttOutbox"("applicationAckKey");

COMMIT;
