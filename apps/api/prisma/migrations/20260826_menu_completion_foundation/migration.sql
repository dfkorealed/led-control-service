BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "ProvisioningScanStatus" AS ENUM ('pending', 'scanning', 'completed', 'failed');
CREATE TYPE "FixtureGroupLifecycleStatus" AS ENUM ('active', 'retiring', 'retired', 'invalid');
CREATE TYPE "MeshControlGroupMemberOperation" AS ENUM ('add', 'delete');

ALTER TYPE "MeshControlGroupStatus" ADD VALUE IF NOT EXISTS 'retiring';
ALTER TYPE "MeshControlGroupStatus" ADD VALUE IF NOT EXISTS 'retired';

ALTER TABLE "Site"
  ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'Asia/Seoul';

ALTER TABLE "Fixture"
  ADD COLUMN "energyTrackingStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "firstStateOccurredAt" TIMESTAMP(3),
  ADD COLUMN "powerOn" BOOLEAN;

ALTER TABLE "FixtureGroup"
  ADD COLUMN "floorId" TEXT,
  ADD COLUMN "gatewayId" TEXT,
  ADD COLUMN "lifecycleStatus" "FixtureGroupLifecycleStatus" NOT NULL DEFAULT 'invalid';

WITH valid_legacy_groups AS (
  SELECT
    group_row."id",
    MIN(fixture."floorId") AS "floorId",
    MIN(mesh_node."gatewayId") AS "gatewayId"
  FROM "FixtureGroup" AS group_row
  JOIN "GroupFixture" AS membership ON membership."groupId" = group_row."id"
  JOIN "Fixture" AS fixture ON fixture."id" = membership."fixtureId"
  JOIN "Floor" AS floor ON floor."id" = fixture."floorId"
  JOIN "MeshNode" AS mesh_node ON mesh_node."id" = fixture."meshNodeId"
  JOIN "Gateway" AS gateway ON gateway."id" = mesh_node."gatewayId"
  GROUP BY group_row."id", group_row."siteId"
  HAVING COUNT(*) > 0
    AND COUNT(DISTINCT fixture."floorId") = 1
    AND COUNT(DISTINCT mesh_node."gatewayId") = 1
    AND BOOL_AND(floor."siteId" = group_row."siteId")
    AND BOOL_AND(gateway."siteId" = group_row."siteId")
)
UPDATE "FixtureGroup" AS group_row
SET
  "floorId" = valid_legacy_groups."floorId",
  "gatewayId" = valid_legacy_groups."gatewayId",
  "lifecycleStatus" = 'active'
FROM valid_legacy_groups
WHERE group_row."id" = valid_legacy_groups."id";

ALTER TABLE "FixtureGroup"
  ADD CONSTRAINT "FixtureGroup_active_boundary_check"
  CHECK (
    "lifecycleStatus" <> 'active'
    OR ("floorId" IS NOT NULL AND "gatewayId" IS NOT NULL)
  ),
  ADD CONSTRAINT "FixtureGroup_floorId_fkey"
  FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FixtureGroup_gatewayId_fkey"
  FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "FixtureGroup_siteId_floorId_gatewayId_lifecycleStatus_idx"
  ON "FixtureGroup"("siteId", "floorId", "gatewayId", "lifecycleStatus");

ALTER TABLE "MeshControlGroupMember"
  ADD COLUMN "desired" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "operationId" TEXT,
  ADD COLUMN "operation" "MeshControlGroupMemberOperation";

ALTER TABLE "ProvisioningSession"
  ADD COLUMN "scanStatus" "ProvisioningScanStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "scanCorrelationId" TEXT,
  ADD COLUMN "scanAttempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "scanStartedAt" TIMESTAMP(3),
  ADD COLUMN "scanCompletedAt" TIMESTAMP(3),
  ADD COLUMN "scanFailureCode" TEXT,
  ADD COLUMN "scanFailureMessage" TEXT;

CREATE INDEX "ProvisioningSession_gatewayId_scanStatus_idx"
  ON "ProvisioningSession"("gatewayId", "scanStatus");
CREATE UNIQUE INDEX "ProvisioningSession_single_scanning_gateway_key"
  ON "ProvisioningSession"("gatewayId")
  WHERE "scanStatus" = 'scanning';

CREATE TABLE "FixtureEnergyDailyAggregate" (
  "id" TEXT NOT NULL,
  "fixtureId" TEXT NOT NULL,
  "localDate" DATE NOT NULL,
  "estimatedKwh" DECIMAL(20,12) NOT NULL,
  "estimatedCost" DECIMAL(20,8) NOT NULL,
  "knownSeconds" INTEGER NOT NULL DEFAULT 0,
  "unknownSeconds" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FixtureEnergyDailyAggregate_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "FixtureEnergyDailyAggregate"
  ADD CONSTRAINT "FixtureEnergyDailyAggregate_nonnegative_seconds_check"
  CHECK ("knownSeconds" >= 0 AND "unknownSeconds" >= 0),
  ADD CONSTRAINT "FixtureEnergyDailyAggregate_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "FixtureEnergyDailyAggregate_fixtureId_localDate_key"
  ON "FixtureEnergyDailyAggregate"("fixtureId", "localDate");
CREATE INDEX "FixtureEnergyDailyAggregate_localDate_idx"
  ON "FixtureEnergyDailyAggregate"("localDate");

ALTER TABLE "Command"
  ADD COLUMN "clientRequestId" TEXT,
  ADD COLUMN "requestFingerprint" TEXT;

UPDATE "Command"
SET
  "clientRequestId" = "id",
  "requestFingerprint" = encode(
    digest(
      concat_ws(
        '|',
        "targetType",
        COALESCE("targetId", ''),
        "targetFixtureIds"::text,
        "brightness"::text
      ),
      'sha256'
    ),
    'hex'
  );

ALTER TABLE "Command"
  ALTER COLUMN "clientRequestId" SET NOT NULL,
  ALTER COLUMN "requestFingerprint" SET NOT NULL;

CREATE UNIQUE INDEX "Command_siteId_requestedBy_clientRequestId_key"
  ON "Command"("siteId", "requestedBy", "clientRequestId");

CREATE FUNCTION "assert_active_fixture_group_integrity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_group_id TEXT;
  target_group "FixtureGroup"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'GroupFixture' THEN
    target_group_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."groupId" ELSE NEW."groupId" END;
  ELSE
    target_group_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
  END IF;

  SELECT * INTO target_group FROM "FixtureGroup" WHERE "id" = target_group_id;
  IF NOT FOUND OR target_group."lifecycleStatus" <> 'active' THEN
    RETURN NULL;
  END IF;

  IF target_group."floorId" IS NULL OR target_group."gatewayId" IS NULL THEN
    RAISE EXCEPTION 'active FixtureGroup requires floorId and gatewayId';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Floor" AS floor
    JOIN "Gateway" AS gateway ON gateway."id" = target_group."gatewayId"
    WHERE floor."id" = target_group."floorId"
      AND floor."siteId" = target_group."siteId"
      AND gateway."siteId" = target_group."siteId"
  ) THEN
    RAISE EXCEPTION 'active FixtureGroup boundary must belong to its site';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "GroupFixture" AS membership
    JOIN "Fixture" AS fixture ON fixture."id" = membership."fixtureId"
    LEFT JOIN "MeshNode" AS mesh_node ON mesh_node."id" = fixture."meshNodeId"
    WHERE membership."groupId" = target_group."id"
      AND (
        fixture."floorId" <> target_group."floorId"
        OR mesh_node."gatewayId" IS DISTINCT FROM target_group."gatewayId"
      )
  ) THEN
    RAISE EXCEPTION 'active FixtureGroup members must match its floor and gateway';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "GroupFixture" WHERE "groupId" = target_group."id"
  ) THEN
    RAISE EXCEPTION 'active FixtureGroup requires at least one member';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "GroupFixture" AS membership
    JOIN "FixtureGroup" AS group_row ON group_row."id" = membership."groupId"
    WHERE membership."fixtureId" IN (
      SELECT "fixtureId" FROM "GroupFixture" WHERE "groupId" = target_group."id"
    )
      AND group_row."lifecycleStatus" IN ('active', 'retiring')
    GROUP BY membership."fixtureId"
    HAVING COUNT(*) > 15
  ) THEN
    RAISE EXCEPTION 'a fixture cannot belong to more than 15 active or retiring FixtureGroups';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "FixtureGroup_active_integrity"
AFTER INSERT OR UPDATE OR DELETE ON "FixtureGroup"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_active_fixture_group_integrity"();

CREATE CONSTRAINT TRIGGER "GroupFixture_active_integrity"
AFTER INSERT OR UPDATE OR DELETE ON "GroupFixture"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_active_fixture_group_integrity"();

COMMIT;
