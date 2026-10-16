BEGIN;
SELECT "lock_automation_membership_mutation"();

-- Recommission snapshots contain JSON wire values and integer counts. Match
-- the CLI's sorted-key canonical JSON, rather than PostgreSQL's spaced output.
CREATE FUNCTION fixture_recommission_canonical_json(value JSONB) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result TEXT;
BEGIN
  IF jsonb_typeof(value)='object' THEN
    SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||fixture_recommission_canonical_json(item),',' ORDER BY key COLLATE "C"),'')||'}'
      INTO result FROM jsonb_each(value) AS entry(key,item);
  ELSIF jsonb_typeof(value)='array' THEN
    SELECT '['||COALESCE(string_agg(fixture_recommission_canonical_json(item),',' ORDER BY ordinal),'')||']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(item,ordinal);
  ELSE result:=value::text;
  END IF;
  RETURN result;
END $$;

CREATE FUNCTION fixture_removal_recommission_job(site_id TEXT,gateway_id TEXT)
RETURNS "GatewayRecommissionJob" LANGUAGE plpgsql AS $$
DECLARE job "GatewayRecommissionJob"; inventory "GatewayInventory"; gateway "Gateway";
  certificate "GatewayCertificate"; recorded JSONB; actual_ids JSONB; recorded_ids JSONB; identity JSONB; name TEXT;
BEGIN
  -- Only this backend's actual locks count. A GUC, another worker's fence or a
  -- job ID string grants no authority. Callers must take membership before rows.
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND granted AND locktype='advisory'
    AND classid=1279607873 AND objid=1296387394 AND objsubid=2 AND mode='ExclusiveLock') THEN RETURN NULL; END IF;
  FOREACH name IN ARRAY ARRAY['GatewayRecommissionJob','GatewayInventory','GatewayCertificate','CertificateRevocationReconciliation',
      'Gateway','Fixture','MeshNode','FixtureRegistrationRemovalOperation','FixtureRegistrationRemovalResultEvidence'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND granted AND locktype='relation'
      AND relation=to_regclass(format('%I',name)) AND mode IN ('ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')) THEN RETURN NULL; END IF;
  END LOOP;
  SELECT * INTO job FROM "GatewayRecommissionJob" WHERE "siteId"=site_id AND "gatewayId"=gateway_id
    AND status='mqtt_revoked' AND "revokedAt" IS NOT NULL AND "appliedAt" IS NULL;
  IF job.id IS NULL OR NOT EXISTS(SELECT 1 FROM "Site" WHERE id=site_id) OR NOT COALESCE(
    job."targetSnapshot"->>'version'='2' AND job."targetSnapshot"->>'siteId'=site_id AND
    job."targetSnapshot"->>'gatewayId'=gateway_id AND job."targetSnapshot"->>'inventoryId'=job."inventoryId" AND
    job."targetSnapshot"->>'serialNumber'=job."serialNumber" AND job."targetSnapshot"->'objectKeys'=job."objectKeys" AND
    job."targetSnapshot"->'deletionIds'->'gateway'=jsonb_build_array(gateway_id) AND
    jsonb_typeof(job."targetSnapshot"->'certificateState')='array' AND
    encode(sha256(convert_to(fixture_recommission_canonical_json(job."targetSnapshot"),'UTF8')),'hex')=job."resetDigest",FALSE) THEN RETURN NULL; END IF;
  SELECT * INTO gateway FROM "Gateway" WHERE id=gateway_id AND "siteId"=site_id AND "serialNumber"=job."serialNumber";
  SELECT * INTO inventory FROM "GatewayInventory" WHERE id=job."inventoryId" AND "claimedGatewayId"=gateway_id
    AND "serialNumber"=job."serialNumber" AND "disabledAt" IS NULL;
  IF gateway.id IS NULL OR inventory.id IS NULL OR (SELECT count(*) FROM "Gateway" WHERE "siteId"=site_id)<>1 OR
    job."targetSnapshot"->>'trustPointersDigest' IS DISTINCT FROM encode(sha256(convert_to(
      fixture_recommission_canonical_json(jsonb_build_array(inventory."certificateFingerprint",gateway."certificateFingerprint")),'UTF8')),'hex') THEN RETURN NULL; END IF;
  SELECT COALESCE(jsonb_agg(id ORDER BY id COLLATE "C"),'[]') INTO actual_ids FROM "GatewayCertificate" WHERE "inventoryId"=inventory.id;
  SELECT COALESCE(jsonb_agg(item->>'id' ORDER BY (item->>'id') COLLATE "C"),'[]') INTO recorded_ids
    FROM jsonb_array_elements(job."targetSnapshot"->'certificateState') AS entry(item);
  IF actual_ids IS DISTINCT FROM recorded_ids THEN RETURN NULL; END IF;
  FOR certificate IN SELECT * FROM "GatewayCertificate" WHERE "inventoryId"=inventory.id LOOP
    SELECT item INTO recorded FROM jsonb_array_elements(job."targetSnapshot"->'certificateState') AS entry(item) WHERE item->>'id'=certificate.id;
    identity:=jsonb_build_object('id',certificate.id,'inventoryId',certificate."inventoryId",'gatewayId',certificate."gatewayId",
      'fingerprint',certificate.fingerprint,'certificateSerial',certificate."certificateSerial",'issuer',certificate.issuer,
      'notBefore',to_char(certificate."notBefore",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'notAfter',to_char(certificate."notAfter",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'replacedById',certificate."replacedById");
    IF recorded->>'purpose' IS DISTINCT FROM certificate.purpose::text OR recorded->>'identityDigest' IS DISTINCT FROM
      encode(sha256(convert_to(fixture_recommission_canonical_json(identity),'UTF8')),'hex') THEN RETURN NULL; END IF;
    IF certificate.purpose='mqtt' THEN
      IF certificate.status<>'revoked' OR certificate."revokedAt" IS NULL OR NOT EXISTS(
        SELECT 1 FROM "CertificateRevocationReconciliation" obligation WHERE obligation."inventoryId"=inventory.id
          AND obligation."certificateId"=certificate.id AND obligation.fingerprint=certificate.fingerprint
          AND obligation.issuer=certificate.issuer AND obligation."certificateSerial"=certificate."certificateSerial"
          AND obligation.purpose='mqtt' AND obligation."completedAt" IS NOT NULL AND obligation."revokedAt" IS NOT NULL
          AND obligation."cancelledAt" IS NULL) THEN RETURN NULL; END IF;
    END IF;
    IF certificate.purpose<>'mqtt' OR recorded->>'status'='revoked' THEN
      IF recorded->>'status' IS DISTINCT FROM certificate.status::text OR recorded->>'revokedAt' IS DISTINCT FROM
        to_char(certificate."revokedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN RETURN NULL; END IF;
    END IF;
  END LOOP;
  RETURN job;
END $$;

CREATE FUNCTION fixture_removal_recommission_allows(site_id TEXT,gateway_id TEXT,table_name TEXT,row_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE job "GatewayRecommissionJob";
BEGIN
  job:=fixture_removal_recommission_job(site_id,gateway_id);
  IF job.id IS NULL THEN RETURN FALSE; END IF;
  IF table_name='Fixture' THEN RETURN COALESCE(job."targetSnapshot"->'deletionIds'->'fixture' ? row_id,FALSE);
  ELSIF table_name='MeshNode' THEN RETURN COALESCE(job."targetSnapshot"->'deletionIds'->'meshNode' ? row_id,FALSE);
  ELSIF table_name IN ('FixtureRegistrationRemovalOperation','FixtureRegistrationRemovalResultEvidence') THEN
    RETURN COALESCE(job."targetSnapshot"->'children'->table_name ? jsonb_build_array(row_id)::text,FALSE);
  END IF;
  RETURN FALSE;
END $$;

CREATE FUNCTION cleanup_fixture_removals_for_recommission(job_id TEXT,reset_digest TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE expected "GatewayRecommissionJob"; job "GatewayRecommissionJob"; actual JSONB;
BEGIN
  SELECT * INTO expected FROM "GatewayRecommissionJob" WHERE id=job_id;
  job:=fixture_removal_recommission_job(expected."siteId",expected."gatewayId");
  IF job.id IS DISTINCT FROM job_id OR job."resetDigest" IS DISTINCT FROM reset_digest THEN
    RAISE EXCEPTION 'exact revoked recommission job and table fences required' USING ERRCODE='23514';
  END IF;
  -- Exact sets are checked before the first delete. Individual DELETE guards
  -- continue checking the same immutable prepared IDs during partial cleanup.
  SELECT COALESCE(jsonb_agg(id ORDER BY id COLLATE "C"),'[]') INTO actual FROM "Fixture" WHERE "siteId"=job."siteId";
  IF actual IS DISTINCT FROM job."targetSnapshot"->'deletionIds'->'fixture' THEN RAISE EXCEPTION 'recommission fixture snapshot changed' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(jsonb_agg(id ORDER BY id COLLATE "C"),'[]') INTO actual FROM "MeshNode" WHERE "gatewayId"=job."gatewayId";
  IF actual IS DISTINCT FROM job."targetSnapshot"->'deletionIds'->'meshNode' THEN RAISE EXCEPTION 'recommission node snapshot changed' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY value COLLATE "C"),'[]') INTO actual FROM
    (SELECT jsonb_build_array("operationId")::text AS value FROM "FixtureRegistrationRemovalOperation" WHERE "siteId"=job."siteId") rows;
  IF actual IS DISTINCT FROM COALESCE(job."targetSnapshot"->'children'->'FixtureRegistrationRemovalOperation','[]'::jsonb) THEN RAISE EXCEPTION 'recommission removal snapshot changed' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY value COLLATE "C"),'[]') INTO actual FROM
    (SELECT jsonb_build_array("eventId")::text AS value FROM "FixtureRegistrationRemovalResultEvidence" WHERE "siteId"=job."siteId") rows;
  IF actual IS DISTINCT FROM COALESCE(job."targetSnapshot"->'children'->'FixtureRegistrationRemovalResultEvidence','[]'::jsonb) THEN RAISE EXCEPTION 'recommission evidence snapshot changed' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM "FixtureRegistrationRemovalOperation" WHERE "siteId"=job."siteId" AND "gatewayId"<>job."gatewayId") THEN
    RAISE EXCEPTION 'recommission removal gateway mismatch' USING ERRCODE='23514';
  END IF;
  DELETE FROM "FixtureRegistrationRemovalResultEvidence" WHERE "siteId"=job."siteId";
  DELETE FROM "FixtureRegistrationRemovalOperation" WHERE "siteId"=job."siteId" AND "gatewayId"=job."gatewayId";
END $$;

CREATE OR REPLACE FUNCTION guard_fixture_registration_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE site_id TEXT; gateway_id TEXT; row_id TEXT; has_operation BOOLEAN;
BEGIN
  IF TG_TABLE_NAME='FixtureRegistrationRemovalOperation' THEN
    site_id:=OLD."siteId"; gateway_id:=OLD."gatewayId"; row_id:=OLD."operationId"; has_operation:=true;
  ELSIF TG_TABLE_NAME='FixtureRegistrationRemovalResultEvidence' THEN
    site_id:=OLD."siteId"; gateway_id:=OLD.terminal->>'gatewayId'; row_id:=OLD."eventId"; has_operation:=true;
  ELSIF TG_TABLE_NAME='Fixture' THEN
    site_id:=OLD."siteId"; gateway_id:=OLD."gatewayId"; row_id:=OLD.id;
    SELECT EXISTS(SELECT 1 FROM "FixtureRegistrationRemovalOperation" WHERE "fixtureId"=OLD.id) INTO has_operation;
  ELSE
    gateway_id:=OLD."gatewayId"; row_id:=OLD.id;
    SELECT "siteId" INTO site_id FROM "FixtureRegistrationRemovalOperation" WHERE "meshNodeId"=OLD.id LIMIT 1;
    has_operation:=FOUND;
    IF site_id IS NULL THEN SELECT "siteId" INTO site_id FROM "Gateway" WHERE id=gateway_id; END IF;
  END IF;
  IF site_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Site" WHERE id=site_id) THEN RETURN OLD; END IF;
  IF fixture_removal_recommission_allows(site_id,gateway_id,TG_TABLE_NAME,row_id) THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME IN ('FixtureRegistrationRemovalOperation','FixtureRegistrationRemovalResultEvidence') THEN
    RAISE EXCEPTION 'registration removal evidence cannot be deleted' USING ERRCODE='23514';
  ELSIF OLD."retiredAt" IS NOT NULL OR has_operation THEN
    RAISE EXCEPTION 'retained registration cannot be physically deleted' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;

-- Preserve the existing append/identity/result checks verbatim. Only DELETE
-- uses the shared Site-or-exact-recommission boundary introduced above.
DROP TRIGGER "FixtureRegistrationRemovalResultEvidence_guard" ON "FixtureRegistrationRemovalResultEvidence";
CREATE TRIGGER "FixtureRegistrationRemovalResultEvidence_guard" BEFORE INSERT OR UPDATE ON "FixtureRegistrationRemovalResultEvidence"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_removal_result_evidence();
CREATE TRIGGER "FixtureRegistrationRemovalResultEvidence_delete_guard" BEFORE DELETE ON "FixtureRegistrationRemovalResultEvidence"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_delete();
COMMIT;
