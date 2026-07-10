ALTER TABLE "DiscoveredMeshNode"
ADD COLUMN "pendingFixtureName" TEXT,
ADD COLUMN "pendingFixtureX" DOUBLE PRECISION,
ADD COLUMN "pendingFixtureY" DOUBLE PRECISION,
ADD COLUMN "pendingRatedWatt" DECIMAL(8,2);
