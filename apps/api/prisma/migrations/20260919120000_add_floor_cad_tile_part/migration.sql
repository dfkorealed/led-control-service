BEGIN;

ALTER TABLE "FloorCadTile"
ADD COLUMN "part" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "FloorCadTile"
ADD CONSTRAINT "FloorCadTile_part_check"
CHECK ("part" >= 0 AND "part" < 128);

ALTER TABLE "FloorCadTile"
ADD CONSTRAINT "FloorCadTile_size_check_v2"
CHECK ("primitiveCount" BETWEEN 1 AND 500000 AND "byteSize" BETWEEN 1 AND 16777216)
NOT VALID;

ALTER TABLE "FloorCadTile"
VALIDATE CONSTRAINT "FloorCadTile_size_check_v2";

ALTER TABLE "FloorCadTile"
DROP CONSTRAINT "FloorCadTile_size_check";

ALTER TABLE "FloorCadTile"
RENAME CONSTRAINT "FloorCadTile_size_check_v2" TO "FloorCadTile_size_check";

CREATE UNIQUE INDEX "FloorCadTile_sceneId_tileX_tileY_lod_part_key"
ON "FloorCadTile"("sceneId", "tileX", "tileY", "lod", "part");
DROP INDEX "FloorCadTile_sceneId_tileX_tileY_lod_key";

DROP INDEX "FloorCadTile_sceneId_lod_idx";
CREATE INDEX "FloorCadTile_sceneId_lod_tileX_tileY_idx"
ON "FloorCadTile"("sceneId", "lod", "tileX", "tileY");

COMMIT;
