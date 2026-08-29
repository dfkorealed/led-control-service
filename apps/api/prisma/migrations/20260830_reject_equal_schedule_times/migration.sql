BEGIN;

LOCK TABLE "LightingSchedule", "MqttOutbox" IN SHARE MODE;

CREATE TEMP TABLE "EqualTimeMigrationFailure" (
  "detail" TEXT NOT NULL
) ON COMMIT DROP;

CREATE FUNCTION pg_temp."raise_equal_time_migration_failure"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $failure$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'Operator remediation required before migration: equal local schedule times detected',
    DETAIL = NEW."detail",
    HINT = 'Set each listed schedule to explicit non-equal local times. Regenerate each listed Gateway full snapshot, then remove only the superseded invalid pending outbox row under the automation recovery runbook. No rows were modified.';
  RETURN NEW;
END;
$failure$;

CREATE CONSTRAINT TRIGGER "EqualTimeMigrationFailure_raise_at_commit"
AFTER INSERT ON "EqualTimeMigrationFailure"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION pg_temp."raise_equal_time_migration_failure"();

DO $migration$
DECLARE
  invalid_schedule_rows TEXT;
  invalid_pending_outbox_rows TEXT;
BEGIN
  SELECT string_agg(
    format(
      '%s(site=%s,gateway=%s,time=%s)',
      schedule."id",
      schedule."siteId",
      schedule."gatewayId",
      schedule."localStartTime"
    ),
    ', ' ORDER BY schedule."id"
  )
  INTO invalid_schedule_rows
  FROM "LightingSchedule" AS schedule
  WHERE schedule."localStartTime" = schedule."localEndTime";

  SELECT string_agg(
    format(
      '%s(gateway=%s,revision=%s,schedule=%s,time=%s)',
      invalid."outboxId",
      invalid."gatewayId",
      invalid."revision",
      invalid."scheduleId",
      invalid."localStartTime"
    ),
    ', ' ORDER BY invalid."outboxId", invalid."scheduleId"
  )
  INTO invalid_pending_outbox_rows
  FROM (
    SELECT
      outbox."id" AS "outboxId",
      outbox."gatewayId" AS "gatewayId",
      outbox."revision" AS "revision",
      schedule_entry.value->>'id' AS "scheduleId",
      schedule_entry.value->>'localStartTime' AS "localStartTime"
    FROM "MqttOutbox" AS outbox
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(outbox."payload"::jsonb->'schedules') = 'array'
          THEN outbox."payload"::jsonb->'schedules'
        ELSE '[]'::jsonb
      END
    ) AS schedule_entry(value)
    WHERE outbox."dispatchId" IS NULL
      AND outbox."gatewayId" IS NOT NULL
      AND outbox."revision" IS NOT NULL
      AND outbox."payloadHash" IS NOT NULL
      AND outbox."publishedAt" IS NULL
      AND outbox."deadLetteredAt" IS NULL
      AND schedule_entry.value->>'localStartTime' = schedule_entry.value->>'localEndTime'
  ) AS invalid;

  IF invalid_schedule_rows IS NOT NULL OR invalid_pending_outbox_rows IS NOT NULL THEN
    INSERT INTO "EqualTimeMigrationFailure" ("detail")
    VALUES (concat_ws(
        E'\n',
        CASE
          WHEN invalid_schedule_rows IS NOT NULL
            THEN 'LightingSchedule rows: ' || invalid_schedule_rows
        END,
        CASE
          WHEN invalid_pending_outbox_rows IS NOT NULL
            THEN 'Pending automation-config MqttOutbox rows: ' || invalid_pending_outbox_rows
        END
      ));
  ELSE
    EXECUTE $ddl$
      ALTER TABLE "LightingSchedule"
        ADD CONSTRAINT "LightingSchedule_local_time_distinct_check"
        CHECK ("localStartTime" <> "localEndTime")
    $ddl$;
  END IF;
END;
$migration$;

COMMIT;
