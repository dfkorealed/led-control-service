-- Harden the additive foundation without rewriting the previous migration.
-- No publisher/worker or production purge/recovery flag is activated here.
CREATE FUNCTION command_protected.require_publish_read_committed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Advisory locks serialize writers, but cannot refresh a REPEATABLE READ
  -- snapshot established before another connection retired a higher epoch.
  -- The first-envelope check likewise needs fresh dispatch/outbox evidence.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'command publish writes require read committed isolation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CommandPublishEpoch_allocation_isolation_guard"
  BEFORE INSERT ON "CommandPublishEpoch" FOR EACH ROW
  EXECUTE FUNCTION command_protected.require_publish_read_committed();
CREATE TRIGGER "CommandPublishAttempt_admission_isolation_guard"
  BEFORE INSERT ON "CommandPublishAttempt" FOR EACH ROW
  EXECUTE FUNCTION command_protected.require_publish_read_committed();

CREATE FUNCTION command_protected.guard_publish_attempt_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE dispatch_attempted BOOLEAN; outbox_attempted BOOLEAN;
BEGIN
  -- Lock both producer records: legacy publishers can mark just the outbox.
  -- Under READ COMMITTED, waiting on either writer observes its committed
  -- marker rather than certifying an older snapshot as a first known attempt.
  SELECT ("publishedAt" IS NOT NULL OR "acceptedAt" IS NOT NULL OR
    "completedAt" IS NOT NULL OR "status" <> 'pending') INTO dispatch_attempted
    FROM public."CommandDispatch" WHERE "id" = NEW."dispatchId" FOR UPDATE;
  SELECT ("deliveryAttemptedAt" IS NOT NULL OR "publishedAt" IS NOT NULL OR
    "attempts" > 0) INTO outbox_attempted
    FROM public."MqttOutbox" WHERE "dispatchId" = NEW."dispatchId" FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public."CommandPublishAttempt" WHERE "dispatchId" = NEW."dispatchId")
    AND (COALESCE(dispatch_attempted, false) OR COALESCE(outbox_attempted, false)) THEN
    RAISE EXCEPTION 'legacy command publish attempt cannot acquire its first envelope';
  END IF;
  -- Subsequent attempts may retain new expiry bounds once the first attempt was
  -- recorded before its marker. This never retrofits an unknown legacy expiry.
  RETURN NEW;
END $$;
CREATE TRIGGER "CommandPublishAttempt_origin_guard"
  BEFORE INSERT ON "CommandPublishAttempt" FOR EACH ROW
  EXECUTE FUNCTION command_protected.guard_publish_attempt_origin();

REVOKE ALL ON FUNCTION command_protected.require_publish_read_committed(),
  command_protected.guard_publish_attempt_origin() FROM PUBLIC;
-- PostgreSQL row locking requires UPDATE on at least one column. Grant a
-- bookkeeping timestamp, not permission to clear attempt evidence or payload.
GRANT UPDATE ("updatedAt") ON "MqttOutbox" TO command_set_publisher;
