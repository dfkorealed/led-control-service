-- Derived safety state is deliberately independent of Command and User rows.
-- This migration creates structures only; it does not enable Command purge.
CREATE TABLE "CommandReplayFence" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "principalSnapshot" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "keyDigest" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommandReplayFence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommandReplayFence_digest_check" CHECK ("keyDigest" ~ '^hmac-sha256:[a-f0-9]{64}$' AND "keyVersion" > 0),
    CONSTRAINT "CommandReplayFence_domain_check" CHECK ("domain" IN ('set-replay', 'status-check-replay'))
);
CREATE UNIQUE INDEX "CommandReplayFence_siteId_principalSnapshot_domain_keyDigest_key" ON "CommandReplayFence"("siteId", "principalSnapshot", "domain", "keyDigest");
CREATE INDEX "CommandReplayFence_siteId_createdAt_idx" ON "CommandReplayFence"("siteId", "createdAt");
ALTER TABLE "CommandReplayFence" ADD CONSTRAINT "CommandReplayFence_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UnresolvedCommandHold" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "originalCommandId" TEXT NOT NULL,
    "originalCreatedAt" TIMESTAMP(3) NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "verificationAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UnresolvedCommandHold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UnresolvedCommandHold_reason_check" CHECK ("reasonCode" IN ('outcome_unknown', 'attempts_exhausted', 'gateway_unavailable')),
    CONSTRAINT "UnresolvedCommandHold_attempt_check" CHECK ("verificationAttemptCount" BETWEEN 0 AND 3)
);
CREATE UNIQUE INDEX "UnresolvedCommandHold_originalCommandId_key" ON "UnresolvedCommandHold"("originalCommandId");
CREATE INDEX "UnresolvedCommandHold_siteId_createdAt_id_idx" ON "UnresolvedCommandHold"("siteId", "createdAt", "id");
CREATE INDEX "UnresolvedCommandHold_siteId_gatewayId_idx" ON "UnresolvedCommandHold"("siteId", "gatewayId");
ALTER TABLE "UnresolvedCommandHold" ADD CONSTRAINT "UnresolvedCommandHold_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UnresolvedCommandHoldTarget" (
    "holdId" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "expectedBrightness" INTEGER NOT NULL,
    CONSTRAINT "UnresolvedCommandHoldTarget_pkey" PRIMARY KEY ("holdId","fixtureId"),
    CONSTRAINT "UnresolvedCommandHoldTarget_brightness_check" CHECK ("expectedBrightness" BETWEEN 0 AND 100)
);
CREATE INDEX "UnresolvedCommandHoldTarget_fixtureId_holdId_idx" ON "UnresolvedCommandHoldTarget"("fixtureId", "holdId");
ALTER TABLE "UnresolvedCommandHoldTarget" ADD CONSTRAINT "UnresolvedCommandHoldTarget_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "UnresolvedCommandHold"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ResolvedCommandRecovery" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "targetCount" INTEGER NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResolvedCommandRecovery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ResolvedCommandRecovery_classification_check" CHECK ("classification" IN ('verified_applied','verified_not_applied','verified_partial')),
    CONSTRAINT "ResolvedCommandRecovery_target_count_check" CHECK ("targetCount" BETWEEN 1 AND 1000)
);
CREATE INDEX "ResolvedCommandRecovery_resolvedAt_id_idx" ON "ResolvedCommandRecovery"("resolvedAt", "id");
ALTER TABLE "ResolvedCommandRecovery" ADD CONSTRAINT "ResolvedCommandRecovery_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RecoveryDispatch" (
    "id" TEXT NOT NULL,
    "holdId" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "verificationAttempt" INTEGER NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "principalSnapshot" TEXT,
    "clientRequestDigest" TEXT,
    "requestKeyVersion" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "publishedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedReceivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecoveryDispatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecoveryDispatch_attempt_check" CHECK ("verificationAttempt" BETWEEN 1 AND 3 AND "chunkIndex" >= 0),
    CONSTRAINT "RecoveryDispatch_status_check" CHECK ("status" IN ('pending', 'published', 'accepted', 'completed', 'failed', 'timed_out')),
    CONSTRAINT "RecoveryDispatch_request_check" CHECK (
      ("principalSnapshot" IS NULL AND "clientRequestDigest" IS NULL AND "requestKeyVersion" IS NULL)
      OR ("principalSnapshot" IS NOT NULL AND "clientRequestDigest" ~ '^hmac-sha256:[a-f0-9]{64}$' AND "requestKeyVersion" > 0))
);
CREATE UNIQUE INDEX "RecoveryDispatch_idempotencyKey_key" ON "RecoveryDispatch"("idempotencyKey");
CREATE UNIQUE INDEX "RecoveryDispatch_gatewayId_sequence_key" ON "RecoveryDispatch"("gatewayId", "sequence");
CREATE UNIQUE INDEX "RecoveryDispatch_holdId_principalSnapshot_clientRequestDigest_key" ON "RecoveryDispatch"("holdId", "principalSnapshot", "clientRequestDigest");
CREATE UNIQUE INDEX "RecoveryDispatch_holdId_verificationAttempt_chunkIndex_key" ON "RecoveryDispatch"("holdId", "verificationAttempt", "chunkIndex");
CREATE INDEX "RecoveryDispatch_holdId_status_idx" ON "RecoveryDispatch"("holdId", "status");
ALTER TABLE "RecoveryDispatch" ADD CONSTRAINT "RecoveryDispatch_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "UnresolvedCommandHold"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RecoveryDispatchTarget" (
    "dispatchId" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "brightness" INTEGER,
    "observedAt" TIMESTAMP(3),
    CONSTRAINT "RecoveryDispatchTarget_status_check" CHECK ("status" IN ('pending','succeeded','failed','timed_out')),
    CONSTRAINT "RecoveryDispatchTarget_brightness_check" CHECK ("brightness" IS NULL OR "brightness" BETWEEN 0 AND 100),
    CONSTRAINT "RecoveryDispatchTarget_pkey" PRIMARY KEY ("dispatchId","fixtureId")
);
ALTER TABLE "RecoveryDispatchTarget" ADD CONSTRAINT "RecoveryDispatchTarget_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "RecoveryDispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RecoveryOutbox" (
    "id" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "deliveryAttemptedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecoveryOutbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecoveryOutbox_get_only_check" CHECK ("topic" LIKE 'sites/%/gateways/%/commands/status-check' AND "payload" ? 'originalCommandId' AND NOT ("payload" ? 'brightness'))
);
CREATE UNIQUE INDEX "RecoveryOutbox_dispatchId_key" ON "RecoveryOutbox"("dispatchId");
CREATE INDEX "RecoveryOutbox_publishedAt_deadLetteredAt_nextAttemptAt_leaseExpiresAt_idx" ON "RecoveryOutbox"("publishedAt", "deadLetteredAt", "nextAttemptAt", "leaseExpiresAt");
ALTER TABLE "RecoveryOutbox" ADD CONSTRAINT "RecoveryOutbox_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "RecoveryDispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LateSetReceipt" (
    "id" TEXT NOT NULL,
    "holdId" TEXT NOT NULL,
    "originalDispatchId" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "wireDigest" TEXT NOT NULL,
    "targetFixtureIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LateSetReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LateSetReceipt_digest_check" CHECK ("wireDigest" ~ '^hmac-sha256:[a-f0-9]{64}$' AND "keyVersion" > 0)
);
CREATE UNIQUE INDEX "LateSetReceipt_originalDispatchId_key" ON "LateSetReceipt"("originalDispatchId");
CREATE INDEX "LateSetReceipt_holdId_idx" ON "LateSetReceipt"("holdId");
ALTER TABLE "LateSetReceipt" ADD CONSTRAINT "LateSetReceipt_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "UnresolvedCommandHold"("id") ON DELETE CASCADE ON UPDATE CASCADE;
