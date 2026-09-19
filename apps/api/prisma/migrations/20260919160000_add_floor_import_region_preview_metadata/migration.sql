-- Existing regions remain explicitly legacy until re-imported and verified.
ALTER TABLE "FloorImportRegion"
  ADD COLUMN "textCount" INTEGER,
  ADD COLUMN "lightCandidateCount" INTEGER,
  ADD COLUMN "previewWidth" INTEGER,
  ADD COLUMN "previewHeight" INTEGER;

ALTER TABLE "FloorImportRegion"
  ADD CONSTRAINT "FloorImportRegion_previewMetadata_check" CHECK (
    ("textCount" IS NULL AND "lightCandidateCount" IS NULL
      AND "previewWidth" IS NULL AND "previewHeight" IS NULL)
    OR
    ("textCount" IS NOT NULL AND "lightCandidateCount" IS NOT NULL
      AND "previewWidth" IS NOT NULL AND "previewHeight" IS NOT NULL
      AND "textCount" BETWEEN 0 AND "primitiveCount"
      AND "lightCandidateCount" BETWEEN 0 AND "primitiveCount"
      AND "previewWidth" BETWEEN 1 AND 2400
      AND "previewHeight" BETWEEN 1 AND 1600)
  );
