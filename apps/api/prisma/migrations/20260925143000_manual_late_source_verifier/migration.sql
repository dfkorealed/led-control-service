-- Additive and ungranted: no API route calls this verifier until a guarded
-- cutover has provisioned a DB-only key and separated runtime/migrator roles.
-- It verifies a known source, never signs arbitrary caller input or returns a
-- digest. This proves a live Command/Override path; a later retired-source
-- receipt is separately needed before Command/Override originals are removed.
CREATE FUNCTION command_protected.verify_manual_action_source(
  p_site_id TEXT, p_gateway_id TEXT, p_source_id TEXT, p_fixture_ids TEXT[]
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  source_record RECORD;
  source_secret BYTEA;
  expected_digest TEXT;
BEGIN
  IF p_site_id IS NULL OR p_gateway_id IS NULL OR p_source_id IS NULL
    OR p_fixture_ids IS NULL OR cardinality(p_fixture_ids) = 0
    OR EXISTS (SELECT 1 FROM unnest(p_fixture_ids) AS target(id) WHERE id IS NULL)
    OR (SELECT count(DISTINCT id) FROM unnest(p_fixture_ids) AS target(id)) <> cardinality(p_fixture_ids)
  THEN
    RETURN FALSE;
  END IF;

  SELECT override."id", override."commandId", override."brightnessPercent",
    override."sourceDigest", override."sourceKeyVersion", override."targetCount"
  INTO source_record
  FROM public."ManualOverride" AS override
  WHERE override."siteId" = p_site_id AND override."gatewayId" = p_gateway_id
    AND (override."commandId" = p_source_id OR override."id" = p_source_id)
    AND override."sourceDigest" IS NOT NULL
  FOR SHARE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  SELECT key."secret" INTO source_secret
  FROM command_protected.manual_source_key AS key
  WHERE key."keyVersion" = source_record."sourceKeyVersion";
  IF source_secret IS NULL THEN
    RAISE EXCEPTION 'manual source verification key unavailable' USING ERRCODE = '55000';
  END IF;
  expected_digest := 'hmac-sha256:' || encode(public.hmac(
    convert_to(jsonb_build_array('manual-source', p_site_id, p_gateway_id,
      source_record."commandId", source_record."brightnessPercent")::text, 'UTF8'),
    source_secret, 'sha256'), 'hex');
  -- PostgreSQL text equality is not guaranteed constant-time. The digest is
  -- never exposed; this narrowly scoped boolean predicate is not an authz
  -- decision and must still be combined with Gateway authentication.
  IF source_record."sourceDigest" IS DISTINCT FROM expected_digest THEN RETURN FALSE; END IF;

  -- A signed Override alone is not evidence that a Set was dispatched. Match
  -- its Command brightness/owner and the complete dispatch target set. A
  -- Gateway may report a legitimate *subset* in one terminal action_result.
  IF NOT EXISTS (
    SELECT 1 FROM public."Command" AS command
    JOIN public."CommandDispatch" AS dispatch ON dispatch."commandId" = command."id"
    WHERE command."id" = source_record."commandId"
      AND command."siteId" = p_site_id
      AND command."brightness" = source_record."brightnessPercent"
      AND dispatch."gatewayId" = p_gateway_id
      AND dispatch."kind" = 'dimming'
      AND source_record."targetCount" > 0
      AND source_record."targetCount" = (
        SELECT count(*) FROM public."ManualOverrideFixture" AS target
        WHERE target."manualOverrideId" = source_record."id")
      AND NOT EXISTS (
        SELECT 1 FROM public."ManualOverrideFixture" AS target
        WHERE target."manualOverrideId" = source_record."id"
          AND (NOT command."targetFixtureIds" @> jsonb_build_array(target."fixtureId")
            OR NOT EXISTS (SELECT 1 FROM public."CommandFixtureResult" AS result
              WHERE result."dispatchId" = dispatch."id" AND result."fixtureId" = target."fixtureId")))
      AND NOT EXISTS (
        SELECT 1 FROM public."CommandFixtureResult" AS result
        WHERE result."dispatchId" = dispatch."id"
          AND NOT EXISTS (SELECT 1 FROM public."ManualOverrideFixture" AS target
            WHERE target."manualOverrideId" = source_record."id"
              AND target."fixtureId" = result."fixtureId"))
      AND NOT EXISTS (
        SELECT 1 FROM unnest(p_fixture_ids) AS offered(id)
        WHERE NOT EXISTS (SELECT 1 FROM public."ManualOverrideFixture" AS target
          WHERE target."manualOverrideId" = source_record."id" AND target."fixtureId" = offered.id))
  ) THEN RETURN FALSE; END IF;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.verify_manual_action_source(TEXT,TEXT,TEXT,TEXT[]) FROM PUBLIC;
