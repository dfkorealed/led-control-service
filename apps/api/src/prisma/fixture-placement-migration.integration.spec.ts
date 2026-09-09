import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const databaseUrl = process.env.FLOOR_EDITOR_TEST_DATABASE_URL;
const migration = readFileSync(join(__dirname, "../../prisma/migrations/20260909000000_fixture_placement/migration.sql"), "utf8");

(databaseUrl ? describe : describe.skip)("fixture placement migration PostgreSQL rehearsal", () => {
  it("preserves legacy coordinates, defaults new rows to unplaced and forbids verified unplaced rows", () => {
    // Transaction-local schema is rolled back; the shared QA database's real tables are never changed.
    const result = spawnSync("psql", [databaseUrl!, "-X", "-v", "ON_ERROR_STOP=1", "-At"], {
      input: `BEGIN;
        CREATE SCHEMA placement_rehearsal_${process.pid};
        SET LOCAL search_path TO placement_rehearsal_${process.pid};
        CREATE TABLE "Fixture" (id text PRIMARY KEY, x double precision, y double precision);
        INSERT INTO "Fixture" VALUES ('legacy', -12.5, 20000);
        ${migration}
        INSERT INTO "Fixture" (id,x,y) VALUES ('new',0,0);
        SELECT id || '|' || x || '|' || y || '|' || "placementStatus" || '|' || ("positionVerifiedAt" IS NULL)
          FROM "Fixture" ORDER BY id;
        DO $$ BEGIN
          BEGIN
            UPDATE "Fixture" SET "positionVerifiedAt"=now() WHERE id='new';
            RAISE EXCEPTION 'constraint missing';
          EXCEPTION WHEN check_violation THEN NULL;
          END;
        END $$;
        ROLLBACK;`, encoding: "utf8"
    });
    expect(result.stderr).not.toContain("ERROR");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("legacy|-12.5|20000|placed|true");
    expect(result.stdout).toContain("new|0|0|unplaced|true");
  });
});
