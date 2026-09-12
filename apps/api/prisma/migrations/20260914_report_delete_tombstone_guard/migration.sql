BEGIN;

-- Old API instances do not call recordReportCleanup. Hold the DELETE-conflicting
-- lock until the guard commits, so subsequent DELETEs/cascades cannot bypass it.
LOCK TABLE "EnergyReportJob" IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION "preserve_energy_report_object_tombstone"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  uuid_pattern CONSTANT TEXT := '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
  object_keys JSONB;
  deleted_at TIMESTAMP := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
  -- Never derive object authority from objectKey or a caller-supplied path.
  -- Invalid legacy identities fail closed: keep the row instead of losing it.
  IF OLD."id" !~* uuid_pattern OR OLD."siteId" !~* uuid_pattern
    OR OLD."format"::text NOT IN ('xlsx', 'pdf') THEN
    RAISE EXCEPTION 'invalid report cleanup identity' USING ERRCODE = '23514';
  END IF;

  SELECT jsonb_agg(format('reports/%s/%s/attempt-%s.%s', OLD."siteId", OLD."id", attempt, OLD."format"::text) ORDER BY attempt)
    INTO object_keys FROM generate_series(1, 3) AS attempt;

  -- Bind to the report table's schema, not the caller's search_path. Preserve a
  -- current cleanup lease/schedule: new prune deletes the job during its fenced
  -- finalize transaction and must retain ownership through that DELETE trigger.
  EXECUTE format('INSERT INTO %I."EnergyReportObjectCleanup"
    ("reportId", "siteId", "objectKeys", "nextAttemptAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $4, $4)
    ON CONFLICT ("reportId") DO UPDATE SET "objectKeys" = EXCLUDED."objectKeys", "updatedAt" = EXCLUDED."updatedAt"', TG_TABLE_SCHEMA)
    USING OLD."id", OLD."siteId", object_keys, deleted_at;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "EnergyReportJob_preserve_objects_before_delete" BEFORE DELETE ON "EnergyReportJob"
FOR EACH ROW EXECUTE FUNCTION "preserve_energy_report_object_tombstone"();

COMMIT;
