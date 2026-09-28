-- Additive phase only. No key is inserted, no Command FK is changed, and
-- existing no-key deployments continue writing ManualOverride as before.
-- A separate guarded cutover must transfer ownership to a non-login key
-- owner, provision/rotate a DB-only key, backfill, and prove role separation.
CREATE SCHEMA IF NOT EXISTS command_protected;
REVOKE ALL ON SCHEMA command_protected FROM PUBLIC;

CREATE TABLE command_protected.manual_source_key (
  "keyVersion" INTEGER PRIMARY KEY CHECK ("keyVersion" > 0),
  "secret" BYTEA NOT NULL CHECK (octet_length("secret") = 32),
  "active" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "manual_source_key_one_active" ON command_protected.manual_source_key ("active") WHERE "active";
REVOKE ALL ON command_protected.manual_source_key FROM PUBLIC;

ALTER TABLE "ManualOverride"
  ADD COLUMN "sourceDigest" TEXT,
  ADD COLUMN "sourceKeyVersion" INTEGER;
ALTER TABLE "ManualOverride" ADD CONSTRAINT "ManualOverride_source_digest_check" CHECK (
  ("sourceDigest" IS NULL AND "sourceKeyVersion" IS NULL)
  OR ("sourceDigest" ~ '^hmac-sha256:[a-f0-9]{64}$' AND "sourceKeyVersion" > 0)
);
ALTER TABLE "ManualOverride" ADD CONSTRAINT "ManualOverride_source_key_version_fkey"
  FOREIGN KEY ("sourceKeyVersion") REFERENCES command_protected.manual_source_key("keyVersion")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION command_protected.bind_manual_override_source()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  active_version INTEGER;
  active_secret BYTEA;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."sourceDigest" IS NOT NULL OR NEW."sourceKeyVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'manual source digest is database-owned' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."commandId" IS DISTINCT FROM OLD."commandId" THEN
      RAISE EXCEPTION 'manual source command identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD."sourceDigest" IS NOT NULL THEN
      IF NEW."siteId" IS DISTINCT FROM OLD."siteId"
        OR NEW."gatewayId" IS DISTINCT FROM OLD."gatewayId"
        OR NEW."brightnessPercent" IS DISTINCT FROM OLD."brightnessPercent"
        OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
        OR NEW."overrideUntil" IS DISTINCT FROM OLD."overrideUntil" THEN
        RAISE EXCEPTION 'bound manual source owner is immutable' USING ERRCODE = '23514';
      END IF;
      IF NEW."sourceDigest" IS DISTINCT FROM OLD."sourceDigest"
        OR NEW."sourceKeyVersion" IS DISTINCT FROM OLD."sourceKeyVersion" THEN
        RAISE EXCEPTION 'manual source digest is immutable' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."sourceDigest" IS NOT NULL OR NEW."sourceKeyVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'manual source digest is database-owned' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public."Command" AS command
    WHERE command."id" = NEW."commandId" AND command."siteId" = NEW."siteId") THEN
    RAISE EXCEPTION 'manual source command owner mismatch' USING ERRCODE = '23514';
  END IF;

  SELECT "keyVersion", "secret" INTO active_version, active_secret
  FROM command_protected.manual_source_key WHERE "active";
  IF active_version IS NULL THEN
    -- Compatibility only while physical Command purge is disabled. The
    -- guarded cutover rejects any null digest before changing the FK.
    RETURN NEW;
  END IF;
  NEW."sourceDigest" := 'hmac-sha256:' || encode(public.hmac(
    convert_to(jsonb_build_array('manual-source', NEW."siteId", NEW."gatewayId",
      NEW."commandId", NEW."brightnessPercent")::text, 'UTF8'),
    active_secret, 'sha256'), 'hex');
  NEW."sourceKeyVersion" := active_version;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.bind_manual_override_source() FROM PUBLIC;

CREATE TRIGGER "ManualOverride_bind_db_source"
BEFORE INSERT OR UPDATE OF "siteId", "gatewayId", "commandId", "brightnessPercent",
  "startedAt", "overrideUntil", "sourceDigest", "sourceKeyVersion"
ON "ManualOverride"
FOR EACH ROW EXECUTE FUNCTION command_protected.bind_manual_override_source();

CREATE FUNCTION command_protected.guard_manual_source_target()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  parent_record RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "sourceDigest", "endedAt" INTO parent_record
      FROM public."ManualOverride" WHERE "id" = OLD."manualOverrideId";
    -- A direct membership DELETE can silently release a still-live Fixture
    -- from manual priority even though the override retains other targets.
    -- FK cascades from an authorized Fixture/override deletion are nested.
    IF FOUND AND parent_record."sourceDigest" IS NOT NULL
      AND parent_record."endedAt" IS NULL AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'active bound manual target cannot be removed directly' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."manualOverrideId", NEW."fixtureId", NEW."siteId", NEW."gatewayId")
    IS DISTINCT FROM (OLD."manualOverrideId", OLD."fixtureId", OLD."siteId", OLD."gatewayId") THEN
    SELECT "sourceDigest", "endedAt" INTO parent_record
      FROM public."ManualOverride" WHERE "id" = OLD."manualOverrideId";
    IF FOUND AND parent_record."sourceDigest" IS NOT NULL AND parent_record."endedAt" IS NULL THEN
      RAISE EXCEPTION 'active bound manual target is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT "sourceDigest", "commandId", "siteId", "gatewayId", "brightnessPercent"
    INTO parent_record FROM public."ManualOverride"
    WHERE "id" = NEW."manualOverrideId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual target parent missing' USING ERRCODE = '23514';
  END IF;
  IF parent_record."sourceDigest" IS NULL THEN
    -- Existing no-key mode remains unchanged. Guarded cutover rejects every
    -- such row before Command originals may be purged.
    RETURN NEW;
  END IF;
  IF NEW."siteId" IS DISTINCT FROM parent_record."siteId"
    OR NEW."gatewayId" IS DISTINCT FROM parent_record."gatewayId"
    OR NOT EXISTS (
      SELECT 1 FROM public."Command" AS command
      WHERE command."id" = parent_record."commandId"
        AND command."siteId" = parent_record."siteId"
        AND command."brightness" = parent_record."brightnessPercent"
        AND command."targetFixtureIds" @> jsonb_build_array(NEW."fixtureId")
    ) THEN
    -- After the Command is removed, an existing signed target may be deleted
    -- by authorized cleanup, but a new target cannot be invented.
    RAISE EXCEPTION 'manual source target is not in the verified Command' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.guard_manual_source_target() FROM PUBLIC;

CREATE TRIGGER "ManualOverrideFixture_db_source_target"
BEFORE INSERT OR UPDATE OF "manualOverrideId", "fixtureId", "siteId", "gatewayId" OR DELETE
ON "ManualOverrideFixture"
FOR EACH ROW EXECUTE FUNCTION command_protected.guard_manual_source_target();
