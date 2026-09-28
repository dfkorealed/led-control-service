-- Explicit B-retirement experiment. Never included in prisma migrate deploy.
-- Install only after runtime/retention-worker role separation and producer
-- stop/drain. The ungranted function is called by a protected retention worker
-- *after* it verifies the versioned full-event HMAC in application code.
BEGIN;

CREATE TABLE command_protected.manual_execution_retirement_permit (
  "transactionId" BIGINT NOT NULL,
  "receiptId" TEXT NOT NULL,
  PRIMARY KEY ("transactionId", "receiptId")
);
REVOKE ALL ON command_protected.manual_execution_retirement_permit FROM PUBLIC;

CREATE FUNCTION command_protected.guard_manual_execution_retirement()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."sourceRetiredAt" IS NOT NULL OR NEW."sourceRetiredAt" IS NULL
    OR to_jsonb(NEW) - 'sourceRetiredAt' IS DISTINCT FROM to_jsonb(OLD) - 'sourceRetiredAt'
    OR NOT EXISTS (
      SELECT 1 FROM command_protected.manual_execution_retirement_permit AS permit
      WHERE permit."transactionId" = txid_current() AND permit."receiptId" = OLD."id")
  THEN
    RAISE EXCEPTION 'manual execution receipt retirement requires protected permit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.guard_manual_execution_retirement() FROM PUBLIC;
DROP TRIGGER "ManualExecutionReplayReceipt_immutable" ON public."ManualExecutionReplayReceipt";
CREATE TRIGGER "ManualExecutionReplayReceipt_immutable"
BEFORE UPDATE ON public."ManualExecutionReplayReceipt"
FOR EACH ROW EXECUTE FUNCTION command_protected.guard_manual_execution_retirement();

-- JS canonicalPayloadHash sorts object keys before hashing. The fixed C order
-- matches the ACK's ASCII field names, but this is not a generic signer API.
CREATE FUNCTION command_protected.canonical_manual_ack_json(value JSONB)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE result TEXT;
BEGIN
  IF jsonb_typeof(value) = 'object' THEN
    SELECT COALESCE(string_agg(to_jsonb(entry.key)::text || ':' ||
      command_protected.canonical_manual_ack_json(entry.value), ','
      ORDER BY entry.key COLLATE "C"), '')
    INTO result FROM jsonb_each(value) AS entry;
    RETURN '{' || result || '}';
  END IF;
  IF jsonb_typeof(value) = 'array' THEN
    SELECT COALESCE(string_agg(command_protected.canonical_manual_ack_json(entry.value), ','
      ORDER BY entry.ordinal), '')
    INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(value, ordinal);
    RETURN '[' || result || ']';
  END IF;
  RETURN value::text;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.canonical_manual_ack_json(JSONB) FROM PUBLIC;

CREATE FUNCTION command_protected.retire_manual_execution_detail(
  p_execution_id TEXT, p_command_id TEXT, p_cutoff TIMESTAMPTZ, p_report_hash TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE origin RECORD; detail RECORD; receipt RECORD; ack RECORD; ack_count BIGINT;
BEGIN
  -- No caller may choose a future cutoff and retire a still-visible Command.
  IF (p_cutoff AT TIME ZONE 'UTC') >
    ((clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '3 months')
    OR p_report_hash !~ '^sha256:[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'manual execution retirement cutoff invalid' USING ERRCODE = '23514'; END IF;

  -- Take relation locks before row locks so a concurrent legacy ACK writer
  -- cannot add a conflicting key after the exact-one ACK check. The final
  -- purge worker must use this same order and keep its batch bounded.
  LOCK TABLE public."MqttOutbox", public."AutomationExecution",
    public."ManualExecutionReplayReceipt" IN SHARE ROW EXCLUSIVE MODE;

  SELECT command."id", command."siteId", command."createdAt",
    override."id" AS "overrideId", override."gatewayId"
  INTO origin FROM public."Command" AS command
  JOIN public."ManualOverride" AS override ON override."commandId" = command."id"
  WHERE command."id" = p_command_id
  FOR UPDATE OF command, override;
  IF NOT FOUND OR origin."createdAt" >= (p_cutoff AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'manual execution retirement source unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT execution.* INTO detail FROM public."AutomationExecution" AS execution
  WHERE execution."id" = p_execution_id FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  IF detail."siteId" IS DISTINCT FROM origin."siteId"
    OR detail."gatewayId" IS DISTINCT FROM origin."gatewayId"
    OR detail."manualOverrideId" IS DISTINCT FROM origin."overrideId"
    OR detail."kind"::text <> 'action_result'
    OR detail."payload"->>'sourceType' <> 'manual_override'
    OR detail."payload"->>'sourceId' NOT IN (p_command_id, origin."overrideId")
    OR (detail."payloadHash" IS NOT NULL AND detail."payloadHash" <> p_report_hash)
  THEN RAISE EXCEPTION 'manual execution retirement attribution mismatch' USING ERRCODE = '23514'; END IF;

  SELECT * INTO receipt FROM public."ManualExecutionReplayReceipt" AS item
  WHERE item."siteId" = origin."siteId" AND item."gatewayId" = origin."gatewayId"
    AND item."eventId" = detail."eventId" AND item."sequence" = detail."sequence"
  FOR UPDATE;
  IF NOT FOUND OR receipt."sourceRetiredAt" IS NOT NULL THEN
    RAISE EXCEPTION 'manual execution retirement receipt missing' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO ack_count FROM public."MqttOutbox" AS item
  WHERE item."applicationAckKey" LIKE
    ('automation-execution:' || detail."gatewayId" || ':' || detail."eventId" || ':' || detail."sequence" || ':%');
  IF ack_count <> 1 THEN
    RAISE EXCEPTION 'manual execution retirement ACK ambiguous' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO ack FROM public."MqttOutbox" AS item
  WHERE item."applicationAckKey" =
    ('automation-execution:' || detail."gatewayId" || ':' || detail."eventId" || ':' || detail."sequence" || ':' || p_report_hash)
  FOR UPDATE;
  IF NOT FOUND OR ack."gatewayId" IS DISTINCT FROM detail."gatewayId"
    OR ack."dispatchId" IS NOT NULL OR ack."revision" IS NOT NULL
    OR ack."topic" <> ('sites/' || origin."siteId" || '/gateways/' || origin."gatewayId" || '/acks/automation/execution-ingested')
    OR ack."payload"->>'gatewayId' <> detail."gatewayId"
    OR ack."payload"->>'eventId' <> detail."eventId"
    OR ack."payload"->>'sequence' <> detail."sequence"::text
    OR ack."payload"->>'reportPayloadHash' <> p_report_hash
    OR (((ack."payload"->>'ingestedAt')::timestamptz) AT TIME ZONE 'UTC')
      IS DISTINCT FROM receipt."ackIngestedAt"
    OR ack."payloadHash" <> ('sha256:' || encode(public.digest(convert_to(
      command_protected.canonical_manual_ack_json(ack."payload"), 'UTF8'), 'sha256'), 'hex'))
  THEN RAISE EXCEPTION 'manual execution retirement ACK mismatch' USING ERRCODE = '23514'; END IF;

  INSERT INTO command_protected.manual_execution_retirement_permit ("transactionId", "receiptId")
  VALUES (txid_current(), receipt."id");
  UPDATE public."ManualExecutionReplayReceipt" SET "sourceRetiredAt" =
    (clock_timestamp() AT TIME ZONE 'UTC') WHERE "id" = receipt."id";
  DELETE FROM command_protected.manual_execution_retirement_permit
    WHERE "transactionId" = txid_current() AND "receiptId" = receipt."id";
  -- The FK CASCADE physically removes every manual fixture result; the ACK
  -- outbox remains until published/lease-safe bounded cleanup.
  DELETE FROM public."AutomationExecution" WHERE "id" = p_execution_id;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.retire_manual_execution_detail(TEXT,TEXT,TIMESTAMPTZ,TEXT) FROM PUBLIC;

-- A published application ACK is a derived delivery fingerprint, not the
-- Command original. Keep unpublished, leased, dead-lettered or otherwise
-- uncertain rows for retry/alert; exact replay can recreate only a proven ACK.
CREATE FUNCTION command_protected.cleanup_retired_manual_ack(
  p_outbox_id TEXT, p_report_hash TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE ack RECORD; receipt RECORD;
BEGIN
  SELECT * INTO ack FROM public."MqttOutbox" AS item
  WHERE item."id" = p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  IF ack."publishedAt" IS NULL OR ack."lockedBy" IS NOT NULL
    OR ack."lockedAt" IS NOT NULL OR ack."leaseExpiresAt" IS NOT NULL
    OR ack."deadLetteredAt" IS NOT NULL OR ack."supersededAt" IS NOT NULL
    OR ack."dispatchId" IS NOT NULL OR ack."revision" IS NOT NULL
    OR ack."gatewayId" IS NULL OR p_report_hash !~ '^sha256:[0-9a-f]{64}$'
  THEN RETURN FALSE; END IF;
  SELECT * INTO receipt FROM public."ManualExecutionReplayReceipt" AS item
  WHERE item."gatewayId" = ack."gatewayId"
    AND item."eventId" = ack."payload"->>'eventId'
    AND item."sequence" = (ack."payload"->>'sequence')::bigint
  FOR SHARE;
  IF NOT FOUND OR receipt."sourceRetiredAt" IS NULL
    OR ack."applicationAckKey" <>
      ('automation-execution:' || receipt."gatewayId" || ':' || receipt."eventId" || ':' || receipt."sequence" || ':' || p_report_hash)
    OR ack."topic" <> ('sites/' || receipt."siteId" || '/gateways/' || receipt."gatewayId" || '/acks/automation/execution-ingested')
    OR ack."payload"->>'gatewayId' <> receipt."gatewayId"
    OR ack."payload"->>'reportPayloadHash' <> p_report_hash
    OR (((ack."payload"->>'ingestedAt')::timestamptz) AT TIME ZONE 'UTC')
      IS DISTINCT FROM receipt."ackIngestedAt"
    OR ack."payloadHash" <> ('sha256:' || encode(public.digest(convert_to(
      command_protected.canonical_manual_ack_json(ack."payload"), 'UTF8'), 'sha256'), 'hex'))
  THEN RAISE EXCEPTION 'retired manual ACK proof mismatch' USING ERRCODE = '23514'; END IF;
  DELETE FROM public."MqttOutbox" WHERE "id" = p_outbox_id;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION command_protected.cleanup_retired_manual_ack(TEXT,TEXT) FROM PUBLIC;

COMMIT;
