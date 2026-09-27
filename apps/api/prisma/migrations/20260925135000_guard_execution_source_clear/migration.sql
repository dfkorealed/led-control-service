-- The older source validator intentionally tolerates FK SetNull after a source
-- delete. Its early return must not also permit an arbitrary payload rewrite
-- in the same UPDATE. This independent guard preserves the legacy validator
-- and rejects every non-FK mutation on that narrow compatibility path.
CREATE OR REPLACE FUNCTION "guard_automation_execution_source_clear"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."lightingScheduleId" IS NOT NULL AND NEW."lightingScheduleId" IS NULL
    AND (to_jsonb(NEW) - 'lightingScheduleId') IS DISTINCT FROM (to_jsonb(OLD) - 'lightingScheduleId')
  THEN
    RAISE EXCEPTION 'source FK clear cannot rewrite execution' USING ERRCODE = '23514';
  END IF;
  IF OLD."vehicleEventRuleId" IS NOT NULL AND NEW."vehicleEventRuleId" IS NULL
    AND (to_jsonb(NEW) - 'vehicleEventRuleId') IS DISTINCT FROM (to_jsonb(OLD) - 'vehicleEventRuleId')
  THEN
    RAISE EXCEPTION 'source FK clear cannot rewrite execution' USING ERRCODE = '23514';
  END IF;
  IF OLD."manualOverrideId" IS NOT NULL AND NEW."manualOverrideId" IS NULL
    AND (to_jsonb(NEW) - 'manualOverrideId') IS DISTINCT FROM (to_jsonb(OLD) - 'manualOverrideId')
  THEN
    RAISE EXCEPTION 'source FK clear cannot rewrite execution' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AutomationExecution_provenance_clear_guard"
BEFORE UPDATE OF "lightingScheduleId", "vehicleEventRuleId", "manualOverrideId"
ON "AutomationExecution"
FOR EACH ROW EXECUTE FUNCTION "guard_automation_execution_source_clear"();
