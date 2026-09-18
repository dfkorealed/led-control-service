ALTER TABLE "FloorImportJob"
ADD COLUMN "excludedRegionPrimitiveCount" INTEGER;

ALTER TABLE "FloorImportJob"
ADD CONSTRAINT "FloorImportJob_excluded_region_primitive_count_check"
CHECK (
  "excludedRegionPrimitiveCount" IS NULL
  OR "excludedRegionPrimitiveCount" BETWEEN 0 AND 1000000
);
