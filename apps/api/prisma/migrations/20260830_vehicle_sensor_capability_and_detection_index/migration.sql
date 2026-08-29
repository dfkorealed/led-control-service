BEGIN;

CREATE TYPE "VehicleSensorCapabilityStatus" AS ENUM (
  'unknown',
  'supported',
  'unsupported'
);

ALTER TABLE "MeshNode"
  ADD COLUMN "vehicleSensorCapabilityStatus" "VehicleSensorCapabilityStatus" NOT NULL DEFAULT 'unknown',
  ADD COLUMN "vehicleSensorCapabilityVerifiedAt" TIMESTAMP(3);

-- Fail closed for every node provisioned before capability-aware model binding.
UPDATE "MeshNode"
SET
  "vehicleSensorCapabilityStatus" = 'unknown',
  "vehicleSensorCapabilityVerifiedAt" = NULL;

ALTER TABLE "MeshNode"
  ADD CONSTRAINT "MeshNode_vehicle_sensor_capability_check"
  CHECK (
    (
      "vehicleSensorCapabilityStatus" = 'supported'
      AND "vehicleSensorCapabilityVerifiedAt" IS NOT NULL
    )
    OR (
      "vehicleSensorCapabilityStatus" = 'unknown'
      AND "vehicleSensorCapabilityVerifiedAt" IS NULL
    )
    OR "vehicleSensorCapabilityStatus" = 'unsupported'
  );

-- Prisma cannot represent this predicate; schema.prisma retains the general
-- ordered index used by latest-execution queries.
CREATE INDEX "AutomationExecution_vehicleEventRuleId_latest_detection_idx"
ON "AutomationExecution"("vehicleEventRuleId", "occurredAt" DESC, "sequence" DESC)
WHERE "kind" = 'vehicle_detected';

COMMIT;
