BEGIN;
SET LOCAL lock_timeout = '10s';

LOCK TABLE "FloorAsset", "FloorImportJob" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "FloorImportJob"
    WHERE "status" IN ('processing', 'applying')
  ) THEN
    RAISE EXCEPTION 'drain CAD processing/applying jobs before migration'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

-- The published next migration updates queued jobs and then alters the same
-- table. Make invariant checks immediate for that staged transaction so no
-- deferred trigger event blocks ALTER TABLE. The safety migration restores the
-- original deferred behavior after installing the new invariants.
DROP TRIGGER "FloorImportJob_asset_invariant" ON "FloorImportJob";
DROP TRIGGER "FloorAsset_import_job_invariant" ON "FloorAsset";

CREATE CONSTRAINT TRIGGER "FloorImportJob_asset_invariant"
AFTER INSERT OR UPDATE ON "FloorImportJob"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_import_job_asset_invariants"();

CREATE CONSTRAINT TRIGGER "FloorAsset_import_job_invariant"
AFTER UPDATE ON "FloorAsset"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_import_job_asset_invariants"();

COMMIT;
