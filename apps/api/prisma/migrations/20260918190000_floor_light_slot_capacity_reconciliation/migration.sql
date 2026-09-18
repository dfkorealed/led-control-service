BEGIN;
SET LOCAL lock_timeout = '10s';

-- The original slot migration was already applied in some environments before
-- structural capacity ordinals replaced the deferred row-count triggers. Lock
-- every mutable side while converging both legacy and fresh schemas.
LOCK TABLE "Floor", "FloorImportJob", "FloorImportCandidate", "Fixture", "FloorLightSlot"
IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  oversized_floor RECORD;
BEGIN
  SELECT "floorId", count(*) AS slot_count INTO oversized_floor
  FROM "FloorLightSlot"
  GROUP BY "floorId"
  HAVING count(*) > 2000
  ORDER BY "floorId"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'existing floor light slots exceed 2000: floor=%, count=%',
      oversized_floor."floorId", oversized_floor.slot_count
      USING ERRCODE = '23514', CONSTRAINT = 'FloorLightSlot_floor_capacity';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS "FloorLightSlot_capacity_insert" ON "FloorLightSlot";
DROP TRIGGER IF EXISTS "FloorLightSlot_capacity_floor_update" ON "FloorLightSlot";
DROP TRIGGER IF EXISTS "FloorLightSlot_assign_capacity_ordinal_insert" ON "FloorLightSlot";
DROP TRIGGER IF EXISTS "FloorLightSlot_assign_capacity_ordinal_update" ON "FloorLightSlot";
DROP FUNCTION IF EXISTS "enforce_floor_light_slot_capacity"();

ALTER TABLE "FloorLightSlot"
ADD COLUMN IF NOT EXISTS "capacityOrdinal" INTEGER;

WITH ranked_slots AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "floorId"
      ORDER BY "createdAt", "id"
    )::INTEGER AS ordinal
  FROM "FloorLightSlot"
  WHERE "capacityOrdinal" IS NULL
)
UPDATE "FloorLightSlot" AS slot
SET "capacityOrdinal" = ranked_slots.ordinal
FROM ranked_slots
WHERE slot."id" = ranked_slots."id";

-- Backfill updates enqueue the existing deferred scope trigger. Validate those
-- rows before changing the table definition; PostgreSQL rejects ALTER TABLE
-- while a relation still has pending trigger events.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE "FloorLightSlot"
  ALTER COLUMN "capacityOrdinal" SET DEFAULT 0,
  ALTER COLUMN "capacityOrdinal" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"FloorLightSlot"'::regclass
      AND conname = 'FloorLightSlot_capacityOrdinal_check'
  ) THEN
    ALTER TABLE "FloorLightSlot"
    ADD CONSTRAINT "FloorLightSlot_capacityOrdinal_check"
    CHECK ("capacityOrdinal" BETWEEN 1 AND 2000);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "FloorLightSlot_floorId_capacityOrdinal_key"
ON "FloorLightSlot"("floorId", "capacityOrdinal");

CREATE OR REPLACE FUNCTION "assign_floor_light_slot_capacity_ordinal"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  available_ordinal INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."floorId" IS NOT DISTINCT FROM OLD."floorId" THEN
    NEW."capacityOrdinal" := OLD."capacityOrdinal";
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('FloorLightSlot.capacity:' || NEW."floorId", 0)
  );

  SELECT candidate.ordinal INTO available_ordinal
  FROM generate_series(1, 2000) AS candidate(ordinal)
  WHERE NOT EXISTS (
    SELECT 1
    FROM "FloorLightSlot"
    WHERE "floorId" = NEW."floorId"
      AND "capacityOrdinal" = candidate.ordinal
  )
  ORDER BY candidate.ordinal
  LIMIT 1;

  IF available_ordinal IS NULL THEN
    RAISE EXCEPTION 'floor light slot capacity exceeded: floor=%, maximum=2000',
      NEW."floorId"
      USING ERRCODE = '23514', CONSTRAINT = 'FloorLightSlot_floor_capacity';
  END IF;

  NEW."capacityOrdinal" := available_ordinal;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "FloorLightSlot_assign_capacity_ordinal_insert"
BEFORE INSERT ON "FloorLightSlot"
FOR EACH ROW EXECUTE FUNCTION "assign_floor_light_slot_capacity_ordinal"();

CREATE TRIGGER "FloorLightSlot_assign_capacity_ordinal_update"
BEFORE UPDATE OF "floorId", "capacityOrdinal" ON "FloorLightSlot"
FOR EACH ROW EXECUTE FUNCTION "assign_floor_light_slot_capacity_ordinal"();

COMMIT;
