BEGIN;
SET LOCAL lock_timeout = '10s';

-- Deployments must stop/drain the old API before changing profile semantics.
-- The lock closes the gap between the active-job check and constraint install.
LOCK TABLE "FloorAsset", "FloorImportJob" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "FloorImportJob"
    WHERE "status" IN ('processing', 'applying')
  ) THEN
    RAISE EXCEPTION 'drain CAD processing/applying jobs before migration'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

-- Queued work has not produced output. The lease-owning worker resolves the
-- profile from the locked source SHA instead of accepting a migration guess.
UPDATE "FloorImportJob"
SET "detectorProfileId" = NULL,
    "detectorProfileVersion" = NULL,
    "detectorProfileDigest" = NULL
WHERE "status" = 'queued';

CREATE OR REPLACE FUNCTION "floor_import_job_assets_are_valid"(job_id TEXT) RETURNS BOOLEAN
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
          rendered."status" = 'ready' AND
          (
            (rendered."mimeType" = 'image/svg+xml' AND
              (rendered."contentEncoding" IS NULL OR rendered."contentEncoding" = 'gzip')) OR
            (rendered."mimeType" IN ('image/png', 'image/jpeg', 'image/webp') AND rendered."contentEncoding" IS NULL)
          )
        )
      )
  );
$$;

-- The preceding migration could not inspect object storage and marked every
-- linked SVG as gzip. Rows created before that migration finished are legacy
-- identity objects; gzip rows produced by the new worker afterwards stay gzip.
WITH profile_migration AS (
  SELECT "finished_at" AS installed_at
  FROM "_prisma_migrations"
  WHERE "migration_name" = '20260917150000_cad_profile_binding'
    AND "finished_at" IS NOT NULL
    AND "rolled_back_at" IS NULL
  ORDER BY "started_at" DESC
  LIMIT 1
)
UPDATE "FloorAsset" AS asset
SET "contentEncoding" = NULL
FROM "FloorImportJob" AS job, profile_migration
WHERE job."renderedAssetId" = asset."id"
  AND asset."mimeType" = 'image/svg+xml'
  AND asset."createdAt" < profile_migration.installed_at;

-- Results produced before immutable profile metadata existed keep an explicit
-- sentinel identity. Do not relabel them as output of the current rule set.
UPDATE "FloorImportJob"
SET "detectorProfileId" = COALESCE("detectorProfileId", 'generic-lighting-v1'),
    "detectorProfileVersion" = 'legacy-unknown',
    "detectorProfileDigest" = repeat('0', 64)
WHERE "status" IN ('review_required', 'completed')
  AND "detectorProfileVersion" IS NULL
  AND "detectorProfileDigest" IS NULL;

ALTER TABLE "FloorImportJob"
  ADD CONSTRAINT "FloorImportJob_detector_profile_state_check" CHECK (
    "status" NOT IN ('review_required', 'applying', 'completed') OR (
      "detectorProfileId" IS NOT NULL AND
      "detectorProfileVersion" IS NOT NULL AND
      "detectorProfileDigest" IS NOT NULL
    )
  );

DROP TRIGGER "FloorImportJob_asset_invariant" ON "FloorImportJob";
DROP TRIGGER "FloorAsset_import_job_invariant" ON "FloorAsset";

CREATE CONSTRAINT TRIGGER "FloorImportJob_asset_invariant"
AFTER INSERT OR UPDATE ON "FloorImportJob"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_import_job_asset_invariants"();

CREATE CONSTRAINT TRIGGER "FloorAsset_import_job_invariant"
AFTER UPDATE ON "FloorAsset"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_import_job_asset_invariants"();

COMMIT;
