BEGIN;

SELECT "lock_automation_membership_mutation"();
LOCK TABLE "ProcessedGatewayEvent" IN SHARE ROW EXCLUSIVE MODE;

-- No attribution is inferred from today's Fixture mapping. Preserve all retained
-- rows; an unattributed legacy BIO receipt requires an explicit audited repair.
-- Prisma masks errors raised midway through explicit transactions. A session-only
-- deferred trigger preserves the actionable preflight at COMMIT, as in the
-- existing BIO contract migration; no persistent table/function is introduced.
CREATE TEMP TABLE "BioCapabilityMigrationFailure" ("detail" TEXT NOT NULL) ON COMMIT DROP;
CREATE FUNCTION pg_temp."raise_bio_capability_migration_failure"()
RETURNS TRIGGER LANGUAGE plpgsql AS $failure$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Operator remediation required before node-local BIO capability migration: ' || NEW."detail",
    HINT = 'Restore audited original node ownership or quarantine/remove invalid ledger after audit, then retry. No rows or schema were changed.';
  RETURN NEW;
END;
$failure$;
CREATE CONSTRAINT TRIGGER "BioCapabilityMigrationFailure_raise_at_commit"
AFTER INSERT ON "BioCapabilityMigrationFailure" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION pg_temp."raise_bio_capability_migration_failure"();

DO $preflight$
DECLARE invalid_event RECORD;
BEGIN
  SELECT "eventId", "gatewayId", "eventType", "sequence" INTO invalid_event
  FROM "ProcessedGatewayEvent"
  WHERE "eventType" IN ('vehicle_sensor_capability', 'bio_pulse_capability')
    AND "meshNodeId" IS NULL
  ORDER BY "createdAt", "eventId" LIMIT 1;
  IF FOUND THEN
    INSERT INTO "BioCapabilityMigrationFailure" ("detail") VALUES (format(
      'eventId=%s gatewayId=%s eventType=%s revision=%s has no MeshNode attribution',
      left(invalid_event."eventId", 128), left(invalid_event."gatewayId", 128),
      invalid_event."eventType", invalid_event."sequence"
    ));
    -- The old CHECK does not cover invalid BIO rows. Skip all DDL on failure
    -- so it cannot mask the deferred operator diagnostic with a CHECK error.
    RETURN;
  END IF;

  ALTER TABLE "ProcessedGatewayEvent"
  DROP CONSTRAINT "ProcessedGatewayEvent_capability_mesh_node_check",
  ADD CONSTRAINT "ProcessedGatewayEvent_capability_mesh_node_check" CHECK (
    "eventType" NOT IN ('vehicle_sensor_capability', 'bio_pulse_capability') OR "meshNodeId" IS NOT NULL
  );

  DROP INDEX "ProcessedGatewayEvent_legacy_sequence_key";
  DROP INDEX "ProcessedGatewayEvent_capability_node_sequence_key";
  CREATE UNIQUE INDEX "ProcessedGatewayEvent_legacy_sequence_key"
  ON "ProcessedGatewayEvent"("gatewayId", "sequence", "eventType")
  WHERE "eventType" NOT IN ('vehicle_sensor_capability', 'bio_pulse_capability');
  CREATE UNIQUE INDEX "ProcessedGatewayEvent_capability_node_sequence_key"
  ON "ProcessedGatewayEvent"("gatewayId", "meshNodeId", "sequence", "eventType")
  WHERE "eventType" IN ('vehicle_sensor_capability', 'bio_pulse_capability');
END;
$preflight$;

COMMIT;
