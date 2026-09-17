BEGIN;
SET LOCAL lock_timeout = '10s';

SELECT "id" FROM "CadProfileUpgradeGate" WHERE "id" = 1 FOR UPDATE;

DO $$
DECLARE
  required_count INTEGER;
BEGIN
  SELECT count(*) INTO required_count
  FROM "_prisma_migrations"
  WHERE "migration_name" IN (
    '20260917145000_cad_profile_upgrade_preflight',
    '20260917150000_cad_profile_binding',
    '20260917160000_cad_upgrade_safety',
    '20260917165000_cad_content_encoding_reconciliation'
  )
    AND "finished_at" IS NOT NULL
    AND "rolled_back_at" IS NULL;
  IF required_count <> 4 THEN
    RAISE EXCEPTION 'CAD profile/content migrations are incomplete'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

UPDATE "CadProfileUpgradeGate"
SET "closed" = false, "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
WHERE "id" = 1;

COMMIT;
