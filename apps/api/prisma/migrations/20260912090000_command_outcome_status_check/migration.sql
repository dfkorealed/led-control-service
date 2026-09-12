BEGIN;

CREATE TYPE "CommandOutcome" AS ENUM ('pending', 'applied', 'not_applied', 'partially_applied', 'unknown');
CREATE TYPE "CommandDispatchKind" AS ENUM ('dimming', 'status_check');

-- Do not infer outcomes for historical commands or backfill status-check identities.
ALTER TABLE "Command" ADD COLUMN "outcome" "CommandOutcome";
ALTER TABLE "CommandDispatch"
  ADD COLUMN "kind" "CommandDispatchKind" NOT NULL DEFAULT 'dimming',
  ADD COLUMN "verificationAttempt" INTEGER,
  ADD COLUMN "clientRequestId" TEXT;

CREATE UNIQUE INDEX "CommandDispatch_clientRequestId_key" ON "CommandDispatch"("clientRequestId");

COMMIT;
