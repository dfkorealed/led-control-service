ALTER TABLE "FloorCadElementOverride"
ADD COLUMN "locatorTileX" INTEGER,
ADD COLUMN "locatorTileY" INTEGER,
ADD COLUMN "locatorLod" INTEGER,
ADD COLUMN "locatorPart" INTEGER;

ALTER TABLE "FloorCadElementOverride"
ADD CONSTRAINT "FloorCadElementOverride_locator_completeness_check"
CHECK (
  ("locatorTileX" IS NULL AND "locatorTileY" IS NULL AND "locatorLod" IS NULL AND "locatorPart" IS NULL)
  OR
  ("locatorTileX" IS NOT NULL AND "locatorTileY" IS NOT NULL AND "locatorLod" IS NOT NULL AND "locatorPart" IS NOT NULL)
),
ADD CONSTRAINT "FloorCadElementOverride_locator_range_check"
CHECK (
  "locatorTileX" IS NULL
  OR (
    "locatorTileX" BETWEEN 0 AND 63
    AND "locatorTileY" BETWEEN 0 AND 63
    AND "locatorLod" BETWEEN 0 AND 2
    AND "locatorPart" BETWEEN 0 AND 127
  )
);
