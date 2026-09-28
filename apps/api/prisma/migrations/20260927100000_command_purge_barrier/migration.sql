-- Additive verifier only. No keys/attestations/credentials are provisioned and
-- no production purge function is installed by migrate deploy.
ALTER TABLE "CommandPurgeBarrierEvidence" ADD COLUMN "proof" JSONB;
CREATE TABLE command_protected.purge_barrier_verify_key (
  "keyVersion" INTEGER PRIMARY KEY CHECK ("keyVersion" > 0),
  "secret" BYTEA NOT NULL CHECK (octet_length("secret") = 32)
);
CREATE TABLE command_protected.purge_clock_attestation (
  "generation" INTEGER PRIMARY KEY REFERENCES "CommandPublishEpoch"("generation"),
  "primaryId" TEXT NOT NULL,
  "continuityId" TEXT NOT NULL,
  "clockDigest" TEXT NOT NULL CHECK ("clockDigest" ~ '^[a-f0-9]{64}$'),
  "healthy" BOOLEAN NOT NULL DEFAULT FALSE,
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  "validUntil" TIMESTAMPTZ(3) NOT NULL
);
REVOKE ALL ON command_protected.purge_barrier_verify_key,
  command_protected.purge_clock_attestation FROM PUBLIC, command_set_publisher, command_publish_retention;

CREATE FUNCTION command_protected.guard_purge_clock_continuity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'purge clock continuity is immutable'; END IF;
  IF (NEW."generation", NEW."primaryId", NEW."continuityId", NEW."clockDigest") IS DISTINCT FROM
    (OLD."generation", OLD."primaryId", OLD."continuityId", OLD."clockDigest")
    OR (NOT OLD."healthy" AND NEW."healthy") OR NEW."observedAt" < OLD."observedAt"
    OR NEW."validUntil" <= NEW."observedAt" THEN
    RAISE EXCEPTION 'purge clock continuity requires a new epoch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "purge_clock_continuity_guard" BEFORE UPDATE OR DELETE
  ON command_protected.purge_clock_attestation FOR EACH ROW
  EXECUTE FUNCTION command_protected.guard_purge_clock_continuity();
REVOKE ALL ON FUNCTION command_protected.guard_purge_clock_continuity() FROM PUBLIC;

CREATE FUNCTION command_protected.purge_barrier_snapshot(p_generation INTEGER)
RETURNS TABLE ("generation" INTEGER, "status" TEXT, "fencedAt" TIMESTAMPTZ,
  "dbNow" TIMESTAMPTZ, "cutoff" TIMESTAMPTZ, "primaryId" TEXT, "continuityId" TEXT,
  "healthy" BOOLEAN, "clockDigest" TEXT, "memberDigest" TEXT, "memberCount" INTEGER, "missingMembers" INTEGER)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e."generation", e."status"::text, e."fencedAt", date_trunc('milliseconds', clock_timestamp()),
    ((date_trunc('milliseconds', transaction_timestamp()) AT TIME ZONE 'UTC') - INTERVAL '3 months') AT TIME ZONE 'UTC',
    c."primaryId", c."continuityId",
    c."healthy" AND NOT pg_is_in_recovery() AND c."primaryId" = pg_postmaster_start_time()::text
      AND c."observedAt" <= clock_timestamp() AND c."validUntil" > clock_timestamp()
      AND clock_timestamp() - c."observedAt" <= INTERVAL '1 second', c."clockDigest",
    encode(public.digest(COALESCE((SELECT jsonb_agg(jsonb_build_array(m."workerId", m."brokerIdentity",
      m."quiesceAckAt") ORDER BY m."workerId")::text FROM public."CommandPublishMember" m
      WHERE m."generation" = p_generation), '[]'), 'sha256'), 'hex'),
    (SELECT count(*)::integer FROM public."CommandPublishMember" m WHERE m."generation" = p_generation),
    (SELECT count(*)::integer FROM public."CommandPublishMember" m
      WHERE m."generation" = p_generation AND m."quiesceAckAt" IS NULL)
  FROM public."CommandPublishEpoch" e
  JOIN command_protected.purge_clock_attestation c ON c."generation" = e."generation"
  WHERE e."generation" = p_generation;
$$;
REVOKE ALL ON FUNCTION command_protected.purge_barrier_snapshot(INTEGER) FROM PUBLIC;
GRANT USAGE ON SCHEMA command_protected TO command_publish_retention;
GRANT EXECUTE ON FUNCTION command_protected.purge_barrier_snapshot(INTEGER) TO command_publish_retention;

CREATE FUNCTION command_protected.valid_purge_barrier(p_id TEXT, p_generation INTEGER, p_boot TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  evidence public."CommandPurgeBarrierEvidence"%ROWTYPE;
  snapshot RECORD;
  proof JSONB;
  secret BYTEA;
  maximum TIMESTAMPTZ;
  signed_text TEXT;
BEGIN
  -- This capability is intentionally unusable outside a disposable cluster.
  IF current_database() !~ '^watermark_[0-9]+$' THEN RETURN FALSE; END IF;
  SELECT * INTO evidence FROM public."CommandPurgeBarrierEvidence" WHERE "id" = p_id;
  IF NOT FOUND OR evidence."generation" <> p_generation OR evidence."workerId" <> session_user
    OR evidence."proof" IS NULL THEN RETURN FALSE; END IF;
  proof := evidence."proof";
  IF proof->>'generation' IS DISTINCT FROM p_generation::text
    OR proof->>'workerBootId' IS DISTINCT FROM p_boot THEN RETURN FALSE; END IF;
  SELECT key."secret" INTO secret FROM command_protected.purge_barrier_verify_key AS key
    WHERE key."keyVersion" = evidence."keyVersion";
  IF secret IS NULL THEN RETURN FALSE; END IF;
  signed_text := array_to_json(ARRAY[evidence."id", evidence."workerId", evidence."keyVersion"::text,
    proof->>'generation', proof->>'workerBootId', proof->>'primaryId', proof->>'continuityId', proof->>'memberDigest',
    proof->>'brokerDigest', proof->>'gatewayDigest', proof->>'clockDigest', proof->>'fencedAt', proof->>'maxExpiresAt',
    proof->>'cutoff', proof->>'dbSampleAt', proof->>'validUntil', proof->>'monotonicWaitMs', proof->>'minimumWaitMs'])::text;
  IF evidence."signature" <> 'hmac-sha256:' || encode(public.hmac(convert_to(signed_text, 'UTF8'), secret, 'sha256'), 'hex')
    OR evidence."brokerDigest" <> 'sha256:' || (proof->>'brokerDigest')
    OR evidence."gatewayDigest" <> 'sha256:' || (proof->>'gatewayDigest')
    OR evidence."clockDigest" <> 'sha256:' || (proof->>'clockDigest') THEN RETURN FALSE; END IF;
  SELECT * INTO snapshot FROM command_protected.purge_barrier_snapshot(p_generation);
  IF NOT FOUND OR snapshot."status" <> 'fenced' OR NOT snapshot."healthy"
    OR snapshot."memberCount" < 1 OR snapshot."missingMembers" <> 0
    OR snapshot."primaryId" IS DISTINCT FROM proof->>'primaryId'
    OR snapshot."continuityId" IS DISTINCT FROM proof->>'continuityId'
    OR snapshot."clockDigest" IS DISTINCT FROM proof->>'clockDigest'
    OR snapshot."memberDigest" IS DISTINCT FROM proof->>'memberDigest'
    OR snapshot."fencedAt" IS DISTINCT FROM (proof->>'fencedAt')::timestamptz
    OR snapshot."cutoff" IS DISTINCT FROM (proof->>'cutoff')::timestamptz
    OR clock_timestamp() >= (proof->>'validUntil')::timestamptz
    OR clock_timestamp() < (proof->>'dbSampleAt')::timestamptz
    OR (proof->>'validUntil')::timestamptz - (proof->>'dbSampleAt')::timestamptz > INTERVAL '500 milliseconds'
    OR (proof->>'monotonicWaitMs')::numeric < (proof->>'minimumWaitMs')::numeric
    THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM public."CommandDispatch" d LEFT JOIN public."MqttOutbox" o ON o."dispatchId" = d."id"
    WHERE d."kind" = 'dimming' AND (d."publishedAt" IS NOT NULL OR d."acceptedAt" IS NOT NULL
      OR d."completedAt" IS NOT NULL OR d."status" <> 'pending' OR o."deliveryAttemptedAt" IS NOT NULL
      OR o."publishedAt" IS NOT NULL OR o."attempts" > 0)
    AND NOT EXISTS (SELECT 1 FROM public."CommandPublishAttempt" a WHERE a."dispatchId" = d."id"))
    THEN RETURN FALSE; END IF;
  SELECT max("expiresAt") INTO maximum FROM public."CommandPublishAttempt" WHERE "generation" = p_generation;
  IF maximum IS DISTINCT FROM NULLIF(proof->>'maxExpiresAt', '')::timestamptz
    OR (proof->>'minimumWaitMs')::numeric <= greatest(10000,
      COALESCE(extract(epoch FROM (maximum - snapshot."fencedAt")) * 1000, 0) + 2000)
    THEN RETURN FALSE; END IF;
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END $$;
REVOKE ALL ON FUNCTION command_protected.valid_purge_barrier(TEXT,INTEGER,TEXT) FROM PUBLIC;
