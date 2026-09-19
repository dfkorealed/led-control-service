BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE "FloorImportJob" ADD COLUMN "preparedMapGenerationId" TEXT;
CREATE INDEX "FloorImportJob_preparedMapGenerationId_floorId_idx"
  ON "FloorImportJob" ("preparedMapGenerationId", "floorId");
ALTER TABLE "FloorImportJob" ADD CONSTRAINT "FloorImportJob_preparedMapGenerationId_floorId_fkey"
  FOREIGN KEY ("preparedMapGenerationId", "floorId") REFERENCES "FloorMapGeneration" ("id", "floorId")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Terminal transitions from any writer (including reset/old cancellation code)
-- release ownership. Floor-locked publication transfers ownership to document /
-- history references before the job becomes terminal. No existing row is changed.
CREATE FUNCTION "release_terminal_import_map_preparation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IN ('completed', 'failed', 'cancelled') THEN
    NEW."preparedMapGenerationId" := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "FloorImportJob_release_terminal_map_preparation"
  BEFORE INSERT OR UPDATE ON "FloorImportJob"
  FOR EACH ROW EXECUTE FUNCTION "release_terminal_import_map_preparation"();
COMMIT;
