-- Explicit guarded cutover experiment. Never included in prisma migrate deploy.
-- The operator must first prove distinct owner/runtime roles, active DB-only
-- key, stopped legacy writers, and zero unsigned Overrides. No key is stored
-- in this file. Command purge remains separately disabled.
BEGIN;

-- Wait for all old producers, then freeze the complete provenance set before
-- preflight. Checking first and locking later would admit an incomplete
-- Override/dispatch between the two steps.
LOCK TABLE public."Command", public."CommandDispatch",
  public."CommandFixtureResult", public."ManualOverride",
  public."ManualOverrideFixture", command_protected.manual_source_key
  IN SHARE ROW EXCLUSIVE MODE;

-- This legacy statement trigger made an unqualified call into public. A
-- protected caller has a fixed safe search_path, so qualify the lock target.
CREATE OR REPLACE FUNCTION public."lock_automation_membership_statement"()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_trigger_depth() = 1 THEN
    PERFORM public."lock_automation_membership_mutation"();
  END IF;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM command_protected.manual_source_key WHERE "active") <> 1
    OR EXISTS (SELECT 1 FROM public."ManualOverride"
      WHERE "sourceDigest" IS NULL OR "sourceKeyVersion" IS NULL)
  THEN RAISE EXCEPTION 'manual detach cutover prerequisites missing' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."ManualOverride" AS override
    WHERE override."commandId" IS NULL
      OR NOT command_protected.verify_manual_action_source(
        override."siteId", override."gatewayId", override."commandId",
        ARRAY(SELECT target."fixtureId" FROM public."ManualOverrideFixture" AS target
          WHERE target."manualOverrideId" = override."id" ORDER BY target."fixtureId")
      )
  ) THEN RAISE EXCEPTION 'manual detach cutover source provenance is incomplete' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- The permit exists only during a protected function call in one transaction.
-- The function deletes it before returning, so no raw Command UUID is retained.
CREATE TABLE command_protected.manual_detach_permit (
  "transactionId" BIGINT NOT NULL,
  "overrideId" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  PRIMARY KEY ("transactionId", "overrideId")
);
REVOKE ALL ON command_protected.manual_detach_permit FROM PUBLIC;

ALTER TABLE public."ManualOverride" ALTER COLUMN "commandId" DROP NOT NULL;
ALTER TABLE public."ManualOverride" ALTER COLUMN "sourceDigest" SET NOT NULL;
ALTER TABLE public."ManualOverride" ALTER COLUMN "sourceKeyVersion" SET NOT NULL;
ALTER TABLE public."ManualOverride"
  DROP CONSTRAINT "ManualOverride_commandId_fkey";
ALTER TABLE public."ManualOverride"
  ADD CONSTRAINT "ManualOverride_commandId_fkey"
  FOREIGN KEY ("commandId") REFERENCES public."Command"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The existing binder rejects every commandId UPDATE. Keep all its other
-- INSERT/UPDATE checks, but route commandId-only UPDATE through a separate
-- permit validator. A combined UPDATE still reaches the binder and fails.
DROP TRIGGER "ManualOverride_bind_db_source" ON public."ManualOverride";
CREATE TRIGGER "ManualOverride_bind_db_source"
BEFORE INSERT OR UPDATE OF "siteId", "gatewayId", "brightnessPercent",
  "startedAt", "overrideUntil", "sourceDigest", "sourceKeyVersion"
ON public."ManualOverride"
FOR EACH ROW EXECUTE FUNCTION command_protected.bind_manual_override_source();

CREATE FUNCTION command_protected.guard_manual_detach()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."commandId" IS NOT DISTINCT FROM OLD."commandId" THEN RETURN NEW; END IF;
  IF OLD."commandId" IS NULL OR NEW."commandId" IS NOT NULL
    OR NEW."siteId" IS DISTINCT FROM OLD."siteId"
    OR NEW."gatewayId" IS DISTINCT FROM OLD."gatewayId"
    OR NEW."brightnessPercent" IS DISTINCT FROM OLD."brightnessPercent"
    OR NEW."sourceDigest" IS DISTINCT FROM OLD."sourceDigest"
    OR NEW."sourceKeyVersion" IS DISTINCT FROM OLD."sourceKeyVersion"
    OR NOT EXISTS (SELECT 1 FROM command_protected.manual_detach_permit AS permit
      WHERE permit."transactionId" = txid_current()
        AND permit."overrideId" = OLD."id"
        AND permit."commandId" = OLD."commandId")
  THEN RAISE EXCEPTION 'manual source detach requires protected permit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.guard_manual_detach() FROM PUBLIC;
CREATE TRIGGER "ManualOverride_guard_detach"
BEFORE UPDATE OF "commandId" ON public."ManualOverride"
FOR EACH ROW EXECUTE FUNCTION command_protected.guard_manual_detach();

-- The current single-column FK does not check requestedBy/site. Retain the
-- existing source trigger's site check and add requestedBy validation for
-- new live links; a detached signed Override has no remaining Command.
CREATE FUNCTION command_protected.guard_manual_live_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE linked RECORD;
BEGIN
  IF NEW."commandId" IS NULL THEN
    IF TG_OP = 'INSERT' OR NEW."sourceDigest" IS NULL
      OR NEW."sourceKeyVersion" IS NULL THEN
      RAISE EXCEPTION 'manual source link missing' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT command."siteId", command."requestedBy" INTO linked
  FROM public."Command" AS command WHERE command."id" = NEW."commandId";
  IF NOT FOUND OR NEW."siteId" IS DISTINCT FROM linked."siteId"
    OR (NEW."requestedById" IS NOT NULL
      AND NEW."requestedById" IS DISTINCT FROM linked."requestedBy") THEN
    RAISE EXCEPTION 'manual source owner mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.guard_manual_live_link() FROM PUBLIC;
CREATE TRIGGER "ManualOverride_guard_live_link"
BEFORE INSERT OR UPDATE OF "commandId", "siteId", "requestedById"
ON public."ManualOverride"
FOR EACH ROW EXECUTE FUNCTION command_protected.guard_manual_live_link();

-- Deliberately ungranted: the future protected purge function may invoke it
-- internally only after its independent hold/outbox/copy safety preflight.
CREATE FUNCTION command_protected.detach_expired_manual_source(p_override_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE old_command_id TEXT;
BEGIN
  SELECT override."commandId" INTO old_command_id
  FROM public."ManualOverride" AS override WHERE override."id" = p_override_id;
  IF old_command_id IS NULL THEN RETURN FALSE; END IF;
  IF NOT command_protected.stage_retired_manual_source(p_override_id) THEN RETURN FALSE; END IF;
  INSERT INTO command_protected.manual_detach_permit
    ("transactionId", "overrideId", "commandId")
  VALUES (txid_current(), p_override_id, old_command_id);
  UPDATE public."ManualOverride" SET "commandId" = NULL
  WHERE "id" = p_override_id AND "commandId" = old_command_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual source changed during detach' USING ERRCODE = '40001'; END IF;
  DELETE FROM command_protected.manual_detach_permit
  WHERE "transactionId" = txid_current() AND "overrideId" = p_override_id;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.detach_expired_manual_source(TEXT) FROM PUBLIC;

COMMIT;
