ALTER TABLE "FloorImportJob"
  ADD COLUMN "detectorProfileId" TEXT NOT NULL DEFAULT 'generic-lighting-v1',
  ADD COLUMN "detectorProfileVersion" TEXT,
  ADD COLUMN "detectorProfileDigest" TEXT;

ALTER TABLE "FloorImportCandidate"
  ADD COLUMN "profileVersion" TEXT NOT NULL DEFAULT 'legacy-unknown',
  ADD COLUMN "profileDigest" TEXT NOT NULL DEFAULT repeat('0', 64);

ALTER TABLE "FloorImportJob"
  ADD CONSTRAINT "FloorImportJob_detector_profile_digest_check" CHECK (
    ("detectorProfileVersion" IS NULL AND "detectorProfileDigest" IS NULL) OR
    (length("detectorProfileVersion") BETWEEN 1 AND 128 AND "detectorProfileDigest" ~ '^[a-f0-9]{64}$')
  );

ALTER TABLE "FloorImportCandidate"
  ADD CONSTRAINT "FloorImportCandidate_profile_digest_check" CHECK (
    length("profileVersion") BETWEEN 1 AND 128 AND "profileDigest" ~ '^[a-f0-9]{64}$'
  );
