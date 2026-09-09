CREATE TYPE "FixturePlacementStatus" AS ENUM ('unplaced', 'placed');

-- Preserve all legacy coordinates without asserting that their physical positions were verified.
ALTER TABLE "Fixture"
  ADD COLUMN "placementStatus" "FixturePlacementStatus" NOT NULL DEFAULT 'placed',
  ADD COLUMN "positionVerifiedAt" TIMESTAMP(3);

ALTER TABLE "Fixture" ALTER COLUMN "placementStatus" SET DEFAULT 'unplaced';
ALTER TABLE "Fixture" ADD CONSTRAINT "Fixture_unplaced_position_unverified"
  CHECK ("placementStatus" <> 'unplaced' OR "positionVerifiedAt" IS NULL);
