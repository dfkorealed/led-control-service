-- CreateEnum
CREATE TYPE "FloorPlanSourceType" AS ENUM ('none', 'image', 'pdf');

-- AlterTable
ALTER TABLE "FloorPlan"
ADD COLUMN "sourceType" "FloorPlanSourceType" NOT NULL DEFAULT 'image',
ADD COLUMN "originalFileUrl" TEXT,
ADD COLUMN "renderedImageUrl" TEXT;

-- CreateTable
CREATE TABLE "FloorMapObject" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "points" JSONB,
    "text" TEXT,
    "strokeColor" TEXT NOT NULL DEFAULT '#0b63e5',
    "fillColor" TEXT,
    "strokeWidth" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "fontSize" DOUBLE PRECISION,
    "zIndex" INTEGER NOT NULL DEFAULT 0,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorMapObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FloorMapObject_floorId_zIndex_idx" ON "FloorMapObject"("floorId", "zIndex");

-- AddForeignKey
ALTER TABLE "FloorMapObject" ADD CONSTRAINT "FloorMapObject_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
