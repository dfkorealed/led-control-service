BEGIN;

-- Historical discoveries cannot be assigned to a validated scan attempt safely.
-- Keep them NULL so consumers can fail closed instead of inferring identity from timestamps.
ALTER TABLE "DiscoveredMeshNode"
  ADD COLUMN "scanCorrelationId" TEXT,
  ADD COLUMN "scanAttempt" INTEGER;

COMMIT;
