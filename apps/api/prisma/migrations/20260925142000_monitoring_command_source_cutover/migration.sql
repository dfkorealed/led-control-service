-- Additive, default OFF. The guarded cutover must stop/drain old producers,
-- backfill every legacy key, lock MonitoringActivity, prove raw count zero,
-- and then set keyedRequired=true in that same transaction. migrate deploy
-- never enables this barrier or Command purge.
CREATE TABLE "MonitoringCommandSourcePolicy" (
  "id" INTEGER NOT NULL,
  "keyedRequired" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "MonitoringCommandSourcePolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonitoringCommandSourcePolicy_singleton_check" CHECK ("id" = 1)
);
INSERT INTO "MonitoringCommandSourcePolicy" ("id", "keyedRequired") VALUES (1, false);
REVOKE ALL ON TABLE "MonitoringCommandSourcePolicy" FROM PUBLIC;

-- The bounded rekey scan orders by site/source across all sites; the existing
-- uniqueness index mixes every source type at each site.
CREATE INDEX "MonitoringActivity_command_source_backfill_idx"
  ON "MonitoringActivity"("siteId", "sourceKey")
  WHERE "sourceType" = 'command';

CREATE FUNCTION "MonitoringActivity_require_keyed_command_source"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  must_be_keyed BOOLEAN;
BEGIN
  IF NEW."sourceType" <> 'command' THEN
    RETURN NEW;
  END IF;
  SELECT policy."keyedRequired" INTO must_be_keyed
  FROM public."MonitoringCommandSourcePolicy" AS policy WHERE policy."id" = 1;
  IF must_be_keyed IS NULL THEN
    RAISE EXCEPTION 'command activity source policy missing' USING ERRCODE = '23514';
  END IF;
  IF must_be_keyed
    AND NEW."sourceKey" !~ '^v[1-9][0-9]*:hmac-sha256:[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'raw command activity source is disabled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MonitoringActivity_keyed_command_source"
BEFORE INSERT OR UPDATE OF "sourceType", "sourceKey" ON "MonitoringActivity"
FOR EACH ROW EXECUTE FUNCTION "MonitoringActivity_require_keyed_command_source"();
REVOKE ALL ON FUNCTION "MonitoringActivity_require_keyed_command_source"() FROM PUBLIC;
