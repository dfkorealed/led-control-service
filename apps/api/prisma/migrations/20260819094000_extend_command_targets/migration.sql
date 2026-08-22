ALTER TABLE "Command"
  ALTER COLUMN "targetId" DROP NOT NULL,
  ADD COLUMN "targetFixtureIds" JSONB;

UPDATE "Command"
SET "targetFixtureIds" = '[]'::jsonb
WHERE "targetFixtureIds" IS NULL;

ALTER TABLE "Command"
  ALTER COLUMN "targetFixtureIds" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "targetFixtureIds" SET NOT NULL;

ALTER TABLE "CommandDispatch"
  ADD COLUMN "deliveryMode" TEXT,
  ADD COLUMN "destinationAddress" TEXT;

UPDATE "CommandDispatch"
SET "deliveryMode" = 'unicast'
WHERE "deliveryMode" IS NULL;

ALTER TABLE "CommandDispatch"
  ALTER COLUMN "deliveryMode" SET DEFAULT 'unicast',
  ALTER COLUMN "deliveryMode" SET NOT NULL;
