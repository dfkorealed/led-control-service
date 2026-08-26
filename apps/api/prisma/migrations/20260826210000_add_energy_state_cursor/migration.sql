ALTER TABLE "ProcessedGatewayEvent" ADD COLUMN "fixtureId" TEXT;

CREATE TABLE "FixtureEnergyStateCursor" (
  "fixtureId" TEXT NOT NULL,
  "aggregatedThrough" TIMESTAMP(3) NOT NULL,
  "observedStateOccurredAt" TIMESTAMP(3),
  "brightness" INTEGER NOT NULL,
  "powerOn" BOOLEAN,
  "ratedWatt" DECIMAL(8,2) NOT NULL,
  "durationRemainders" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FixtureEnergyStateCursor_pkey" PRIMARY KEY ("fixtureId")
);

CREATE INDEX "ProcessedGatewayEvent_fixtureId_idx" ON "ProcessedGatewayEvent"("fixtureId");

ALTER TABLE "ProcessedGatewayEvent"
  ADD CONSTRAINT "ProcessedGatewayEvent_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FixtureEnergyStateCursor"
  ADD CONSTRAINT "FixtureEnergyStateCursor_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FixtureEnergyStateCursor"
  ADD CONSTRAINT "FixtureEnergyStateCursor_brightness_check" CHECK ("brightness" BETWEEN 0 AND 100);
