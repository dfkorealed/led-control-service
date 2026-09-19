-- CreateEnum
CREATE TYPE "FloorMapGenerationStatus" AS ENUM ('preparing', 'prepared', 'active', 'retired', 'failed');

-- CreateEnum
CREATE TYPE "FloorMapStageStatus" AS ENUM ('preparing', 'ready', 'committed', 'failed', 'expired');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FloorAssetKind" ADD VALUE 'map_manifest';
ALTER TYPE "FloorAssetKind" ADD VALUE 'map_chunk';
ALTER TYPE "FloorAssetKind" ADD VALUE 'map_index';
ALTER TYPE "FloorAssetKind" ADD VALUE 'map_changeset';
ALTER TYPE "FloorAssetKind" ADD VALUE 'map_stage_part';
ALTER TYPE "FloorAssetKind" ADD VALUE 'map_display_manifest';
ALTER TYPE "FloorAssetKind" ADD VALUE 'map_display_tile';

-- CreateTable
CREATE TABLE "FloorMapDocument" (
    "floorId" TEXT NOT NULL,
    "activeGenerationId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "changesSinceCheckpoint" INTEGER NOT NULL DEFAULT 0,
    "deltaDecodedBytes" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorMapDocument_pkey" PRIMARY KEY ("floorId")
);

-- CreateTable
CREATE TABLE "FloorMapGeneration" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "status" "FloorMapGenerationStatus" NOT NULL DEFAULT 'preparing',
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "baseRevision" INTEGER NOT NULL,
    "sourceGenerationId" TEXT,
    "sourceRevision" INTEGER,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "gridSize" INTEGER NOT NULL,
    "elementCount" INTEGER NOT NULL DEFAULT 0,
    "decodedBytes" BIGINT NOT NULL DEFAULT 0,
    "manifestAssetId" TEXT,
    "manifestDecodedBytes" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorMapGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorMapChunk" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "assetId" TEXT NOT NULL,
    "decodedBytes" INTEGER NOT NULL,
    "elementCount" INTEGER NOT NULL,
    "minX" DOUBLE PRECISION NOT NULL,
    "minY" DOUBLE PRECISION NOT NULL,
    "maxX" DOUBLE PRECISION NOT NULL,
    "maxY" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "FloorMapChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorMapIndexShard" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "decodedBytes" INTEGER NOT NULL,
    "elementCount" INTEGER NOT NULL,

    CONSTRAINT "FloorMapIndexShard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorMapChangeSet" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "baseRevision" INTEGER NOT NULL,
    "resultRevision" INTEGER NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payloadAssetId" TEXT NOT NULL,
    "inverseAssetId" TEXT NOT NULL,
    "decodedBytes" INTEGER NOT NULL,
    "inverseDecodedBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FloorMapChangeSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorMapRevisionAsset" (
    "revisionId" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,

    CONSTRAINT "FloorMapRevisionAsset_pkey" PRIMARY KEY ("revisionId","assetId")
);

-- CreateTable
CREATE TABLE "FloorMapStage" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leaseTokenHash" TEXT NOT NULL,
    "baseRevision" INTEGER NOT NULL,
    "status" "FloorMapStageStatus" NOT NULL DEFAULT 'preparing',
    "payloadHash" TEXT,
    "decodedBytes" BIGINT NOT NULL DEFAULT 0,
    "partCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorMapStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorMapStagePart" (
    "stageId" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "part" INTEGER NOT NULL,
    "assetId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "decodedBytes" INTEGER NOT NULL,

    CONSTRAINT "FloorMapStagePart_pkey" PRIMARY KEY ("stageId","part")
);

-- CreateIndex
CREATE UNIQUE INDEX "FloorMapDocument_activeGenerationId_key" ON "FloorMapDocument"("activeGenerationId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorMapDocument_activeGenerationId_floorId_key" ON "FloorMapDocument"("activeGenerationId", "floorId");

-- CreateIndex
CREATE INDEX "FloorMapGeneration_floorId_status_idx" ON "FloorMapGeneration"("floorId", "status");

-- CreateIndex
CREATE INDEX "FloorMapGeneration_status_expiresAt_idx" ON "FloorMapGeneration"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "FloorMapGeneration_manifestAssetId_idx" ON "FloorMapGeneration"("manifestAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorMapGeneration_id_floorId_key" ON "FloorMapGeneration"("id", "floorId");

-- CreateIndex
CREATE INDEX "FloorMapChunk_assetId_idx" ON "FloorMapChunk"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorMapChunk_generationId_ordinal_key" ON "FloorMapChunk"("generationId", "ordinal");

-- CreateIndex
CREATE INDEX "FloorMapIndexShard_assetId_idx" ON "FloorMapIndexShard"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorMapIndexShard_identity_key" ON "FloorMapIndexShard"("generationId", "prefix");

-- CreateIndex
CREATE INDEX "FloorMapChangeSet_payloadAssetId_idx" ON "FloorMapChangeSet"("payloadAssetId");

-- CreateIndex
CREATE INDEX "FloorMapChangeSet_inverseAssetId_idx" ON "FloorMapChangeSet"("inverseAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorMapChangeSet_request_key" ON "FloorMapChangeSet"("floorId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorMapChangeSet_generationId_resultRevision_key" ON "FloorMapChangeSet"("generationId", "resultRevision");

-- CreateIndex
CREATE INDEX "FloorMapRevisionAsset_assetId_idx" ON "FloorMapRevisionAsset"("assetId");

-- CreateIndex
CREATE INDEX "FloorMapRevisionAsset_generationId_idx" ON "FloorMapRevisionAsset"("generationId");

-- CreateIndex
CREATE INDEX "FloorMapStage_status_expiresAt_idx" ON "FloorMapStage"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "FloorMapStage_id_floorId_key" ON "FloorMapStage"("id", "floorId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorMapStage_floorId_requestId_key" ON "FloorMapStage"("floorId", "requestId");

-- CreateIndex
CREATE INDEX "FloorMapStagePart_assetId_idx" ON "FloorMapStagePart"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorMapRevision_id_floorId_key" ON "FloorMapRevision"("id", "floorId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorAsset_id_floorId_key" ON "FloorAsset"("id", "floorId");

-- AddForeignKey
ALTER TABLE "FloorMapDocument" ADD CONSTRAINT "FloorMapDocument_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapDocument" ADD CONSTRAINT "FloorMapDocument_activeGenerationId_floorId_fkey" FOREIGN KEY ("activeGenerationId", "floorId") REFERENCES "FloorMapGeneration"("id", "floorId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapGeneration" ADD CONSTRAINT "FloorMapGeneration_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapGeneration" ADD CONSTRAINT "FloorMapGeneration_manifestAssetId_floorId_fkey" FOREIGN KEY ("manifestAssetId", "floorId") REFERENCES "FloorAsset"("id", "floorId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapChunk" ADD CONSTRAINT "FloorMapChunk_generationId_floorId_fkey" FOREIGN KEY ("generationId", "floorId") REFERENCES "FloorMapGeneration"("id", "floorId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapChunk" ADD CONSTRAINT "FloorMapChunk_assetId_floorId_fkey" FOREIGN KEY ("assetId", "floorId") REFERENCES "FloorAsset"("id", "floorId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapIndexShard" ADD CONSTRAINT "FloorMapIndexShard_generationId_floorId_fkey" FOREIGN KEY ("generationId", "floorId") REFERENCES "FloorMapGeneration"("id", "floorId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapIndexShard" ADD CONSTRAINT "FloorMapIndexShard_assetId_floorId_fkey" FOREIGN KEY ("assetId", "floorId") REFERENCES "FloorAsset"("id", "floorId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapChangeSet" ADD CONSTRAINT "FloorMapChangeSet_generationId_floorId_fkey" FOREIGN KEY ("generationId", "floorId") REFERENCES "FloorMapGeneration"("id", "floorId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapChangeSet" ADD CONSTRAINT "FloorMapChangeSet_payloadAssetId_floorId_fkey" FOREIGN KEY ("payloadAssetId", "floorId") REFERENCES "FloorAsset"("id", "floorId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapChangeSet" ADD CONSTRAINT "FloorMapChangeSet_inverseAssetId_floorId_fkey" FOREIGN KEY ("inverseAssetId", "floorId") REFERENCES "FloorAsset"("id", "floorId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapRevisionAsset" ADD CONSTRAINT "FloorMapRevisionAsset_revisionId_floorId_fkey" FOREIGN KEY ("revisionId", "floorId") REFERENCES "FloorMapRevision"("id", "floorId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapRevisionAsset" ADD CONSTRAINT "FloorMapRevisionAsset_generationId_floorId_fkey" FOREIGN KEY ("generationId", "floorId") REFERENCES "FloorMapGeneration"("id", "floorId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapRevisionAsset" ADD CONSTRAINT "FloorMapRevisionAsset_assetId_floorId_fkey" FOREIGN KEY ("assetId", "floorId") REFERENCES "FloorAsset"("id", "floorId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapStage" ADD CONSTRAINT "FloorMapStage_generationId_floorId_fkey" FOREIGN KEY ("generationId", "floorId") REFERENCES "FloorMapGeneration"("id", "floorId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapStagePart" ADD CONSTRAINT "FloorMapStagePart_stageId_floorId_fkey" FOREIGN KEY ("stageId", "floorId") REFERENCES "FloorMapStage"("id", "floorId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapStagePart" ADD CONSTRAINT "FloorMapStagePart_assetId_floorId_fkey" FOREIGN KEY ("assetId", "floorId") REFERENCES "FloorAsset"("id", "floorId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- No backfill, reset or old-map conversion. Existing live rows are unchanged.
ALTER TABLE "FloorMapDocument" ADD CONSTRAINT "FloorMapDocument_ranges" CHECK (
  "revision" >= 0 AND "changesSinceCheckpoint" >= 0 AND "deltaDecodedBytes" BETWEEN 0 AND 536870912
);
ALTER TABLE "FloorMapGeneration" ADD CONSTRAINT "FloorMapGeneration_ranges" CHECK (
  "formatVersion" = 1 AND "baseRevision" >= 0 AND "width" BETWEEN 512 AND 32768 AND "height" BETWEEN 512 AND 32768
  AND "gridSize" BETWEEN 5 AND 200 AND "elementCount" BETWEEN 0 AND 500000 AND "decodedBytes" BETWEEN 0 AND 536870912
  AND (("sourceGenerationId" IS NULL AND "sourceRevision" IS NULL) OR
       ("sourceGenerationId" IS NOT NULL AND "sourceRevision" IS NOT NULL AND "sourceRevision" >= 0))
  AND (("manifestAssetId" IS NULL AND "manifestDecodedBytes" IS NULL) OR
       ("manifestAssetId" IS NOT NULL AND "manifestDecodedBytes" IS NOT NULL AND "manifestDecodedBytes" BETWEEN 1 AND 8388608))
  AND ("status" NOT IN ('prepared', 'active', 'retired') OR "manifestAssetId" IS NOT NULL)
);
ALTER TABLE "FloorMapChunk" ADD CONSTRAINT "FloorMapChunk_ranges" CHECK (
  "ordinal" BETWEEN 0 AND 16383 AND "decodedBytes" BETWEEN 1 AND 8388608 AND "elementCount" BETWEEN 1 AND 500000
  AND "minX" > '-Infinity'::float8 AND "minY" > '-Infinity'::float8
  AND "maxX" < 'Infinity'::float8 AND "maxY" < 'Infinity'::float8
  AND "maxX" >= "minX" AND "maxY" >= "minY"
  AND "maxX" - "minX" < 'Infinity'::float8 AND "maxY" - "minY" < 'Infinity'::float8
);
ALTER TABLE "FloorMapIndexShard" ADD CONSTRAINT "FloorMapIndexShard_ranges" CHECK (
  "prefix" ~ '^[a-f0-9]{2,64}$' AND "decodedBytes" BETWEEN 1 AND 8388608 AND "elementCount" BETWEEN 1 AND 500000
);
ALTER TABLE "FloorMapChangeSet" ADD CONSTRAINT "FloorMapChangeSet_ranges" CHECK (
  length("requestId") BETWEEN 1 AND 512 AND "baseRevision" >= 0 AND "resultRevision"::bigint = "baseRevision"::bigint + 1
  AND "payloadHash" ~ '^[a-f0-9]{64}$' AND "decodedBytes" BETWEEN 1 AND 536870912 AND "inverseDecodedBytes" BETWEEN 1 AND 536870912
);
ALTER TABLE "FloorMapStage" ADD CONSTRAINT "FloorMapStage_ranges" CHECK (
  length("requestId") BETWEEN 1 AND 512 AND "baseRevision" >= 0 AND "decodedBytes" BETWEEN 0 AND 536870912
  AND "partCount" BETWEEN 0 AND 1024 AND "leaseTokenHash" ~ '^[a-f0-9]{64}$'
  AND ("payloadHash" IS NULL OR "payloadHash" ~ '^[a-f0-9]{64}$')
);
ALTER TABLE "FloorMapStagePart" ADD CONSTRAINT "FloorMapStagePart_ranges" CHECK (
  "part" BETWEEN 0 AND 1023 AND "decodedBytes" BETWEEN 1 AND 524288 AND "sha256" ~ '^[a-f0-9]{64}$'
);

-- Derived display cache has its own ledger, never a canonical element type.
-- It intentionally has no import-job FK: manual-only maps use the same renderer.
CREATE TABLE "FloorMapDisplayAsset" (
  "id" TEXT PRIMARY KEY, "floorId" TEXT NOT NULL, "generationId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL, "role" TEXT NOT NULL, "decodedBytes" INTEGER NOT NULL,
  "tileX" INTEGER, "tileY" INTEGER, "lod" INTEGER, "part" INTEGER,
  "minX" DOUBLE PRECISION, "minY" DOUBLE PRECISION, "maxX" DOUBLE PRECISION, "maxY" DOUBLE PRECISION,
  CONSTRAINT "FloorMapDisplayAsset_generationId_floorId_fkey" FOREIGN KEY ("generationId", "floorId")
    REFERENCES "FloorMapGeneration" ("id", "floorId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorMapDisplayAsset_assetId_floorId_fkey" FOREIGN KEY ("assetId", "floorId")
    REFERENCES "FloorAsset" ("id", "floorId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "FloorMapDisplayAsset_ranges" CHECK (
    ("role" = 'manifest' AND "decodedBytes" BETWEEN 1 AND 8388608 AND "tileX" IS NULL AND "tileY" IS NULL
      AND "lod" IS NULL AND "part" IS NULL AND "minX" IS NULL AND "minY" IS NULL AND "maxX" IS NULL AND "maxY" IS NULL)
    OR ("role" = 'tile' AND "decodedBytes" BETWEEN 1 AND 16777216 AND "tileX" BETWEEN 0 AND 63 AND "tileY" BETWEEN 0 AND 63
      AND "lod" BETWEEN 0 AND 2 AND "part" BETWEEN 0 AND 127
      AND "tileX" IS NOT NULL AND "tileY" IS NOT NULL AND "lod" IS NOT NULL AND "part" IS NOT NULL
      AND "minX" IS NOT NULL AND "minY" IS NOT NULL AND "maxX" IS NOT NULL AND "maxY" IS NOT NULL
      AND "minX" > '-Infinity'::float8 AND "minY" > '-Infinity'::float8
      AND "maxX" < 'Infinity'::float8 AND "maxY" < 'Infinity'::float8 AND "maxX" >= "minX" AND "maxY" >= "minY")
  )
);
CREATE UNIQUE INDEX "FloorMapDisplayAsset_generationId_assetId_key" ON "FloorMapDisplayAsset" ("generationId", "assetId");
CREATE UNIQUE INDEX "FloorMapDisplayAsset_tile_key" ON "FloorMapDisplayAsset" ("generationId", "role", "tileX", "tileY", "lod", "part");
CREATE UNIQUE INDEX "FloorMapDisplayAsset_manifest_key" ON "FloorMapDisplayAsset" ("generationId") WHERE "role" = 'manifest';
CREATE INDEX "FloorMapDisplayAsset_assetId_idx" ON "FloorMapDisplayAsset" ("assetId");

-- Referenced assets must resist direct deletion, but an authorized Floor/Site
-- cascade must be able to remove both sides regardless of PostgreSQL trigger order.
DO $$ DECLARE row record; BEGIN
  FOR row IN SELECT conrelid::regclass AS relation, conname FROM pg_constraint
    WHERE contype = 'f' AND confdeltype = 'a' AND conrelid IN (
      '"FloorMapDocument"'::regclass, '"FloorMapGeneration"'::regclass, '"FloorMapChunk"'::regclass,
      '"FloorMapIndexShard"'::regclass, '"FloorMapChangeSet"'::regclass, '"FloorMapRevisionAsset"'::regclass,
      '"FloorMapStagePart"'::regclass, '"FloorMapDisplayAsset"'::regclass
    )
  LOOP EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', row.relation, row.conname); END LOOP;
END $$;
