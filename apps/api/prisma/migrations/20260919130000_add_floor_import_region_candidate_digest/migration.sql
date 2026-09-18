ALTER TABLE "FloorImportRegion"
ADD COLUMN "candidateIdentityDigest" TEXT;

ALTER TABLE "FloorImportRegion"
ADD CONSTRAINT "FloorImportRegion_candidateIdentityDigest_check"
CHECK (
  "candidateIdentityDigest" IS NULL OR
  "candidateIdentityDigest" ~ '^[a-f0-9]{64}$'
);
