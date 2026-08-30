BEGIN;

DROP TRIGGER "AutomationExecution_source_check" ON "AutomationExecution";

CREATE TRIGGER "AutomationExecution_source_check"
BEFORE INSERT OR UPDATE OF
  "siteId", "gatewayId", "revision", "ruleId", "lightingScheduleId",
  "vehicleEventRuleId", "manualOverrideId", "kind", "payload"
ON "AutomationExecution"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_execution_source"();

COMMIT;
