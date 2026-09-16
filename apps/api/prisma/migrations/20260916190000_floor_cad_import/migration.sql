CREATE TYPE "FloorImportSourceFormat" AS ENUM ('dwg', 'dxf');
CREATE TYPE "FloorImportJobStatus" AS ENUM ('queued', 'processing', 'review_required', 'applying', 'completed', 'failed', 'cancelled');
CREATE TYPE "FloorImportDetectionMethod" AS ENUM ('rule_based', 'ai_assisted');
CREATE TYPE "FloorImportCandidateReviewStatus" AS ENUM ('pending', 'accepted', 'rejected');

CREATE TABLE "FloorImportJob" (
  "id" TEXT NOT NULL,
  "floorId" TEXT NOT NULL,
  "sourceAssetId" TEXT NOT NULL,
  "renderedAssetId" TEXT,
  "sourceFormat" "FloorImportSourceFormat" NOT NULL,
  "status" "FloorImportJobStatus" NOT NULL DEFAULT 'queued',
  "stage" TEXT NOT NULL DEFAULT 'queued',
  "progressPercent" INTEGER NOT NULL DEFAULT 0,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "parserVersion" TEXT,
  "detectorVersion" TEXT,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "reviewRequiredAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FloorImportJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FloorImportJob_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorImportJob_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "FloorAsset"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "FloorImportJob_renderedAssetId_fkey" FOREIGN KEY ("renderedAssetId") REFERENCES "FloorAsset"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "FloorImportJob_progress_check" CHECK ("progressPercent" BETWEEN 0 AND 100),
  CONSTRAINT "FloorImportJob_attempt_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "FloorImportJob_lease_check" CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CONSTRAINT "FloorImportJob_asset_check" CHECK ("renderedAssetId" IS NULL OR "renderedAssetId" <> "sourceAssetId"),
  CONSTRAINT "FloorImportJob_stage_check" CHECK (length(btrim("stage")) BETWEEN 1 AND 100),
  CONSTRAINT "FloorImportJob_lifecycle_check" CHECK (
    (
      "status" = 'queued' AND "progressPercent" = 0 AND
      "leaseOwner" IS NULL AND "renderedAssetId" IS NULL AND
      "failureCode" IS NULL AND "failureMessage" IS NULL AND
      "startedAt" IS NULL AND "reviewRequiredAt" IS NULL AND "appliedAt" IS NULL AND
      "completedAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
    ) OR (
      "status" = 'processing' AND "progressPercent" BETWEEN 1 AND 99 AND "attemptCount" >= 1 AND
      "leaseOwner" IS NOT NULL AND "startedAt" IS NOT NULL AND "renderedAssetId" IS NULL AND
      "failureCode" IS NULL AND "failureMessage" IS NULL AND
      "reviewRequiredAt" IS NULL AND "appliedAt" IS NULL AND "completedAt" IS NULL AND
      "failedAt" IS NULL AND "cancelledAt" IS NULL
    ) OR (
      "status" = 'review_required' AND "progressPercent" = 100 AND "leaseOwner" IS NULL AND
      "renderedAssetId" IS NOT NULL AND "startedAt" IS NOT NULL AND "reviewRequiredAt" IS NOT NULL AND
      "failureCode" IS NULL AND "failureMessage" IS NULL AND "appliedAt" IS NULL AND
      "completedAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
    ) OR (
      "status" = 'applying' AND "progressPercent" = 100 AND "leaseOwner" IS NULL AND
      "renderedAssetId" IS NOT NULL AND "startedAt" IS NOT NULL AND "reviewRequiredAt" IS NOT NULL AND
      "failureCode" IS NULL AND "failureMessage" IS NULL AND "appliedAt" IS NULL AND
      "completedAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
    ) OR (
      "status" = 'completed' AND "progressPercent" = 100 AND "leaseOwner" IS NULL AND
      "renderedAssetId" IS NOT NULL AND "startedAt" IS NOT NULL AND "reviewRequiredAt" IS NOT NULL AND
      "appliedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND
      "failureCode" IS NULL AND "failureMessage" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
    ) OR (
      "status" = 'failed' AND "leaseOwner" IS NULL AND "failureCode" IS NOT NULL AND
      length(btrim("failureCode")) BETWEEN 1 AND 100 AND "failureMessage" IS NOT NULL AND
      length(btrim("failureMessage")) BETWEEN 1 AND 2000 AND "failedAt" IS NOT NULL AND
      "completedAt" IS NULL AND "cancelledAt" IS NULL
    ) OR (
      "status" = 'cancelled' AND "leaseOwner" IS NULL AND
      "failureCode" IS NULL AND "failureMessage" IS NULL AND "cancelledAt" IS NOT NULL AND
      "completedAt" IS NULL AND "failedAt" IS NULL
    )
  )
);

CREATE TABLE "FloorImportCandidate" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "sourceEntityId" TEXT NOT NULL,
  "layerName" TEXT NOT NULL,
  "blockName" TEXT,
  "x" DOUBLE PRECISION NOT NULL,
  "y" DOUBLE PRECISION NOT NULL,
  "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "confidence" DOUBLE PRECISION NOT NULL,
  "detectionMethod" "FloorImportDetectionMethod" NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "inputDigest" TEXT,
  "reviewStatus" "FloorImportCandidateReviewStatus" NOT NULL DEFAULT 'pending',
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FloorImportCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FloorImportCandidate_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FloorImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorImportCandidate_source_check" CHECK (
    length(btrim("sourceEntityId")) BETWEEN 1 AND 512 AND
    length(btrim("layerName")) BETWEEN 1 AND 512 AND
    ("blockName" IS NULL OR length(btrim("blockName")) BETWEEN 1 AND 512)
  ),
  CONSTRAINT "FloorImportCandidate_position_check" CHECK (
    "x" >= 0 AND "x" NOT IN ('Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "y" >= 0 AND "y" NOT IN ('Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "rotation" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION)
  ),
  CONSTRAINT "FloorImportCandidate_confidence_check" CHECK ("confidence" BETWEEN 0 AND 1),
  CONSTRAINT "FloorImportCandidate_ai_metadata_check" CHECK (
    ("detectionMethod" = 'rule_based' AND "provider" IS NULL AND "model" IS NULL AND "inputDigest" IS NULL) OR
    ("detectionMethod" = 'ai_assisted' AND
      "provider" IS NOT NULL AND "model" IS NOT NULL AND "inputDigest" IS NOT NULL AND
      length(btrim("provider")) BETWEEN 1 AND 200 AND
      length(btrim("model")) BETWEEN 1 AND 200 AND
      "inputDigest" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "FloorImportCandidate_review_check" CHECK (
    ("reviewStatus" = 'pending' AND "reviewedAt" IS NULL) OR
    ("reviewStatus" IN ('accepted', 'rejected') AND "reviewedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "FloorImportJob_renderedAssetId_key" ON "FloorImportJob"("renderedAssetId");
CREATE INDEX "FloorImportJob_floorId_createdAt_idx" ON "FloorImportJob"("floorId", "createdAt");
CREATE INDEX "FloorImportJob_sourceAssetId_idx" ON "FloorImportJob"("sourceAssetId");
CREATE INDEX "FloorImportJob_status_leaseExpiresAt_createdAt_idx" ON "FloorImportJob"("status", "leaseExpiresAt", "createdAt");

-- Terminal jobs remain as history; only one job may own a floor's conversion/review/apply workflow.
CREATE UNIQUE INDEX "FloorImportJob_floorId_active_key"
ON "FloorImportJob"("floorId")
WHERE "status" IN ('queued', 'processing', 'review_required', 'applying');

CREATE UNIQUE INDEX "FloorImportCandidate_jobId_sourceEntityId_key" ON "FloorImportCandidate"("jobId", "sourceEntityId");
CREATE INDEX "FloorImportCandidate_jobId_reviewStatus_id_idx" ON "FloorImportCandidate"("jobId", "reviewStatus", "id");

-- Prisma cannot express cross-table asset role/tenant/MIME invariants. Deferred
-- constraint triggers validate the final transaction state from both mutation sides.
CREATE FUNCTION "floor_import_job_assets_are_valid"(job_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "FloorImportJob" AS job
    JOIN "FloorAsset" AS source ON source."id" = job."sourceAssetId"
    LEFT JOIN "FloorAsset" AS rendered ON rendered."id" = job."renderedAssetId"
    WHERE job."id" = job_id
      AND source."floorId" = job."floorId"
      AND source."kind" = 'original'
      AND source."status" = 'ready'
      AND (
        (job."sourceFormat" = 'dwg' AND source."mimeType" IN (
          'application/acad', 'application/x-acad', 'application/autocad', 'application/dwg',
          'application/x-dwg', 'application/vnd.autodesk.autocad.dwg', 'image/vnd.dwg', 'image/x-dwg'
        )) OR
        (job."sourceFormat" = 'dxf' AND source."mimeType" IN (
          'application/dxf', 'application/x-dxf', 'application/vnd.autodesk.autocad.dxf',
          'image/vnd.dxf', 'image/x-dxf'
        ))
      )
      AND (
        job."renderedAssetId" IS NULL OR (
          rendered."floorId" = job."floorId" AND rendered."kind" = 'rendered' AND
          rendered."status" = 'ready' AND rendered."mimeType" IN ('image/svg+xml', 'image/png', 'image/jpeg', 'image/webp')
        )
      )
  );
$$;

CREATE FUNCTION "enforce_floor_import_job_asset_invariants"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  invalid_job_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'FloorImportJob' THEN
    IF EXISTS (SELECT 1 FROM "FloorImportJob" WHERE "id" = NEW."id")
      AND NOT "floor_import_job_assets_are_valid"(NEW."id") THEN
      RAISE EXCEPTION 'floor import job asset invariant violated: job=%', NEW."id"
        USING ERRCODE = '23514', CONSTRAINT = 'FloorImportJob_asset_invariant';
    END IF;
  ELSE
    SELECT job."id" INTO invalid_job_id
    FROM "FloorImportJob" AS job
    WHERE (job."sourceAssetId" = NEW."id" OR job."renderedAssetId" = NEW."id")
      AND NOT "floor_import_job_assets_are_valid"(job."id")
    LIMIT 1;
    IF invalid_job_id IS NOT NULL THEN
      RAISE EXCEPTION 'floor import job asset invariant violated: job=%', invalid_job_id
        USING ERRCODE = '23514', CONSTRAINT = 'FloorAsset_import_job_invariant';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "FloorImportJob_asset_invariant"
AFTER INSERT OR UPDATE ON "FloorImportJob"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_import_job_asset_invariants"();

CREATE CONSTRAINT TRIGGER "FloorAsset_import_job_invariant"
AFTER UPDATE ON "FloorAsset"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_import_job_asset_invariants"();
