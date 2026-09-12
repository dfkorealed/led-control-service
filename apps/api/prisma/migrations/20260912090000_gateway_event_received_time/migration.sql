-- Preserve the original ledger time for historical events while new rows record API receipt time.
CREATE TYPE "GatewayEventIngestionStatus" AS ENUM ('accepted', 'rejected_future_timestamp');

ALTER TABLE "ProcessedGatewayEvent"
  ADD COLUMN "receivedAt" TIMESTAMP(3);

UPDATE "ProcessedGatewayEvent"
SET "receivedAt" = "createdAt"
WHERE "receivedAt" IS NULL;

ALTER TABLE "ProcessedGatewayEvent"
  ALTER COLUMN "receivedAt" SET NOT NULL,
  ALTER COLUMN "receivedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "ingestionStatus" "GatewayEventIngestionStatus" NOT NULL DEFAULT 'accepted';
