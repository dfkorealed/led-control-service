BEGIN;
SELECT "lock_automation_membership_mutation"();
CREATE TABLE "FixtureRegistrationRemovalCleanupRecovery" (
  "operationId" TEXT PRIMARY KEY REFERENCES "FixtureRegistrationRemovalOperation"("operationId") ON DELETE CASCADE ON UPDATE CASCADE,
  "siteId" TEXT NOT NULL, "beforeSnapshot" JSONB NOT NULL, "rollbackSnapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

-- Used only for the integer/string/boolean JSON domains of these snapshots,
-- catalog deliveries and receipts; keys are ASCII contract fields.
CREATE FUNCTION fixture_removal_canonical_json(value JSONB) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result TEXT;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||fixture_removal_canonical_json(v),',' ORDER BY key COLLATE "C"),'')||'}'
      INTO result FROM jsonb_each(value) entry(key,v);
    WHEN 'array' THEN SELECT '['||COALESCE(string_agg(fixture_removal_canonical_json(v),',' ORDER BY ordinal),'')||']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY entry(v,ordinal);
    ELSE result:=value::text;
  END CASE;
  RETURN result;
END $$;
CREATE FUNCTION fixture_removal_json_hash(value JSONB) RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT AS $$
  SELECT 'sha256:'||encode(sha256(convert_to(fixture_removal_canonical_json(value),'UTF8')),'hex')
$$;
CREATE FUNCTION fixture_removal_desired_members(group_id TEXT) RETURNS JSONB LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('meshNodeId',member."meshNodeId",'meshAddress',lower(node."meshAddress"))
    ORDER BY member."meshNodeId" COLLATE "C"),'[]'::jsonb)
  FROM "MeshControlGroupMember" member JOIN "MeshNode" node ON node.id=member."meshNodeId"
  WHERE member."groupId"=group_id AND member.desired
$$;

CREATE FUNCTION guard_fixture_removal_cleanup_recovery() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE op "FixtureRegistrationRemovalOperation"; catalog "BioSensorCatalogDelivery"; expected JSONB; groups JSONB; item JSONB; cleanup JSONB;
BEGIN
  -- Parent operation DELETE remains independently protected, including the
  -- separately authorized recommission boundary. This permits its FK cascade,
  -- never a direct deletion while the immutable parent still exists.
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM "FixtureRegistrationRemovalOperation" WHERE "operationId"=OLD."operationId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'removal cleanup recovery cannot be deleted' USING ERRCODE='23514';
  END IF;
  SELECT * INTO op FROM "FixtureRegistrationRemovalOperation" WHERE "operationId"=NEW."operationId" FOR UPDATE;
  SELECT * INTO catalog FROM "BioSensorCatalogDelivery" WHERE "siteId"=op."siteId" AND "gatewayId"=op."gatewayId"
    AND "assignmentVersion"=op."assignmentVersion" AND "catalogRevision"=(SELECT revision FROM "BioSensorCatalogState" WHERE id=1);
  IF op."operationId" IS NULL OR NEW."siteId"<>op."siteId" OR catalog."deliveryId" IS NULL OR
    fixture_removal_json_hash(catalog.payload)<>catalog."payloadHash" THEN
    RAISE EXCEPTION 'removal recovery scope/catalog mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',g.id,'configurationVersion',g."configurationVersion",'desired',m.desired,
      'desiredMembers',fixture_removal_desired_members(g.id),'desiredHash',fixture_removal_json_hash(fixture_removal_desired_members(g.id))) ORDER BY g.id COLLATE "C"),'[]'::jsonb)
      INTO groups FROM "MeshControlGroupMember" m JOIN "MeshControlGroup" g ON g.id=m."groupId"
      WHERE m."meshNodeId"=op."meshNodeId" AND m."gatewayId"=op."gatewayId";
    expected:=jsonb_build_object('catalog',catalog.payload-ARRAY['schemaVersion','siteId','gatewayId','assignmentVersion','eventId','catalogRevision','issuedAt'],'groups',groups);
    IF op.status<>'pending' OR op."cleanupSnapshot" IS NOT NULL OR NEW."rollbackSnapshot" IS NOT NULL OR NEW."beforeSnapshot" IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'cleanup before image must match exact current desired state' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-'rollbackSnapshot') IS DISTINCT FROM (to_jsonb(OLD)-'rollbackSnapshot') OR OLD."rollbackSnapshot" IS NOT NULL OR
      NEW."rollbackSnapshot" IS NULL OR op.status<>'reconcile_required' OR op.result->>'status' IS DISTINCT FROM 'rejected' OR
      op."cleanupSnapshot" IS NULL THEN
      RAISE EXCEPTION 'rollback is write once and requires definitive rejected evidence' USING ERRCODE='23514';
    END IF;
    cleanup:=op."cleanupSnapshot";
    IF catalog."catalogRevision"<>(cleanup->'catalog'->>'revision')::bigint+1 OR
      (catalog.payload-ARRAY['schemaVersion','siteId','gatewayId','assignmentVersion','eventId','catalogRevision','issuedAt']) IS DISTINCT FROM NEW."beforeSnapshot"->'catalog' THEN
      RAISE EXCEPTION 'rollback catalog must restore original content at the next revision' USING ERRCODE='23514';
    END IF;
    groups:='[]'::jsonb;
    FOR item IN SELECT value FROM jsonb_array_elements(NEW."beforeSnapshot"->'groups') LOOP
      IF NOT EXISTS(SELECT 1 FROM "MeshControlGroup" g WHERE g.id=item->>'id' AND g."gatewayId"=op."gatewayId"
        AND g."configurationVersion"=(item->>'configurationVersion')::int+1 AND EXISTS(
          SELECT 1 FROM jsonb_array_elements(cleanup->'groups') pinned WHERE pinned->>'id'=g.id
            AND (pinned->>'configurationVersion')::int=g."configurationVersion"
            AND pinned->>'desiredHash'=fixture_removal_json_hash(fixture_removal_desired_members(g.id)))) THEN
        RAISE EXCEPTION 'cleanup membership/version drift prevents rollback' USING ERRCODE='23514';
      END IF;
      groups:=groups||jsonb_build_array(jsonb_build_object('id',item->>'id','configurationVersion',(item->>'configurationVersion')::int+2,'desiredHash',item->>'desiredHash'));
    END LOOP;
    expected:=jsonb_build_object('catalog',jsonb_build_object('assignmentVersion',op."assignmentVersion",'revision',catalog."catalogRevision",'payloadHash',catalog."payloadHash"),'groups',groups);
    IF NEW."rollbackSnapshot" IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'rollback target snapshot mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "FixtureRegistrationRemovalCleanupRecovery_lock" BEFORE INSERT OR UPDATE OR DELETE ON "FixtureRegistrationRemovalCleanupRecovery"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "FixtureRegistrationRemovalCleanupRecovery_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FixtureRegistrationRemovalCleanupRecovery"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_removal_cleanup_recovery();

CREATE FUNCTION fixture_removal_allows_group_restore(fixture_id TEXT,group_id TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM "FixtureRegistrationRemovalOperation" op JOIN "FixtureRegistrationRemovalCleanupRecovery" recovery USING ("operationId")
    JOIN "MeshControlGroup" g ON g.id=group_id AND g."gatewayId"=op."gatewayId"
    WHERE op."fixtureId"=fixture_id AND op.status='reconcile_required' AND op.result->>'status'='rejected'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery."beforeSnapshot"->'groups') original
        WHERE original->>'id'=group_id AND original->'desired'='true'::jsonb)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery."rollbackSnapshot"->'groups') pinned
        WHERE pinned->>'id'=group_id AND (pinned->>'configurationVersion')::int=g."configurationVersion"))
$$;
CREATE OR REPLACE FUNCTION guard_fixture_registration_new_work() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE fixture_id TEXT; value JSONB;
BEGIN
  value:=to_jsonb(NEW);
  IF TG_TABLE_NAME='MeshControlGroupMember' THEN
    IF NOT NEW.desired THEN RETURN NEW; END IF;
    SELECT id INTO fixture_id FROM "Fixture" WHERE "meshNodeId"=NEW."meshNodeId";
    IF fixture_removal_allows_group_restore(fixture_id,NEW."groupId") THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='FloorLightSlot' THEN fixture_id:=NEW."assignedFixtureId";
  ELSE fixture_id:=value->>'fixtureId'; END IF;
  IF fixture_id IS NOT NULL THEN PERFORM assert_fixture_registration_active(fixture_id); END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION fixture_removal_rollback_desired_matches(operation_id TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(recovery."rollbackSnapshot" IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(recovery."beforeSnapshot"->'groups') original
    LEFT JOIN "MeshControlGroup" g ON g.id=original->>'id'
    WHERE g.id IS NULL OR g."gatewayId"<>op."gatewayId" OR g."configurationVersion"<>(original->>'configurationVersion')::int+2
      OR fixture_removal_desired_members(g.id) IS DISTINCT FROM original->'desiredMembers'),FALSE)
  FROM "FixtureRegistrationRemovalOperation" op JOIN "FixtureRegistrationRemovalCleanupRecovery" recovery USING ("operationId") WHERE op."operationId"=operation_id
$$;
CREATE FUNCTION enforce_fixture_removal_rollback_staging() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM "FixtureRegistrationRemovalOperation" WHERE "operationId"=NEW."operationId") AND NEW."rollbackSnapshot" IS NOT NULL
    AND NOT COALESCE(fixture_removal_rollback_desired_matches(NEW."operationId"),FALSE) THEN
    RAISE EXCEPTION 'rollback snapshot and original desired memberships must commit atomically' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "FixtureRegistrationRemovalCleanupRecovery_staging" AFTER UPDATE ON "FixtureRegistrationRemovalCleanupRecovery"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_fixture_removal_rollback_staging();

CREATE FUNCTION guard_fixture_removal_rejected_closure() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE recovery "FixtureRegistrationRemovalCleanupRecovery"; catalog "BioSensorCatalogDelivery"; item JSONB; expected JSONB; members JSONB;
BEGIN
  IF NEW.status<>'rejected' OR OLD.status='rejected' OR NEW."cleanupSnapshot" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO recovery FROM "FixtureRegistrationRemovalCleanupRecovery" WHERE "operationId"=NEW."operationId";
  IF NEW.result->>'status' IS DISTINCT FROM 'rejected' OR NOT COALESCE(fixture_removal_rollback_desired_matches(NEW."operationId"),FALSE) THEN
    RAISE EXCEPTION 'rejected cleanup requires original desired rollback and exact ACKs' USING ERRCODE='23514';
  END IF;
  item:=recovery."rollbackSnapshot"->'catalog';
  SELECT * INTO catalog FROM "BioSensorCatalogDelivery" WHERE "siteId"=NEW."siteId" AND "gatewayId"=NEW."gatewayId"
    AND "assignmentVersion"=NEW."assignmentVersion" AND "catalogRevision"=(item->>'revision')::bigint;
  expected:=jsonb_build_object('schemaVersion',1,'siteId',NEW."siteId",'gatewayId',NEW."gatewayId",'assignmentVersion',NEW."assignmentVersion",
    'eventId',catalog."deliveryId",'catalogRevision',catalog."catalogRevision",'deliveryPayloadHash',catalog."payloadHash");
  IF NOT COALESCE(catalog."catalogRevision"=(SELECT revision FROM "BioSensorCatalogState" WHERE id=1) AND catalog."supersededAt" IS NULL
    AND catalog."appliedAt" IS NOT NULL AND catalog.status IN ('applied','duplicate') AND catalog."payloadHash"=item->>'payloadHash'
    AND fixture_removal_json_hash(catalog.payload)=catalog."payloadHash" AND fixture_removal_json_hash(catalog."ackPayload")=catalog."ackHash"
    AND (catalog."ackPayload"-ARRAY['status','occurredAt'])=expected AND catalog."ackPayload"->>'status' IN ('applied','duplicate')
    AND catalog."ackPayload"->>'occurredAt' IS NOT NULL,FALSE) THEN
    RAISE EXCEPTION 'rollback catalog exact ACK missing' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(recovery."beforeSnapshot"->'groups') LOOP
    SELECT COALESCE(jsonb_agg(jsonb_build_object('meshNodeId',"meshNodeId",'meshAddress',"meshAddress") ORDER BY "meshNodeId" COLLATE "C","meshAddress" COLLATE "C"),'[]'::jsonb)
      INTO members FROM "MeshControlGroupAppliedMember" WHERE "groupId"=item->>'id';
    IF members IS DISTINCT FROM item->'desiredMembers' OR NOT EXISTS(SELECT 1 FROM "MeshControlGroup" g WHERE g.id=item->>'id'
      AND g.status='ready' AND g."operationPlanVersion"=g."configurationVersion" AND NOT EXISTS(
        SELECT 1 FROM "MeshControlGroupExpectedOperation" work WHERE work."groupId"=g.id AND work."configurationVersion"=g."configurationVersion" AND work.status<>'applied')) THEN
      RAISE EXCEPTION 'rollback group exact ACK missing' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER "FixtureRegistrationRemovalOperation_rollback_closure" BEFORE UPDATE OF status ON "FixtureRegistrationRemovalOperation"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_removal_rejected_closure();
COMMIT;
