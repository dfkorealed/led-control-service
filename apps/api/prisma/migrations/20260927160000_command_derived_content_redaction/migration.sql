-- Forward-only content tombstones. Does not install any physical-purge cutover.
ALTER TABLE "ManualOverride" ADD COLUMN "contentRedactedAt" TIMESTAMP(3),
  ALTER COLUMN "brightnessPercent" DROP NOT NULL,
  ADD CONSTRAINT "ManualOverride_content_state_check" CHECK (
    ("contentRedactedAt" IS NULL AND "brightnessPercent" IS NOT NULL)
    OR ("contentRedactedAt" IS NOT NULL AND "brightnessPercent" IS NULL
      AND "requestedById" IS NULL AND "endedAt" IS NOT NULL AND "targetCount" = 0
      AND "sourceDigest" IS NULL AND "sourceKeyVersion" IS NULL)
  );
ALTER TABLE "AutomationExecution" ADD COLUMN "contentRedactedAt" TIMESTAMP(3),
  ALTER COLUMN "payload" DROP NOT NULL,
  ADD CONSTRAINT "AutomationExecution_content_state_check" CHECK (
    ("contentRedactedAt" IS NULL AND "payload" IS NOT NULL)
    OR ("contentRedactedAt" IS NOT NULL AND "kind" = 'action_result'
      AND "payload" IS NULL AND "payloadHash" IS NULL AND "occurrenceKey" IS NULL
      AND "ruleId" IS NULL AND "lightingScheduleId" IS NULL AND "vehicleEventRuleId" IS NULL)
  );

-- Existing validators still own all ordinary rows. The independent guards below
-- authorize only the remove-only transition, so redaction cannot bypass source checks.
DROP TRIGGER "ManualOverride_bind_db_source" ON "ManualOverride";
CREATE TRIGGER "ManualOverride_bind_db_source"
BEFORE INSERT OR UPDATE OF "siteId", "gatewayId", "commandId", "brightnessPercent",
  "startedAt", "overrideUntil", "sourceDigest", "sourceKeyVersion" ON "ManualOverride"
FOR EACH ROW WHEN (NEW."contentRedactedAt" IS NULL)
EXECUTE FUNCTION command_protected.bind_manual_override_source();
DROP TRIGGER "AutomationExecution_source_check" ON "AutomationExecution";
CREATE TRIGGER "AutomationExecution_source_check"
BEFORE INSERT OR UPDATE OF "siteId", "gatewayId", "revision", "ruleId", "lightingScheduleId",
  "vehicleEventRuleId", "manualOverrideId", "kind", "payload" ON "AutomationExecution"
FOR EACH ROW WHEN (NEW."contentRedactedAt" IS NULL)
EXECUTE FUNCTION "validate_automation_execution_source"();

CREATE FUNCTION "guard_manual_content_redaction"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command_row RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."contentRedactedAt" IS NOT NULL THEN
    IF (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
      RAISE EXCEPTION 'redacted manual source is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "contentRedactedAt", "outcome", "createdAt" INTO command_row
    FROM "Command" WHERE "id" = NEW."commandId" AND "siteId" = NEW."siteId" FOR UPDATE;
  IF command_row."contentRedactedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'redacted command cannot acquire manual detail' USING ERRCODE = '23514';
  END IF;
  IF NEW."contentRedactedAt" IS NOT NULL THEN
    IF TG_OP <> 'UPDATE' OR OLD."endedAt" IS NULL OR command_row."createdAt" IS NULL
      OR command_row."createdAt" >= (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '3 months'
      OR command_row."outcome" IS NULL OR command_row."outcome" IN ('pending', 'unknown')
      OR (to_jsonb(NEW) - ARRAY['brightnessPercent','requestedById','sourceDigest','sourceKeyVersion','contentRedactedAt','updatedAt'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['brightnessPercent','requestedById','sourceDigest','sourceKeyVersion','contentRedactedAt','updatedAt'])
      OR EXISTS (SELECT 1 FROM "ManualOverrideFixture" WHERE "manualOverrideId" = NEW."id")
      OR EXISTS (SELECT 1 FROM "AutomationExecution" WHERE "manualOverrideId" = NEW."id" AND "contentRedactedAt" IS NULL)
    THEN RAISE EXCEPTION 'manual content redaction is not settled' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ManualOverride_content_guard" BEFORE INSERT OR UPDATE ON "ManualOverride"
FOR EACH ROW EXECUTE FUNCTION "guard_manual_content_redaction"();

CREATE OR REPLACE FUNCTION "assert_manual_override_has_target"(manual_override_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE stored_count INTEGER; actual_count INTEGER; redacted TIMESTAMP(3);
BEGIN
  SELECT "targetCount", "contentRedactedAt" INTO stored_count, redacted
    FROM "ManualOverride" WHERE "id" = manual_override_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*)::integer INTO actual_count FROM "ManualOverrideFixture" WHERE "manualOverrideId" = manual_override_id;
  IF stored_count IS DISTINCT FROM actual_count OR (redacted IS NULL AND stored_count < 1)
    OR (redacted IS NOT NULL AND stored_count <> 0) THEN
    RAISE EXCEPTION 'manual source target cardinality mismatch' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "guard_execution_content_redaction"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."contentRedactedAt" IS NOT NULL THEN
    -- Preserve FK SET NULL when the whole source/site is explicitly deleted.
    IF NEW."manualOverrideId" IS NULL AND OLD."manualOverrideId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "ManualOverride" WHERE "id" = OLD."manualOverrideId")
      AND (to_jsonb(NEW) - 'manualOverrideId') = (to_jsonb(OLD) - 'manualOverrideId') THEN RETURN NEW; END IF;
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'redacted execution is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."manualOverrideId" IS NOT NULL THEN
    SELECT source."contentRedactedAt", source."endedAt", command."createdAt", command."outcome"
      INTO source_row FROM "ManualOverride" source JOIN "Command" command ON command."id" = source."commandId"
      WHERE source."id" = NEW."manualOverrideId" FOR UPDATE OF source, command;
    IF source_row."contentRedactedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'redacted manual source cannot acquire execution detail' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."contentRedactedAt" IS NOT NULL THEN
    IF TG_OP <> 'UPDATE' OR OLD."manualOverrideId" IS NULL OR source_row."endedAt" IS NULL
      OR source_row."createdAt" >= (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '3 months'
      OR source_row."outcome" IS NULL OR source_row."outcome" IN ('pending', 'unknown')
      OR (to_jsonb(NEW) - ARRAY['payload','payloadHash','occurrenceKey','contentRedactedAt'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['payload','payloadHash','occurrenceKey','contentRedactedAt'])
      OR NOT EXISTS (SELECT 1 FROM "ManualExecutionReplayReceipt" receipt
        WHERE receipt."siteId" = NEW."siteId" AND receipt."gatewayId" = NEW."gatewayId"
          AND receipt."eventId" = NEW."eventId" AND receipt."sequence" = NEW."sequence")
      OR EXISTS (SELECT 1 FROM "AutomationExecutionFixtureResult" WHERE "executionId" = NEW."id")
    THEN RAISE EXCEPTION 'execution content redaction is not settled' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AutomationExecution_content_guard" BEFORE INSERT OR UPDATE ON "AutomationExecution"
FOR EACH ROW EXECUTE FUNCTION "guard_execution_content_redaction"();

-- Child writes lock the parent: an old producer that raced the cleanup either
-- commits first and is removed, or sees the tombstone and cannot restore detail.
CREATE FUNCTION "guard_redacted_detail_child"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE redacted TIMESTAMP(3);
BEGIN
  IF TG_TABLE_NAME = 'ManualOverrideFixture' THEN
    SELECT "contentRedactedAt" INTO redacted FROM "ManualOverride" WHERE "id" = NEW."manualOverrideId" FOR UPDATE;
  ELSIF TG_TABLE_NAME = 'AutomationExecutionFixtureResult' THEN
    SELECT "contentRedactedAt" INTO redacted FROM "AutomationExecution" WHERE "id" = NEW."executionId" FOR UPDATE;
  ELSIF TG_TABLE_NAME = 'CommandFixtureResult' THEN
    SELECT command."contentRedactedAt" INTO redacted FROM "Command" command JOIN "CommandDispatch" dispatch
      ON dispatch."commandId" = command."id" WHERE dispatch."id" = NEW."dispatchId" FOR UPDATE OF command;
  ELSIF TG_TABLE_NAME = 'MqttOutbox' THEN
    IF NEW."dispatchId" IS NOT NULL THEN
      SELECT command."contentRedactedAt" INTO redacted FROM "Command" command JOIN "CommandDispatch" dispatch
        ON dispatch."commandId" = command."id" WHERE dispatch."id" = NEW."dispatchId" FOR UPDATE OF command;
    ELSIF NEW."applicationAckKey" LIKE 'automation-execution:%' THEN
      SELECT "contentRedactedAt" INTO redacted FROM "AutomationExecution"
        WHERE "gatewayId" = NEW."gatewayId" AND "eventId" = NEW."payload"->>'eventId'
          AND "sequence"::text = NEW."payload"->>'sequence' FOR UPDATE;
    END IF;
  END IF;
  IF redacted IS NOT NULL THEN RAISE EXCEPTION 'redacted detail cannot be restored' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ManualOverrideFixture_content_guard" BEFORE INSERT OR UPDATE ON "ManualOverrideFixture"
FOR EACH ROW EXECUTE FUNCTION "guard_redacted_detail_child"();
CREATE TRIGGER "AutomationExecutionFixtureResult_content_guard" BEFORE INSERT OR UPDATE ON "AutomationExecutionFixtureResult"
FOR EACH ROW EXECUTE FUNCTION "guard_redacted_detail_child"();
CREATE TRIGGER "CommandFixtureResult_content_guard" BEFORE INSERT OR UPDATE ON "CommandFixtureResult"
FOR EACH ROW EXECUTE FUNCTION "guard_redacted_detail_child"();
CREATE TRIGGER "MqttOutbox_content_guard" BEFORE INSERT OR UPDATE ON "MqttOutbox"
FOR EACH ROW EXECUTE FUNCTION "guard_redacted_detail_child"();

CREATE FUNCTION "guard_command_content_restoration"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE redacted TIMESTAMP(3);
BEGIN
  IF TG_TABLE_NAME = 'Command' THEN
    IF OLD."contentRedactedAt" IS NOT NULL AND
      (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
      RAISE EXCEPTION 'redacted command is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "contentRedactedAt" INTO redacted FROM "Command" WHERE "id" = NEW."commandId" FOR UPDATE;
    IF redacted IS NOT NULL AND (TG_OP = 'INSERT' OR
      (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt')) THEN
      RAISE EXCEPTION 'redacted command dispatch is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Command_content_restoration_guard" BEFORE UPDATE ON "Command"
FOR EACH ROW EXECUTE FUNCTION "guard_command_content_restoration"();
CREATE TRIGGER "CommandDispatch_content_restoration_guard" BEFORE INSERT OR UPDATE ON "CommandDispatch"
FOR EACH ROW EXECUTE FUNCTION "guard_command_content_restoration"();
