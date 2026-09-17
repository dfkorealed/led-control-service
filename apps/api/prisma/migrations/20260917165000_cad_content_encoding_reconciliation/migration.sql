BEGIN;
SET LOCAL lock_timeout = '10s';

LOCK TABLE "FloorAsset", "FloorImportJob", "FloorImportAttemptCleanup" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "FloorImportJob" WHERE "status" IN ('processing', 'applying')) THEN
    RAISE EXCEPTION 'drain CAD processing/applying jobs before content encoding migration'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

ALTER TABLE "FloorAsset" DROP CONSTRAINT "FloorAsset_content_encoding_check";
ALTER TABLE "FloorAsset"
  ADD CONSTRAINT "FloorAsset_content_encoding_check" CHECK (
    "contentEncoding" IS NULL OR "contentEncoding" IN ('gzip', 'unknown')
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
          (
            (rendered."mimeType" = 'image/svg+xml' AND
              (rendered."contentEncoding" IS NULL OR rendered."contentEncoding" IN ('gzip', 'unknown'))) OR
            (rendered."mimeType" IN ('image/png', 'image/jpeg', 'image/webp') AND rendered."contentEncoding" IS NULL)
          )
        )
      )
  );
$$;

-- A committed attempt ledger is the only durable evidence that the gzip-writing
-- worker produced the object. Every other linked SVG is intentionally unknown;
-- object storage, not timestamps, decides its encoding at first use.
UPDATE "FloorAsset" AS asset
SET "contentEncoding" = CASE WHEN EXISTS (
  SELECT 1 FROM "FloorImportAttemptCleanup" AS cleanup
  WHERE cleanup."assetId" = asset."id"
    AND cleanup."objectKey" = asset."objectKey"
    AND cleanup."committedAt" IS NOT NULL
    AND cleanup."cleanedAt" IS NULL
) THEN 'gzip' ELSE 'unknown' END
FROM "FloorImportJob" AS job
WHERE job."renderedAssetId" = asset."id"
  AND asset."mimeType" = 'image/svg+xml';

COMMIT;
