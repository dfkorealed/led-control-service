BEGIN;

ALTER TABLE "ManualOverride"
  ALTER COLUMN "overrideUntil" DROP NOT NULL;

ALTER TABLE "ManualOverride" DROP CONSTRAINT "ManualOverride_time_range_check";
ALTER TABLE "ManualOverride" ADD CONSTRAINT "ManualOverride_time_range_check" CHECK (
  ("overrideUntil" IS NULL AND "endedAt" IS NULL)
  OR (
    "overrideUntil" > "startedAt"
    AND ("endedAt" IS NULL OR ("endedAt" >= "startedAt" AND "endedAt" <= "overrideUntil"))
  )
);

COMMIT;
