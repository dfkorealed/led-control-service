-- Preserve existing rules as other-lamp controls. Apply only after API/Gateway
-- support is deployed; this migration never enables a rule or changes a lamp.
BEGIN;
SELECT "lock_automation_membership_mutation"();
LOCK TABLE "VehicleEventRule", "VehicleEventSource", "VehicleEventTarget", "GatewayAutomationProtocolSupport" IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE "VehicleEventRule" ADD COLUMN "selfControlEnabled" BOOLEAN NOT NULL DEFAULT false;
-- Mirror the wire codec: seconds through 127, whole minutes afterwards. Never
-- accept values which the Gateway would need to round or a native 0% detection.
ALTER TABLE "VehicleEventRule" ADD CONSTRAINT "VehicleEventRule_native_configuration_check"
  CHECK (NOT "selfControlEnabled" OR (
    "holdSeconds" BETWEEN 1 AND 1800
    AND ("holdSeconds" <= 127 OR "holdSeconds" % 60 = 0)
    AND (NOT "dimmingEnabled" OR "brightnessPercent" BETWEEN 1 AND 100)
  ));
ALTER TABLE "GatewayAutomationProtocolSupport" ADD COLUMN "bioNativeSelfControlVersion" INTEGER;
ALTER TABLE "GatewayAutomationProtocolSupport" ADD CONSTRAINT "GatewayAutomationProtocolSupport_self_version_check"
  CHECK ("bioNativeSelfControlVersion" IS NULL OR "bioNativeSelfControlVersion" = 1);

CREATE OR REPLACE FUNCTION "assert_vehicle_event_rule_has_source_and_target"(rule_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  saved RECORD;
  actual_sources INTEGER;
  actual_targets INTEGER;
BEGIN
  SELECT "sourceCount", "targetCount", "selfControlEnabled", "sensorProtocol", status
    INTO saved FROM "VehicleEventRule" WHERE id = rule_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COUNT(*)::INTEGER INTO actual_sources FROM "VehicleEventSource" WHERE "ruleId" = rule_id;
  SELECT COUNT(*)::INTEGER INTO actual_targets FROM "VehicleEventTarget" WHERE "ruleId" = rule_id;
  IF saved."sourceCount" IS DISTINCT FROM actual_sources OR saved."targetCount" IS DISTINCT FROM actual_targets THEN
    RAISE EXCEPTION 'vehicle event counters do not match fixture rows' USING ERRCODE = '23514';
  END IF;
  IF actual_sources < 1 OR (NOT saved."selfControlEnabled" AND actual_targets < 1) THEN
    RAISE EXCEPTION 'vehicle event requires a source and an output' USING ERRCODE = '23514';
  END IF;
  IF saved."selfControlEnabled" THEN
    IF saved."sensorProtocol"::TEXT <> 'bio_usb_pulse' OR actual_sources <> 1 THEN
      RAISE EXCEPTION 'native self control requires one BIO source' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "VehicleEventSource" s JOIN "VehicleEventTarget" t
      ON t."ruleId" = s."ruleId" AND t."fixtureId" = s."fixtureId" WHERE s."ruleId" = rule_id) THEN
      RAISE EXCEPTION 'native self source must not be a force-output target' USING ERRCODE = '23514';
    END IF;
    -- Existing membership mutation serialization also protects this cross-row
    -- constraint; disabled drafts reserve no physical configuration ownership.
    IF saved.status::TEXT = 'enabled' AND EXISTS (
      SELECT 1 FROM "VehicleEventSource" own_source
      JOIN "VehicleEventSource" other_source ON other_source."fixtureId" = own_source."fixtureId" AND other_source."ruleId" <> rule_id
      JOIN "VehicleEventRule" other_rule ON other_rule.id = other_source."ruleId"
      WHERE own_source."ruleId" = rule_id AND other_rule."selfControlEnabled" AND other_rule.status::TEXT = 'enabled'
    ) THEN RAISE EXCEPTION 'native self source already has an enabled owner' USING ERRCODE = '23514'; END IF;
  END IF;
END;
$$;
COMMIT;
