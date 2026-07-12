CREATE TYPE "FloorAssetKind" AS ENUM ('original', 'rendered');
CREATE TYPE "FloorAssetStatus" AS ENUM ('pending', 'ready');

CREATE TABLE "FloorAsset" (
  "id" TEXT NOT NULL,
  "floorId" TEXT NOT NULL,
  "kind" "FloorAssetKind" NOT NULL,
  "status" "FloorAssetStatus" NOT NULL DEFAULT 'pending',
  "objectKey" TEXT NOT NULL,
  "publicUrl" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "sha256" TEXT NOT NULL,
  "readyAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FloorAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FloorAsset_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FloorAsset_objectKey_key" ON "FloorAsset"("objectKey");
CREATE INDEX "FloorAsset_floorId_status_createdAt_idx" ON "FloorAsset"("floorId", "status", "createdAt");
