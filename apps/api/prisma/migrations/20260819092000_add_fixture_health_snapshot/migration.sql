ALTER TABLE "Fixture"
ADD COLUMN "healthFaultCodes" JSONB,
ADD COLUMN "healthLastSeenAt" TIMESTAMP(3);
