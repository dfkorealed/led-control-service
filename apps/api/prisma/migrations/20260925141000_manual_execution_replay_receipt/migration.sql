-- Additive only. This table does not delete AutomationExecution or enable
-- Command purge; a guarded cutover must prove backfill and late-event safety.
CREATE TABLE "ManualExecutionReplayReceipt" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "sequence" BIGINT NOT NULL,
  "eventDigest" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "ackIngestedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ManualExecutionReplayReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualExecutionReplayReceipt_digest_check"
    CHECK ("eventDigest" ~ '^hmac-sha256:[a-f0-9]{64}$' AND "keyVersion" > 0),
  CONSTRAINT "ManualExecutionReplayReceipt_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ManualExecutionReplayReceipt_gatewayId_eventId_sequence_key"
  ON "ManualExecutionReplayReceipt"("gatewayId", "eventId", "sequence");
CREATE INDEX "ManualExecutionReplayReceipt_siteId_createdAt_idx"
  ON "ManualExecutionReplayReceipt"("siteId", "createdAt");

-- Until a guarded B cutover adds the narrowly validated sourceRetiredAt
-- transition, all replay evidence and the original ACK time are append-only.
CREATE FUNCTION "ManualExecutionReplayReceipt_reject_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'manual execution replay receipt is immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "ManualExecutionReplayReceipt_immutable"
BEFORE UPDATE ON "ManualExecutionReplayReceipt"
FOR EACH ROW EXECUTE FUNCTION "ManualExecutionReplayReceipt_reject_update"();
