BEGIN;

CREATE TYPE "CommandOutcome" AS ENUM ('pending', 'applied', 'not_applied', 'partially_applied', 'unknown');
CREATE TYPE "CommandDispatchKind" AS ENUM ('dimming', 'status_check');

-- Do not infer outcomes for historical commands or backfill status-check identities.
ALTER TABLE "Command" ADD COLUMN "outcome" "CommandOutcome";
-- Persist the first possible MQTT send before calling the broker. NULL proves no
-- attempt only for coordinated new publishers; historical rows stay unclassified.
ALTER TABLE "MqttOutbox" ADD COLUMN "deliveryAttemptedAt" TIMESTAMP(3);
ALTER TABLE "CommandDispatch"
  ADD COLUMN "kind" "CommandDispatchKind" NOT NULL DEFAULT 'dimming',
  ADD COLUMN "verificationAttempt" INTEGER,
  ADD COLUMN "clientRequestId" TEXT;

CREATE UNIQUE INDEX "CommandDispatch_clientRequestId_key" ON "CommandDispatch"("clientRequestId");

COMMIT;
