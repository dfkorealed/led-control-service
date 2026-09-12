CREATE TYPE "EnergyReportStatus" AS ENUM ('queued', 'processing', 'completed', 'failed', 'expired');
CREATE TYPE "EnergyReportFormat" AS ENUM ('xlsx', 'pdf');

CREATE TABLE "EnergyReportJob" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "requestedByUserId" TEXT,
  "requestedByActorId" TEXT NOT NULL,
  "requestedByLoginIdSnapshot" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "format" "EnergyReportFormat" NOT NULL,
  "status" "EnergyReportStatus" NOT NULL DEFAULT 'queued',
  "progressPercent" INTEGER NOT NULL DEFAULT 0,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "requestSnapshot" JSONB NOT NULL,
  "dataSnapshot" JSONB,
  "documentSnapshot" JSONB,
  "contentFingerprint" TEXT,
  "objectKey" TEXT,
  "contentType" TEXT,
  "sizeBytes" INTEGER,
  "contentSha256" TEXT,
  "failureCode" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "objectDeletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EnergyReportJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EnergyReportJob_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EnergyReportJob_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "EnergyReportJob_progress_check" CHECK ("progressPercent" BETWEEN 0 AND 100),
  CONSTRAINT "EnergyReportJob_attempt_check" CHECK ("attemptCount" BETWEEN 0 AND 3),
  CONSTRAINT "EnergyReportJob_lease_check" CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CONSTRAINT "EnergyReportJob_hash_check" CHECK (
    "requestHash" ~ '^[a-f0-9]{64}$' AND
    ("contentFingerprint" IS NULL OR "contentFingerprint" ~ '^[a-f0-9]{64}$') AND
    ("contentSha256" IS NULL OR "contentSha256" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "EnergyReportJob_snapshot_check" CHECK (
    jsonb_typeof("requestSnapshot") = 'object' AND
    ("dataSnapshot" IS NULL OR jsonb_typeof("dataSnapshot") = 'object') AND
    (("documentSnapshot" IS NULL AND "contentFingerprint" IS NULL) OR
      ("documentSnapshot" IS NOT NULL AND "dataSnapshot" IS NOT NULL AND "contentFingerprint" IS NOT NULL AND
       jsonb_typeof("documentSnapshot") = 'object' AND "documentSnapshot" ? 'contentFingerprint' AND
       COALESCE("documentSnapshot"->>'contentFingerprint' = "contentFingerprint", FALSE)))
  ),
  CONSTRAINT "EnergyReportJob_object_check" CHECK ("sizeBytes" IS NULL OR "sizeBytes" > 0),
  CONSTRAINT "EnergyReportJob_status_state_check" CHECK (
    ("status" = 'queued' AND "progressPercent" = 0 AND "startedAt" IS NULL AND "completedAt" IS NULL AND "expiresAt" IS NULL AND "failureCode" IS NULL AND "leaseOwner" IS NULL) OR
    ("status" = 'processing' AND "progressPercent" BETWEEN 1 AND 99 AND "attemptCount" >= 1 AND "startedAt" IS NOT NULL AND "completedAt" IS NULL AND "expiresAt" IS NULL AND "failureCode" IS NULL AND "leaseOwner" IS NOT NULL) OR
    ("status" = 'failed' AND "progressPercent" < 100 AND "attemptCount" >= 1 AND "startedAt" IS NOT NULL AND "completedAt" IS NULL AND "expiresAt" IS NULL AND "failureCode" IS NOT NULL AND "leaseOwner" IS NULL) OR
    ("status" IN ('completed', 'expired') AND "progressPercent" = 100 AND "attemptCount" >= 1 AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "expiresAt" IS NOT NULL AND "expiresAt" > "completedAt" AND "failureCode" IS NULL AND "leaseOwner" IS NULL AND "documentSnapshot" IS NOT NULL AND "objectKey" IS NOT NULL AND "contentType" IS NOT NULL AND "sizeBytes" IS NOT NULL AND "contentSha256" IS NOT NULL)
  ),
  CONSTRAINT "EnergyReportJob_deletion_check" CHECK ("objectDeletedAt" IS NULL OR "status" = 'expired')
);

CREATE UNIQUE INDEX "EnergyReportJob_objectKey_key" ON "EnergyReportJob"("objectKey");
CREATE UNIQUE INDEX "EnergyReportJob_active_request_key" ON "EnergyReportJob"("siteId", "requestedByActorId", "requestHash") WHERE "status" IN ('queued', 'processing');
CREATE INDEX "EnergyReportJob_siteId_createdAt_idx" ON "EnergyReportJob"("siteId", "createdAt");
CREATE INDEX "EnergyReportJob_status_leaseExpiresAt_createdAt_idx" ON "EnergyReportJob"("status", "leaseExpiresAt", "createdAt");
CREATE INDEX "EnergyReportJob_status_expiresAt_objectDeletedAt_idx" ON "EnergyReportJob"("status", "expiresAt", "objectDeletedAt");
CREATE INDEX "EnergyReportJob_requestedByUserId_idx" ON "EnergyReportJob"("requestedByUserId");

-- Identity/request values are permanent. Data/document may be filled once by a leased
-- worker; replay may retain the same value but cannot overwrite or clear a snapshot.
CREATE FUNCTION "guard_energy_report_snapshots"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."siteId" IS DISTINCT FROM OLD."siteId"
    OR NEW."requestedByActorId" IS DISTINCT FROM OLD."requestedByActorId"
    OR NEW."requestedByLoginIdSnapshot" IS DISTINCT FROM OLD."requestedByLoginIdSnapshot"
    OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."format" IS DISTINCT FROM OLD."format"
    OR NEW."requestSnapshot" IS DISTINCT FROM OLD."requestSnapshot"
    OR (OLD."dataSnapshot" IS NOT NULL AND NEW."dataSnapshot" IS DISTINCT FROM OLD."dataSnapshot")
    OR (OLD."documentSnapshot" IS NOT NULL AND NEW."documentSnapshot" IS DISTINCT FROM OLD."documentSnapshot")
    OR (OLD."contentFingerprint" IS NOT NULL AND NEW."contentFingerprint" IS DISTINCT FROM OLD."contentFingerprint") THEN
    RAISE EXCEPTION 'energy report snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "EnergyReportJob_snapshot_immutable" BEFORE UPDATE ON "EnergyReportJob"
FOR EACH ROW EXECUTE FUNCTION "guard_energy_report_snapshots"();
