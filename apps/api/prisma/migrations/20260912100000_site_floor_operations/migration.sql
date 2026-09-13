CREATE TYPE "FloorStatus" AS ENUM ('active', 'archived');

ALTER TABLE "Site"
ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'KRW';

ALTER TABLE "Floor"
ADD COLUMN "status" "FloorStatus" NOT NULL DEFAULT 'active',
ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Floor_siteId_status_displayOrder_idx"
ON "Floor"("siteId", "status", "displayOrder");
