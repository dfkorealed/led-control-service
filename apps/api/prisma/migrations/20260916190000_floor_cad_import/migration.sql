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
  CONSTRAINT "FloorImportJob_stage_check" CHECK (length(btrim("stage")) BETWEEN 1 AND 100)
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
  CONSTRAINT "FloorImportCandidate_review_check" CHECK (
    ("reviewStatus" = 'pending' AND "reviewedAt" IS NULL) OR
    ("reviewStatus" IN ('accepted', 'rejected') AND "reviewedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "FloorImportJob_sourceAssetId_key" ON "FloorImportJob"("sourceAssetId");
CREATE UNIQUE INDEX "FloorImportJob_renderedAssetId_key" ON "FloorImportJob"("renderedAssetId");
CREATE INDEX "FloorImportJob_floorId_createdAt_idx" ON "FloorImportJob"("floorId", "createdAt");
CREATE INDEX "FloorImportJob_status_leaseExpiresAt_createdAt_idx" ON "FloorImportJob"("status", "leaseExpiresAt", "createdAt");

-- Terminal jobs remain as history; only one job may own a floor's conversion/review/apply workflow.
CREATE UNIQUE INDEX "FloorImportJob_floorId_active_key"
ON "FloorImportJob"("floorId")
WHERE "status" IN ('queued', 'processing', 'review_required', 'applying');

CREATE UNIQUE INDEX "FloorImportCandidate_jobId_sourceEntityId_key" ON "FloorImportCandidate"("jobId", "sourceEntityId");
CREATE INDEX "FloorImportCandidate_jobId_reviewStatus_id_idx" ON "FloorImportCandidate"("jobId", "reviewStatus", "id");
