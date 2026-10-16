BEGIN;
SELECT "lock_automation_membership_mutation"();
ALTER TABLE "Fixture" ADD COLUMN "retiredAt" TIMESTAMP(3);
ALTER TABLE "MeshNode" ADD COLUMN "retiredAt" TIMESTAMP(3);
ALTER TABLE "Gateway" ADD COLUMN "fixtureRegistrationRemovalVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "Gateway_fixture_registration_removal_version_check" CHECK ("fixtureRegistrationRemovalVersion" IN (0,1));

CREATE TABLE "FixtureRegistrationRemovalOperation" (
  "operationId" TEXT PRIMARY KEY, "siteId" TEXT NOT NULL, "floorId" TEXT NOT NULL, "fixtureId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL, "gatewaySerial" TEXT NOT NULL, "assignmentVersion" INTEGER NOT NULL,
  "nodeId" TEXT NOT NULL, "meshNodeId" TEXT NOT NULL, "deviceUuid" TEXT NOT NULL, "meshAddress" TEXT NOT NULL,
  "originalProvisionCommandId" TEXT NOT NULL, "fixtureName" TEXT NOT NULL, "serialNumber" TEXT,
  "requestedById" TEXT NOT NULL, "clientRequestId" TEXT NOT NULL, "expectedUpdatedAt" TIMESTAMP(3) NOT NULL,
  "requestHash" TEXT NOT NULL, "bindingSnapshot" JSONB NOT NULL, "bindingHash" TEXT NOT NULL, "cleanupSnapshot" JSONB,
  "payload" JSONB NOT NULL, "commandHash" TEXT NOT NULL, "requestedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "errorCode" TEXT, "result" JSONB, "resultHash" TEXT, "resultEventId" TEXT,
  "gatewayConfirmedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "applicationAck" JSONB, "applicationAckHash" TEXT,
  "ackPublishedAt" TIMESTAMP(3), "ackAttempts" INTEGER NOT NULL DEFAULT 0,
  "ackNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "ackLockedBy" TEXT, "ackLeaseExpiresAt" TIMESTAMP(3), "publishedAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "lockedBy" TEXT, "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FixtureRegistrationRemovalOperation_fixture_fkey" FOREIGN KEY ("fixtureId","siteId")
    REFERENCES "Fixture"("id","siteId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "FixtureRegistrationRemovalOperation_node_fkey" FOREIGN KEY ("meshNodeId","gatewayId")
    REFERENCES "MeshNode"("id","gatewayId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "FixtureRegistrationRemovalOperation_contract_check" CHECK (
    "status" IN ('pending','gateway_confirmed','completed','rejected','reconcile_required') AND "assignmentVersion">0 AND
    "attempts">=0 AND "ackAttempts">=0 AND "deviceUuid" ~ '^bio:[0-9a-f]{12}$' AND
    "meshAddress" ~ '^0x[0-7][0-9a-f]{3}$' AND "meshAddress"<>'0x0000' AND
    "requestHash" ~ '^sha256:[0-9a-f]{64}$' AND "bindingHash" ~ '^sha256:[0-9a-f]{64}$' AND "commandHash" ~ '^sha256:[0-9a-f]{64}$' AND
    "expiresAt">"requestedAt" AND "expiresAt"<="requestedAt"+INTERVAL '30 seconds' AND
    ("errorCode" IS NULL OR "errorCode" ~ '^[A-Z][A-Z0-9_]{0,127}$') AND
    (("lockedBy" IS NULL)=("leaseExpiresAt" IS NULL)) AND (("ackLockedBy" IS NULL)=("ackLeaseExpiresAt" IS NULL)) AND
    (("status"='completed')=("completedAt" IS NOT NULL)) AND
    ("completedAt" IS NULL OR "completedAt">="gatewayConfirmedAt") AND
    ("status" NOT IN ('gateway_confirmed','completed') OR COALESCE("result"->>'status'='removed' AND "gatewayConfirmedAt" IS NOT NULL,FALSE)) AND
    ("status" NOT IN ('rejected','reconcile_required') OR "errorCode" IS NOT NULL) AND
    ("status" NOT IN ('pending','gateway_confirmed','completed') OR "errorCode" IS NULL) AND
    (("result" IS NULL AND "resultHash" IS NULL AND "resultEventId" IS NULL) OR
      ("result" IS NOT NULL AND "resultHash" IS NOT NULL AND "resultEventId" IS NOT NULL AND "resultHash" ~ '^sha256:[0-9a-f]{64}$')) AND
    (("applicationAck" IS NULL AND "applicationAckHash" IS NULL AND "ackPublishedAt" IS NULL AND "ackLockedBy" IS NULL) OR
      ("applicationAck" IS NOT NULL AND "applicationAckHash" IS NOT NULL AND "applicationAckHash" ~ '^sha256:[0-9a-f]{64}$' AND "result" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "FixtureRegistrationRemovalOperation_request_key" ON "FixtureRegistrationRemovalOperation"("siteId","requestedById","clientRequestId");
CREATE UNIQUE INDEX "FixtureRegistrationRemovalOperation_resultEventId_key" ON "FixtureRegistrationRemovalOperation"("resultEventId");
CREATE UNIQUE INDEX "FixtureRegistrationRemovalOperation_active_fixture_key" ON "FixtureRegistrationRemovalOperation"("fixtureId")
  WHERE "status" IN ('pending','gateway_confirmed','reconcile_required');
CREATE INDEX "FixtureRegistrationRemovalOperation_publish_idx" ON "FixtureRegistrationRemovalOperation"("status","nextAttemptAt","leaseExpiresAt");
CREATE INDEX "FixtureRegistrationRemovalOperation_ack_idx" ON "FixtureRegistrationRemovalOperation"("ackPublishedAt","ackNextAttemptAt","ackLeaseExpiresAt");
CREATE INDEX "FixtureRegistrationRemovalOperation_fixtureId_status_idx" ON "FixtureRegistrationRemovalOperation"("fixtureId","status");

-- Every producer takes the pre-existing membership serializer BEFORE row locks.
-- A caller using row locks itself must take it first as well (API policy helper).
CREATE FUNCTION assert_fixture_registration_active(fixture_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "lock_automation_membership_mutation"();
  IF NOT EXISTS(SELECT 1 FROM "Fixture" f LEFT JOIN "MeshNode" n ON n.id=f."meshNodeId"
      WHERE f.id=fixture_id AND f."retiredAt" IS NULL AND (n.id IS NULL OR n."retiredAt" IS NULL)) OR
    EXISTS(SELECT 1 FROM "FixtureRegistrationRemovalOperation" WHERE "fixtureId"=fixture_id
      AND status IN ('pending','gateway_confirmed','reconcile_required')) THEN
    RAISE EXCEPTION 'fixture registration is retired, removing or unavailable' USING ERRCODE='23514';
  END IF;
END $$;

CREATE FUNCTION guard_fixture_registration_removal_operation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE expected_binding JSONB; expected_payload JSONB; mutable_fields TEXT[]; cleanup JSONB; item JSONB;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'registration removal evidence cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM assert_fixture_registration_active(NEW."fixtureId");
    IF NEW.status<>'pending' OR NEW.result IS NOT NULL OR NEW."applicationAck" IS NOT NULL OR
      NOT EXISTS(SELECT 1 FROM "Fixture" f JOIN "MeshNode" n ON n.id=f."meshNodeId" JOIN "Gateway" g ON g.id=n."gatewayId"
        WHERE f.id=NEW."fixtureId" AND f."siteId"=NEW."siteId" AND f."floorId"=NEW."floorId" AND f."updatedAt"=NEW."expectedUpdatedAt"
          AND n.id=NEW."meshNodeId" AND n."deviceUuid"=NEW."deviceUuid" AND n."meshAddress"=NEW."meshAddress" AND n."vehicleSensorProtocol"='bio_usb_pulse'
          AND g.id=NEW."gatewayId" AND g."siteId"=NEW."siteId" AND g."serialNumber"=NEW."gatewaySerial"
          AND g."assignmentVersion"=NEW."assignmentVersion" AND g."fixtureRegistrationRemovalVersion"=1) OR
      EXISTS(SELECT 1 FROM "GroupFixture" WHERE "fixtureId"=NEW."fixtureId") OR
      EXISTS(SELECT 1 FROM "LightingScheduleFixture" WHERE "fixtureId"=NEW."fixtureId") OR
      EXISTS(SELECT 1 FROM "VehicleEventSource" WHERE "fixtureId"=NEW."fixtureId") OR
      EXISTS(SELECT 1 FROM "VehicleEventTarget" WHERE "fixtureId"=NEW."fixtureId") OR
      EXISTS(SELECT 1 FROM "TemporaryControlLease" WHERE "fixtureId"=NEW."fixtureId" AND "ownerSessionId" IS NOT NULL) THEN
      RAISE EXCEPTION 'removal requires supported exact live unreferenced registration' USING ERRCODE='23514';
    END IF;
  ELSE
    mutable_fields:=ARRAY['status','errorCode','result','resultHash','resultEventId','gatewayConfirmedAt','completedAt','cleanupSnapshot',
      'applicationAck','applicationAckHash','ackPublishedAt','ackAttempts','ackNextAttemptAt','ackLockedBy','ackLeaseExpiresAt',
      'publishedAt','attempts','nextAttemptAt','lockedBy','leaseExpiresAt','updatedAt'];
    IF (to_jsonb(NEW)-mutable_fields) IS DISTINCT FROM (to_jsonb(OLD)-mutable_fields) OR
      (OLD.result IS NOT NULL AND ROW(NEW.result,NEW."resultHash",NEW."resultEventId") IS DISTINCT FROM ROW(OLD.result,OLD."resultHash",OLD."resultEventId")) OR
      (OLD."gatewayConfirmedAt" IS NOT NULL AND NEW."gatewayConfirmedAt" IS DISTINCT FROM OLD."gatewayConfirmedAt") OR
      (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt") OR
      (OLD."cleanupSnapshot" IS NOT NULL AND NEW."cleanupSnapshot" IS DISTINCT FROM OLD."cleanupSnapshot") OR
      (OLD."applicationAck" IS NOT NULL AND ROW(NEW."applicationAck",NEW."applicationAckHash") IS DISTINCT FROM ROW(OLD."applicationAck",OLD."applicationAckHash")) OR
      (NEW.status<>OLD.status AND NOT (
        (OLD.status='pending' AND NEW.status IN ('gateway_confirmed','rejected','reconcile_required')) OR
        (OLD.status='gateway_confirmed' AND NEW.status IN ('completed','reconcile_required')) OR
        (OLD.status='reconcile_required' AND NEW.status IN ('gateway_confirmed','rejected')))) THEN
      RAISE EXCEPTION 'immutable removal identity, evidence or invalid transition' USING ERRCODE='23514';
    END IF;
  END IF;
  expected_binding:=jsonb_build_object('version',1,'siteId',NEW."siteId",'fixtureId',NEW."fixtureId",'gatewayId',NEW."gatewayId",
    'gatewaySerial',NEW."gatewaySerial",'assignmentVersion',NEW."assignmentVersion",'nodeId',NEW."nodeId",'deviceUuid',NEW."deviceUuid",
    'meshAddress',NEW."meshAddress",'originalProvisionCommandId',NEW."originalProvisionCommandId");
  expected_payload:=expected_binding||jsonb_build_object('operationId',NEW."operationId",'bindingHash',NEW."bindingHash");
  IF NEW."bindingSnapshot" IS DISTINCT FROM expected_binding OR
    (NEW.payload-ARRAY['requestedAt','expiresAt']) IS DISTINCT FROM expected_payload OR NOT COALESCE(
      (NEW.payload->>'requestedAt')::timestamptz AT TIME ZONE 'UTC'=NEW."requestedAt" AND
      (NEW.payload->>'expiresAt')::timestamptz AT TIME ZONE 'UTC'=NEW."expiresAt",FALSE) THEN
    RAISE EXCEPTION 'removal snapshot/payload mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.status='pending' AND (NEW.result IS NOT NULL OR NEW."gatewayConfirmedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'pending removal cannot hold terminal evidence' USING ERRCODE='23514';
  END IF;
  IF NEW."gatewayConfirmedAt" IS NOT NULL AND (NEW.result->>'status' IS DISTINCT FROM 'removed' OR
      NEW.status NOT IN ('gateway_confirmed','completed','reconcile_required')) THEN
    RAISE EXCEPTION 'gateway confirmation requires removed terminal' USING ERRCODE='23514';
  END IF;
  cleanup:=NEW."cleanupSnapshot";
  IF cleanup IS NOT NULL THEN
    IF jsonb_typeof(cleanup) IS DISTINCT FROM 'object' OR (cleanup-ARRAY['catalog','groups'])<>'{}'::jsonb OR
      NOT cleanup ? 'catalog' OR jsonb_typeof(cleanup->'groups') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'invalid cleanup snapshot shape' USING ERRCODE='23514';
    END IF;
    item:=cleanup->'catalog';
    IF item<>'null'::jsonb AND NOT COALESCE(jsonb_typeof(item)='object' AND
      (item-ARRAY['assignmentVersion','revision','payloadHash'])='{}'::jsonb AND
      item->'assignmentVersion'=to_jsonb(NEW."assignmentVersion") AND jsonb_typeof(item->'revision')='number' AND
      item->>'revision' ~ '^[1-9][0-9]*$' AND (item->>'revision')::numeric<=9007199254740991 AND
      item->>'payloadHash' ~ '^sha256:[0-9a-f]{64}$',FALSE) THEN
      RAISE EXCEPTION 'invalid cleanup catalog identity' USING ERRCODE='23514';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(cleanup->'groups') LOOP
      IF NOT COALESCE(jsonb_typeof(item)='object' AND (item-ARRAY['id','configurationVersion','desiredHash'])='{}'::jsonb AND
        item->>'id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' AND
        jsonb_typeof(item->'configurationVersion')='number' AND item->>'configurationVersion' ~ '^[1-9][0-9]*$' AND
        (item->>'configurationVersion')::numeric<=2147483647 AND item->>'desiredHash' ~ '^sha256:[0-9a-f]{64}$',FALSE) THEN
        RAISE EXCEPTION 'invalid cleanup group identity' USING ERRCODE='23514';
      END IF;
    END LOOP;
    IF (SELECT count(*)<>count(DISTINCT value->>'id') FROM jsonb_array_elements(cleanup->'groups')) THEN
      RAISE EXCEPTION 'duplicate cleanup group identity' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.result IS NOT NULL AND NOT COALESCE(
    (NEW.result-ARRAY['eventId','commandHash','occurredAt','status','errorCode'])=NEW.payload AND
    NEW.result->>'eventId'=NEW."resultEventId" AND NEW.result->>'commandHash'=NEW."commandHash" AND
    (NEW.result->>'occurredAt')::timestamptz AT TIME ZONE 'UTC'>=NEW."requestedAt" AND
    NEW.result->>'status' IN ('removed','rejected','reconcile_required') AND
    ((NEW.result->>'status'='removed' AND NEW.result->'errorCode'='null'::jsonb) OR
      (NEW.result->>'status'<>'removed' AND NEW.result->>'errorCode' ~ '^[A-Z][A-Z0-9_]{0,127}$')) AND
    (NEW.status NOT IN ('gateway_confirmed','completed') OR NEW.result->>'status'='removed') AND
    (NEW.status<>'rejected' OR NEW.result->>'status'='rejected'),FALSE) THEN
    RAISE EXCEPTION 'removal terminal identity mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW."applicationAck" IS NOT NULL AND NOT COALESCE(
    (NEW."applicationAck"-ARRAY['commandHash','eventId','resultHash','ingestedAt','status'])=expected_payload AND
    NEW."applicationAck"->>'operationId'=NEW."operationId" AND NEW."applicationAck"->>'eventId'=NEW."resultEventId" AND
    NEW."applicationAck"->>'commandHash'=NEW."commandHash" AND NEW."applicationAck"->>'resultHash'=NEW."resultHash" AND
    NEW."applicationAck"->>'status' IN ('ingested','duplicate') AND NEW."applicationAck"->>'ingestedAt' IS NOT NULL,FALSE) THEN
    RAISE EXCEPTION 'removal application ACK identity mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "FixtureRegistrationRemovalOperation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FixtureRegistrationRemovalOperation"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_removal_operation();

CREATE FUNCTION guard_fixture_registration_retirement() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE original JSONB; replacement JSONB; operation "FixtureRegistrationRemovalOperation"; target_id TEXT;
BEGIN
  original:=to_jsonb(OLD); replacement:=to_jsonb(NEW); target_id:=OLD.id;
  IF TG_TABLE_NAME='Fixture' THEN
    SELECT * INTO operation FROM "FixtureRegistrationRemovalOperation" WHERE "fixtureId"=target_id
      AND status IN ('pending','gateway_confirmed','reconcile_required','completed') ORDER BY "createdAt" DESC LIMIT 1;
  ELSE
    SELECT * INTO operation FROM "FixtureRegistrationRemovalOperation" WHERE "meshNodeId"=target_id
      AND status IN ('pending','gateway_confirmed','reconcile_required','completed') ORDER BY "createdAt" DESC LIMIT 1;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD."retiredAt" IS NOT NULL OR operation."operationId" IS NOT NULL THEN
      RAISE EXCEPTION 'retained registration cannot be physically deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."retiredAt" IS NOT NULL AND (replacement-'updatedAt') IS DISTINCT FROM (original-'updatedAt') THEN
    RAISE EXCEPTION 'retired registration is immutable history' USING ERRCODE='23514';
  END IF;
  IF OLD."retiredAt" IS NULL AND NEW."retiredAt" IS NOT NULL THEN
    IF operation.status IS DISTINCT FROM 'gateway_confirmed' OR operation.result->>'status' IS DISTINCT FROM 'removed' OR
      (TG_TABLE_NAME='MeshNode' AND replacement->>'deviceUuid' IS NOT NULL) THEN
      RAISE EXCEPTION 'retirement requires exact removed terminal and operating UUID release' USING ERRCODE='23514';
    END IF;
    IF (TG_TABLE_NAME='MeshNode' AND (replacement-ARRAY['retiredAt','deviceUuid','updatedAt']) IS DISTINCT FROM
        (original-ARRAY['retiredAt','deviceUuid','updatedAt'])) OR
      (TG_TABLE_NAME='Fixture' AND (replacement-ARRAY['retiredAt','updatedAt','placementStatus','positionVerifiedAt','x','y']) IS DISTINCT FROM
        (original-ARRAY['retiredAt','updatedAt','placementStatus','positionVerifiedAt','x','y'])) THEN
      RAISE EXCEPTION 'retirement cannot rewrite original registration identity' USING ERRCODE='23514';
    END IF;
  ELSIF operation."operationId" IS NOT NULL AND
    ((TG_TABLE_NAME='Fixture' AND (replacement-ARRAY['updatedAt','status','brightness','rssi','hopCount','lastSeenAt','lastUnreachableAt',
        'lastStateEventId','lastStateSequence','lastStateOccurredAt','lastPresenceEventId','lastPresenceSequence','lastPresenceOccurredAt',
        'statusReason','reportedStatus','reportedStatusReason','healthFaultCodes','healthLastSeenAt','powerOn',
        'bioControlMode','bioConfiguredBrightness','bioRawHighBrightness','firstStateOccurredAt','commandSuccessRate']) IS DISTINCT FROM
      (original-ARRAY['updatedAt','status','brightness','rssi','hopCount','lastSeenAt','lastUnreachableAt',
        'lastStateEventId','lastStateSequence','lastStateOccurredAt','lastPresenceEventId','lastPresenceSequence','lastPresenceOccurredAt',
        'statusReason','reportedStatus','reportedStatusReason','healthFaultCodes','healthLastSeenAt','powerOn',
        'bioControlMode','bioConfiguredBrightness','bioRawHighBrightness','firstStateOccurredAt','commandSuccessRate'])) OR
     (TG_TABLE_NAME='MeshNode' AND (replacement->'id',replacement->'gatewayId',replacement->'deviceUuid',replacement->'meshAddress') IS DISTINCT FROM
       (original->'id',original->'gatewayId',original->'deviceUuid',original->'meshAddress'))) THEN
    RAISE EXCEPTION 'removing registration identity is fenced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Fixture_registration_retirement_guard" BEFORE UPDATE OR DELETE ON "Fixture" FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_retirement();
CREATE TRIGGER "MeshNode_registration_retirement_guard" BEFORE UPDATE OR DELETE ON "MeshNode" FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_retirement();

-- Retiring both retained rows, UUID release and operation completion are one
-- deferred commit boundary; no intermediate partial retirement may commit.
CREATE FUNCTION enforce_fixture_registration_retirement_commit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation "FixtureRegistrationRemovalOperation"; target_id TEXT;
BEGIN
  IF TG_TABLE_NAME='FixtureRegistrationRemovalOperation' THEN target_id:=NEW."fixtureId";
  ELSIF TG_TABLE_NAME='Fixture' THEN target_id:=NEW.id;
  ELSE SELECT id INTO target_id FROM "Fixture" WHERE "meshNodeId"=NEW.id; END IF;
  FOR operation IN SELECT * FROM "FixtureRegistrationRemovalOperation" WHERE "fixtureId"=target_id LOOP
    IF EXISTS(SELECT 1 FROM "Fixture" f JOIN "MeshNode" n ON n.id=operation."meshNodeId" WHERE f.id=target_id AND
      ((operation.status='completed' AND (f."retiredAt" IS NULL OR n."retiredAt" IS NULL OR n."deviceUuid" IS NOT NULL)) OR
       (operation.status IN ('pending','gateway_confirmed','reconcile_required') AND (f."retiredAt" IS NOT NULL OR n."retiredAt" IS NOT NULL)))) THEN
      RAISE EXCEPTION 'registration retirement requires atomic completed fixture/node pair' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['FixtureRegistrationRemovalOperation','Fixture','MeshNode'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_fixture_registration_retirement_commit()',name||'_retirement_commit',name);
  END LOOP;
END $$;

CREATE FUNCTION guard_fixture_registration_new_work() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE fixture_id TEXT; node_id TEXT; value JSONB;
BEGIN
  value:=to_jsonb(NEW);
  -- Historical ACK/result updates remain writable; new work/changed bindings
  -- must be active. Desired=false internal membership cleanup is permitted.
  IF TG_TABLE_NAME='MeshControlGroupMember' THEN
    IF NOT NEW.desired THEN RETURN NEW; END IF;
    node_id:=NEW."meshNodeId";
    SELECT id INTO fixture_id FROM "Fixture" WHERE "meshNodeId"=node_id;
  ELSIF TG_TABLE_NAME='FloorLightSlot' THEN fixture_id:=NEW."assignedFixtureId";
  ELSE fixture_id:=value->>'fixtureId'; END IF;
  IF fixture_id IS NOT NULL THEN PERFORM assert_fixture_registration_active(fixture_id); END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['FixtureRegistrationRemovalOperation','Fixture','MeshNode','Gateway','GroupFixture',
      'CommandFixtureResult','AutomationExecutionFixtureResult','FloorLightSlot','MeshControlGroupMember','SensorModeOperation',
      'BioSensorPreparationOperation','BioRegistrationRevalidationOperation'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"()',name||'_registration_removal_lock',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['GroupFixture','CommandFixtureResult','AutomationExecutionFixtureResult','LightingScheduleFixture',
      'VehicleEventSource','VehicleEventTarget','ManualOverrideFixture','SensorModeOperation','BioSensorPreparationOperation',
      'BioRegistrationRevalidationOperation','TemporaryControlTarget'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_new_work()',name||'_registration_new_work',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['GroupFixture','LightingScheduleFixture','VehicleEventSource','VehicleEventTarget','ManualOverrideFixture'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF "fixtureId" ON %I FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_new_work()',name||'_registration_rebind',name);
  END LOOP;
END $$;
CREATE TRIGGER "FloorLightSlot_registration_new_work" BEFORE INSERT OR UPDATE OF "assignedFixtureId" ON "FloorLightSlot" FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_new_work();
CREATE TRIGGER "MeshControlGroupMember_registration_new_work" BEFORE INSERT OR UPDATE OF "meshNodeId",desired ON "MeshControlGroupMember" FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_new_work();
COMMIT;
