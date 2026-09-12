import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const databaseUrl = process.env.FLOOR_ASSET_MIGRATION_TEST_DATABASE_URL ?? process.env.FLOOR_EDITOR_TEST_DATABASE_URL;
const psqlDatabaseUrl = databaseUrl ? (() => {
  const url = new URL(databaseUrl);
  url.searchParams.delete("schema");
  return url.toString();
})() : undefined;
const migration = readFileSync(join(__dirname, "../../prisma/migrations/20260912090000_floor_asset_private_ledger/migration.sql"), "utf8");
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("floor asset private ledger migration PostgreSQL rehearsal", () => {
  const schemaName = `floor_asset_migration_${process.pid}_${Date.now()}`.toLowerCase();

  afterAll(() => {
    runSql(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  });

  it("rewrites historical revision asset URLs before dropping publicUrl", () => {
    const publicOriginal = "https://objects.example/floor-assets/floors/floor-1/original.pdf";
    const publicRendered = "https://objects.example/floor-assets/floors/floor-1/rendered.png";
    const snapshot = JSON.stringify({
      version: 2,
      floorPlan: {
        imageUrl: publicRendered,
        sourceType: "pdf",
        originalFileUrl: publicOriginal,
        renderedImageUrl: publicRendered,
        width: 1200,
        height: 800,
        gridSize: 10
      },
      fixtures: [],
      objects: []
    });
    const result = runSql(`
      CREATE SCHEMA "${schemaName}";
      SET search_path TO "${schemaName}";
      CREATE TYPE "FloorAssetStatus" AS ENUM ('pending', 'ready');
      CREATE TABLE "FloorAsset" (
        "id" TEXT PRIMARY KEY, "floorId" TEXT NOT NULL, "status" "FloorAssetStatus" NOT NULL,
        "publicUrl" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE "FloorPlan" (
        "floorId" TEXT PRIMARY KEY, "imageUrl" TEXT NOT NULL, "originalFileUrl" TEXT, "renderedImageUrl" TEXT
      );
      CREATE TABLE "FloorMapRevision" (
        "id" TEXT PRIMARY KEY, "floorId" TEXT NOT NULL, "snapshot" JSONB NOT NULL, "snapshotSha256" TEXT NOT NULL
      );
      INSERT INTO "FloorAsset" ("id", "floorId", "status", "publicUrl", "createdAt") VALUES
        ('asset-original', 'floor-1', 'ready', '${publicOriginal}', now()),
        ('asset-rendered', 'floor-1', 'ready', '${publicRendered}', now());
      INSERT INTO "FloorPlan" VALUES ('floor-1', '${publicRendered}', '${publicOriginal}', '${publicRendered}');
      INSERT INTO "FloorMapRevision" VALUES ('revision-1', 'floor-1', '${snapshot}'::jsonb, 'legacy-hash');
      ${migration}
      SELECT "snapshot"->'floorPlan'->>'imageUrl',
             "snapshot"->'floorPlan'->>'originalFileUrl',
             "snapshot"->'floorPlan'->>'renderedImageUrl',
             "snapshotSha256"
      FROM "FloorMapRevision" WHERE "id" = 'revision-1';
      SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = '${schemaName}' AND table_name = 'FloorAsset' AND column_name = 'publicUrl';
    `, ["-qAt", "-v", "ON_ERROR_STOP=1"]);

    if (result.status !== 0) throw new Error(result.stderr);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("ERROR");
    const [revision, publicUrlColumnCount] = result.stdout.trim().split("\n").slice(-2);
    expect(revision).toBe("/api/floors/floor-1/assets/asset-rendered/content|/api/floors/floor-1/assets/asset-original/content|/api/floors/floor-1/assets/asset-rendered/content|2fa73486dc70e57872cc7dd263c3d03bb0e8c64de040981b19237bd8e0e56298");
    expect(publicUrlColumnCount).toBe("0");
  });

  function runSql(sql: string, args: string[] = ["-q", "-v", "ON_ERROR_STOP=1"]) {
    return spawnSync("psql", [...args, psqlDatabaseUrl!], { encoding: "utf8", input: sql });
  }
});
