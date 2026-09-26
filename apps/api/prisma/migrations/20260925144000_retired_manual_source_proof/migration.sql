-- Additive only: no key provisioning, Command deletion, runtime grants or
-- guarded FK cutover. Proofs are DB-keyed safety state, not command history.
CREATE TABLE command_protected.retired_manual_source_proof (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "siteId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "commandCreatedAt" TIMESTAMP(3) NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "commandAliasDigest" TEXT NOT NULL,
  "overrideAliasDigest" TEXT NOT NULL,
  "targetCount" INTEGER NOT NULL CHECK ("targetCount" > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RetiredManualSourceProof_site_fkey"
    FOREIGN KEY ("siteId") REFERENCES public."Site"("id") ON DELETE CASCADE,
  CONSTRAINT "RetiredManualSourceProof_key_fkey"
    FOREIGN KEY ("keyVersion") REFERENCES command_protected.manual_source_key("keyVersion")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "RetiredManualSourceProof_digest_check" CHECK (
    "commandAliasDigest" ~ '^hmac-sha256:[a-f0-9]{64}$'
    AND "overrideAliasDigest" ~ '^hmac-sha256:[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "RetiredManualSourceProof_command_alias_key"
  ON command_protected.retired_manual_source_proof
  ("siteId", "gatewayId", "keyVersion", "commandAliasDigest");
CREATE UNIQUE INDEX "RetiredManualSourceProof_override_alias_key"
  ON command_protected.retired_manual_source_proof
  ("siteId", "gatewayId", "keyVersion", "overrideAliasDigest");
CREATE INDEX "RetiredManualSourceProof_site_created_idx"
  ON command_protected.retired_manual_source_proof ("siteId", "createdAt");

CREATE TABLE command_protected.retired_manual_source_target (
  "proofId" TEXT NOT NULL,
  "targetDigest" TEXT NOT NULL CHECK ("targetDigest" ~ '^hmac-sha256:[a-f0-9]{64}$'),
  CONSTRAINT "RetiredManualSourceTarget_pkey" PRIMARY KEY ("proofId", "targetDigest"),
  CONSTRAINT "RetiredManualSourceTarget_proof_fkey"
    FOREIGN KEY ("proofId") REFERENCES command_protected.retired_manual_source_proof("id")
    ON DELETE CASCADE
);
REVOKE ALL ON command_protected.retired_manual_source_proof,
  command_protected.retired_manual_source_target FROM PUBLIC;

-- A purge transaction may invoke this only after it owns the global mutation
-- fence and original row locks. The function independently rechecks the old
-- Command cutoff and live Command/Override/Dispatch/target provenance, then
-- stages a minimal receipt. Staging an active Override is safe by itself:
-- the current Command FK still cascades on deletion, so the guarded detach
-- cutover must precede any active Command purge. This function is ungranted.
CREATE FUNCTION command_protected.stage_retired_manual_source(p_override_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  source_record RECORD;
  source_secret BYTEA;
  source_version INTEGER;
  target_ids TEXT[];
  proof_id TEXT;
  command_digest TEXT;
  override_digest TEXT;
BEGIN
  SELECT override."commandId" INTO source_record
  FROM public."ManualOverride" AS override WHERE override."id" = p_override_id;
  IF NOT FOUND OR source_record."commandId" IS NULL THEN RETURN FALSE; END IF;

  -- Command before Override is the common purge mutation order. Recheck the
  -- link after both locks; a concurrent delete/update must not stage a stale
  -- source or leak an active override through the old cascade FK.
  PERFORM 1 FROM public."Command" AS command
  WHERE command."id" = source_record."commandId" FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  SELECT override."id", override."commandId", override."siteId",
    override."gatewayId", override."brightnessPercent", override."endedAt",
    override."targetCount", command."createdAt"
  INTO source_record
  FROM public."ManualOverride" AS override
  JOIN public."Command" AS command ON command."id" = override."commandId"
  WHERE override."id" = p_override_id
  FOR UPDATE OF override;
  IF NOT FOUND OR source_record."createdAt" >= (clock_timestamp() AT TIME ZONE 'UTC' - INTERVAL '3 months')
  THEN RETURN FALSE; END IF;

  SELECT array_agg(target."fixtureId" ORDER BY target."fixtureId") INTO target_ids
  FROM public."ManualOverrideFixture" AS target
  WHERE target."manualOverrideId" = source_record."id";
  IF target_ids IS NULL OR cardinality(target_ids) <> source_record."targetCount"
    OR NOT command_protected.verify_manual_action_source(
      source_record."siteId", source_record."gatewayId", source_record."commandId", target_ids)
  THEN RETURN FALSE; END IF;

  SELECT key."keyVersion", key."secret" INTO source_version, source_secret
  FROM command_protected.manual_source_key AS key WHERE key."active";
  IF source_version IS NULL THEN
    RAISE EXCEPTION 'retired manual source key unavailable' USING ERRCODE = '55000';
  END IF;
  command_digest := 'hmac-sha256:' || encode(public.hmac(convert_to(
    jsonb_build_array('retired-manual-command', source_record."siteId",
      source_record."gatewayId", source_record."commandId")::text, 'UTF8'),
    source_secret, 'sha256'), 'hex');
  override_digest := 'hmac-sha256:' || encode(public.hmac(convert_to(
    jsonb_build_array('retired-manual-override', source_record."siteId",
      source_record."gatewayId", source_record."id")::text, 'UTF8'),
    source_secret, 'sha256'), 'hex');

  SELECT proof."id" INTO proof_id
  FROM command_protected.retired_manual_source_proof AS proof
  WHERE proof."siteId" = source_record."siteId"
    AND proof."gatewayId" = source_record."gatewayId"
    AND proof."keyVersion" = source_version
    AND proof."commandAliasDigest" = command_digest
  FOR UPDATE;
  IF proof_id IS NULL THEN
    INSERT INTO command_protected.retired_manual_source_proof
      ("siteId", "gatewayId", "commandCreatedAt", "keyVersion",
       "commandAliasDigest", "overrideAliasDigest", "targetCount")
    VALUES (source_record."siteId", source_record."gatewayId", source_record."createdAt",
      source_version, command_digest, override_digest, source_record."targetCount")
    RETURNING "id" INTO proof_id;
  ELSIF NOT EXISTS (
    SELECT 1 FROM command_protected.retired_manual_source_proof AS proof
    WHERE proof."id" = proof_id
      AND proof."commandCreatedAt" = source_record."createdAt"
      AND proof."overrideAliasDigest" = override_digest
      AND proof."targetCount" = source_record."targetCount"
  ) THEN
    RAISE EXCEPTION 'retired manual source proof conflict' USING ERRCODE = '23514';
  END IF;

  INSERT INTO command_protected.retired_manual_source_target ("proofId", "targetDigest")
  SELECT proof_id, 'hmac-sha256:' || encode(public.hmac(convert_to(
    jsonb_build_array('retired-manual-target', source_record."siteId",
      source_record."gatewayId", target_id)::text, 'UTF8'), source_secret, 'sha256'), 'hex')
  FROM unnest(target_ids) AS target(target_id)
  ON CONFLICT DO NOTHING;
  IF (SELECT count(*) FROM command_protected.retired_manual_source_target
      WHERE "proofId" = proof_id) <> source_record."targetCount" THEN
    RAISE EXCEPTION 'retired manual source target proof incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.stage_retired_manual_source(TEXT) FROM PUBLIC;

-- Only a scoped boolean check is exposed at the guarded cutover. A retired
-- proof contains neither old source UUID nor fixture UUID nor brightness.
CREATE FUNCTION command_protected.verify_retired_manual_action_source(
  p_site_id TEXT, p_gateway_id TEXT, p_source_id TEXT, p_fixture_ids TEXT[]
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  key_record RECORD;
  proof_record RECORD;
  command_digest TEXT;
  override_digest TEXT;
BEGIN
  IF p_site_id IS NULL OR p_gateway_id IS NULL OR p_source_id IS NULL
    OR p_fixture_ids IS NULL OR cardinality(p_fixture_ids) = 0
    OR EXISTS (SELECT 1 FROM unnest(p_fixture_ids) AS target(id) WHERE id IS NULL)
    OR (SELECT count(DISTINCT id) FROM unnest(p_fixture_ids) AS target(id)) <> cardinality(p_fixture_ids)
  THEN RETURN FALSE; END IF;

  -- Loop over bounded key versions, not all historical proofs for a Site.
  -- Indexed alias lookup avoids a site-wide scan on every late Gateway event.
  FOR key_record IN SELECT "keyVersion", "secret"
    FROM command_protected.manual_source_key
  LOOP
    command_digest := 'hmac-sha256:' || encode(public.hmac(convert_to(
      jsonb_build_array('retired-manual-command', p_site_id, p_gateway_id, p_source_id)::text,
      'UTF8'), key_record."secret", 'sha256'), 'hex');
    override_digest := 'hmac-sha256:' || encode(public.hmac(convert_to(
      jsonb_build_array('retired-manual-override', p_site_id, p_gateway_id, p_source_id)::text,
      'UTF8'), key_record."secret", 'sha256'), 'hex');
    SELECT proof."id", proof."targetCount" INTO proof_record
    FROM command_protected.retired_manual_source_proof AS proof
    WHERE proof."siteId" = p_site_id AND proof."gatewayId" = p_gateway_id
      AND proof."keyVersion" = key_record."keyVersion"
      AND (proof."commandAliasDigest" = command_digest
        OR proof."overrideAliasDigest" = override_digest)
    FOR SHARE;
    IF FOUND AND proof_record."targetCount" = (
        SELECT count(*) FROM command_protected.retired_manual_source_target AS target
        WHERE target."proofId" = proof_record."id")
      AND NOT EXISTS (
        SELECT 1 FROM unnest(p_fixture_ids) AS offered(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM command_protected.retired_manual_source_target AS target
          WHERE target."proofId" = proof_record."id"
            AND target."targetDigest" = 'hmac-sha256:' || encode(public.hmac(convert_to(
              jsonb_build_array('retired-manual-target', p_site_id,
                p_gateway_id, offered.id)::text, 'UTF8'), key_record."secret", 'sha256'), 'hex')))
    THEN RETURN TRUE; END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.verify_retired_manual_action_source(TEXT,TEXT,TEXT,TEXT[]) FROM PUBLIC;
