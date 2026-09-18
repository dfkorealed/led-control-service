BEGIN;
SET LOCAL lock_timeout = '10s';

LOCK TABLE "FloorImportJob" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "FloorImportJob"
DROP CONSTRAINT "FloorImportJob_lifecycle_check";

ALTER TABLE "FloorImportJob"
ADD CONSTRAINT "FloorImportJob_lifecycle_check" CHECK (
  (
    "status" = 'queued' AND "progressPercent" BETWEEN 0 AND 90 AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "renderedAssetId" IS NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND
    "startedAt" IS NULL AND "reviewRequiredAt" IS NULL AND "appliedAt" IS NULL AND
    "completedAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'processing' AND "progressPercent" BETWEEN 1 AND 99 AND "attemptCount" >= 1 AND
    "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND
    "startedAt" IS NOT NULL AND "renderedAssetId" IS NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND
    "reviewRequiredAt" IS NULL AND "appliedAt" IS NULL AND "completedAt" IS NULL AND
    "failedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'review_required' AND "progressPercent" = 100 AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND
    "renderedAssetId" IS NOT NULL AND "startedAt" IS NOT NULL AND "reviewRequiredAt" IS NOT NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND "appliedAt" IS NULL AND
    "completedAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'applying' AND "progressPercent" = 100 AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND
    "renderedAssetId" IS NOT NULL AND "startedAt" IS NOT NULL AND "reviewRequiredAt" IS NOT NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND "appliedAt" IS NULL AND
    "completedAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'completed' AND "progressPercent" = 100 AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND
    "renderedAssetId" IS NOT NULL AND "startedAt" IS NOT NULL AND "reviewRequiredAt" IS NOT NULL AND
    "appliedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'failed' AND "progressPercent" BETWEEN 0 AND 100 AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "failureCode" IS NOT NULL AND
    length(btrim("failureCode")) BETWEEN 1 AND 100 AND "failureMessage" IS NOT NULL AND
    length(btrim("failureMessage")) BETWEEN 1 AND 2000 AND "failedAt" IS NOT NULL AND
    "completedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'cancelled' AND "progressPercent" BETWEEN 0 AND 100 AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND "cancelledAt" IS NOT NULL AND
    "completedAt" IS NULL AND "failedAt" IS NULL
  )
);

COMMIT;
