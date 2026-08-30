BEGIN;

CREATE OR REPLACE FUNCTION "validate_automation_execution_source"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_site_id TEXT;
  source_gateway_id TEXT;
  snapshot_source_type TEXT;
  snapshot_source_id TEXT;
  snapshot_source_exists BOOLEAN := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."lightingScheduleId" IS NOT NULL
      AND NEW."lightingScheduleId" IS NULL
      AND NEW."vehicleEventRuleId" IS NOT DISTINCT FROM OLD."vehicleEventRuleId"
      AND NEW."manualOverrideId" IS NOT DISTINCT FROM OLD."manualOverrideId"
      AND NOT EXISTS (SELECT 1 FROM "LightingSchedule" WHERE "id" = OLD."lightingScheduleId")
    THEN
      RETURN NEW;
    END IF;
    IF OLD."vehicleEventRuleId" IS NOT NULL
      AND NEW."vehicleEventRuleId" IS NULL
      AND NEW."lightingScheduleId" IS NOT DISTINCT FROM OLD."lightingScheduleId"
      AND NEW."manualOverrideId" IS NOT DISTINCT FROM OLD."manualOverrideId"
      AND NOT EXISTS (SELECT 1 FROM "VehicleEventRule" WHERE "id" = OLD."vehicleEventRuleId")
    THEN
      RETURN NEW;
    END IF;
    IF OLD."manualOverrideId" IS NOT NULL
      AND NEW."manualOverrideId" IS NULL
      AND NEW."lightingScheduleId" IS NOT DISTINCT FROM OLD."lightingScheduleId"
      AND NEW."vehicleEventRuleId" IS NOT DISTINCT FROM OLD."vehicleEventRuleId"
      AND NOT EXISTS (SELECT 1 FROM "ManualOverride" WHERE "id" = OLD."manualOverrideId")
    THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW."kind" IN ('schedule_started', 'schedule_ended') THEN
    IF NEW."ruleId" IS NULL
      OR NEW."vehicleEventRuleId" IS NOT NULL
      OR NEW."manualOverrideId" IS NOT NULL
    THEN
      RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
    END IF;
    IF NEW."lightingScheduleId" IS NOT NULL
      AND NEW."ruleId" IS DISTINCT FROM NEW."lightingScheduleId"
    THEN
      RAISE EXCEPTION 'execution ruleId does not match source' USING ERRCODE = '23514';
    END IF;
    snapshot_source_type := 'schedule';
    snapshot_source_id := NEW."ruleId";
  ELSIF NEW."kind" IN ('vehicle_detected', 'event_started', 'event_extended', 'event_ended') THEN
    IF NEW."ruleId" IS NULL
      OR NEW."lightingScheduleId" IS NOT NULL
      OR NEW."manualOverrideId" IS NOT NULL
    THEN
      RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
    END IF;
    IF NEW."vehicleEventRuleId" IS NOT NULL
      AND NEW."ruleId" IS DISTINCT FROM NEW."vehicleEventRuleId"
    THEN
      RAISE EXCEPTION 'execution ruleId does not match source' USING ERRCODE = '23514';
    END IF;
    snapshot_source_type := 'vehicle_event_rule';
    snapshot_source_id := NEW."ruleId";
  ELSIF NEW."kind" = 'action_result' THEN
    snapshot_source_type := NEW."payload"->>'sourceType';
    snapshot_source_id := NEW."payload"->>'sourceId';
    IF snapshot_source_type = 'schedule' THEN
      IF snapshot_source_id IS NULL
        OR NEW."vehicleEventRuleId" IS NOT NULL
        OR NEW."manualOverrideId" IS NOT NULL
      THEN
        RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
      END IF;
      IF NEW."ruleId" IS DISTINCT FROM snapshot_source_id
        OR (NEW."lightingScheduleId" IS NOT NULL AND NEW."lightingScheduleId" IS DISTINCT FROM snapshot_source_id)
      THEN
        RAISE EXCEPTION 'execution ruleId does not match source' USING ERRCODE = '23514';
      END IF;
    ELSIF snapshot_source_type = 'vehicle_event_rule' THEN
      IF snapshot_source_id IS NULL
        OR NEW."lightingScheduleId" IS NOT NULL
        OR NEW."manualOverrideId" IS NOT NULL
      THEN
        RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
      END IF;
      IF NEW."ruleId" IS DISTINCT FROM snapshot_source_id
        OR (NEW."vehicleEventRuleId" IS NOT NULL AND NEW."vehicleEventRuleId" IS DISTINCT FROM snapshot_source_id)
      THEN
        RAISE EXCEPTION 'execution ruleId does not match source' USING ERRCODE = '23514';
      END IF;
    ELSIF snapshot_source_type = 'manual_override' THEN
      IF snapshot_source_id IS NULL
        OR NEW."lightingScheduleId" IS NOT NULL
        OR NEW."vehicleEventRuleId" IS NOT NULL
        OR NEW."manualOverrideId" IS NULL
      THEN
        RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
      END IF;
      IF NEW."ruleId" IS NOT NULL OR NEW."manualOverrideId" IS DISTINCT FROM snapshot_source_id THEN
        RAISE EXCEPTION 'manual execution cannot contain ruleId' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."kind" = 'telemetry_gap' THEN
    IF NEW."ruleId" IS NOT NULL
      OR num_nonnulls(NEW."lightingScheduleId", NEW."vehicleEventRuleId", NEW."manualOverrideId") <> 0
    THEN
      RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."lightingScheduleId" IS NOT NULL THEN
    SELECT "siteId", "gatewayId"
    INTO source_site_id, source_gateway_id
    FROM "LightingSchedule"
    WHERE "id" = NEW."lightingScheduleId";
  ELSIF NEW."vehicleEventRuleId" IS NOT NULL THEN
    SELECT "siteId", "gatewayId"
    INTO source_site_id, source_gateway_id
    FROM "VehicleEventRule"
    WHERE "id" = NEW."vehicleEventRuleId";
  ELSIF NEW."manualOverrideId" IS NOT NULL THEN
    SELECT "siteId", "gatewayId"
    INTO source_site_id, source_gateway_id
    FROM "ManualOverride"
    WHERE "id" = NEW."manualOverrideId";
  ELSIF snapshot_source_type IN ('schedule', 'vehicle_event_rule') THEN
    SELECT EXISTS (
      SELECT 1
      FROM "MqttOutbox" AS outbox
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE snapshot_source_type
          WHEN 'schedule' THEN outbox."payload"->'schedules'
          ELSE outbox."payload"->'vehicleEventRules'
        END
      ) AS snapshot_source
      WHERE outbox."dispatchId" IS NULL
        AND outbox."applicationAckKey" IS NULL
        AND outbox."gatewayId" = NEW."gatewayId"
        AND outbox."revision" = NEW."revision"
        AND outbox."payloadHash" = outbox."payload"->>'payloadHash'
        AND outbox."payload"->>'siteId' = NEW."siteId"
        AND outbox."payload"->>'gatewayId' = NEW."gatewayId"
        AND outbox."payload"->>'revision' = NEW."revision"::TEXT
        AND snapshot_source->>'id' = snapshot_source_id
        AND snapshot_source->>'status' = 'enabled'
    ) INTO snapshot_source_exists;
    IF NOT snapshot_source_exists THEN
      RAISE EXCEPTION 'execution source is absent from immutable snapshot' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
  END IF;

  IF source_site_id IS DISTINCT FROM NEW."siteId"
    OR source_gateway_id IS DISTINCT FROM NEW."gatewayId"
  THEN
    RAISE EXCEPTION 'execution source owner does not match execution owner' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
