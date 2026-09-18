import { readFileSync } from "node:fs";
import { join } from "node:path";
import { disposablePostgres } from "../../test/support/disposable-postgres";

const baseMigration = readFileSync(join(
  __dirname,
  "../../prisma/migrations/20260918090000_floor_light_slots_map_reset/migration.sql"
), "utf8");
const reconciliationMigration = readFileSync(join(
  __dirname,
  "../../prisma/migrations/20260918190000_floor_light_slot_capacity_reconciliation/migration.sql"
), "utf8");

jest.setTimeout(60_000);

describe("floor light slot capacity reconciliation", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;

  beforeAll(async () => {
    cluster = await disposablePostgres();
  });

  afterAll(() => cluster?.stop());

  it.each([false, true])(
    "upgrades an applied legacy slot migration without losing rows (old capacity triggers: %s)",
    (withLegacyCapacityTriggers) => {
      const databaseUrl = cluster.database();
      bootstrapSlotSchema(cluster, databaseUrl);
      seedSlots(cluster, databaseUrl, 3);
      downgradeCapacitySchema(cluster, databaseUrl, withLegacyCapacityTriggers);

      cluster.sql(databaseUrl, reconciliationMigration);

      expect(cluster.sql(databaseUrl, `
        SELECT string_agg("capacityOrdinal"::text, ',' ORDER BY "id")
        FROM "FloorLightSlot";
      `)).toBe("1,2,3");
      expect(cluster.sql(databaseUrl, `
        SELECT string_agg(tgname, ',' ORDER BY tgname)
        FROM pg_trigger
        WHERE tgrelid = '"FloorLightSlot"'::regclass AND NOT tgisinternal;
      `)).toBe(
        "FloorLightSlot_assign_capacity_ordinal_insert," +
        "FloorLightSlot_assign_capacity_ordinal_update," +
        "FloorLightSlot_scope_invariant"
      );
      expect(cluster.sql(databaseUrl, `
        SELECT count(*) FROM pg_proc JOIN pg_namespace AS namespace
          ON namespace.oid = pg_proc.pronamespace
        WHERE namespace.nspname = 'public'
          AND proname = 'enforce_floor_light_slot_capacity';
      `)).toBe("0");

      seedCandidate(cluster, databaseUrl, 4);
      cluster.sql(databaseUrl, `
        INSERT INTO "FloorLightSlot" (
          "id", "floorId", "sourceImportJobId", "sourceCandidateId",
          "x", "y", "rotation", "updatedAt"
        ) VALUES ('slot-4', 'floor-a', 'job-a', 'candidate-4', 4, 4, 0, CURRENT_TIMESTAMP);
      `);
      expect(cluster.sql(databaseUrl, `
        SELECT "capacityOrdinal" FROM "FloorLightSlot" WHERE "id" = 'slot-4';
      `)).toBe("4");
    }
  );

  it("is safe after the latest base migration already created structural capacity", () => {
    const databaseUrl = cluster.database();
    bootstrapSlotSchema(cluster, databaseUrl);
    seedSlots(cluster, databaseUrl, 2);

    cluster.sql(databaseUrl, reconciliationMigration);

    expect(cluster.sql(databaseUrl, `
      SELECT min("capacityOrdinal") || ':' || max("capacityOrdinal") || ':' || count(*)
      FROM "FloorLightSlot";
    `)).toBe("1:2:2");
  });

  it("fails closed and rolls back when legacy data already exceeds the floor limit", () => {
    const databaseUrl = cluster.database();
    bootstrapSlotSchema(cluster, databaseUrl);
    downgradeCapacitySchema(cluster, databaseUrl, false);
    cluster.sql(databaseUrl, `
      INSERT INTO "Floor" ("id") VALUES ('floor-a');
      INSERT INTO "FloorImportJob" ("id", "floorId") VALUES ('job-a', 'floor-a');
      INSERT INTO "FloorImportCandidate" ("id", "jobId")
      SELECT 'candidate-' || value, 'job-a' FROM generate_series(1, 2001) AS value;
      INSERT INTO "FloorLightSlot" (
        "id", "floorId", "sourceImportJobId", "sourceCandidateId",
        "x", "y", "rotation", "updatedAt"
      )
      SELECT 'slot-' || value, 'floor-a', 'job-a', 'candidate-' || value,
        value, value, 0, CURRENT_TIMESTAMP
      FROM generate_series(1, 2001) AS value;
    `);

    expect(() => cluster.sql(databaseUrl, reconciliationMigration))
      .toThrow("existing floor light slots exceed 2000");
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'FloorLightSlot'
        AND column_name = 'capacityOrdinal';
    `)).toBe("0");
  });
});

function bootstrapSlotSchema(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string
) {
  cluster.sql(databaseUrl, `
    CREATE TABLE "Floor" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "FloorImportJob" (
      "id" TEXT PRIMARY KEY,
      "floorId" TEXT NOT NULL REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE TABLE "FloorImportCandidate" (
      "id" TEXT PRIMARY KEY,
      "jobId" TEXT NOT NULL REFERENCES "FloorImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE TABLE "Fixture" (
      "id" TEXT PRIMARY KEY,
      "floorId" TEXT NOT NULL REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    ${baseMigration}
  `);
}

function seedSlots(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  count: number
) {
  cluster.sql(databaseUrl, `
    INSERT INTO "Floor" ("id") VALUES ('floor-a');
    INSERT INTO "FloorImportJob" ("id", "floorId") VALUES ('job-a', 'floor-a');
    INSERT INTO "FloorImportCandidate" ("id", "jobId")
    SELECT 'candidate-' || value, 'job-a' FROM generate_series(1, ${count}) AS value;
    INSERT INTO "FloorLightSlot" (
      "id", "floorId", "sourceImportJobId", "sourceCandidateId",
      "x", "y", "rotation", "updatedAt"
    )
    SELECT 'slot-' || value, 'floor-a', 'job-a', 'candidate-' || value,
      value, value, 0, CURRENT_TIMESTAMP
    FROM generate_series(1, ${count}) AS value;
  `);
}

function seedCandidate(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  ordinal: number
) {
  cluster.sql(databaseUrl, `
    INSERT INTO "FloorImportCandidate" ("id", "jobId")
    VALUES ('candidate-${ordinal}', 'job-a');
  `);
}

function downgradeCapacitySchema(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  withLegacyCapacityTriggers: boolean
) {
  cluster.sql(databaseUrl, `
    DROP TRIGGER "FloorLightSlot_assign_capacity_ordinal_insert" ON "FloorLightSlot";
    DROP TRIGGER "FloorLightSlot_assign_capacity_ordinal_update" ON "FloorLightSlot";
    DROP FUNCTION "assign_floor_light_slot_capacity_ordinal"();
    DROP INDEX "FloorLightSlot_floorId_capacityOrdinal_key";
    ALTER TABLE "FloorLightSlot" DROP CONSTRAINT "FloorLightSlot_capacityOrdinal_check";
    ALTER TABLE "FloorLightSlot" DROP COLUMN "capacityOrdinal";
    ${withLegacyCapacityTriggers ? `
      CREATE FUNCTION "enforce_floor_light_slot_capacity"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RETURN NEW;
      END;
      $$;
      CREATE CONSTRAINT TRIGGER "FloorLightSlot_capacity_insert"
      AFTER INSERT ON "FloorLightSlot" DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION "enforce_floor_light_slot_capacity"();
      CREATE CONSTRAINT TRIGGER "FloorLightSlot_capacity_floor_update"
      AFTER UPDATE OF "floorId" ON "FloorLightSlot" DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION "enforce_floor_light_slot_capacity"();
    ` : ""}
  `);
}
