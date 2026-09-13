BEGIN;
SET LOCAL lock_timeout = '10s';

-- Freeze labels at INSERT, including NULL on legacy rows. A later live name cannot
-- reconstruct the name at request time, so no mutable-name backfill is performed.
LOCK TABLE "EnergyReportJob" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "EnergyReportJob" ADD COLUMN "targetLabelSnapshot" TEXT;
ALTER TABLE "EnergyReportJob" ADD CONSTRAINT "EnergyReportJob_target_label_check"
  CHECK ("targetLabelSnapshot" IS NULL OR length("targetLabelSnapshot") > 0);

CREATE OR REPLACE FUNCTION "guard_energy_report_snapshots"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."siteId" IS DISTINCT FROM OLD."siteId"
    OR NEW."requestedByActorId" IS DISTINCT FROM OLD."requestedByActorId"
    OR NEW."requestedByLoginIdSnapshot" IS DISTINCT FROM OLD."requestedByLoginIdSnapshot"
    OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."format" IS DISTINCT FROM OLD."format"
    OR NEW."requestSnapshot" IS DISTINCT FROM OLD."requestSnapshot"
    OR NEW."targetLabelSnapshot" IS DISTINCT FROM OLD."targetLabelSnapshot"
    OR (OLD."dataSnapshot" IS NOT NULL AND NEW."dataSnapshot" IS DISTINCT FROM OLD."dataSnapshot")
    OR (OLD."documentSnapshot" IS NOT NULL AND NEW."documentSnapshot" IS DISTINCT FROM OLD."documentSnapshot")
    OR (OLD."contentFingerprint" IS NOT NULL AND NEW."contentFingerprint" IS DISTINCT FROM OLD."contentFingerprint") THEN
    RAISE EXCEPTION 'energy report snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
