BEGIN;

SELECT "lock_automation_membership_mutation"();

CREATE TYPE "VehicleSensorProtocol" AS ENUM ('bluez_stateful', 'bio_usb_pulse');
CREATE TYPE "BioPulseReadiness" AS ENUM ('off', 'shadow', 'ready', 'degraded');

-- Expand only: existing V1 capability evidence and five-second rules stay intact.
ALTER TABLE "MeshNode"
  ADD COLUMN "vehicleSensorProtocol" "VehicleSensorProtocol" NOT NULL DEFAULT 'bluez_stateful',
  ADD COLUMN "bioPulseReadiness" "BioPulseReadiness" NOT NULL DEFAULT 'off',
  ADD COLUMN "bioPulseProfileId" TEXT,
  ADD COLUMN "bioPulseVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "bioPulseCapabilityRevision" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "VehicleEventRule"
  ADD COLUMN "sensorProtocol" "VehicleSensorProtocol" NOT NULL DEFAULT 'bluez_stateful',
  DROP CONSTRAINT "VehicleEventRule_hold_check",
  ADD CONSTRAINT "VehicleEventRule_hold_check" CHECK (
    "holdSeconds" BETWEEN CASE "sensorProtocol" WHEN 'bio_usb_pulse' THEN 10 ELSE 5 END AND 1800
  );

ALTER TABLE "MeshNode"
  DROP CONSTRAINT "MeshNode_vehicle_sensor_capability_check",
  ADD CONSTRAINT "MeshNode_vehicle_sensor_capability_check" CHECK (
    (
      "vehicleSensorCapabilityStatus" = 'unknown'
      AND "vehicleSensorCapabilityVerifiedAt" IS NULL
      AND "vehicleSensorCapabilityRevision" = 0
      AND NOT "vehicleSensorServerBound"
      AND NOT "vehicleVendorEventModelBound"
    ) OR (
      "vehicleSensorProtocol" = 'bluez_stateful'
      AND (
        (
          "vehicleSensorCapabilityStatus" = 'supported'
          AND "vehicleSensorCapabilityVerifiedAt" IS NOT NULL
          AND "vehicleSensorCapabilityRevision" > 0
          AND "vehicleSensorServerBound"
          AND "vehicleVendorEventModelBound"
        ) OR (
          "vehicleSensorCapabilityStatus" = 'unsupported'
          AND "vehicleSensorCapabilityRevision" > 0
          AND (NOT "vehicleSensorServerBound" OR NOT "vehicleVendorEventModelBound")
        )
      )
    )
  ),
  ADD CONSTRAINT "MeshNode_bio_pulse_capability_check" CHECK (
    "bioPulseCapabilityRevision" >= 0
    AND ("bioPulseProfileId" IS NULL OR "bioPulseProfileId" ~ '[^[:space:]]')
    AND (
      (
        "vehicleSensorProtocol" = 'bluez_stateful'
        AND "bioPulseReadiness" = 'off'
        AND "bioPulseCapabilityRevision" = 0
        AND "bioPulseProfileId" IS NULL
        AND "bioPulseVerifiedAt" IS NULL
      ) OR (
        "vehicleSensorProtocol" = 'bio_usb_pulse'
        AND ("bioPulseReadiness" = 'off' OR "bioPulseCapabilityRevision" > 0)
        AND (
          "bioPulseReadiness" <> 'ready'
          OR ("bioPulseProfileId" IS NOT NULL AND "bioPulseVerifiedAt" IS NOT NULL)
        )
      )
    )
  );

-- Qualification metadata is not a sensor-mode GET, snapshot ACK, or optical proof.
CREATE FUNCTION "vehicle_event_source_is_ready"(node "MeshNode", protocol "VehicleSensorProtocol")
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $function$
  SELECT COALESCE(node."vehicleSensorProtocol" = protocol AND CASE protocol
    WHEN 'bluez_stateful' THEN
      node."vehicleSensorCapabilityStatus" = 'supported'
      AND node."vehicleSensorCapabilityVerifiedAt" IS NOT NULL
      AND node."vehicleSensorCapabilityRevision" > 0
      AND node."vehicleSensorServerBound" AND node."vehicleVendorEventModelBound"
    WHEN 'bio_usb_pulse' THEN
      node."bioPulseReadiness" = 'ready'
      AND node."bioPulseCapabilityRevision" > 0
      AND node."bioPulseProfileId" IS NOT NULL AND node."bioPulseProfileId" ~ '[^[:space:]]'
      AND node."bioPulseVerifiedAt" IS NOT NULL
    END, false);
$function$;

CREATE FUNCTION "assert_vehicle_event_source_ready"(fixture_id TEXT, protocol "VehicleSensorProtocol")
RETURNS VOID LANGUAGE plpgsql AS $function$
DECLARE
  node_id TEXT;
  node "MeshNode";
BEGIN
  -- A lock alone does not change the version seen by an older RR snapshot.
  -- A newly created rule is invisible to that snapshot, so parent locks alone
  -- miss it. Preserve every logical value (including updatedAt) while creating
  -- row versions that fence concurrent node downgrade and Fixture reassignment.
  -- These UPDATE lists deliberately exclude capability/owner trigger columns.
  UPDATE "Fixture" SET "updatedAt" = "updatedAt" WHERE "id" = fixture_id
    RETURNING "meshNodeId" INTO node_id;
  UPDATE "MeshNode" SET "updatedAt" = "updatedAt" WHERE "id" = node_id
    RETURNING * INTO node;
  IF NOT "vehicle_event_source_is_ready"(node, protocol) THEN
    RAISE EXCEPTION 'vehicle event source requires verified capability for its rule protocol' USING ERRCODE = '23514';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION "validate_vehicle_event_source_capability"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE
  protocol "VehicleSensorProtocol";
BEGIN
  SELECT "sensorProtocol" INTO protocol FROM "VehicleEventRule" WHERE "id" = NEW."ruleId";
  PERFORM "assert_vehicle_event_source_ready"(NEW."fixtureId", protocol);
  RETURN NEW;
END;
$function$;

DROP TRIGGER "VehicleEventSource_vehicle_sensor_capability_guard" ON "VehicleEventSource";
CREATE TRIGGER "VehicleEventSource_vehicle_sensor_capability_guard"
BEFORE INSERT OR UPDATE OF "fixtureId", "ruleId" ON "VehicleEventSource"
FOR EACH ROW EXECUTE FUNCTION "validate_vehicle_event_source_capability"();

CREATE OR REPLACE FUNCTION "guard_mesh_node_vehicle_sensor_capability"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  -- Source membership writes change their parent row version. Lock those parents
  -- before reading membership so old RR/Serializable snapshots cannot miss them.
  PERFORM 1 FROM "VehicleEventRule" AS rule
  WHERE rule."gatewayId" = NEW."gatewayId" AND rule."status" = 'enabled'
  ORDER BY rule."id" FOR UPDATE OF rule;
  IF EXISTS (
    SELECT 1 FROM "Fixture" AS fixture
    JOIN "VehicleEventSource" AS source ON source."fixtureId" = fixture."id"
    JOIN "VehicleEventRule" AS rule ON rule."id" = source."ruleId"
    WHERE fixture."meshNodeId" = OLD."id" AND rule."status" = 'enabled'
      AND NOT "vehicle_event_source_is_ready"(NEW, rule."sensorProtocol")
  ) THEN
    RAISE EXCEPTION 'enabled vehicle event rule requires verified source capability for its protocol' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER "MeshNode_vehicle_sensor_capability_statement_lock" ON "MeshNode";
CREATE TRIGGER "MeshNode_vehicle_sensor_capability_statement_lock"
BEFORE UPDATE OF "vehicleSensorProtocol", "bioPulseReadiness", "bioPulseProfileId", "bioPulseVerifiedAt", "bioPulseCapabilityRevision",
  "vehicleSensorCapabilityStatus", "vehicleSensorCapabilityVerifiedAt", "vehicleSensorCapabilityRevision", "vehicleSensorServerBound", "vehicleVendorEventModelBound"
ON "MeshNode" FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();

DROP TRIGGER "MeshNode_vehicle_sensor_capability_guard" ON "MeshNode";
CREATE TRIGGER "MeshNode_vehicle_sensor_capability_guard"
BEFORE UPDATE OF "vehicleSensorProtocol", "bioPulseReadiness", "bioPulseProfileId", "bioPulseVerifiedAt", "bioPulseCapabilityRevision",
  "vehicleSensorCapabilityStatus", "vehicleSensorCapabilityVerifiedAt", "vehicleSensorCapabilityRevision", "vehicleSensorServerBound", "vehicleVendorEventModelBound"
ON "MeshNode" FOR EACH ROW EXECUTE FUNCTION "guard_mesh_node_vehicle_sensor_capability"();

CREATE OR REPLACE FUNCTION "guard_vehicle_event_rule_source_capability"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE
  fixture_id TEXT;
BEGIN
  IF NEW."status" = 'enabled' OR NEW."sensorProtocol" IS DISTINCT FROM OLD."sensorProtocol" THEN
    FOR fixture_id IN SELECT "fixtureId" FROM "VehicleEventSource"
      WHERE "ruleId" = NEW."id" ORDER BY "fixtureId"
    LOOP
      PERFORM "assert_vehicle_event_source_ready"(fixture_id, NEW."sensorProtocol");
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER "VehicleEventRule_vehicle_sensor_capability_guard" ON "VehicleEventRule";
CREATE TRIGGER "VehicleEventRule_vehicle_sensor_capability_guard"
BEFORE UPDATE OF "status", "sensorProtocol" ON "VehicleEventRule"
FOR EACH ROW EXECUTE FUNCTION "guard_vehicle_event_rule_source_capability"();

CREATE OR REPLACE FUNCTION "guard_fixture_vehicle_sensor_capability"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE
  replacement "MeshNode";
BEGIN
  IF NEW."meshNodeId" IS NOT DISTINCT FROM OLD."meshNodeId" THEN RETURN NEW; END IF;
  -- This is another admission path; use the same parent version fence as downgrade.
  PERFORM 1 FROM "VehicleEventRule" AS rule
  WHERE rule."gatewayId" = OLD."gatewayId" AND rule."status" = 'enabled'
  ORDER BY rule."id" FOR UPDATE OF rule;
  -- Reassignment admits the new node too: write its MVCC fence, not its timestamp.
  UPDATE "MeshNode" SET "updatedAt" = "updatedAt" WHERE "id" = NEW."meshNodeId"
    RETURNING * INTO replacement;
  IF EXISTS (
    SELECT 1 FROM "VehicleEventSource" AS source
    JOIN "VehicleEventRule" AS rule ON rule."id" = source."ruleId"
    WHERE source."fixtureId" = OLD."id" AND rule."status" = 'enabled'
      AND NOT "vehicle_event_source_is_ready"(replacement, rule."sensorProtocol")
  ) THEN
    RAISE EXCEPTION 'enabled vehicle event rule requires verified source capability for its protocol' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

COMMIT;
