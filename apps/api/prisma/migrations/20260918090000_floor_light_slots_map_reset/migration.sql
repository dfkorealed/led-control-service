BEGIN;
SET LOCAL lock_timeout = '10s';

-- Parent updates must not cross the trigger installation boundary.
LOCK TABLE "Floor", "FloorImportJob", "FloorImportCandidate", "Fixture"
IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "FloorLightSlot" (
  "id" TEXT NOT NULL,
  "floorId" TEXT NOT NULL,
  "sourceImportJobId" TEXT NOT NULL,
  "sourceCandidateId" TEXT NOT NULL,
  "assignedFixtureId" TEXT,
  "x" DOUBLE PRECISION NOT NULL,
  "y" DOUBLE PRECISION NOT NULL,
  "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FloorLightSlot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FloorLightSlot_floorId_fkey"
    FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorLightSlot_sourceImportJobId_fkey"
    FOREIGN KEY ("sourceImportJobId") REFERENCES "FloorImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorLightSlot_sourceCandidateId_fkey"
    FOREIGN KEY ("sourceCandidateId") REFERENCES "FloorImportCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FloorLightSlot_assignedFixtureId_fkey"
    FOREIGN KEY ("assignedFixtureId") REFERENCES "Fixture"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "FloorLightSlot_geometry_check" CHECK (
    "x" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "y" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION) AND
    "rotation" NOT IN ('-Infinity'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION)
  )
);

CREATE UNIQUE INDEX "FloorLightSlot_sourceCandidateId_key"
ON "FloorLightSlot"("sourceCandidateId");
CREATE UNIQUE INDEX "FloorLightSlot_assignedFixtureId_key"
ON "FloorLightSlot"("assignedFixtureId");
CREATE INDEX "FloorLightSlot_floorId_id_idx"
ON "FloorLightSlot"("floorId", "id");

-- Serialize capacity checks by floor at transaction end. Updates lock the old
-- and new floor in deterministic order; deletes need no check because they only
-- reduce the count. This permits delete-then-insert map replacement transactions.
CREATE FUNCTION "enforce_floor_light_slot_capacity"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_floor_ids TEXT[];
  checked_floor_id TEXT;
  slot_count BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    affected_floor_ids := ARRAY[OLD."floorId", NEW."floorId"];
  ELSE
    affected_floor_ids := ARRAY[NEW."floorId"];
  END IF;

  FOR checked_floor_id IN
    SELECT DISTINCT affected."floorId"
    FROM unnest(affected_floor_ids) AS affected("floorId")
    WHERE affected."floorId" IS NOT NULL
    ORDER BY affected."floorId"
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('FloorLightSlot.capacity:' || checked_floor_id, 0)
    );
  END LOOP;

  FOR checked_floor_id IN
    SELECT DISTINCT affected."floorId"
    FROM unnest(affected_floor_ids) AS affected("floorId")
    WHERE affected."floorId" IS NOT NULL
    ORDER BY affected."floorId"
  LOOP
    SELECT count(*) INTO slot_count
    FROM "FloorLightSlot"
    WHERE "floorId" = checked_floor_id;

    IF slot_count > 2000 THEN
      RAISE EXCEPTION 'floor light slot capacity exceeded: floor=%, count=%, maximum=2000',
        checked_floor_id, slot_count
        USING ERRCODE = '23514', CONSTRAINT = 'FloorLightSlot_floor_capacity';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- Prisma cannot express that a slot, its source job/candidate, and its optional
-- fixture all belong to one floor. Validate the final state from every mutable side.
CREATE FUNCTION "floor_light_slot_is_valid"(slot_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM "FloorLightSlot" AS slot
    LEFT JOIN "FloorImportJob" AS job
      ON job."id" = slot."sourceImportJobId"
    LEFT JOIN "FloorImportCandidate" AS candidate
      ON candidate."id" = slot."sourceCandidateId"
    LEFT JOIN "Fixture" AS fixture
      ON fixture."id" = slot."assignedFixtureId"
    WHERE slot."id" = slot_id
      AND (
        job."id" IS NULL OR
        candidate."id" IS NULL OR
        candidate."jobId" <> slot."sourceImportJobId" OR
        job."floorId" <> slot."floorId" OR
        (
          slot."assignedFixtureId" IS NOT NULL AND
          (fixture."id" IS NULL OR fixture."floorId" <> slot."floorId")
        )
      )
  );
$$;

CREATE FUNCTION "enforce_floor_light_slot_invariants"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  invalid_slot_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'FloorLightSlot' THEN
    invalid_slot_id := NEW."id";
  ELSIF TG_TABLE_NAME = 'FloorImportJob' THEN
    SELECT slot."id" INTO invalid_slot_id
    FROM "FloorLightSlot" AS slot
    WHERE slot."sourceImportJobId" = NEW."id"
      AND NOT "floor_light_slot_is_valid"(slot."id")
    LIMIT 1;
  ELSIF TG_TABLE_NAME = 'FloorImportCandidate' THEN
    SELECT slot."id" INTO invalid_slot_id
    FROM "FloorLightSlot" AS slot
    WHERE slot."sourceCandidateId" = NEW."id"
      AND NOT "floor_light_slot_is_valid"(slot."id")
    LIMIT 1;
  ELSIF TG_TABLE_NAME = 'Fixture' THEN
    SELECT slot."id" INTO invalid_slot_id
    FROM "FloorLightSlot" AS slot
    WHERE slot."assignedFixtureId" = NEW."id"
      AND NOT "floor_light_slot_is_valid"(slot."id")
    LIMIT 1;
  END IF;

  IF invalid_slot_id IS NOT NULL
    AND NOT "floor_light_slot_is_valid"(invalid_slot_id) THEN
    RAISE EXCEPTION 'floor light slot scope invariant violated: slot=%', invalid_slot_id
      USING ERRCODE = '23514', CONSTRAINT = 'FloorLightSlot_scope_invariant';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "FloorLightSlot_scope_invariant"
AFTER INSERT OR UPDATE ON "FloorLightSlot"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_light_slot_invariants"();

CREATE CONSTRAINT TRIGGER "FloorLightSlot_capacity_insert"
AFTER INSERT ON "FloorLightSlot"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_light_slot_capacity"();

CREATE CONSTRAINT TRIGGER "FloorLightSlot_capacity_floor_update"
AFTER UPDATE OF "floorId" ON "FloorLightSlot"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_light_slot_capacity"();

CREATE CONSTRAINT TRIGGER "FloorImportJob_light_slot_invariant"
AFTER UPDATE OF "floorId" ON "FloorImportJob"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_light_slot_invariants"();

CREATE CONSTRAINT TRIGGER "FloorImportCandidate_light_slot_invariant"
AFTER UPDATE OF "jobId" ON "FloorImportCandidate"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_light_slot_invariants"();

CREATE CONSTRAINT TRIGGER "Fixture_light_slot_invariant"
AFTER UPDATE OF "floorId" ON "Fixture"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_floor_light_slot_invariants"();

COMMIT;
