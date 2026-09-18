BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE "CadProfileUpgradeGate" (
  "id" SMALLINT PRIMARY KEY,
  "closed" BOOLEAN NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "CadProfileUpgradeGate_singleton_check" CHECK ("id" = 1)
);

INSERT INTO "CadProfileUpgradeGate" ("id", "closed") VALUES (1, true);

CREATE FUNCTION "enforce_cad_profile_upgrade_gate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'processing'
     AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'processing')
     AND EXISTS (SELECT 1 FROM "CadProfileUpgradeGate" WHERE "id" = 1 AND "closed") THEN
    RAISE EXCEPTION 'CAD profile upgrade gate is closed'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "FloorImportJob_profile_upgrade_gate"
BEFORE INSERT OR UPDATE OF "status" ON "FloorImportJob"
FOR EACH ROW EXECUTE FUNCTION "enforce_cad_profile_upgrade_gate"();

COMMIT;
