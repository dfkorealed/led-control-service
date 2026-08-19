ALTER TYPE "DiscoveredNodeStatus" ADD VALUE 'reconcile_required';

ALTER TABLE "DiscoveredMeshNode"
ADD COLUMN "pendingFixtureSize" DOUBLE PRECISION;
