ALTER TYPE "FloorMapStageStatus" ADD VALUE IF NOT EXISTS 'queued';
ALTER TYPE "FloorMapStageStatus" ADD VALUE IF NOT EXISTS 'processing';
ALTER TYPE "FloorMapStageStatus" ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TABLE "FloorMapStage"
  ADD COLUMN "leaseFence" INTEGER,
  ADD COLUMN "requestHash" TEXT,
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "expectedPartCount" INTEGER,
  ADD COLUMN "expectedDecodedBytes" BIGINT,
  ADD COLUMN "workerToken" TEXT,
  ADD COLUMN "workerExpiresAt" TIMESTAMP(3),
  ADD COLUMN "result" JSONB,
  ADD COLUMN "errorCode" TEXT;

-- The old implementation never recorded resumable authority. Fence zero and an
-- empty envelope deliberately cannot authorize new work. Do not delete parts,
-- assets, committed receipts or revision pins during an additive deployment.
UPDATE "FloorMapStage" SET "leaseFence" = 0, "requestHash" = repeat('0', 64), "metadata" = '{}',
  "status" = CASE WHEN "status"::text IN ('preparing', 'ready') THEN 'expired'::"FloorMapStageStatus" ELSE "status" END,
  "errorCode" = CASE WHEN "status"::text IN ('preparing', 'ready') THEN 'legacy_authority_unavailable' ELSE NULL END;

ALTER TABLE "FloorMapStage"
  ALTER COLUMN "leaseFence" SET NOT NULL,
  ALTER COLUMN "requestHash" SET NOT NULL,
  ALTER COLUMN "metadata" SET NOT NULL,
  ADD CONSTRAINT "FloorMapStage_authority_check" CHECK (
    "leaseFence" >= 0 AND "requestHash" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("metadata") = 'object'
    AND octet_length("metadata"::text) <= 2097152
    AND NOT ("metadata" ?| ARRAY['leaseToken','token','password','credentials','cookie','authorization'])
    AND ("status"::text NOT IN ('preparing','ready','queued','processing') OR "leaseFence" > 0)
  ),
  ADD CONSTRAINT "FloorMapStage_commit_intent_check" CHECK (
    ("expectedPartCount" IS NULL AND "expectedDecodedBytes" IS NULL)
    OR ("expectedPartCount" IS NOT NULL AND "expectedDecodedBytes" IS NOT NULL
      AND "expectedPartCount" BETWEEN 1 AND 1024
      AND "expectedDecodedBytes" BETWEEN 1 AND 536870912
      AND "expectedDecodedBytes" <= "expectedPartCount"::bigint * 524288
      AND "payloadHash" IS NOT NULL)
  ),
  ADD CONSTRAINT "FloorMapStage_worker_claim_check" CHECK (
    ("workerToken" IS NULL AND "workerExpiresAt" IS NULL)
    OR ("workerToken" IS NOT NULL AND "workerExpiresAt" IS NOT NULL AND length("workerToken") BETWEEN 1 AND 128)
  );
