ALTER TABLE "FloorImportJob"
  ALTER COLUMN "detectorProfileId" DROP DEFAULT,
  ALTER COLUMN "detectorProfileId" DROP NOT NULL;

-- Active jobs are resolved from their locked source SHA-256 by the new worker.
-- Terminal/review jobs retain the profile identity that produced their result.
UPDATE "FloorImportJob"
SET "detectorProfileId" = NULL,
    "detectorProfileVersion" = NULL,
    "detectorProfileDigest" = NULL
WHERE "status" IN ('queued', 'processing');

ALTER TABLE "FloorImportJob"
  ADD CONSTRAINT "FloorImportJob_detector_profile_id_check" CHECK (
    "detectorProfileId" IS NULL OR
    "detectorProfileId" IN ('generic-lighting-v1', 'site-drawing-20260803-v1')
  );

ALTER TABLE "FloorAsset" ADD COLUMN "contentEncoding" TEXT;

UPDATE "FloorAsset" AS asset
SET "contentEncoding" = 'gzip'
FROM "FloorImportJob" AS job
WHERE job."renderedAssetId" = asset."id"
  AND asset."mimeType" = 'image/svg+xml';

ALTER TABLE "FloorAsset"
  ADD CONSTRAINT "FloorAsset_content_encoding_check" CHECK (
    "contentEncoding" IS NULL OR "contentEncoding" = 'gzip'
  );

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
          ((rendered."mimeType" = 'image/svg+xml' AND rendered."contentEncoding" = 'gzip') OR
           (rendered."mimeType" IN ('image/png', 'image/jpeg', 'image/webp') AND rendered."contentEncoding" IS NULL))
        )
      )
  );
$$;
