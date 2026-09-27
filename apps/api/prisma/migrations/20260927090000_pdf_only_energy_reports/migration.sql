-- Apply only after old API and worker instances have stopped creating jobs and PUTs.
-- The existing BEFORE DELETE trigger records all historical xlsx/pdf attempt keys
-- in EnergyReportObjectCleanup. That ledger is deliberately never truncated.
BEGIN;

LOCK TABLE "EnergyReportJob" IN ACCESS EXCLUSIVE MODE;
DELETE FROM "EnergyReportJob";

ALTER TYPE "EnergyReportFormat" RENAME TO "EnergyReportFormat_legacy";
CREATE TYPE "EnergyReportFormat" AS ENUM ('pdf');
ALTER TABLE "EnergyReportJob" ALTER COLUMN "format" TYPE "EnergyReportFormat"
  USING "format"::text::"EnergyReportFormat";
DROP TYPE "EnergyReportFormat_legacy";

COMMIT;
