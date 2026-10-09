BEGIN;
SELECT "lock_automation_membership_mutation"();

-- No FK: retain the old assignment/revision attribution after deletion or
-- reassignment. Retirement is not successful current snapshot materialization.
CREATE TABLE "BioSensorConvergenceWork" (
  "siteId" TEXT NOT NULL, "gatewayId" TEXT NOT NULL, "assignmentVersion" INTEGER NOT NULL,
  "catalogRevision" BIGINT NOT NULL, "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3), "retiredAt" TIMESTAMP(3),
  PRIMARY KEY ("siteId", "gatewayId", "assignmentVersion", "catalogRevision"),
  CHECK ("catalogRevision">0 AND "catalogRevision"<=9007199254740991),
  CHECK (NOT ("completedAt" IS NOT NULL AND "retiredAt" IS NOT NULL))
);
CREATE INDEX "BioSensorConvergenceWork_pending" ON "BioSensorConvergenceWork" ("nextAttemptAt", "gatewayId")
  WHERE "completedAt" IS NULL AND "retiredAt" IS NULL;

-- Strict ingress validates and hashes wire envelopes. SQL compares their
-- persisted immutable attribution, never duplicates the canonical serializer.
-- Optional proposed live fields are used only by authenticated capability
-- ingestion before storing the observation+ledger in the same transaction.
CREATE FUNCTION bio_sensor_blocked_reasons(fixture_id TEXT, as_of TIMESTAMP DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  proposed_readiness TEXT DEFAULT NULL, proposed_profile TEXT DEFAULT NULL,
  proposed_verified TIMESTAMP DEFAULT NULL, proposed_revision BIGINT DEFAULT NULL)
RETURNS TEXT[] LANGUAGE plpgsql STABLE AS $function$
DECLARE
  f "Fixture"; n "MeshNode"; g "Gateway"; p "BioSensorPreparationOperation";
  profile "BioSensorProfileRevision"; policy "BioSensorSitePolicy"; delivery "BioSensorCatalogDelivery";
  reasons TEXT[] := '{}'; current_catalog_revision BIGINT; matches INTEGER; binding_ok BOOLEAN; checkpoint_ok BOOLEAN;
BEGIN
  SELECT * INTO f FROM "Fixture" WHERE "id"=fixture_id;
  SELECT * INTO n FROM "MeshNode" WHERE "id"=f."meshNodeId";
  SELECT * INTO g FROM "Gateway" WHERE "id"=f."gatewayId";
  SELECT "revision" INTO current_catalog_revision FROM "BioSensorCatalogState" WHERE "id"=1;
  SELECT * INTO p FROM "BioSensorPreparationOperation" WHERE "fixtureId"=fixture_id
    ORDER BY "requestedAt" DESC, "commandId" DESC LIMIT 1;
  binding_ok := COALESCE(n."vehicleSensorProtocol"='bio_usb_pulse'
    AND n."deviceUuid" ~ '^bio:[0-9a-f]{12}$' AND n."meshAddress" ~ '^0x[0-7][0-9a-f]{3}$' AND n."meshAddress"<>'0x0000'
    AND n."gatewayId"=g."id" AND g."siteId"=f."siteId" AND g."assignmentVersion">0
    AND EXISTS(SELECT 1 FROM "Floor" WHERE "id"=f."floorId" AND "siteId"=f."siteId" AND "status"='active')
    AND p."siteId"=f."siteId" AND p."gatewayId"=g."id" AND p."nodeId"=n."id"
    AND p."assignmentVersion"=g."assignmentVersion" AND p."meshAddress"=n."meshAddress"
    AND p."deviceIdentityHash"=encode(sha256(convert_to(n."deviceUuid",'UTF8')),'hex')
    AND p."payload"->>'commandId'=p."commandId" AND p."payload"->>'fixtureId'=f."id"
    AND p."payload"->>'nodeId'=n."id" AND p."payload"->>'siteId'=f."siteId" AND p."payload"->>'gatewayId'=g."id"
    AND p."payload"->>'deviceIdentityHash'=p."deviceIdentityHash" AND p."payload"->>'meshAddress'=n."meshAddress"
    AND p."payload"->>'assignmentVersion'=g."assignmentVersion"::TEXT
    AND p."payload"->>'operation'=p."operation" AND p."payload"->>'catalogRevision'=current_catalog_revision::TEXT
    AND p."supersededAt" IS NULL AND p."catalogRevision"=current_catalog_revision, false);
  IF NOT binding_ok THEN reasons := array_append(reasons,'binding_changed'); END IF;
  checkpoint_ok := COALESCE(binding_ok AND p."status"='ready' AND p."resultHash" IS NOT NULL AND p."ackHash" IS NOT NULL
    AND p."ackPayload"->>'status'='applied' AND p."ackPayload"->>'commandId'=p."commandId"
    AND p."ackPayload"->>'reportPayloadHash'=p."resultHash" AND p."ackPayload"->>'eventId'=p."resultEventId"
    AND p."ackPayload"->>'fixtureId'=f."id" AND p."ackPayload"->>'nodeId'=n."id"
    AND p."ackPayload"->>'siteId'=f."siteId" AND p."ackPayload"->>'gatewayId'=g."id"
    AND p."ackPayload"->>'assignmentVersion'=g."assignmentVersion"::TEXT
    AND p."result"->>'commandId'=p."commandId" AND p."result"->>'commandPayloadHash'=p."payloadHash"
    AND p."result"->>'eventId'=p."resultEventId" AND p."result"->>'fixtureId'=f."id"
    AND p."result"->>'operation'=p."operation"
    AND p."result"->>'siteId'=f."siteId" AND p."result"->>'gatewayId'=g."id" AND p."result"->>'nodeId'=n."id"
    AND p."result"->>'assignmentVersion'=g."assignmentVersion"::TEXT
    AND p."result"->>'deviceIdentityHash'=p."deviceIdentityHash" AND p."result"->>'meshAddress'=n."meshAddress"
    AND p."result"->>'catalogRevision'=current_catalog_revision::TEXT AND p."result"->>'status'='ready'
    AND EXISTS (SELECT 1 FROM "Site" s JOIN "User" u ON u."id"=s."adminUserId"
      JOIN "Organization" o ON o."id"=u."organizationId" WHERE s."id"=f."siteId" AND u."id"=p."actorId"
        AND u."status"='active' AND u."role"='admin' AND u."organizationId"=s."organizationId" AND o."type"='customer'),false);
  IF NOT checkpoint_ok OR p."result"->>'modeVerified' IS DISTINCT FROM 'true' THEN reasons := array_append(reasons,'mode_unverified'); END IF;
  WITH latest AS (SELECT DISTINCT ON ("profileId") * FROM "BioSensorProfileRevision" ORDER BY "profileId","revision" DESC)
    SELECT count(*) INTO matches FROM latest WHERE "status"='approved' AND "fingerprint"=p."result"->'fingerprint';
  IF matches<>1 THEN
    reasons := array_append(reasons,'fingerprint_unverified'); reasons := array_append(reasons,'profile_unverified');
  ELSE
    WITH latest AS (SELECT DISTINCT ON ("profileId") * FROM "BioSensorProfileRevision" ORDER BY "profileId","revision" DESC)
      SELECT * INTO profile FROM latest WHERE "status"='approved' AND "fingerprint"=p."result"->'fingerprint';
    IF p."result"->>'profileKey' IS DISTINCT FROM (profile."profileId"||'@'||profile."revision"::TEXT) THEN
      reasons := array_append(reasons,'profile_unverified');
    END IF;
  END IF;
  SELECT * INTO policy FROM "BioSensorSitePolicy" WHERE "siteId"=f."siteId";
  IF NOT COALESCE(policy."enabled" AND EXISTS (SELECT 1 FROM "Site" s JOIN "User" u ON u."id"=s."adminUserId"
      JOIN "Organization" o ON o."id"=u."organizationId" WHERE s."id"=f."siteId" AND u."id"=policy."ownerUserId"
        AND u."status"='active' AND u."role"='admin' AND u."organizationId"=s."organizationId" AND o."type"='customer'),false)
    THEN reasons := array_append(reasons,'operating_policy_required'); END IF;
  SELECT * INTO delivery FROM "BioSensorCatalogDelivery" WHERE "siteId"=f."siteId" AND "gatewayId"=g."id"
    AND "assignmentVersion"=g."assignmentVersion" AND "catalogRevision"=current_catalog_revision;
  IF NOT COALESCE(delivery."supersededAt" IS NULL AND delivery."appliedAt" IS NOT NULL AND delivery."status" IN ('applied','duplicate')
    AND delivery."ackHash" IS NOT NULL AND delivery."ackPayload"->>'deliveryPayloadHash'=delivery."payloadHash"
    AND delivery."ackPayload"->>'eventId'=delivery."deliveryId"
    AND delivery."ackPayload"->>'siteId'=f."siteId" AND delivery."ackPayload"->>'gatewayId'=g."id"
    AND delivery."ackPayload"->>'assignmentVersion'=g."assignmentVersion"::TEXT
    AND delivery."ackPayload"->>'catalogRevision'=current_catalog_revision::TEXT AND delivery."ackPayload"->>'status' IN ('applied','duplicate')
    AND delivery."payload"->'executionPolicy'->>'enabled'='true'
    AND delivery."payload"->'executionPolicy'->>'ownerUserId'=policy."ownerUserId"
    AND delivery."payload"->'executionPolicy'->>'maximumResponseSeconds'=policy."maximumResponseSeconds"::TEXT
    AND delivery."payload"->'executionPolicy'->>'escalationAction'=policy."escalationAction",false)
    THEN reasons := array_append(reasons,'catalog_pending'); END IF;
  IF NOT COALESCE((SELECT "maxSnapshotVersion"=2 FROM "GatewayAutomationProtocolSupport"
    WHERE "gatewayId"=g."id" AND "siteId"=f."siteId" AND "assignmentVersion"=g."assignmentVersion"
    ORDER BY "declarationRevision" DESC LIMIT 1),false) OR NOT EXISTS (
      SELECT 1 FROM "GatewayInventory" i JOIN "GatewayCertificate" c ON c."inventoryId"=i."id"
      WHERE i."claimedGatewayId"=g."id" AND i."claimedAt" IS NOT NULL AND i."disabledAt" IS NULL
        AND g."claimedAt" IS NOT NULL AND c."gatewayId"=g."id" AND c."purpose"='mqtt' AND c."status"='active'
        AND c."revokedAt" IS NULL AND c."notBefore"<=as_of AND c."notAfter">as_of)
    THEN reasons := array_append(reasons,'gateway_protocol_unverified'); END IF;
  IF NOT COALESCE(checkpoint_ok AND p."result"->>'linkVerified'='true'
    -- A proposed revision selects the complete NEW observation. NULL proposed
    -- metadata must fail closed, not inherit fields from the previous node.
    AND CASE WHEN proposed_revision IS NOT NULL THEN proposed_readiness ELSE n."bioPulseReadiness"::TEXT END='ready'
    AND COALESCE(proposed_revision,n."bioPulseCapabilityRevision")>0
    AND CASE WHEN proposed_revision IS NOT NULL THEN proposed_profile ELSE n."bioPulseProfileId" END=profile."profileId"||'@'||profile."revision"::TEXT
    AND CASE WHEN proposed_revision IS NOT NULL THEN proposed_verified ELSE n."bioPulseVerifiedAt" END<=as_of+interval '1 second'
    AND CASE WHEN proposed_revision IS NOT NULL THEN proposed_verified ELSE n."bioPulseVerifiedAt" END>=date_trunc('milliseconds',(p."result"->>'observedAt')::timestamptz AT TIME ZONE 'UTC')
    AND CASE WHEN proposed_revision IS NOT NULL THEN proposed_verified ELSE n."bioPulseVerifiedAt" END>=as_of-(profile."linkPolicy"->>'maxAgeMs')::BIGINT*interval '1 millisecond'
    AND (proposed_revision IS NOT NULL OR EXISTS (SELECT 1 FROM "ProcessedGatewayEvent" e
      WHERE e."gatewayId"=g."id" AND e."meshNodeId"=n."id" AND e."scopeKey"=n."id" AND e."eventType"='bio_pulse_capability'
        AND e."sequence"=n."bioPulseCapabilityRevision" AND e."occurredAt"=n."bioPulseVerifiedAt"
        AND e."ingestionStatus"='accepted' AND e."payloadHash" IS NOT NULL
        AND EXISTS(SELECT 1 FROM "MqttOutbox" receipt WHERE receipt."gatewayId"=g."id" AND receipt."revision" IS NULL
          AND receipt."automationAssignmentVersion"=g."assignmentVersion" AND receipt."applicationAckKey" IS NOT NULL
          AND receipt."payload"->>'schemaVersion'='2' AND receipt."payload"->>'eventId'=e."eventId"
          AND receipt."payload"->>'meshNodeId'=n."id" AND receipt."payload"->>'capabilityRevision'=n."bioPulseCapabilityRevision"::TEXT
          AND receipt."payload"->>'deliveryPayloadHash'=e."payloadHash" AND receipt."payload"->>'status' IN ('applied','duplicate')))),false)
    THEN reasons := array_append(reasons,'link_unverified'); END IF;
  IF p."status"='unsupported' OR n."vehicleSensorCapabilityStatus"='unsupported' THEN reasons := array_append(reasons,'unsupported'); END IF;
  RETURN reasons;
END;
$function$;

CREATE OR REPLACE FUNCTION "vehicle_event_source_is_ready"(node "MeshNode", protocol "VehicleSensorProtocol")
RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(node."vehicleSensorProtocol"=protocol AND CASE protocol
    WHEN 'bluez_stateful' THEN node."vehicleSensorCapabilityStatus"='supported' AND node."vehicleSensorCapabilityVerifiedAt" IS NOT NULL
      AND node."vehicleSensorCapabilityRevision">0 AND node."vehicleSensorServerBound" AND node."vehicleVendorEventModelBound"
    WHEN 'bio_usb_pulse' THEN EXISTS(SELECT 1 FROM "Fixture" f WHERE f."meshNodeId"=node."id"
      AND cardinality(bio_sensor_blocked_reasons(f."id"))=0) END,false);
$function$;

-- Disabled historical source membership is editable after live qualification
-- loss. Enabled admission still passes the exact common predicate/MVCC fence.
CREATE OR REPLACE FUNCTION "validate_vehicle_event_source_capability"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE rule "VehicleEventRule";
BEGIN
  SELECT * INTO rule FROM "VehicleEventRule" WHERE "id"=NEW."ruleId";
  IF rule."status"='enabled' OR rule."sensorProtocol"='bluez_stateful' THEN
    PERFORM "assert_vehicle_event_source_ready"(NEW."fixtureId",rule."sensorProtocol");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION "guard_mesh_node_vehicle_sensor_capability"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM 1 FROM "VehicleEventRule" WHERE "gatewayId"=NEW."gatewayId" AND "status"='enabled' ORDER BY "id" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "Fixture" f JOIN "VehicleEventSource" s ON s."fixtureId"=f."id"
    JOIN "VehicleEventRule" r ON r."id"=s."ruleId" WHERE f."meshNodeId"=OLD."id" AND r."status"='enabled'
      AND CASE WHEN r."sensorProtocol"='bio_usb_pulse' THEN NEW."vehicleSensorProtocol"<>'bio_usb_pulse'
        OR cardinality(bio_sensor_blocked_reasons(f."id",clock_timestamp() AT TIME ZONE 'UTC',
          NEW."bioPulseReadiness"::TEXT,NEW."bioPulseProfileId",NEW."bioPulseVerifiedAt",NEW."bioPulseCapabilityRevision"))<>0
        ELSE NOT "vehicle_event_source_is_ready"(NEW,r."sensorProtocol") END) THEN
    RAISE EXCEPTION 'enabled vehicle event rule requires current verified source evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION bio_sensor_catalog_invalidation() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."revision"=OLD."revision" THEN RETURN NEW; END IF;
  UPDATE "BioSensorPreparationOperation" SET "supersededAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "supersededAt" IS NULL;
  UPDATE "VehicleEventRule" SET "status"='disabled' WHERE "sensorProtocol"='bio_usb_pulse' AND "status"='enabled';
  INSERT INTO "BioSensorConvergenceWork" ("siteId","gatewayId","assignmentVersion","catalogRevision")
    SELECT "siteId","id","assignmentVersion",NEW."revision" FROM "Gateway" WHERE "assignmentVersion">0
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "BioSensorCatalogState_current_invalidation" AFTER UPDATE OF "revision" ON "BioSensorCatalogState"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_catalog_invalidation();

-- Owner loss changes the real policy, not merely the dashboard. A global
-- catalog revision affects all sites, so its invalidation/work is global too.
CREATE FUNCTION bio_sensor_owner_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE changed INTEGER;
BEGIN
  PERFORM "lock_automation_membership_mutation"();
  UPDATE "BioSensorSitePolicy" policy SET "enabled"=false WHERE policy."enabled" AND NOT EXISTS (
    SELECT 1 FROM "Site" s JOIN "User" u ON u."id"=s."adminUserId" JOIN "Organization" o ON o."id"=u."organizationId"
    WHERE s."id"=policy."siteId" AND u."id"=policy."ownerUserId" AND u."role"='admin' AND u."status"='active'
      AND u."organizationId"=s."organizationId" AND o."type"='customer');
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed>0 THEN UPDATE "BioSensorCatalogState" SET "revision"="revision"+1 WHERE "id"=1; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Site_bio_policy_owner_changed" AFTER UPDATE OF "adminUserId","organizationId" ON "Site"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_owner_changed();
CREATE TRIGGER "User_bio_policy_owner_changed" AFTER UPDATE OF "role","status","organizationId" ON "User"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_owner_changed();
CREATE TRIGGER "Organization_bio_policy_owner_changed" AFTER UPDATE OF "type" ON "Organization"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_owner_changed();

CREATE FUNCTION bio_sensor_binding_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM "lock_automation_membership_mutation"();
  IF TG_TABLE_NAME='Gateway' THEN
    IF (NEW."assignmentVersion",NEW."siteId",NEW."claimedAt") IS NOT DISTINCT FROM (OLD."assignmentVersion",OLD."siteId",OLD."claimedAt") THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='MeshNode' THEN
    IF (NEW."deviceUuid",NEW."meshAddress",NEW."gatewayId") IS NOT DISTINCT FROM (OLD."deviceUuid",OLD."meshAddress",OLD."gatewayId") THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='Fixture' THEN
    IF (NEW."meshNodeId",NEW."gatewayId",NEW."siteId") IS NOT DISTINCT FROM (OLD."meshNodeId",OLD."gatewayId",OLD."siteId") THEN RETURN NEW; END IF;
  END IF;
  -- Fence before existing capability guards see a lost binding. Restoration
  -- and execution history are untouched, including old pending target receipts.
  UPDATE "VehicleEventRule" SET "status"='disabled' WHERE "sensorProtocol"='bio_usb_pulse' AND "status"='enabled';
  RETURN NEW;
END;
$function$;
CREATE FUNCTION bio_sensor_binding_committed() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
  -- AFTER sees the new assignment; BEFORE already disabled affected admission.
  -- Both persist atomically, and no envelope/hash is synthesized in SQL.
  UPDATE "BioSensorCatalogState" SET "revision"="revision"+1 WHERE "id"=1;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Gateway_aaa_bio_binding_invalidation" BEFORE UPDATE OF "assignmentVersion","siteId","claimedAt" ON "Gateway"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_binding_changed();
CREATE TRIGGER "MeshNode_aaa_bio_binding_invalidation" BEFORE UPDATE OF "deviceUuid","meshAddress","gatewayId" ON "MeshNode"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_binding_changed();
CREATE TRIGGER "Fixture_aaa_bio_binding_invalidation" BEFORE UPDATE OF "meshNodeId","gatewayId","siteId" ON "Fixture"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_binding_changed();
CREATE TRIGGER "Gateway_bio_binding_work" AFTER UPDATE OF "assignmentVersion","siteId","claimedAt" ON "Gateway"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_binding_committed();
CREATE TRIGGER "MeshNode_bio_binding_work" AFTER UPDATE OF "deviceUuid","meshAddress","gatewayId" ON "MeshNode"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_binding_committed();
CREATE TRIGGER "Fixture_bio_binding_work" AFTER UPDATE OF "meshNodeId","gatewayId","siteId" ON "Fixture"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_binding_committed();
-- Persisted claim/certificate/floor revocation is another evidence invalidation.
-- Temporary expiry still keeps work retriable; natural time expiry is evaluated
-- dynamically by the common predicate and bounded worker qualification sweep.
CREATE TRIGGER "GatewayCertificate_bio_authority_work" AFTER UPDATE OF "status","revokedAt","notBefore","notAfter","gatewayId","inventoryId" ON "GatewayCertificate"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_binding_committed();
CREATE TRIGGER "GatewayInventory_bio_authority_work" AFTER UPDATE OF "claimedGatewayId","claimedAt","disabledAt" ON "GatewayInventory"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_binding_committed();
CREATE TRIGGER "Floor_bio_binding_work" AFTER UPDATE OF "status","siteId" ON "Floor"
  FOR EACH ROW EXECUTE FUNCTION bio_sensor_binding_committed();

-- Acquire the shared membership/catalog serialization domain before row locks,
-- including direct SQL mutation paths, not from an AFTER-row inversion.
CREATE TRIGGER "Gateway_bio_binding_statement_lock" BEFORE UPDATE OF "assignmentVersion","siteId","claimedAt" ON "Gateway"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "MeshNode_bio_binding_statement_lock" BEFORE UPDATE OF "deviceUuid","meshAddress","gatewayId" ON "MeshNode"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "Fixture_bio_binding_statement_lock" BEFORE UPDATE OF "meshNodeId","gatewayId","siteId" ON "Fixture"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "GatewayCertificate_bio_authority_statement_lock" BEFORE UPDATE OF "status","revokedAt","notBefore","notAfter","gatewayId","inventoryId" ON "GatewayCertificate"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "GatewayInventory_bio_authority_statement_lock" BEFORE UPDATE OF "claimedGatewayId","claimedAt","disabledAt" ON "GatewayInventory"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "Floor_bio_binding_statement_lock" BEFORE UPDATE OF "status","siteId" ON "Floor"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "Organization_bio_policy_statement_lock" BEFORE UPDATE OF "type" ON "Organization"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();

-- Existing deployments gain no implicit approval. Invalidate/disable legacy
-- BIO evidence and schedule serializer-owned convergence without RF/SET writes.
UPDATE "BioSensorCatalogState" SET "revision"="revision"+1 WHERE "id"=1;
COMMIT;
