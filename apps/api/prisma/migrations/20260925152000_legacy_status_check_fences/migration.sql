-- The old CommandDispatch.clientRequestId was globally unique. A keyed
-- replay marker must retain that global scope after its Command is deleted.
ALTER TABLE "CommandReplayFence"
  DROP CONSTRAINT "CommandReplayFence_domain_check";
ALTER TABLE "CommandReplayFence"
  ADD CONSTRAINT "CommandReplayFence_domain_check"
  CHECK ("domain" IN ('set-replay', 'set-replay-orphan', 'status-check-replay',
    'legacy-status-check-global'));
CREATE UNIQUE INDEX "CommandReplayFence_legacy_status_key_global_key"
  ON "CommandReplayFence" ("keyDigest")
  WHERE "domain" = 'legacy-status-check-global';

CREATE TABLE "LegacyStatusCheckDispatchFence" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "dispatchDigest" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LegacyStatusCheckDispatchFence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LegacyStatusCheckDispatchFence_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LegacyStatusCheckDispatchFence_digest_format_check"
    CHECK ("dispatchDigest" ~ '^hmac-sha256:[a-f0-9]{64}$' AND "keyVersion" > 0)
);
CREATE UNIQUE INDEX "LegacyStatusCheckDispatchFence_dispatchDigest_key"
  ON "LegacyStatusCheckDispatchFence" ("dispatchDigest");
CREATE INDEX "LegacyStatusCheckDispatchFence_siteId_createdAt_idx"
  ON "LegacyStatusCheckDispatchFence" ("siteId", "createdAt");
