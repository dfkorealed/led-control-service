BEGIN;
SELECT "lock_automation_membership_mutation"();

CREATE TABLE "FixtureRegistrationRemovalResultEvidence" (
  "eventId" TEXT PRIMARY KEY, "operationId" TEXT NOT NULL, "siteId" TEXT NOT NULL,
  terminal JSONB NOT NULL, "terminalHash" TEXT NOT NULL,
  "applicationAck" JSONB, "applicationAckHash" TEXT, "receivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "FixtureRegistrationRemovalResultEvidence_operationId_fkey" FOREIGN KEY ("operationId")
    REFERENCES "FixtureRegistrationRemovalOperation"("operationId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FixtureRegistrationRemovalResultEvidence_hash_check" CHECK (
    "terminalHash" ~ '^sha256:[0-9a-f]{64}$' AND
    (("applicationAck" IS NULL)=("applicationAckHash" IS NULL)) AND
    (("applicationAck" IS NULL AND "applicationAckHash" IS NULL) OR
     ("applicationAck" IS NOT NULL AND "applicationAckHash" ~ '^sha256:[0-9a-f]{64}$')))
);
CREATE INDEX "FixtureRegistrationRemovalResultEvidence_operationId_createdAt_idx"
  ON "FixtureRegistrationRemovalResultEvidence"("operationId","createdAt");

-- Preserve previous exact bytes. NULL receipt time means the old schema did
-- not retain a transport receipt; migration never fabricates one.
INSERT INTO "FixtureRegistrationRemovalResultEvidence"
  ("eventId","operationId","siteId",terminal,"terminalHash","applicationAck","applicationAckHash","receivedAt")
SELECT "resultEventId","operationId","siteId",result,"resultHash","applicationAck","applicationAckHash",NULL
FROM "FixtureRegistrationRemovalOperation" WHERE result IS NOT NULL;

CREATE FUNCTION guard_fixture_removal_result_evidence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE operation "FixtureRegistrationRemovalOperation"; identity JSONB;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM "Site" WHERE id=OLD."siteId") THEN RETURN OLD; END IF;
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'removal result evidence is append only' USING ERRCODE='23514';
  END IF;
  SELECT * INTO operation FROM "FixtureRegistrationRemovalOperation" WHERE "operationId"=NEW."operationId" FOR UPDATE;
  identity:=operation.payload-ARRAY['requestedAt','expiresAt'];
  IF operation."operationId" IS NULL OR NEW."siteId"<>operation."siteId" OR NEW."receivedAt" IS NULL OR NOT COALESCE(
    (NEW.terminal-ARRAY['eventId','commandHash','occurredAt','status','errorCode'])=operation.payload AND
    NEW.terminal->>'eventId'=NEW."eventId" AND NEW.terminal->>'commandHash'=operation."commandHash" AND
    (NEW.terminal->>'occurredAt')::timestamptz AT TIME ZONE 'UTC'>=operation."requestedAt" AND
    NEW.terminal->>'status' IN ('removed','rejected','reconcile_required') AND
    ((NEW.terminal->>'status'='removed' AND NEW.terminal->'errorCode'='null'::jsonb) OR
     (NEW.terminal->>'status'<>'removed' AND NEW.terminal->>'errorCode' ~ '^[A-Z][A-Z0-9_]{0,127}$')) AND
    (NEW."applicationAck"-ARRAY['commandHash','eventId','resultHash','ingestedAt','status'])=identity AND
    NEW."applicationAck"->>'commandHash'=operation."commandHash" AND NEW."applicationAck"->>'eventId'=NEW."eventId" AND
    NEW."applicationAck"->>'resultHash'=NEW."terminalHash" AND NEW."applicationAck"->>'status' IN ('ingested','duplicate') AND
    NEW."applicationAck"->>'ingestedAt' IS NOT NULL,FALSE) THEN
    RAISE EXCEPTION 'removal evidence command or ACK identity mismatch' USING ERRCODE='23514';
  END IF;
  IF operation.result IS NOT NULL AND NOT (operation.status='reconcile_required' AND
    operation.result->>'status'='reconcile_required' AND NEW.terminal->>'status' IN ('removed','rejected')) THEN
    RAISE EXCEPTION 'definitive removal evidence cannot be replaced' USING ERRCODE='23514';
  END IF;
  IF operation.result IS NULL AND EXISTS(SELECT 1 FROM "FixtureRegistrationRemovalResultEvidence" WHERE "operationId"=NEW."operationId") THEN
    RAISE EXCEPTION 'unpointed removal evidence must be reconciled before appending' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "FixtureRegistrationRemovalResultEvidence_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "FixtureRegistrationRemovalResultEvidence" FOR EACH ROW EXECUTE FUNCTION guard_fixture_removal_result_evidence();
CREATE TRIGGER "FixtureRegistrationRemovalResultEvidence_lock" BEFORE INSERT OR UPDATE OR DELETE
  ON "FixtureRegistrationRemovalResultEvidence" FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();

-- Keep the full original admission/payload/snapshot validator for INSERT and
-- first cleanupSnapshot writes. A separate UPDATE guard below permits only
-- append-proven uncertain->definitive result/ACK pointer replacement.
DROP TRIGGER "FixtureRegistrationRemovalOperation_guard" ON "FixtureRegistrationRemovalOperation";
CREATE TRIGGER "FixtureRegistrationRemovalOperation_guard" BEFORE INSERT OR UPDATE OF "cleanupSnapshot"
  ON "FixtureRegistrationRemovalOperation" FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_removal_operation();

CREATE FUNCTION guard_fixture_removal_result_pointer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE mutable_fields TEXT[]; changed BOOLEAN; evidence "FixtureRegistrationRemovalResultEvidence";
BEGIN
  mutable_fields:=ARRAY['status','errorCode','result','resultHash','resultEventId','gatewayConfirmedAt','completedAt','cleanupSnapshot',
    'applicationAck','applicationAckHash','ackPublishedAt','ackAttempts','ackNextAttemptAt','ackLockedBy','ackLeaseExpiresAt',
    'publishedAt','attempts','nextAttemptAt','lockedBy','leaseExpiresAt','updatedAt'];
  IF (to_jsonb(NEW)-mutable_fields) IS DISTINCT FROM (to_jsonb(OLD)-mutable_fields) OR
    (OLD."gatewayConfirmedAt" IS NOT NULL AND NEW."gatewayConfirmedAt" IS DISTINCT FROM OLD."gatewayConfirmedAt") OR
    (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt") OR
    (OLD."cleanupSnapshot" IS NOT NULL AND NEW."cleanupSnapshot" IS DISTINCT FROM OLD."cleanupSnapshot") OR
    (NEW.status<>OLD.status AND NOT (
      (OLD.status='pending' AND NEW.status IN ('gateway_confirmed','rejected','reconcile_required')) OR
      (OLD.status='gateway_confirmed' AND NEW.status IN ('completed','reconcile_required')) OR
      (OLD.status='reconcile_required' AND NEW.status IN ('gateway_confirmed','rejected')))) THEN
    RAISE EXCEPTION 'immutable removal identity or invalid transition' USING ERRCODE='23514';
  END IF;
  changed:=ROW(NEW.result,NEW."resultHash",NEW."resultEventId") IS DISTINCT FROM ROW(OLD.result,OLD."resultHash",OLD."resultEventId");
  IF changed AND OLD.result IS NOT NULL THEN
    IF OLD.status<>'reconcile_required' OR OLD.result->>'status'<>'reconcile_required' OR
      NEW.result->>'status' NOT IN ('removed','rejected') OR NOT EXISTS(
        SELECT 1 FROM "FixtureRegistrationRemovalResultEvidence" old_evidence WHERE old_evidence."operationId"=OLD."operationId"
          AND old_evidence."eventId"=OLD."resultEventId" AND old_evidence.terminal=OLD.result AND old_evidence."terminalHash"=OLD."resultHash"
          AND old_evidence."applicationAck" IS NOT DISTINCT FROM OLD."applicationAck"
          AND old_evidence."applicationAckHash" IS NOT DISTINCT FROM OLD."applicationAckHash") THEN
      RAISE EXCEPTION 'removal result replacement requires preserved uncertain evidence' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.result IS NOT NULL THEN
    SELECT * INTO evidence FROM "FixtureRegistrationRemovalResultEvidence" WHERE "eventId"=NEW."resultEventId" AND "operationId"=NEW."operationId";
    IF evidence."eventId" IS NULL OR evidence.terminal IS DISTINCT FROM NEW.result OR evidence."terminalHash" IS DISTINCT FROM NEW."resultHash" OR
      evidence."applicationAck" IS DISTINCT FROM NEW."applicationAck" OR evidence."applicationAckHash" IS DISTINCT FROM NEW."applicationAckHash" OR
      (NEW.status IN ('gateway_confirmed','completed') AND NEW.result->>'status'<>'removed') OR
      (NEW.status='rejected' AND NEW.result->>'status'<>'rejected') OR NEW.status='pending' OR
      (NEW."gatewayConfirmedAt" IS NOT NULL AND NEW.result->>'status'<>'removed') THEN
      RAISE EXCEPTION 'latest removal result/ACK must point to exact immutable evidence' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.result IS NOT NULL OR NEW."applicationAck" IS NOT NULL OR NEW."gatewayConfirmedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'removal evidence cannot be cleared' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "FixtureRegistrationRemovalOperation_result_pointer_guard" BEFORE UPDATE ON "FixtureRegistrationRemovalOperation"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_removal_result_pointer();
COMMIT;
