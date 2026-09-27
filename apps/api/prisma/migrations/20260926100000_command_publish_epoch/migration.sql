-- Additive safety foundation only: no active epoch, credential provisioning,
-- production purge, recovery POST, or broker/Gateway safety assertion is enabled.
CREATE SCHEMA IF NOT EXISTS command_protected;
REVOKE ALL ON SCHEMA command_protected FROM PUBLIC;
CREATE TYPE "CommandPublishEpochStatus" AS ENUM ('active', 'quiescing', 'fenced', 'retired');

CREATE TABLE "CommandPublishEpoch" (
  "generation" INTEGER PRIMARY KEY CHECK ("generation" > 0),
  "status" "CommandPublishEpochStatus" NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "quiescingAt" TIMESTAMPTZ(3),
  "fencedAt" TIMESTAMPTZ(3),
  "retiredAt" TIMESTAMPTZ(3)
);
-- A replacement may start only after its predecessor has retired. This is
-- stronger than a single-active index and prevents overlapping barrier work.
CREATE UNIQUE INDEX "CommandPublishEpoch_one_live" ON "CommandPublishEpoch" ((true)) WHERE "status" <> 'retired';

CREATE TABLE "CommandPublishMember" (
  "generation" INTEGER NOT NULL REFERENCES "CommandPublishEpoch"("generation") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "workerId" TEXT NOT NULL CHECK (length("workerId") BETWEEN 1 AND 200),
  "brokerIdentity" TEXT NOT NULL CHECK (length("brokerIdentity") BETWEEN 1 AND 200),
  "registeredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "quiesceAckAt" TIMESTAMPTZ(3),
  PRIMARY KEY ("generation", "workerId")
);
CREATE UNIQUE INDEX "CommandPublishMember_generation_brokerIdentity_workerId_key"
  ON "CommandPublishMember" ("generation", "brokerIdentity", "workerId");

CREATE TABLE "CommandPublishAttempt" (
  "id" TEXT PRIMARY KEY,
  "generation" INTEGER NOT NULL REFERENCES "CommandPublishEpoch"("generation") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "workerId" TEXT NOT NULL,
  "dispatchId" TEXT NOT NULL REFERENCES "CommandDispatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL CHECK (isfinite("expiresAt")),
  "attemptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("generation", "workerId") REFERENCES "CommandPublishMember"("generation", "workerId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "CommandPublishAttempt_generation_expiresAt_idx" ON "CommandPublishAttempt" ("generation", "expiresAt");
CREATE INDEX "CommandPublishAttempt_dispatchId_idx" ON "CommandPublishAttempt" ("dispatchId");

CREATE TABLE "CommandPurgeBarrierEvidence" (
  "id" TEXT PRIMARY KEY,
  "generation" INTEGER NOT NULL REFERENCES "CommandPublishEpoch"("generation") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "workerId" TEXT NOT NULL CHECK (length("workerId") BETWEEN 1 AND 200),
  "brokerDigest" TEXT NOT NULL CHECK ("brokerDigest" ~ '^sha256:[a-f0-9]{64}$'),
  "gatewayDigest" TEXT NOT NULL CHECK ("gatewayDigest" ~ '^sha256:[a-f0-9]{64}$'),
  "clockDigest" TEXT NOT NULL CHECK ("clockDigest" ~ '^sha256:[a-f0-9]{64}$'),
  "signature" TEXT NOT NULL CHECK ("signature" ~ '^hmac-sha256:[a-f0-9]{64}$'),
  "keyVersion" INTEGER NOT NULL CHECK ("keyVersion" > 0),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CommandPurgeBarrierEvidence_generation_createdAt_idx" ON "CommandPurgeBarrierEvidence" ("generation", "createdAt");

CREATE FUNCTION command_protected.guard_publish_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Serialize generation allocation, including explicit IDs from distinct workers.
  PERFORM pg_advisory_xact_lock(724190026, 1);
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'command publish generation history is immutable';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'active' OR NEW."generation" <= COALESCE((SELECT MAX("generation") FROM public."CommandPublishEpoch"), 0)
      OR NEW."quiescingAt" IS NOT NULL OR NEW."fencedAt" IS NOT NULL OR NEW."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'command publish generation must advance and start active';
    END IF;
    NEW."createdAt" := clock_timestamp();
  ELSE
    IF NEW."generation" <> OLD."generation" OR NEW."createdAt" <> OLD."createdAt"
      OR NEW."quiescingAt" IS DISTINCT FROM OLD."quiescingAt"
      OR NEW."fencedAt" IS DISTINCT FROM OLD."fencedAt"
      OR NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN
      RAISE EXCEPTION 'command publish generation metadata is immutable';
    END IF;
    IF OLD."status" = 'active' AND NEW."status" = 'quiescing' THEN
      NEW."quiescingAt" := clock_timestamp();
    ELSIF OLD."status" = 'quiescing' AND NEW."status" = 'fenced' THEN
      NEW."fencedAt" := clock_timestamp();
    ELSIF OLD."status" = 'fenced' AND NEW."status" = 'retired' THEN
      NEW."retiredAt" := clock_timestamp();
    ELSE
      RAISE EXCEPTION 'invalid command publish epoch transition';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CommandPublishEpoch_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CommandPublishEpoch"
  FOR EACH ROW EXECUTE FUNCTION command_protected.guard_publish_epoch();

CREATE FUNCTION command_protected.guard_publish_member() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE epoch_status public."CommandPublishEpochStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'command publish member history is immutable'; END IF;
  SELECT "status" INTO epoch_status FROM public."CommandPublishEpoch" WHERE "generation" = NEW."generation" FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF epoch_status IS DISTINCT FROM 'active' OR NEW."quiesceAckAt" IS NOT NULL THEN
      RAISE EXCEPTION 'command publish member requires active generation';
    END IF;
    NEW."registeredAt" := clock_timestamp();
  ELSE
    IF (NEW."generation", NEW."workerId", NEW."brokerIdentity", NEW."registeredAt") IS DISTINCT FROM
      (OLD."generation", OLD."workerId", OLD."brokerIdentity", OLD."registeredAt")
      OR OLD."quiesceAckAt" IS NOT NULL OR NEW."quiesceAckAt" IS NULL OR epoch_status <> 'quiescing' THEN
      RAISE EXCEPTION 'invalid command publish member acknowledgement';
    END IF;
    NEW."quiesceAckAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CommandPublishMember_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CommandPublishMember"
  FOR EACH ROW EXECUTE FUNCTION command_protected.guard_publish_member();

CREATE FUNCTION command_protected.guard_publish_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE epoch_status public."CommandPublishEpochStatus"; dispatch_kind public."CommandDispatchKind";
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'command publish attempt is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT "status" INTO epoch_status FROM public."CommandPublishEpoch" WHERE "generation" = OLD."generation" FOR SHARE;
    IF epoch_status NOT IN ('fenced', 'retired') THEN RAISE EXCEPTION 'command publish attempt is not fenced'; END IF;
    -- Only the protected role receives DELETE. Its later barrier worker must
    -- validate signatures/drain and delete envelope + raw Command atomically.
    RETURN OLD;
  END IF;
  SELECT "status" INTO epoch_status FROM public."CommandPublishEpoch" WHERE "generation" = NEW."generation" FOR SHARE;
  IF epoch_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'command publish attempt requires active generation'; END IF;
  SELECT "kind" INTO dispatch_kind FROM public."CommandDispatch" WHERE "id" = NEW."dispatchId" FOR UPDATE;
  IF dispatch_kind IS DISTINCT FROM 'dimming' THEN RAISE EXCEPTION 'command publish attempt requires dimming dispatch'; END IF;
  IF EXISTS (SELECT 1 FROM public."CommandPublishAttempt" WHERE "dispatchId" = NEW."dispatchId" AND "generation" <> NEW."generation") THEN
    RAISE EXCEPTION 'command publish dispatch cannot cross generations';
  END IF;
  NEW."attemptedAt" := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER "CommandPublishAttempt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CommandPublishAttempt"
  FOR EACH ROW EXECUTE FUNCTION command_protected.guard_publish_attempt();

CREATE FUNCTION command_protected.guard_publish_dispatch_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" AND EXISTS (
    SELECT 1 FROM public."CommandPublishAttempt" WHERE "dispatchId" = OLD."id") THEN
    RAISE EXCEPTION 'attempted command publish dispatch kind is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CommandDispatch_publish_kind_guard" BEFORE UPDATE OF "kind" ON "CommandDispatch"
  FOR EACH ROW EXECUTE FUNCTION command_protected.guard_publish_dispatch_kind();

CREATE FUNCTION command_protected.guard_purge_barrier_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'command purge barrier evidence is immutable'; END IF;
  PERFORM 1 FROM public."CommandPublishEpoch" WHERE "generation" = NEW."generation" AND "status" = 'fenced' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'command purge barrier evidence requires fenced generation'; END IF;
  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER "CommandPurgeBarrierEvidence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CommandPurgeBarrierEvidence"
  FOR EACH ROW EXECUTE FUNCTION command_protected.guard_purge_barrier_evidence();

-- Privilege groups only; deployment must separately bind actual non-owner
-- credentials. Never run runtime traffic as the migration owner/superuser.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'command_set_publisher') THEN
    CREATE ROLE command_set_publisher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'command_publish_retention') THEN
    CREATE ROLE command_publish_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;
REVOKE ALL ON "CommandPublishEpoch", "CommandPublishMember", "CommandPublishAttempt", "CommandPurgeBarrierEvidence"
  FROM PUBLIC, command_set_publisher, command_publish_retention;
REVOKE ALL ON FUNCTION command_protected.guard_publish_epoch(), command_protected.guard_publish_member(),
  command_protected.guard_publish_attempt(), command_protected.guard_publish_dispatch_kind(),
  command_protected.guard_purge_barrier_evidence() FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO command_set_publisher, command_publish_retention;
GRANT SELECT ON "CommandPublishEpoch", "CommandPublishMember", "CommandPublishAttempt" TO command_set_publisher;
-- Row locks need an UPDATE privilege. Grant an immutable column rather than
-- status: the trigger rejects changing generation, even for this lock grant.
GRANT UPDATE ("generation") ON "CommandPublishEpoch" TO command_set_publisher;
GRANT INSERT ON "CommandPublishMember", "CommandPublishAttempt" TO command_set_publisher;
GRANT UPDATE ("quiesceAckAt") ON "CommandPublishMember" TO command_set_publisher;
GRANT SELECT ON "CommandDispatch" TO command_set_publisher;
GRANT SELECT ON "MqttOutbox" TO command_set_publisher;
GRANT UPDATE ("id") ON "CommandDispatch" TO command_set_publisher;
GRANT SELECT ON "CommandPublishEpoch", "CommandPublishMember", "CommandPublishAttempt", "CommandPurgeBarrierEvidence" TO command_publish_retention;
GRANT INSERT ON "CommandPublishEpoch", "CommandPurgeBarrierEvidence" TO command_publish_retention;
GRANT UPDATE ("status") ON "CommandPublishEpoch" TO command_publish_retention;
GRANT DELETE ON "CommandPublishAttempt" TO command_publish_retention;
GRANT SELECT ON "CommandDispatch", "MqttOutbox" TO command_publish_retention;
