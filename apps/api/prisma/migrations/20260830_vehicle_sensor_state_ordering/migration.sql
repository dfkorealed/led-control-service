BEGIN;

SELECT "lock_automation_membership_mutation"();

ALTER TABLE "MeshNode"
  ADD COLUMN "vehicleSensorCapabilityRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "vehicleSensorServerBound" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "vehicleVendorEventModelBound" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ProcessedGatewayEvent"
  ADD COLUMN "payloadHash" TEXT;

UPDATE "MeshNode"
SET
  "vehicleSensorCapabilityRevision" = CASE
    WHEN "vehicleSensorCapabilityStatus" = 'unknown' THEN 0
    ELSE 1
  END,
  "vehicleSensorServerBound" = "vehicleSensorCapabilityStatus" = 'supported',
  "vehicleVendorEventModelBound" = "vehicleSensorCapabilityStatus" = 'supported';

ALTER TABLE "MeshNode"
  DROP CONSTRAINT "MeshNode_vehicle_sensor_capability_check",
  ADD CONSTRAINT "MeshNode_vehicle_sensor_capability_check" CHECK (
    (
      "vehicleSensorCapabilityRevision" = 0
      AND "vehicleSensorCapabilityStatus" = 'unknown'
      AND "vehicleSensorCapabilityVerifiedAt" IS NULL
      AND NOT "vehicleSensorServerBound"
      AND NOT "vehicleVendorEventModelBound"
    )
    OR
    (
      "vehicleSensorCapabilityRevision" > 0
      AND "vehicleSensorCapabilityStatus" = 'supported'
      AND "vehicleSensorCapabilityVerifiedAt" IS NOT NULL
      AND "vehicleSensorServerBound"
      AND "vehicleVendorEventModelBound"
    )
    OR
    (
      "vehicleSensorCapabilityRevision" > 0
      AND "vehicleSensorCapabilityStatus" = 'unsupported'
      AND NOT (
        "vehicleSensorCapabilityVerifiedAt" IS NOT NULL
        AND "vehicleSensorServerBound"
        AND "vehicleVendorEventModelBound"
      )
    )
  );

ALTER TABLE "ProcessedGatewayEvent"
  ADD CONSTRAINT "ProcessedGatewayEvent_payload_hash_check" CHECK (
    "payloadHash" IS NULL OR "payloadHash" ~ '^sha256:[0-9a-f]{64}$'
  );

DROP TRIGGER "MeshNode_vehicle_sensor_capability_statement_lock" ON "MeshNode";
CREATE TRIGGER "MeshNode_vehicle_sensor_capability_statement_lock"
BEFORE UPDATE OF
  "vehicleSensorCapabilityStatus",
  "vehicleSensorCapabilityVerifiedAt",
  "vehicleSensorCapabilityRevision",
  "vehicleSensorServerBound",
  "vehicleVendorEventModelBound"
ON "MeshNode"
FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();

DROP TRIGGER "MeshNode_vehicle_sensor_capability_guard" ON "MeshNode";
CREATE TRIGGER "MeshNode_vehicle_sensor_capability_guard"
BEFORE UPDATE OF
  "vehicleSensorCapabilityStatus",
  "vehicleSensorCapabilityVerifiedAt",
  "vehicleSensorCapabilityRevision",
  "vehicleSensorServerBound",
  "vehicleVendorEventModelBound"
ON "MeshNode"
FOR EACH ROW EXECUTE FUNCTION "guard_mesh_node_vehicle_sensor_capability"();

COMMIT;
