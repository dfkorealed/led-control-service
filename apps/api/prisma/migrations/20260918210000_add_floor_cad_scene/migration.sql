BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TYPE "FloorPlanSourceType" ADD VALUE 'cad';
ALTER TYPE "FloorAssetKind" ADD VALUE 'cad_manifest';
ALTER TYPE "FloorAssetKind" ADD VALUE 'cad_tile';
ALTER TYPE "FloorAssetKind" ADD VALUE 'cad_region_preview';
ALTER TYPE "FloorImportJobStatus" ADD VALUE 'region_selection_required' AFTER 'processing';

LOCK TABLE "FloorImportJob" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "FloorImportJob"
DROP CONSTRAINT "FloorImportJob_lifecycle_check";

DROP INDEX "FloorImportJob_floorId_active_key";

ALTER TABLE "FloorImportJob"
ADD CONSTRAINT "FloorImportJob_lifecycle_check" CHECK (
  (
    "status" = 'queued' AND "progressPercent" BETWEEN 0 AND 99 AND
    ("progressPercent" = 0 OR "attemptCount" >= 1) AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "renderedAssetId" IS NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND
    "startedAt" IS NULL AND "reviewRequiredAt" IS NULL AND "appliedAt" IS NULL AND
    "completedAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'processing' AND "progressPercent" BETWEEN 1 AND 99 AND "attemptCount" >= 1 AND
    "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND
    "startedAt" IS NOT NULL AND "renderedAssetId" IS NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND
    "reviewRequiredAt" IS NULL AND "appliedAt" IS NULL AND "completedAt" IS NULL AND
    "failedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status"::text = 'region_selection_required' AND "progressPercent" BETWEEN 1 AND 99 AND
    "attemptCount" >= 1 AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND
    "renderedAssetId" IS NULL AND "startedAt" IS NOT NULL AND "reviewRequiredAt" IS NOT NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND "appliedAt" IS NULL AND
    "completedAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'review_required' AND "progressPercent" = 100 AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND
    "renderedAssetId" IS NOT NULL AND "startedAt" IS NOT NULL AND "reviewRequiredAt" IS NOT NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND "appliedAt" IS NULL AND
    "completedAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'applying' AND "progressPercent" = 100 AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND
    "renderedAssetId" IS NOT NULL AND "startedAt" IS NOT NULL AND "reviewRequiredAt" IS NOT NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND "appliedAt" IS NULL AND
    "completedAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'completed' AND "progressPercent" = 100 AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND
    "renderedAssetId" IS NOT NULL AND "startedAt" IS NOT NULL AND "reviewRequiredAt" IS NOT NULL AND
    "appliedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'failed' AND "progressPercent" BETWEEN 0 AND 100 AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "failureCode" IS NOT NULL AND
    length(btrim("failureCode")) BETWEEN 1 AND 100 AND "failureMessage" IS NOT NULL AND
    length(btrim("failureMessage")) BETWEEN 1 AND 2000 AND "failedAt" IS NOT NULL AND
    "completedAt" IS NULL AND "cancelledAt" IS NULL
  ) OR (
    "status" = 'cancelled' AND "progressPercent" BETWEEN 0 AND 100 AND
    "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND
    "failureCode" IS NULL AND "failureMessage" IS NULL AND "cancelledAt" IS NOT NULL AND
    "completedAt" IS NULL AND "failedAt" IS NULL
  )
);

CREATE UNIQUE INDEX "FloorImportJob_floorId_active_key"
ON "FloorImportJob"("floorId")
WHERE "status" NOT IN ('completed', 'failed', 'cancelled');

CREATE TABLE "FloorImportRegion" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "regionId" TEXT NOT NULL,
  "minX" DOUBLE PRECISION NOT NULL,
  "minY" DOUBLE PRECISION NOT NULL,
  "maxX" DOUBLE PRECISION NOT NULL,
  "maxY" DOUBLE PRECISION NOT NULL,
  "primitiveCount" INTEGER NOT NULL,
  "previewAssetId" TEXT,
  "selectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FloorImportRegion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FloorImportRegion_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "FloorImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorImportRegion_previewAssetId_fkey"
    FOREIGN KEY ("previewAssetId") REFERENCES "FloorAsset"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "FloorImportRegion_regionId_check"
    CHECK (length(btrim("regionId")) BETWEEN 1 AND 512),
  CONSTRAINT "FloorImportRegion_primitiveCount_check"
    CHECK ("primitiveCount" BETWEEN 1 AND 500000),
  CONSTRAINT "FloorImportRegion_bounds_check" CHECK (
    "minX" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "minY" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "maxX" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "maxY" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "maxX" > "minX" AND "maxY" > "minY"
  )
);

CREATE TABLE "FloorCadScene" (
  "id" TEXT NOT NULL,
  "floorId" TEXT NOT NULL,
  "sourceImportJobId" TEXT NOT NULL,
  "sourceRegionId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "tileSize" INTEGER NOT NULL DEFAULT 512,
  "primitiveCount" INTEGER NOT NULL,
  "tileCount" INTEGER NOT NULL,
  "manifestAssetId" TEXT NOT NULL,
  "sourceMinX" DOUBLE PRECISION NOT NULL,
  "sourceMinY" DOUBLE PRECISION NOT NULL,
  "sourceMaxX" DOUBLE PRECISION NOT NULL,
  "sourceMaxY" DOUBLE PRECISION NOT NULL,
  "transformScaleX" DOUBLE PRECISION NOT NULL,
  "transformScaleY" DOUBLE PRECISION NOT NULL,
  "transformTranslateX" DOUBLE PRECISION NOT NULL,
  "transformTranslateY" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FloorCadScene_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FloorCadScene_floorId_fkey"
    FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorCadScene_sourceImportJobId_fkey"
    FOREIGN KEY ("sourceImportJobId") REFERENCES "FloorImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorCadScene_sourceRegionId_fkey"
    FOREIGN KEY ("sourceRegionId") REFERENCES "FloorImportRegion"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "FloorCadScene_manifestAssetId_fkey"
    FOREIGN KEY ("manifestAssetId") REFERENCES "FloorAsset"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "FloorCadScene_dimensions_check" CHECK (
    "version" = 1 AND "status" = 'active' AND
    "width" BETWEEN 512 AND 32768 AND "height" BETWEEN 512 AND 32768 AND
    "tileSize" = 512 AND "primitiveCount" BETWEEN 0 AND 500000 AND
    "tileCount" BETWEEN 0 AND 12288
  ),
  CONSTRAINT "FloorCadScene_geometry_check" CHECK (
    "sourceMinX" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "sourceMinY" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "sourceMaxX" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "sourceMaxY" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "sourceMaxX" > "sourceMinX" AND "sourceMaxY" > "sourceMinY" AND
    "transformScaleX" > 0 AND
    "transformScaleX" NOT IN ('Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "transformScaleY" <> 0 AND
    "transformScaleY" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "transformTranslateX" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "transformTranslateY" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION)
  )
);

CREATE TABLE "FloorCadTile" (
  "id" TEXT NOT NULL,
  "sceneId" TEXT NOT NULL,
  "tileX" INTEGER NOT NULL,
  "tileY" INTEGER NOT NULL,
  "lod" INTEGER NOT NULL,
  "assetId" TEXT NOT NULL,
  "primitiveCount" INTEGER NOT NULL,
  "byteSize" BIGINT NOT NULL,
  "minX" DOUBLE PRECISION NOT NULL,
  "minY" DOUBLE PRECISION NOT NULL,
  "maxX" DOUBLE PRECISION NOT NULL,
  "maxY" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FloorCadTile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FloorCadTile_sceneId_fkey"
    FOREIGN KEY ("sceneId") REFERENCES "FloorCadScene"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorCadTile_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "FloorAsset"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "FloorCadTile_coordinate_check"
    CHECK ("tileX" BETWEEN 0 AND 63 AND "tileY" BETWEEN 0 AND 63 AND "lod" BETWEEN 0 AND 2),
  CONSTRAINT "FloorCadTile_size_check"
    CHECK ("primitiveCount" BETWEEN 0 AND 500000 AND "byteSize" BETWEEN 1 AND 16777216),
  CONSTRAINT "FloorCadTile_bounds_check" CHECK (
    "minX" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "minY" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "maxX" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "maxY" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "maxX" > "minX" AND "maxY" > "minY"
  )
);

CREATE TABLE "FloorCadElementOverride" (
  "sceneId" TEXT NOT NULL,
  "elementId" TEXT NOT NULL,
  "hidden" BOOLEAN,
  "translateX" DOUBLE PRECISION,
  "translateY" DOUBLE PRECISION,
  "scaleX" DOUBLE PRECISION,
  "scaleY" DOUBLE PRECISION,
  "rotation" DOUBLE PRECISION,
  "strokeColor" TEXT,
  "fillColor" TEXT,
  "strokeWidth" DOUBLE PRECISION,
  "text" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FloorCadElementOverride_pkey" PRIMARY KEY ("sceneId", "elementId"),
  CONSTRAINT "FloorCadElementOverride_sceneId_fkey"
    FOREIGN KEY ("sceneId") REFERENCES "FloorCadScene"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorCadElementOverride_elementId_check"
    CHECK (length(btrim("elementId")) BETWEEN 1 AND 512),
  CONSTRAINT "FloorCadElementOverride_value_check" CHECK (
    "hidden" IS NOT NULL OR "translateX" IS NOT NULL OR "translateY" IS NOT NULL OR
    "scaleX" IS NOT NULL OR "scaleY" IS NOT NULL OR "rotation" IS NOT NULL OR
    "strokeColor" IS NOT NULL OR "fillColor" IS NOT NULL OR "strokeWidth" IS NOT NULL OR "text" IS NOT NULL
  ),
  CONSTRAINT "FloorCadElementOverride_transform_check" CHECK (
    ("translateX" IS NULL OR "translateX" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION)) AND
    ("translateY" IS NULL OR "translateY" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION)) AND
    ("scaleX" IS NULL OR ("scaleX" > 0 AND "scaleX" NOT IN ('Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION))) AND
    ("scaleY" IS NULL OR ("scaleY" > 0 AND "scaleY" NOT IN ('Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION))) AND
    ("rotation" IS NULL OR "rotation" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION)) AND
    ("strokeWidth" IS NULL OR ("strokeWidth" >= 0 AND "strokeWidth" NOT IN ('Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION)))
  ),
  CONSTRAINT "FloorCadElementOverride_style_check" CHECK (
    ("strokeColor" IS NULL OR "strokeColor" ~ '^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$') AND
    ("fillColor" IS NULL OR "fillColor" ~ '^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$') AND
    ("text" IS NULL OR length("text") <= 65536)
  )
);

CREATE TABLE "FloorCadLayerState" (
  "sceneId" TEXT NOT NULL,
  "layerName" TEXT NOT NULL,
  "visible" BOOLEAN NOT NULL DEFAULT true,
  "locked" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FloorCadLayerState_pkey" PRIMARY KEY ("sceneId", "layerName"),
  CONSTRAINT "FloorCadLayerState_sceneId_fkey"
    FOREIGN KEY ("sceneId") REFERENCES "FloorCadScene"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorCadLayerState_layerName_check"
    CHECK (length(btrim("layerName")) BETWEEN 1 AND 512)
);

CREATE UNIQUE INDEX "FloorImportRegion_previewAssetId_key" ON "FloorImportRegion"("previewAssetId");
CREATE UNIQUE INDEX "FloorImportRegion_jobId_regionId_key" ON "FloorImportRegion"("jobId", "regionId");
CREATE INDEX "FloorImportRegion_jobId_selectedAt_idx" ON "FloorImportRegion"("jobId", "selectedAt");
CREATE UNIQUE INDEX "FloorImportRegion_jobId_selected_key"
ON "FloorImportRegion"("jobId") WHERE "selectedAt" IS NOT NULL;

CREATE UNIQUE INDEX "FloorCadScene_floorId_key" ON "FloorCadScene"("floorId");
CREATE UNIQUE INDEX "FloorCadScene_sourceImportJobId_key" ON "FloorCadScene"("sourceImportJobId");
CREATE UNIQUE INDEX "FloorCadScene_sourceRegionId_key" ON "FloorCadScene"("sourceRegionId");
CREATE UNIQUE INDEX "FloorCadScene_manifestAssetId_key" ON "FloorCadScene"("manifestAssetId");
CREATE INDEX "FloorCadScene_status_createdAt_idx" ON "FloorCadScene"("status", "createdAt");

CREATE UNIQUE INDEX "FloorCadTile_assetId_key" ON "FloorCadTile"("assetId");
CREATE UNIQUE INDEX "FloorCadTile_sceneId_tileX_tileY_lod_key"
ON "FloorCadTile"("sceneId", "tileX", "tileY", "lod");
CREATE INDEX "FloorCadTile_sceneId_lod_idx" ON "FloorCadTile"("sceneId", "lod");
CREATE INDEX "FloorCadElementOverride_sceneId_updatedAt_idx"
ON "FloorCadElementOverride"("sceneId", "updatedAt");

-- CAD binary geometry remains in FloorAsset-backed object storage. These
-- predicates only validate ownership, asset role, and the selected region.
CREATE FUNCTION "floor_import_region_is_valid"(region_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "FloorImportRegion" AS region
    JOIN "FloorImportJob" AS job ON job."id" = region."jobId"
    LEFT JOIN "FloorAsset" AS preview ON preview."id" = region."previewAssetId"
    WHERE region."id" = region_id
      AND (
        region."previewAssetId" IS NULL OR (
          preview."floorId" = job."floorId" AND
          preview."kind"::text = 'cad_region_preview' AND preview."status" = 'ready'
        )
      )
  );
$$;

CREATE FUNCTION "floor_cad_scene_is_valid"(scene_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "FloorCadScene" AS scene
    JOIN "FloorImportJob" AS job ON job."id" = scene."sourceImportJobId"
    JOIN "FloorImportRegion" AS region ON region."id" = scene."sourceRegionId"
    JOIN "FloorAsset" AS manifest ON manifest."id" = scene."manifestAssetId"
    WHERE scene."id" = scene_id
      AND job."floorId" = scene."floorId"
      AND region."jobId" = job."id"
      AND region."selectedAt" IS NOT NULL
      AND "floor_import_region_is_valid"(region."id")
      AND scene."sourceMinX" = region."minX"
      AND scene."sourceMinY" = region."minY"
      AND scene."sourceMaxX" = region."maxX"
      AND scene."sourceMaxY" = region."maxY"
      AND manifest."floorId" = scene."floorId"
      AND manifest."kind"::text = 'cad_manifest'
      AND manifest."status" = 'ready'
  );
$$;

CREATE FUNCTION "floor_cad_tile_is_valid"(tile_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "FloorCadTile" AS tile
    JOIN "FloorCadScene" AS scene ON scene."id" = tile."sceneId"
    JOIN "FloorAsset" AS asset ON asset."id" = tile."assetId"
    WHERE tile."id" = tile_id
      AND "floor_cad_scene_is_valid"(scene."id")
      AND asset."floorId" = scene."floorId"
      AND asset."kind"::text = 'cad_tile'
      AND asset."status" = 'ready'
      AND tile."tileX" < CEIL(scene."width"::numeric / scene."tileSize")
      AND tile."tileY" < CEIL(scene."height"::numeric / scene."tileSize")
      AND tile."minX" = tile."tileX" * scene."tileSize"
      AND tile."minY" = tile."tileY" * scene."tileSize"
      AND tile."maxX" = LEAST(scene."width", (tile."tileX" + 1) * scene."tileSize")
      AND tile."maxY" = LEAST(scene."height", (tile."tileY" + 1) * scene."tileSize")
      AND tile."minX" >= 0 AND tile."minY" >= 0
      AND tile."maxX" <= scene."width" AND tile."maxY" <= scene."height"
  );
$$;

CREATE FUNCTION "floor_cad_scene_with_tiles_is_valid"(scene_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT "floor_cad_scene_is_valid"(scene_id)
    AND NOT EXISTS (
      SELECT 1
      FROM "FloorCadTile" AS tile
      WHERE tile."sceneId" = scene_id
        AND NOT "floor_cad_tile_is_valid"(tile."id")
    );
$$;

-- Lock scene ownership rows before validation so concurrent job, region, or
-- asset mutations cannot commit against a pre-insert/pre-update scene snapshot.
CREATE FUNCTION "lock_floor_cad_referenced_owners"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  referenced_asset_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'FloorImportRegion' THEN
    referenced_asset_id := NEW."previewAssetId";
  ELSIF TG_TABLE_NAME = 'FloorCadScene' THEN
    -- Keep this order stable for every scene write. The scene validity predicate
    -- depends on both rows, so asset-only locking leaves a write-skew window.
    PERFORM job."id"
    FROM "FloorImportJob" AS job
    WHERE job."id" = NEW."sourceImportJobId"
    FOR UPDATE;
    PERFORM region."id"
    FROM "FloorImportRegion" AS region
    WHERE region."id" = NEW."sourceRegionId"
    FOR UPDATE;
    referenced_asset_id := NEW."manifestAssetId";
  ELSE
    referenced_asset_id := NEW."assetId";
  END IF;

  IF referenced_asset_id IS NOT NULL THEN
    PERFORM asset."id"
    FROM "FloorAsset" AS asset
    WHERE asset."id" = referenced_asset_id
    FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_floor_cad_link_invariants"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  invalid_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'FloorImportRegion' THEN
    IF NOT "floor_import_region_is_valid"(NEW."id") THEN
      invalid_id := NEW."id";
    ELSE
      SELECT scene."id" INTO invalid_id
      FROM "FloorCadScene" AS scene
      WHERE scene."sourceRegionId" = NEW."id"
        AND NOT "floor_cad_scene_with_tiles_is_valid"(scene."id")
      LIMIT 1;
    END IF;
  ELSIF TG_TABLE_NAME = 'FloorCadScene' THEN
    IF NOT "floor_cad_scene_with_tiles_is_valid"(NEW."id") THEN
      invalid_id := NEW."id";
    END IF;
  ELSIF TG_TABLE_NAME = 'FloorCadTile' THEN
    IF NOT "floor_cad_tile_is_valid"(NEW."id") THEN
      invalid_id := NEW."id";
    END IF;
  ELSIF TG_TABLE_NAME = 'FloorImportJob' THEN
    SELECT linked."id" INTO invalid_id
    FROM (
      SELECT region."id"
      FROM "FloorImportRegion" AS region
      WHERE region."jobId" = NEW."id" AND NOT "floor_import_region_is_valid"(region."id")
      UNION ALL
      SELECT scene."id"
      FROM "FloorCadScene" AS scene
      WHERE scene."sourceImportJobId" = NEW."id"
        AND NOT "floor_cad_scene_with_tiles_is_valid"(scene."id")
    ) AS linked
    LIMIT 1;
  ELSE
    SELECT linked."id" INTO invalid_id
    FROM (
      SELECT region."id"
      FROM "FloorImportRegion" AS region
      WHERE region."previewAssetId" = NEW."id" AND NOT "floor_import_region_is_valid"(region."id")
      UNION ALL
      SELECT scene."id"
      FROM "FloorCadScene" AS scene
      WHERE scene."manifestAssetId" = NEW."id"
        AND NOT "floor_cad_scene_with_tiles_is_valid"(scene."id")
      UNION ALL
      SELECT tile."id"
      FROM "FloorCadTile" AS tile
      WHERE tile."assetId" = NEW."id" AND NOT "floor_cad_tile_is_valid"(tile."id")
    ) AS linked
    LIMIT 1;
  END IF;

  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION 'floor CAD scene scope invariant violated: record=%', invalid_id
      USING ERRCODE = '23514', CONSTRAINT = 'FloorCadScene_scope_invariant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "FloorImportRegion_cad_asset_lock"
BEFORE INSERT OR UPDATE ON "FloorImportRegion"
FOR EACH ROW EXECUTE FUNCTION "lock_floor_cad_referenced_owners"();

CREATE TRIGGER "FloorCadScene_cad_asset_lock"
BEFORE INSERT OR UPDATE ON "FloorCadScene"
FOR EACH ROW EXECUTE FUNCTION "lock_floor_cad_referenced_owners"();

CREATE TRIGGER "FloorCadTile_cad_asset_lock"
BEFORE INSERT OR UPDATE ON "FloorCadTile"
FOR EACH ROW EXECUTE FUNCTION "lock_floor_cad_referenced_owners"();

CREATE CONSTRAINT TRIGGER "FloorImportRegion_cad_scope_invariant"
AFTER INSERT OR UPDATE ON "FloorImportRegion"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_cad_link_invariants"();

CREATE CONSTRAINT TRIGGER "FloorCadScene_scope_invariant"
AFTER INSERT OR UPDATE ON "FloorCadScene"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_cad_link_invariants"();

CREATE CONSTRAINT TRIGGER "FloorCadTile_scope_invariant"
AFTER INSERT OR UPDATE ON "FloorCadTile"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_cad_link_invariants"();

CREATE CONSTRAINT TRIGGER "FloorImportJob_cad_scope_invariant"
AFTER UPDATE OF "floorId" ON "FloorImportJob"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_cad_link_invariants"();

CREATE CONSTRAINT TRIGGER "FloorAsset_cad_scope_invariant"
AFTER UPDATE ON "FloorAsset"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_cad_link_invariants"();

COMMIT;
