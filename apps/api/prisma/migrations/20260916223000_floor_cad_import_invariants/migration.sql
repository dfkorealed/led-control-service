ALTER TABLE "FloorImportJob" ADD COLUMN "failedAt" TIMESTAMP(3);

ALTER TABLE "FloorImportCandidate"
ADD COLUMN "provider" TEXT,
ADD COLUMN "model" TEXT,
ADD COLUMN "inputDigest" TEXT;

-- Existing failures predate failedAt. Their persisted update time is the only
-- deterministic timestamp available for the required terminal-state marker.
UPDATE "FloorImportJob"
SET "failedAt" = "updatedAt"
WHERE "status" = 'failed' AND "failedAt" IS NULL;

ALTER TABLE "FloorImportJob"
ADD CONSTRAINT "FloorImportJob_lifecycle_check" CHECK (
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
);

ALTER TABLE "FloorImportCandidate"
ADD CONSTRAINT "FloorImportCandidate_ai_metadata_check" CHECK (
  ("detectionMethod" = 'rule_based' AND "provider" IS NULL AND "model" IS NULL AND "inputDigest" IS NULL) OR
  ("detectionMethod" = 'ai_assisted' AND
    "provider" IS NOT NULL AND "model" IS NOT NULL AND "inputDigest" IS NOT NULL AND
    length(btrim("provider")) BETWEEN 1 AND 200 AND
    length(btrim("model")) BETWEEN 1 AND 200 AND
    "inputDigest" ~ '^[a-f0-9]{64}$')
);

DROP INDEX "FloorImportJob_sourceAssetId_key";
CREATE INDEX "FloorImportJob_sourceAssetId_idx" ON "FloorImportJob"("sourceAssetId");

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

DO $$
DECLARE
  invalid_job_id TEXT;
BEGIN
  SELECT job."id" INTO invalid_job_id
  FROM "FloorImportJob" AS job
  WHERE NOT "floor_import_job_assets_are_valid"(job."id")
  LIMIT 1;

  IF invalid_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'floor import job asset invariant violated during migration: job=%', invalid_job_id
      USING ERRCODE = '23514', CONSTRAINT = 'FloorImportJob_asset_invariant';
  END IF;
END;
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
