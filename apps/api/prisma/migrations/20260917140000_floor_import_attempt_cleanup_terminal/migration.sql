BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE "FloorImportAttemptCleanup"
  ADD COLUMN "cleanedAt" TIMESTAMP(3),
  ADD CONSTRAINT "FloorImportAttemptCleanup_terminal_check" CHECK (
    NOT ("committedAt" IS NOT NULL AND "cleanedAt" IS NOT NULL)
    AND (
      "cleanedAt" IS NULL
      OR (
        "lastCleanedAt" IS NOT NULL
        AND "leaseOwner" IS NULL
        AND "leaseExpiresAt" IS NULL
      )
    )
  );

COMMIT;
