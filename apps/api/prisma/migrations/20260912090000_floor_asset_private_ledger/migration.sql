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

ALTER TABLE "FloorAsset" DROP COLUMN "publicUrl";

CREATE INDEX "FloorAsset_status_uploadExpiresAt_cleanupStartedAt_idx"
ON "FloorAsset"("status", "uploadExpiresAt", "cleanupStartedAt");
