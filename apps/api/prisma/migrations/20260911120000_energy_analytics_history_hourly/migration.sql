CREATE TABLE "EnergyFixtureIdentity" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "fixtureId" TEXT,
    "trackingStartedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EnergyFixtureIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EnergyFixtureDimensionVersion" (
    "id" TEXT NOT NULL,
    "energyFixtureId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "floorName" TEXT NOT NULL,
    "ratedWatt" DECIMAL(8,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnergyFixtureDimensionVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EnergyFixtureDimensionVersion_effective_range_check"
      CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom")
);

CREATE TABLE "EnergyGroupIdentity" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "groupId" TEXT,
    "trackingStartedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EnergyGroupIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EnergyGroupDimensionVersion" (
    "id" TEXT NOT NULL,
    "energyGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnergyGroupDimensionVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EnergyGroupDimensionVersion_effective_range_check"
      CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom")
);

CREATE TABLE "EnergyGroupMembershipVersion" (
    "id" TEXT NOT NULL,
    "energyGroupId" TEXT NOT NULL,
    "energyFixtureId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnergyGroupMembershipVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EnergyGroupMembershipVersion_effective_range_check"
      CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom")
);

CREATE TABLE "FixtureEnergyHourlyAggregate" (
    "id" TEXT NOT NULL,
    "energyFixtureId" TEXT NOT NULL,
    "bucketStartUtc" TIMESTAMP(3) NOT NULL,
    "localDate" DATE NOT NULL,
    "localHour" INTEGER NOT NULL,
    "utcOffsetMinutes" INTEGER NOT NULL,
    "estimatedKwh" DECIMAL(20,12) NOT NULL,
    "knownSeconds" INTEGER NOT NULL DEFAULT 0,
    "unknownSeconds" INTEGER NOT NULL DEFAULT 0,
    "brightnessWeightedSeconds" DECIMAL(20,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FixtureEnergyHourlyAggregate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FixtureEnergyHourlyAggregate_local_hour_check" CHECK ("localHour" BETWEEN 0 AND 23),
    CONSTRAINT "FixtureEnergyHourlyAggregate_nonnegative_check"
      CHECK ("estimatedKwh" >= 0 AND "knownSeconds" >= 0 AND "unknownSeconds" >= 0 AND "brightnessWeightedSeconds" >= 0)
);

CREATE UNIQUE INDEX "EnergyFixtureIdentity_fixtureId_key" ON "EnergyFixtureIdentity"("fixtureId");
CREATE INDEX "EnergyFixtureIdentity_siteId_trackingStartedAt_idx" ON "EnergyFixtureIdentity"("siteId", "trackingStartedAt");
CREATE UNIQUE INDEX "EnergyFixtureDimensionVersion_energyFixtureId_effectiveFrom_key" ON "EnergyFixtureDimensionVersion"("energyFixtureId", "effectiveFrom");
CREATE UNIQUE INDEX "EnergyFixtureDimensionVersion_one_open_key" ON "EnergyFixtureDimensionVersion"("energyFixtureId") WHERE "effectiveTo" IS NULL;
CREATE INDEX "EnergyFixtureDimensionVersion_floorId_effectiveFrom_effectiveTo_idx" ON "EnergyFixtureDimensionVersion"("floorId", "effectiveFrom", "effectiveTo");
CREATE UNIQUE INDEX "EnergyGroupIdentity_groupId_key" ON "EnergyGroupIdentity"("groupId");
CREATE INDEX "EnergyGroupIdentity_siteId_trackingStartedAt_idx" ON "EnergyGroupIdentity"("siteId", "trackingStartedAt");
CREATE UNIQUE INDEX "EnergyGroupDimensionVersion_energyGroupId_effectiveFrom_key" ON "EnergyGroupDimensionVersion"("energyGroupId", "effectiveFrom");
CREATE UNIQUE INDEX "EnergyGroupDimensionVersion_one_open_key" ON "EnergyGroupDimensionVersion"("energyGroupId") WHERE "effectiveTo" IS NULL;
CREATE UNIQUE INDEX "EnergyGroupMembershipVersion_energyGroupId_energyFixtureId_effectiveFrom_key" ON "EnergyGroupMembershipVersion"("energyGroupId", "energyFixtureId", "effectiveFrom");
CREATE UNIQUE INDEX "EnergyGroupMembershipVersion_one_open_key" ON "EnergyGroupMembershipVersion"("energyGroupId", "energyFixtureId") WHERE "effectiveTo" IS NULL;
CREATE INDEX "EnergyGroupMembershipVersion_energyFixtureId_effectiveFrom_effectiveTo_idx" ON "EnergyGroupMembershipVersion"("energyFixtureId", "effectiveFrom", "effectiveTo");
CREATE UNIQUE INDEX "FixtureEnergyHourlyAggregate_energyFixtureId_bucketStartUtc_key" ON "FixtureEnergyHourlyAggregate"("energyFixtureId", "bucketStartUtc");
CREATE INDEX "FixtureEnergyHourlyAggregate_localDate_localHour_idx" ON "FixtureEnergyHourlyAggregate"("localDate", "localHour");
CREATE INDEX "FixtureEnergyHourlyAggregate_bucketStartUtc_idx" ON "FixtureEnergyHourlyAggregate"("bucketStartUtc");

ALTER TABLE "EnergyFixtureIdentity" ADD CONSTRAINT "EnergyFixtureIdentity_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnergyFixtureIdentity" ADD CONSTRAINT "EnergyFixtureIdentity_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnergyFixtureDimensionVersion" ADD CONSTRAINT "EnergyFixtureDimensionVersion_energyFixtureId_fkey"
  FOREIGN KEY ("energyFixtureId") REFERENCES "EnergyFixtureIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnergyGroupIdentity" ADD CONSTRAINT "EnergyGroupIdentity_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnergyGroupIdentity" ADD CONSTRAINT "EnergyGroupIdentity_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "FixtureGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnergyGroupDimensionVersion" ADD CONSTRAINT "EnergyGroupDimensionVersion_energyGroupId_fkey"
  FOREIGN KEY ("energyGroupId") REFERENCES "EnergyGroupIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnergyGroupMembershipVersion" ADD CONSTRAINT "EnergyGroupMembershipVersion_energyGroupId_fkey"
  FOREIGN KEY ("energyGroupId") REFERENCES "EnergyGroupIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnergyGroupMembershipVersion" ADD CONSTRAINT "EnergyGroupMembershipVersion_energyFixtureId_fkey"
  FOREIGN KEY ("energyFixtureId") REFERENCES "EnergyFixtureIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FixtureEnergyHourlyAggregate" ADD CONSTRAINT "FixtureEnergyHourlyAggregate_energyFixtureId_fkey"
  FOREIGN KEY ("energyFixtureId") REFERENCES "EnergyFixtureIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "EnergyFixtureIdentity" (
  "id", "siteId", "fixtureId", "trackingStartedAt", "createdAt", "updatedAt"
)
SELECT gen_random_uuid()::text, f."siteId", f."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Fixture" f;

INSERT INTO "EnergyFixtureDimensionVersion" (
  "id", "energyFixtureId", "name", "floorId", "floorName", "ratedWatt", "effectiveFrom", "createdAt"
)
SELECT gen_random_uuid()::text, efi."id", f."name", f."floorId", fl."name", f."ratedWatt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Fixture" f
JOIN "Floor" fl ON fl."id" = f."floorId"
JOIN "EnergyFixtureIdentity" efi ON efi."fixtureId" = f."id";

INSERT INTO "EnergyGroupIdentity" (
  "id", "siteId", "groupId", "trackingStartedAt", "createdAt", "updatedAt"
)
SELECT gen_random_uuid()::text, g."siteId", g."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "FixtureGroup" g;

INSERT INTO "EnergyGroupDimensionVersion" (
  "id", "energyGroupId", "name", "effectiveFrom", "createdAt"
)
SELECT gen_random_uuid()::text, egi."id", g."name", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "FixtureGroup" g
JOIN "EnergyGroupIdentity" egi ON egi."groupId" = g."id";

INSERT INTO "EnergyGroupMembershipVersion" (
  "id", "energyGroupId", "energyFixtureId", "effectiveFrom", "createdAt"
)
SELECT gen_random_uuid()::text, egi."id", efi."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "GroupFixture" gf
JOIN "EnergyGroupIdentity" egi ON egi."groupId" = gf."groupId"
JOIN "EnergyFixtureIdentity" efi ON efi."fixtureId" = gf."fixtureId";

ALTER TABLE "FixtureEnergyDailyAggregate" ADD COLUMN "energyFixtureId" TEXT;
UPDATE "FixtureEnergyDailyAggregate" daily
SET "energyFixtureId" = identity."id"
FROM "EnergyFixtureIdentity" identity
WHERE identity."fixtureId" = daily."fixtureId";
ALTER TABLE "FixtureEnergyDailyAggregate" ALTER COLUMN "energyFixtureId" SET NOT NULL;
ALTER TABLE "FixtureEnergyDailyAggregate" ALTER COLUMN "fixtureId" DROP NOT NULL;
DROP INDEX IF EXISTS "FixtureEnergyDailyAggregate_fixtureId_localDate_key";
CREATE UNIQUE INDEX "FixtureEnergyDailyAggregate_energyFixtureId_localDate_key"
  ON "FixtureEnergyDailyAggregate"("energyFixtureId", "localDate");
CREATE INDEX "FixtureEnergyDailyAggregate_fixtureId_localDate_idx"
  ON "FixtureEnergyDailyAggregate"("fixtureId", "localDate");
ALTER TABLE "FixtureEnergyDailyAggregate" DROP CONSTRAINT IF EXISTS "FixtureEnergyDailyAggregate_fixtureId_fkey";
ALTER TABLE "FixtureEnergyDailyAggregate" ADD CONSTRAINT "FixtureEnergyDailyAggregate_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FixtureEnergyDailyAggregate" ADD CONSTRAINT "FixtureEnergyDailyAggregate_energyFixtureId_fkey"
  FOREIGN KEY ("energyFixtureId") REFERENCES "EnergyFixtureIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
