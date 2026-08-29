BEGIN;

SELECT "lock_automation_membership_mutation"();

LOCK TABLE "VehicleEventSource", "VehicleEventRule", "Fixture", "MeshNode" IN SHARE MODE;

DO $preflight$
DECLARE
  invalid_sources TEXT;
BEGIN
  SELECT string_agg(
    format(
      'rule=%s,node=%s,fixture=%s,status=%s,verifiedAt=%s',
      source."ruleId",
      COALESCE(node."id", '<unregistered>'),
      source."fixtureId",
      COALESCE(node."vehicleSensorCapabilityStatus"::TEXT, '<missing>'),
      COALESCE(node."vehicleSensorCapabilityVerifiedAt"::TEXT, 'NULL')
    ),
    ', ' ORDER BY source."ruleId", source."fixtureId"
  )
  INTO invalid_sources
  FROM "VehicleEventSource" AS source
  LEFT JOIN "Fixture" AS fixture ON fixture."id" = source."fixtureId"
  LEFT JOIN "MeshNode" AS node ON node."id" = fixture."meshNodeId"
  WHERE node."vehicleSensorCapabilityStatus" IS DISTINCT FROM 'supported'
    OR node."vehicleSensorCapabilityVerifiedAt" IS NULL;

  IF invalid_sources IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Operator remediation required before migration: invalid vehicle event sources detected',
      DETAIL = invalid_sources,
      HINT = 'Disable or delete the owning rules as appropriate, then verify each listed MeshNode or remove its VehicleEventSource before retrying the migration. No rows were modified.';
  END IF;
END;
$preflight$;

CREATE FUNCTION "validate_vehicle_event_source_capability"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM 1
  FROM "Fixture" AS fixture
  INNER JOIN "MeshNode" AS node ON node."id" = fixture."meshNodeId"
  WHERE fixture."id" = NEW."fixtureId"
    AND node."vehicleSensorCapabilityStatus" = 'supported'
    AND node."vehicleSensorCapabilityVerifiedAt" IS NOT NULL
  FOR UPDATE OF node;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vehicle event source requires a verified supported MeshNode'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "VehicleEventSource_vehicle_sensor_capability_guard"
BEFORE INSERT OR UPDATE OF "fixtureId" ON "VehicleEventSource"
FOR EACH ROW EXECUTE FUNCTION "validate_vehicle_event_source_capability"();

CREATE FUNCTION "guard_mesh_node_vehicle_sensor_capability"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."vehicleSensorCapabilityStatus" = 'supported'
    AND NEW."vehicleSensorCapabilityVerifiedAt" IS NULL
  THEN
    RAISE EXCEPTION 'supported vehicle sensor capability requires verifiedAt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."vehicleSensorCapabilityStatus" = 'unknown'
    AND NEW."vehicleSensorCapabilityVerifiedAt" IS NOT NULL
  THEN
    RAISE EXCEPTION 'unknown vehicle sensor capability requires null verifiedAt'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    NEW."vehicleSensorCapabilityStatus" = 'supported'
    AND NEW."vehicleSensorCapabilityVerifiedAt" IS NOT NULL
  ) THEN
    -- Source INSERT updates its parent counter before taking the node row lock.
    -- Locking enabled parents here turns a stale RR/Serializable snapshot into
    -- a serialization failure instead of allowing a concurrent downgrade.
    PERFORM 1
    FROM "VehicleEventRule" AS rule
    WHERE rule."gatewayId" = NEW."gatewayId"
      AND rule."status" = 'enabled'
    ORDER BY rule."id"
    FOR UPDATE OF rule;

    IF EXISTS (
      SELECT 1
      FROM "Fixture" AS fixture
      INNER JOIN "VehicleEventSource" AS source ON source."fixtureId" = fixture."id"
      INNER JOIN "VehicleEventRule" AS rule ON rule."id" = source."ruleId"
      WHERE fixture."meshNodeId" = OLD."id"
        AND rule."status" = 'enabled'
    ) THEN
      RAISE EXCEPTION 'enabled vehicle event rule requires verified supported source capability'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MeshNode_vehicle_sensor_capability_statement_lock"
BEFORE UPDATE OF "vehicleSensorCapabilityStatus", "vehicleSensorCapabilityVerifiedAt" ON "MeshNode"
FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();

CREATE TRIGGER "MeshNode_vehicle_sensor_capability_guard"
BEFORE UPDATE OF "vehicleSensorCapabilityStatus", "vehicleSensorCapabilityVerifiedAt" ON "MeshNode"
FOR EACH ROW EXECUTE FUNCTION "guard_mesh_node_vehicle_sensor_capability"();

CREATE FUNCTION "guard_vehicle_event_rule_source_capability"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" = 'enabled' AND EXISTS (
    SELECT 1
    FROM "VehicleEventSource" AS source
    INNER JOIN "Fixture" AS fixture ON fixture."id" = source."fixtureId"
    LEFT JOIN "MeshNode" AS node ON node."id" = fixture."meshNodeId"
    WHERE source."ruleId" = NEW."id"
      AND (
        node."vehicleSensorCapabilityStatus" IS DISTINCT FROM 'supported'
        OR node."vehicleSensorCapabilityVerifiedAt" IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'enabled vehicle event rule requires verified supported source capability'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "VehicleEventRule_vehicle_sensor_capability_guard"
BEFORE UPDATE OF "status" ON "VehicleEventRule"
FOR EACH ROW EXECUTE FUNCTION "guard_vehicle_event_rule_source_capability"();

CREATE FUNCTION "guard_fixture_vehicle_sensor_capability"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."meshNodeId" IS DISTINCT FROM OLD."meshNodeId" AND EXISTS (
    SELECT 1
    FROM "VehicleEventSource" AS source
    INNER JOIN "VehicleEventRule" AS rule ON rule."id" = source."ruleId"
    WHERE source."fixtureId" = OLD."id"
      AND rule."status" = 'enabled'
  ) THEN
    PERFORM 1
    FROM "MeshNode" AS node
    WHERE node."id" = NEW."meshNodeId"
      AND node."vehicleSensorCapabilityStatus" = 'supported'
      AND node."vehicleSensorCapabilityVerifiedAt" IS NOT NULL
    FOR UPDATE OF node;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'enabled vehicle event rule requires verified supported source capability'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Fixture_vehicle_sensor_capability_statement_lock"
BEFORE UPDATE OF "meshNodeId" ON "Fixture"
FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();

CREATE TRIGGER "Fixture_vehicle_sensor_capability_guard"
BEFORE UPDATE OF "meshNodeId" ON "Fixture"
FOR EACH ROW EXECUTE FUNCTION "guard_fixture_vehicle_sensor_capability"();

COMMIT;
