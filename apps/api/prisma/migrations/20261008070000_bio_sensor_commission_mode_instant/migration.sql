BEGIN;
SELECT "lock_automation_membership_mutation"();
-- Link GET verifiedAt refresh is not attribution to a new commission. Preserve
-- the initial mode GET instant separately; do not synthesize historical proof.
ALTER TABLE "MeshNode" ADD COLUMN "bioPulseSensorModeVerifiedAt" TIMESTAMP(3);
ALTER FUNCTION bio_sensor_blocked_reasons(TEXT,TIMESTAMP,TEXT,TEXT,TIMESTAMP,BIGINT) RENAME TO bio_sensor_base_blocked_reasons;
CREATE FUNCTION bio_sensor_blocked_reasons(fixture_id TEXT, as_of TIMESTAMP DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  proposed_readiness TEXT DEFAULT NULL, proposed_profile TEXT DEFAULT NULL, proposed_verified TIMESTAMP DEFAULT NULL,
  proposed_revision BIGINT DEFAULT NULL, proposed_sensor_mode TIMESTAMP DEFAULT NULL)
RETURNS TEXT[] LANGUAGE plpgsql STABLE AS $function$
DECLARE reasons TEXT[]; live_mode TIMESTAMP; commission_mode TIMESTAMP;
BEGIN
  reasons := bio_sensor_base_blocked_reasons(fixture_id,as_of,proposed_readiness,proposed_profile,proposed_verified,proposed_revision);
  SELECT n."bioPulseSensorModeVerifiedAt" INTO live_mode FROM "Fixture" f JOIN "MeshNode" n ON n."id"=f."meshNodeId" WHERE f."id"=fixture_id;
  -- Wire Date parsing and Prisma DateTime retain millisecond instants. Normalize
  -- timezone spelling and sub-millisecond input identically, not text equality.
  SELECT date_trunc('milliseconds',(p."result"->>'observedAt')::timestamptz AT TIME ZONE 'UTC') INTO commission_mode
    FROM "BioSensorPreparationOperation" p WHERE p."fixtureId"=fixture_id ORDER BY p."requestedAt" DESC,p."commandId" DESC LIMIT 1;
  IF commission_mode IS NULL OR (CASE WHEN proposed_revision IS NOT NULL THEN proposed_sensor_mode ELSE live_mode END) IS DISTINCT FROM commission_mode THEN
    IF NOT ('mode_unverified'=ANY(reasons)) THEN reasons := array_append(reasons,'mode_unverified'); END IF;
  END IF;
  RETURN reasons;
END;
$function$;

-- Reparse callers after the overload transition; do not leave a cached base
-- function OID as the authority for direct SQL enabled source admission.
CREATE OR REPLACE FUNCTION "vehicle_event_source_is_ready"(node "MeshNode", protocol "VehicleSensorProtocol")
RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(node."vehicleSensorProtocol"=protocol AND CASE protocol
    WHEN 'bluez_stateful' THEN node."vehicleSensorCapabilityStatus"='supported' AND node."vehicleSensorCapabilityVerifiedAt" IS NOT NULL
      AND node."vehicleSensorCapabilityRevision">0 AND node."vehicleSensorServerBound" AND node."vehicleVendorEventModelBound"
    WHEN 'bio_usb_pulse' THEN EXISTS(SELECT 1 FROM "Fixture" f WHERE f."meshNodeId"=node."id"
      AND cardinality(bio_sensor_blocked_reasons(f."id"))=0) END,false);
$function$;

CREATE OR REPLACE FUNCTION "guard_mesh_node_vehicle_sensor_capability"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM 1 FROM "VehicleEventRule" WHERE "gatewayId"=NEW."gatewayId" AND "status"='enabled' ORDER BY "id" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "Fixture" f JOIN "VehicleEventSource" s ON s."fixtureId"=f."id"
    JOIN "VehicleEventRule" r ON r."id"=s."ruleId" WHERE f."meshNodeId"=OLD."id" AND r."status"='enabled'
      AND CASE WHEN r."sensorProtocol"='bio_usb_pulse' THEN NEW."vehicleSensorProtocol"<>'bio_usb_pulse'
        OR cardinality(bio_sensor_blocked_reasons(f."id",clock_timestamp() AT TIME ZONE 'UTC',
          NEW."bioPulseReadiness"::TEXT,NEW."bioPulseProfileId",NEW."bioPulseVerifiedAt",NEW."bioPulseCapabilityRevision",NEW."bioPulseSensorModeVerifiedAt"))<>0
        ELSE NOT "vehicle_event_source_is_ready"(NEW,r."sensorProtocol") END) THEN
    RAISE EXCEPTION 'enabled vehicle event rule requires current verified source evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "MeshNode_bio_sensor_mode_statement_lock" BEFORE UPDATE OF "bioPulseSensorModeVerifiedAt" ON "MeshNode"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
DROP TRIGGER "MeshNode_vehicle_sensor_capability_guard" ON "MeshNode";
CREATE TRIGGER "MeshNode_vehicle_sensor_capability_guard" BEFORE UPDATE OF "vehicleSensorProtocol","bioPulseReadiness","bioPulseProfileId",
  "bioPulseVerifiedAt","bioPulseCapabilityRevision","bioPulseSensorModeVerifiedAt","vehicleSensorCapabilityStatus",
  "vehicleSensorCapabilityVerifiedAt","vehicleSensorCapabilityRevision","vehicleSensorServerBound","vehicleVendorEventModelBound" ON "MeshNode"
  FOR EACH ROW EXECUTE FUNCTION "guard_mesh_node_vehicle_sensor_capability"();
-- Revoke any intervening/historical ready assumptions and enqueue serializer
-- convergence. NULL mode metadata never inherits an old ACK's commission.
UPDATE "BioSensorCatalogState" SET "revision"="revision"+1 WHERE "id"=1;
COMMIT;
