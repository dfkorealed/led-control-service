-- Explicit guarded cutover only. Never part of prisma migrate deploy. Installing
-- this function does not register a worker, enable the API purge flag, provision
-- a login credential, or certify Gateway/MQTT publisher safety.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'command_retention_owner') THEN
    CREATE ROLE command_retention_owner NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'command_retention_worker') THEN
    CREATE ROLE command_retention_worker NOLOGIN NOINHERIT;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public, command_protected TO command_retention_owner, command_retention_worker;
GRANT SELECT ON public."Command", public."CommandDispatch", public."CommandFixtureResult",
  public."MqttOutbox", public."ManualOverride", public."AutomationExecution",
  public."MonitoringActivity", public."GatewayRecommissionJob",
  public."UnresolvedCommandHold", public."UnresolvedCommandHoldTarget",
  public."LateSetReceipt", public."CommandReplayFence",
  public."LegacyStatusCheckDispatchFence" TO command_retention_owner;
-- The nonlogin definer reads only the protected manual provenance needed to
-- resolve an Override alias after its Command FK has been detached. No app or
-- worker principal gets this key or a signer/alias-lookup function.
GRANT SELECT ON command_protected.manual_source_key,
  command_protected.retired_manual_source_proof TO command_retention_owner;
GRANT DELETE ON public."Command" TO command_retention_owner;
GRANT SELECT, DELETE ON public."CommandPublishAttempt" TO command_retention_owner;
GRANT SELECT ON public."CommandPublishEpoch" TO command_retention_owner;
GRANT UPDATE ("generation") ON public."CommandPublishEpoch" TO command_retention_owner;
GRANT EXECUTE ON FUNCTION command_protected.valid_purge_barrier(TEXT,INTEGER,TEXT)
  TO command_retention_owner;
GRANT SELECT ON public."CommandPurgeBarrierEvidence" TO command_retention_owner;
GRANT SELECT ON public."CommandPublishEpoch", public."CommandPublishMember", public."CommandPublishAttempt"
  TO command_retention_worker;
GRANT UPDATE ("generation") ON public."CommandPublishEpoch" TO command_retention_worker;
GRANT INSERT ON public."CommandPurgeBarrierEvidence" TO command_retention_worker;
GRANT EXECUTE ON FUNCTION command_protected.purge_barrier_snapshot(INTEGER) TO command_retention_worker;
GRANT UPDATE ("updatedAt") ON public."Command" TO command_retention_owner;

-- The dedicated worker can stage only derived safety/copy cleanup data. It
-- cannot directly DELETE Command/dispatch/result, manual executions, or ACK.
GRANT SELECT ON public."Command", public."CommandDispatch", public."CommandFixtureResult",
  public."MqttOutbox", public."ManualOverride", public."ManualOverrideFixture",
  public."AutomationExecution", public."AutomationExecutionFixtureResult",
  public."ManualExecutionReplayReceipt", public."MonitoringActivity",
  public."GatewayRecommissionJob", public."UnresolvedCommandHold",
  public."UnresolvedCommandHoldTarget", public."LateSetReceipt",
  public."LateSetTerminalFence", public."CommandReplayFence",
  public."LegacyStatusCheckDispatchFence", public."CommandRetentionAttempt",
  public."Fixture", public."Gateway", public."Site" TO command_retention_worker;
-- PostgreSQL requires UPDATE privilege for SELECT ... FOR UPDATE. Grant only
-- the non-identity audit timestamp; the worker cannot rewrite original
-- target, key, status, or createdAt columns.
GRANT UPDATE ("updatedAt") ON public."Command" TO command_retention_worker;
GRANT INSERT ON public."CommandReplayFence", public."UnresolvedCommandHold",
  public."UnresolvedCommandHoldTarget", public."LateSetReceipt",
  public."LegacyStatusCheckDispatchFence", public."ManualExecutionReplayReceipt",
  public."CommandRetentionAttempt" TO command_retention_worker;
GRANT UPDATE ON public."UnresolvedCommandHold", public."MonitoringActivity",
  public."CommandRetentionAttempt" TO command_retention_worker;
GRANT DELETE ON public."MonitoringActivity" TO command_retention_worker;
GRANT EXECUTE ON FUNCTION public."lock_automation_membership_mutation"() TO command_retention_worker;
GRANT EXECUTE ON FUNCTION command_protected.detach_expired_manual_source(TEXT),
  command_protected.retire_manual_execution_detail(TEXT,TEXT,TIMESTAMPTZ,TEXT),
  command_protected.cleanup_retired_manual_ack(TEXT,TEXT)
  TO command_retention_worker;

-- Explicitly provisioned during guarded cutover, never in migrate deploy or
-- source control. This is a DB-held verification copy of the durable app HMAC
-- keyring, not the independent DB-only manual-source key. The definer uses it
-- only for exact boolean comparisons against original Command/dispatch rows;
-- no worker/runtime role receives SELECT or a generic signing oracle.
CREATE TABLE command_protected.command_safety_verify_key (
  "keyVersion" INTEGER PRIMARY KEY,
  "secret" BYTEA NOT NULL CHECK (octet_length("secret") = 32)
);
REVOKE ALL ON command_protected.command_safety_verify_key FROM PUBLIC;
ALTER TABLE command_protected.command_safety_verify_key OWNER TO command_retention_owner;

CREATE FUNCTION command_protected.matches_exact_command_digest(
  p_domain TEXT, p_parts TEXT[], p_expected TEXT, p_key_version INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  secret_value BYTEA;
  encoded_parts TEXT;
  canonical_tuple TEXT;
BEGIN
  IF p_expected !~ '^hmac-sha256:[a-f0-9]{64}$' OR p_parts IS NULL
    OR array_position(p_parts, NULL) IS NOT NULL THEN RETURN FALSE; END IF;
  SELECT "secret" INTO secret_value
  FROM command_protected.command_safety_verify_key
  WHERE "keyVersion" = p_key_version;
  IF secret_value IS NULL THEN RETURN FALSE; END IF;
  SELECT string_agg(to_json(part)::text, ',' ORDER BY ordinal)
    INTO encoded_parts FROM unnest(p_parts) WITH ORDINALITY AS value(part, ordinal);
  canonical_tuple := '[' || to_json(p_domain)::text
    || CASE WHEN encoded_parts IS NULL THEN '' ELSE ',' || encoded_parts END || ']';
  RETURN p_expected = 'hmac-sha256:' || encode(public.hmac(
    convert_to(canonical_tuple, 'UTF8'), secret_value, 'sha256'), 'hex');
END;
$$;
REVOKE ALL ON FUNCTION command_protected.matches_exact_command_digest(TEXT,TEXT[],TEXT,INTEGER)
  FROM PUBLIC;
ALTER FUNCTION command_protected.matches_exact_command_digest(TEXT,TEXT[],TEXT,INTEGER)
  OWNER TO command_retention_owner;

CREATE FUNCTION command_protected.three_calendar_months_before_utc(p_now TIMESTAMPTZ)
RETURNS TIMESTAMP
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT (p_now AT TIME ZONE 'UTC') - INTERVAL '3 months' $$;
ALTER FUNCTION command_protected.three_calendar_months_before_utc(TIMESTAMPTZ)
  OWNER TO command_retention_owner;
GRANT EXECUTE ON FUNCTION command_protected.three_calendar_months_before_utc(TIMESTAMPTZ)
  TO command_retention_worker;

CREATE FUNCTION command_protected.delete_expired_command_candidate(
  p_command_id TEXT, p_override_id TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  command_row public."Command"%ROWTYPE;
  set_dispatch public."CommandDispatch"%ROWTYPE;
  hold_row public."UnresolvedCommandHold"%ROWTYPE;
  receipt_row public."LateSetReceipt"%ROWTYPE;
  expected_targets TEXT[];
  dispatch_targets TEXT[];
  hold_targets TEXT[];
  receipt_targets TEXT[];
  cutoff TIMESTAMP(3);
  dimming_count INTEGER;
  set_gateway_id TEXT;
  manual_proof_count INTEGER;
  manual_alias_match_count INTEGER;
BEGIN
  PERFORM public.lock_automation_membership_mutation();
  PERFORM pg_advisory_xact_lock(8052026092501::bigint);
  -- A setting only locates a signed capability, never authorizes it by itself.
  IF NOT command_protected.valid_purge_barrier(current_setting('command.purge_evidence', true),
    NULLIF(current_setting('command.purge_generation', true), '')::integer,
    current_setting('command.purge_boot', true)) THEN RETURN FALSE; END IF;
  -- DB transaction clock is the sole deletion clock. The exact cutoff row
  -- remains, including Jan/Feb/May month-end clamp boundaries.
  SELECT (("proof"->>'cutoff')::timestamptz AT TIME ZONE 'UTC') INTO cutoff
    FROM public."CommandPurgeBarrierEvidence"
    WHERE "id" = current_setting('command.purge_evidence', true);
  SELECT * INTO command_row FROM public."Command"
  WHERE "id" = p_command_id FOR UPDATE;
  IF NOT FOUND OR command_row."createdAt" >= cutoff THEN RETURN FALSE; END IF;

  SELECT count(*), min("gatewayId") INTO dimming_count, set_gateway_id
  FROM public."CommandDispatch"
  WHERE "commandId" = p_command_id AND "kind" = 'dimming';
  IF dimming_count <> 1 THEN RETURN FALSE; END IF;
  SELECT * INTO set_dispatch FROM public."CommandDispatch"
    WHERE "commandId" = p_command_id AND "kind" = 'dimming';
  IF EXISTS (SELECT 1 FROM public."CommandDispatch" AS dispatch
    WHERE dispatch."commandId" = p_command_id
      AND (NOT EXISTS (SELECT 1 FROM public."CommandFixtureResult" AS result
        WHERE result."dispatchId" = dispatch."id")
        OR NOT EXISTS (SELECT 1 FROM public."MqttOutbox" AS outbox
          WHERE outbox."dispatchId" = dispatch."id" AND outbox."publishedAt" IS NOT NULL
            AND outbox."lockedBy" IS NULL AND outbox."lockedAt" IS NULL
            AND outbox."leaseExpiresAt" IS NULL AND outbox."deadLetteredAt" IS NULL
            AND outbox."supersededAt" IS NULL))) THEN RETURN FALSE; END IF;

  IF NOT EXISTS (SELECT 1 FROM public."CommandReplayFence" AS fence
    WHERE fence."siteId" = command_row."siteId"
      AND fence."domain" = CASE WHEN command_row."requestedBy" IS NULL
        THEN 'set-replay-orphan' ELSE 'set-replay' END
      AND fence."principalSnapshot" = COALESCE(command_row."requestedBy", '__unattributed__')
      AND command_protected.matches_exact_command_digest(
        fence."domain", CASE WHEN command_row."requestedBy" IS NULL
          THEN ARRAY[command_row."siteId", command_row."clientRequestId"]::TEXT[]
          ELSE ARRAY[command_row."siteId", command_row."requestedBy",
            command_row."clientRequestId"]::TEXT[] END,
        fence."keyDigest", fence."keyVersion"))
    THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM public."CommandDispatch" AS dispatch
    WHERE dispatch."commandId" = p_command_id AND dispatch."kind" = 'status_check'
      AND NOT EXISTS (SELECT 1 FROM public."LegacyStatusCheckDispatchFence" AS fence
        WHERE fence."siteId" = command_row."siteId"
          AND command_protected.matches_exact_command_digest(
            'legacy-status-check-dispatch', ARRAY[dispatch."id"]::TEXT[],
            fence."dispatchDigest", fence."keyVersion"))) THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM public."CommandDispatch" AS dispatch
    WHERE dispatch."commandId" = p_command_id AND dispatch."kind" = 'status_check'
      AND dispatch."clientRequestId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public."CommandReplayFence" AS fence
        WHERE fence."siteId" = command_row."siteId"
          AND fence."domain" = 'legacy-status-check-global'
          AND fence."principalSnapshot" = '__legacy_global__'
          AND command_protected.matches_exact_command_digest(
            fence."domain", ARRAY[dispatch."clientRequestId"]::TEXT[],
            fence."keyDigest", fence."keyVersion"))) THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM public."CommandDispatch" AS dispatch
    WHERE dispatch."commandId" = p_command_id AND dispatch."kind" = 'status_check'
    GROUP BY dispatch."verificationAttempt"
    HAVING dispatch."verificationAttempt" IS NULL
      OR count(*) FILTER (WHERE dispatch."clientRequestId" IS NOT NULL) <> 1)
    THEN RETURN FALSE; END IF;
  IF command_row."outcome" IS NULL OR command_row."outcome" = 'pending' THEN RETURN FALSE; END IF;
  SELECT * INTO hold_row FROM public."UnresolvedCommandHold"
    WHERE "originalCommandId" = p_command_id;
  IF command_row."outcome" = 'unknown' THEN
    -- The restricted worker may call this definer without the TS preflight.
    -- A hold/receipt's existence is insufficient: preserve exactly the old
    -- Set's scope, complete targets, brightness and authenticated wire tuple.
    IF hold_row."id" IS NULL OR hold_row."siteId" <> command_row."siteId"
      OR hold_row."gatewayId" <> set_dispatch."gatewayId"
      OR hold_row."originalCreatedAt" <> command_row."createdAt"
      OR jsonb_typeof(command_row."targetFixtureIds") IS DISTINCT FROM 'array'
      THEN RETURN FALSE; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(command_row."targetFixtureIds") AS item
      WHERE jsonb_typeof(item) <> 'string') THEN RETURN FALSE; END IF;
    SELECT array_agg(id ORDER BY id) INTO expected_targets
      FROM jsonb_array_elements_text(command_row."targetFixtureIds") AS value(id);
    IF COALESCE(cardinality(expected_targets), 0) = 0
      OR cardinality(expected_targets) <> (SELECT count(DISTINCT id) FROM unnest(expected_targets) AS value(id))
      THEN RETURN FALSE; END IF;
    SELECT array_agg("fixtureId" ORDER BY "fixtureId") INTO dispatch_targets
      FROM public."CommandFixtureResult" WHERE "dispatchId" = set_dispatch."id";
    SELECT array_agg("fixtureId" ORDER BY "fixtureId") INTO hold_targets
      FROM public."UnresolvedCommandHoldTarget" WHERE "holdId" = hold_row."id";
    IF dispatch_targets IS DISTINCT FROM expected_targets OR hold_targets IS DISTINCT FROM expected_targets
      OR EXISTS (SELECT 1 FROM public."UnresolvedCommandHoldTarget"
        WHERE "holdId" = hold_row."id" AND "expectedBrightness" <> command_row."brightness")
      OR hold_row."verificationAttemptCount" < COALESCE((SELECT max("verificationAttempt")
        FROM public."CommandDispatch" WHERE "commandId" = p_command_id AND "kind" = 'status_check'), 0)
      OR (SELECT count(*) FROM public."LateSetReceipt" WHERE "holdId" = hold_row."id") <> 1
      THEN RETURN FALSE; END IF;
    SELECT * INTO receipt_row FROM public."LateSetReceipt" WHERE "holdId" = hold_row."id";
    IF receipt_row."originalDispatchId" <> set_dispatch."id"
      OR NOT command_protected.matches_exact_command_digest('late-set-wire',
        ARRAY[command_row."siteId", set_dispatch."gatewayId", command_row."id",
          set_dispatch."id", set_dispatch."idempotencyKey", set_dispatch."sequence"::text],
        receipt_row."wireDigest", receipt_row."keyVersion")
      OR jsonb_typeof(receipt_row."targetFixtureIds") IS DISTINCT FROM 'array'
      THEN RETURN FALSE; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(receipt_row."targetFixtureIds") AS item
      WHERE jsonb_typeof(item) <> 'string') THEN RETURN FALSE; END IF;
    SELECT array_agg(id ORDER BY id) INTO receipt_targets
      FROM jsonb_array_elements_text(receipt_row."targetFixtureIds") AS value(id);
    IF receipt_targets IS DISTINCT FROM expected_targets THEN RETURN FALSE; END IF;
  ELSIF hold_row."id" IS NOT NULL THEN
    -- A terminal original must not leave an active unresolved alias behind.
    RETURN FALSE;
  END IF;

  -- The caller's nullable Override ID is not evidence. Detach leaves the
  -- original Command FK NULL, so independently recover its alias from the
  -- DB-keyed retirement proof. Wrong/null aliases cannot suppress raw-copy
  -- checks. Missing/rotated-away proof keys fail closed through the FK.
  SELECT count(*), count(*) FILTER (WHERE p_override_id IS NOT NULL
      AND proof."commandCreatedAt" = command_row."createdAt"
      AND proof."overrideAliasDigest" = 'hmac-sha256:' || encode(public.hmac(convert_to(
        jsonb_build_array('retired-manual-override', command_row."siteId",
          set_gateway_id, p_override_id)::text, 'UTF8'), key."secret", 'sha256'), 'hex'))
    INTO manual_proof_count, manual_alias_match_count
  FROM command_protected.retired_manual_source_proof AS proof
  JOIN command_protected.manual_source_key AS key
    ON key."keyVersion" = proof."keyVersion"
  WHERE proof."siteId" = command_row."siteId"
    AND proof."gatewayId" = set_gateway_id
    AND proof."commandAliasDigest" = 'hmac-sha256:' || encode(public.hmac(convert_to(
      jsonb_build_array('retired-manual-command', command_row."siteId",
        set_gateway_id, p_command_id)::text, 'UTF8'), key."secret", 'sha256'), 'hex');
  IF (manual_proof_count = 0 AND p_override_id IS NOT NULL)
    OR (manual_proof_count > 0 AND
      (p_override_id IS NULL OR manual_alias_match_count <> manual_proof_count))
    THEN RETURN FALSE; END IF;

  IF EXISTS (SELECT 1 FROM public."ManualOverride" WHERE "commandId" = p_command_id)
    OR EXISTS (SELECT 1 FROM public."AutomationExecution" AS execution
      WHERE execution."siteId" = command_row."siteId"
        AND execution."kind" = 'action_result'
        AND (execution."payload"->>'sourceId' = p_command_id
          OR (p_override_id IS NOT NULL AND
            (execution."payload"->>'sourceId' = p_override_id
              OR execution."manualOverrideId" = p_override_id))))
    OR EXISTS (SELECT 1 FROM public."MonitoringActivity"
      WHERE "siteId" = command_row."siteId" AND "sourceType" = 'command'
        AND "sourceKey" LIKE p_command_id || ':%')
    THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM public."GatewayRecommissionJob" AS job
    WHERE job."siteId" = command_row."siteId"
      AND (job."status" IN ('prepared', 'mqtt_revocation_pending', 'mqtt_revoked')
        OR job."targetSnapshot"::text LIKE '%' || p_command_id || '%'
        OR EXISTS (SELECT 1 FROM public."CommandDispatch" AS dispatch
          WHERE dispatch."commandId" = p_command_id
            AND job."targetSnapshot"::text LIKE '%' || dispatch."id" || '%')))
    THEN RETURN FALSE; END IF;

  -- The final check remains in the same automation/exclusive-permit transaction.
  IF NOT command_protected.valid_purge_barrier(current_setting('command.purge_evidence', true),
    NULLIF(current_setting('command.purge_generation', true), '')::integer,
    current_setting('command.purge_boot', true)) THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM public."CommandPublishAttempt" a JOIN public."CommandDispatch" d
    ON d."id" = a."dispatchId" WHERE d."commandId" = p_command_id
      AND a."generation" <> current_setting('command.purge_generation')::integer) THEN RETURN FALSE; END IF;
  DELETE FROM public."CommandPublishAttempt" a USING public."CommandDispatch" d
    WHERE a."dispatchId" = d."id" AND d."commandId" = p_command_id;
  DELETE FROM public."Command"
  WHERE "id" = p_command_id AND "createdAt" < cutoff;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.delete_expired_command_candidate(TEXT,TEXT) FROM PUBLIC;
ALTER FUNCTION command_protected.delete_expired_command_candidate(TEXT,TEXT)
  OWNER TO command_retention_owner;
GRANT EXECUTE ON FUNCTION command_protected.delete_expired_command_candidate(TEXT,TEXT)
  TO command_retention_worker;

COMMIT;
