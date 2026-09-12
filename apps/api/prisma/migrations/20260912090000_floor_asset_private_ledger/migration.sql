ALTER TABLE "FloorAsset"
ADD COLUMN "uploadExpiresAt" TIMESTAMP(3),
ADD COLUMN "cleanupStartedAt" TIMESTAMP(3);

UPDATE "FloorAsset"
SET "uploadExpiresAt" = "createdAt" + INTERVAL '5 minutes'
WHERE "status" = 'pending';

UPDATE "FloorPlan" AS plan
SET "imageUrl" = '/api/floors/' || asset."floorId" || '/assets/' || asset."id" || '/content'
FROM "FloorAsset" AS asset
WHERE plan."floorId" = asset."floorId"
  AND plan."imageUrl" = asset."publicUrl";

UPDATE "FloorPlan" AS plan
SET "originalFileUrl" = '/api/floors/' || asset."floorId" || '/assets/' || asset."id" || '/content'
FROM "FloorAsset" AS asset
WHERE plan."floorId" = asset."floorId"
  AND plan."originalFileUrl" = asset."publicUrl";

UPDATE "FloorPlan" AS plan
SET "renderedImageUrl" = '/api/floors/' || asset."floorId" || '/assets/' || asset."id" || '/content'
FROM "FloorAsset" AS asset
WHERE plan."floorId" = asset."floorId"
  AND plan."renderedImageUrl" = asset."publicUrl";

CREATE TEMP TABLE "_FloorMapRevisionAssetPathChanged" (
  "id" TEXT PRIMARY KEY
);

INSERT INTO "_FloorMapRevisionAssetPathChanged" ("id")
SELECT DISTINCT revision."id"
FROM "FloorMapRevision" AS revision
JOIN "FloorAsset" AS asset ON asset."floorId" = revision."floorId"
WHERE revision."snapshot" #>> '{floorPlan,imageUrl}' = asset."publicUrl"
   OR revision."snapshot" #>> '{floorPlan,originalFileUrl}' = asset."publicUrl"
   OR revision."snapshot" #>> '{floorPlan,renderedImageUrl}' = asset."publicUrl";

UPDATE "FloorMapRevision" AS revision
SET "snapshot" = jsonb_set(
  revision."snapshot",
  '{floorPlan,imageUrl}',
  to_jsonb('/api/floors/' || asset."floorId" || '/assets/' || asset."id" || '/content'),
  false
)
FROM "FloorAsset" AS asset
WHERE revision."floorId" = asset."floorId"
  AND revision."snapshot" #>> '{floorPlan,imageUrl}' = asset."publicUrl";

UPDATE "FloorMapRevision" AS revision
SET "snapshot" = jsonb_set(
  revision."snapshot",
  '{floorPlan,originalFileUrl}',
  to_jsonb('/api/floors/' || asset."floorId" || '/assets/' || asset."id" || '/content'),
  false
)
FROM "FloorAsset" AS asset
WHERE revision."floorId" = asset."floorId"
  AND revision."snapshot" #>> '{floorPlan,originalFileUrl}' = asset."publicUrl";

UPDATE "FloorMapRevision" AS revision
SET "snapshot" = jsonb_set(
  revision."snapshot",
  '{floorPlan,renderedImageUrl}',
  to_jsonb('/api/floors/' || asset."floorId" || '/assets/' || asset."id" || '/content'),
  false
)
FROM "FloorAsset" AS asset
WHERE revision."floorId" = asset."floorId"
  AND revision."snapshot" #>> '{floorPlan,renderedImageUrl}' = asset."publicUrl";

-- FloorMapRevision hashes use the API's recursively key-sorted, compact JSON form.
-- Recompute only snapshots changed above so historical integrity metadata remains aligned.
CREATE FUNCTION pg_temp.floor_editor_stable_json(value JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  result TEXT;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(to_json(key)::text || ':' || pg_temp.floor_editor_stable_json(child), ',' ORDER BY key COLLATE "C"), '') || '}'
      INTO result
      FROM jsonb_each(value) AS entry(key, child);
      RETURN result;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(pg_temp.floor_editor_stable_json(child), ',' ORDER BY ordinal), '') || ']'
      INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(child, ordinal);
      RETURN result;
    ELSE
      RETURN value::text;
  END CASE;
END;
$$;

UPDATE "FloorMapRevision" AS revision
SET "snapshotSha256" = encode(sha256(convert_to(pg_temp.floor_editor_stable_json(revision."snapshot"), 'UTF8')), 'hex')
FROM "_FloorMapRevisionAssetPathChanged" AS changed
WHERE changed."id" = revision."id";

DROP TABLE "_FloorMapRevisionAssetPathChanged";

ALTER TABLE "FloorAsset" DROP COLUMN "publicUrl";

CREATE INDEX "FloorAsset_status_uploadExpiresAt_cleanupStartedAt_idx"
ON "FloorAsset"("status", "uploadExpiresAt", "cleanupStartedAt");
