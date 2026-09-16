BEGIN;

CREATE TABLE "FloorImportAttemptCleanup" (
  "jobId" TEXT NOT NULL,
  "floorId" TEXT NOT NULL,
  "attemptCount" INTEGER NOT NULL,
  "assetId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "lastCleanedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "committedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FloorImportAttemptCleanup_pkey" PRIMARY KEY ("jobId", "attemptCount"),
  CONSTRAINT "FloorImportAttemptCleanup_attempt_check" CHECK ("attemptCount" BETWEEN 1 AND 3),
  CONSTRAINT "FloorImportAttemptCleanup_lease_pair" CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CONSTRAINT "FloorImportAttemptCleanup_key_check" CHECK (
    "objectKey" = 'floors/' || "floorId" || '/' || "jobId" || '-attempt-' || "attemptCount"::text || '.svg'
  )
);

CREATE UNIQUE INDEX "FloorImportAttemptCleanup_assetId_key" ON "FloorImportAttemptCleanup"("assetId");
CREATE UNIQUE INDEX "FloorImportAttemptCleanup_objectKey_key" ON "FloorImportAttemptCleanup"("objectKey");
CREATE INDEX "FloorImportAttemptCleanup_nextAttemptAt_leaseExpiresAt_idx"
  ON "FloorImportAttemptCleanup"("nextAttemptAt", "leaseExpiresAt");

COMMIT;
