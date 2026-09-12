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

-- FloorMapRevision hashes use the API's recursively key-sorted, compact JSON form.
-- PostgreSQL JSONB preserves decimal digits, while the API parses numbers as IEEE-754
-- and JSON.stringify switches to exponent notation below 1e-6 and at 1e21.
CREATE FUNCTION pg_temp.floor_editor_json_number(value JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET extra_float_digits = 1 AS $$
DECLARE
  number_text TEXT := lower((value #>> '{}')::DOUBLE PRECISION::TEXT);
  sign_text TEXT := '';
  mantissa TEXT;
  digits TEXT;
  digits_before_decimal INTEGER;
  exponent_value INTEGER;
  scientific_exponent INTEGER;
  decimal_position INTEGER;
BEGIN
  IF position('e' IN number_text) = 0 THEN
    RETURN number_text;
  END IF;

  mantissa := split_part(number_text, 'e', 1);
  exponent_value := split_part(number_text, 'e', 2)::INTEGER;
  IF left(mantissa, 1) = '-' THEN
    sign_text := '-';
    mantissa := substr(mantissa, 2);
  END IF;

  digits_before_decimal := CASE
    WHEN position('.' IN mantissa) = 0 THEN length(mantissa)
    ELSE position('.' IN mantissa) - 1
  END;
  digits := replace(mantissa, '.', '');
  scientific_exponent := exponent_value + digits_before_decimal - 1;

  IF scientific_exponent BETWEEN -6 AND 20 THEN
    decimal_position := scientific_exponent + 1;
    IF decimal_position <= 0 THEN
      RETURN sign_text || '0.' || repeat('0', -decimal_position) || digits;
    END IF;
    IF decimal_position >= length(digits) THEN
      RETURN sign_text || digits || repeat('0', decimal_position - length(digits));
    END IF;
    RETURN sign_text || substr(digits, 1, decimal_position) || '.' || substr(digits, decimal_position + 1);
  END IF;

  RETURN sign_text || left(digits, 1)
    || CASE WHEN length(digits) > 1 THEN '.' || substr(digits, 2) ELSE '' END
    || 'e' || CASE WHEN scientific_exponent >= 0 THEN '+' ELSE '' END
    || scientific_exponent::TEXT;
END;
$$;

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
    WHEN 'number' THEN
      RETURN pg_temp.floor_editor_json_number(value);
    ELSE
      RETURN value::text;
  END CASE;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "FloorMapRevision" AS revision
    JOIN "_FloorMapRevisionAssetPathChanged" AS changed ON changed."id" = revision."id"
    WHERE revision."snapshotSha256" <> encode(
      sha256(convert_to(pg_temp.floor_editor_stable_json(revision."snapshot"), 'UTF8')),
      'hex'
    )
  ) THEN
    RAISE EXCEPTION 'FloorMapRevision snapshot integrity check failed before private asset URL migration';
  END IF;
END;
$$;

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

-- Recompute only snapshots changed above so historical integrity metadata remains aligned.
UPDATE "FloorMapRevision" AS revision
SET "snapshotSha256" = encode(sha256(convert_to(pg_temp.floor_editor_stable_json(revision."snapshot"), 'UTF8')), 'hex')
FROM "_FloorMapRevisionAssetPathChanged" AS changed
WHERE changed."id" = revision."id";

DROP TABLE "_FloorMapRevisionAssetPathChanged";

ALTER TABLE "FloorAsset" DROP COLUMN "publicUrl";

CREATE INDEX "FloorAsset_status_uploadExpiresAt_cleanupStartedAt_idx"
ON "FloorAsset"("status", "uploadExpiresAt", "cleanupStartedAt");
