import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFloorEditorSnapshot } from "@led-control/shared";
import { hashFloorEditorSnapshot } from "../floor-editor/floor-editor-snapshot";

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
  const invalidSchemaName = `${schemaName}_invalid`;
  const unmatchedPlanSchemaName = `${schemaName}_unmatched_plan`;
  const unmatchedRevisionSchemaName = `${schemaName}_unmatched_revision`;

  afterAll(() => {
    runSql(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
    runSql(`DROP SCHEMA IF EXISTS "${invalidSchemaName}" CASCADE;`);
    runSql(`DROP SCHEMA IF EXISTS "${unmatchedPlanSchemaName}" CASCADE;`);
    runSql(`DROP SCHEMA IF EXISTS "${unmatchedRevisionSchemaName}" CASCADE;`);
  });

  it("rewrites URLs with the runtime canonical hash across number boundaries and nested values", () => {
    const publicOriginal = "https://objects.example/floor-assets/floors/floor-1/original.pdf";
    const publicRendered = "https://objects.example/floor-assets/floors/floor-1/rendered.png";
    const snapshot = parseFloorEditorSnapshot({
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
      objects: [{
        id: "object-1",
        type: "triangle",
        x: 1e-7,
        y: 1e-6,
        width: 1e20,
        height: 1e21,
        rotation: 9007199254740993,
        points: [{ x: 1e-7, y: 1e-6 }, { x: 1e20, y: 1e21 }, { x: 1.2345678901234567, y: -1e-7 }],
        text: null,
        strokeColor: "#112233",
        fillColor: null,
        strokeWidth: 1e-7,
        fontSize: null,
        zIndex: 0,
        locked: false,
        visible: true
      }]
    });
    const expectedSnapshot = parseFloorEditorSnapshot({
      ...snapshot,
      floorPlan: {
        ...snapshot.floorPlan!,
        imageUrl: "/api/floors/floor-1/assets/asset-rendered/content",
        originalFileUrl: "/api/floors/floor-1/assets/asset-original/content",
        renderedImageUrl: "/api/floors/floor-1/assets/asset-rendered/content"
      }
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
      INSERT INTO "FloorMapRevision" VALUES (
        'revision-1',
        'floor-1',
        ${sqlLiteral(JSON.stringify(snapshot))}::jsonb,
        ${sqlLiteral(hashFloorEditorSnapshot(snapshot))}
      );
      ${migration}
      SELECT json_build_object(
        'snapshot', revision."snapshot",
        'snapshotSha256', revision."snapshotSha256",
        'publicUrlColumnCount', (
          SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema = '${schemaName}' AND table_name = 'FloorAsset' AND column_name = 'publicUrl'
        )
      )
      FROM "FloorMapRevision" AS revision WHERE revision."id" = 'revision-1';
    `, ["-qAt", "-v", "ON_ERROR_STOP=1"]);

    if (result.status !== 0) throw new Error(result.stderr);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("ERROR");
    const revision = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    expect(revision.snapshot).toEqual(expectedSnapshot);
    expect(revision.snapshotSha256).toBe(hashFloorEditorSnapshot(expectedSnapshot));
    expect(revision.publicUrlColumnCount).toBe(0);
  });

  it("aborts before changing URLs or dropping publicUrl when the original runtime hash is invalid", () => {
    const publicUrl = "https://objects.example/floor-assets/floors/floor-2/map.png";
    const snapshot = parseFloorEditorSnapshot({
      version: 2,
      floorPlan: {
        imageUrl: publicUrl,
        sourceType: "image",
        originalFileUrl: publicUrl,
        renderedImageUrl: null,
        width: 640,
        height: 480,
        gridSize: 10
      },
      fixtures: [],
      objects: []
    });
    const setup = runSql(`
      CREATE SCHEMA "${invalidSchemaName}";
      SET search_path TO "${invalidSchemaName}";
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
      INSERT INTO "FloorAsset" VALUES ('asset-map', 'floor-2', 'ready', ${sqlLiteral(publicUrl)}, now());
      INSERT INTO "FloorPlan" VALUES ('floor-2', ${sqlLiteral(publicUrl)}, ${sqlLiteral(publicUrl)}, NULL);
      INSERT INTO "FloorMapRevision" VALUES (
        'revision-2', 'floor-2', ${sqlLiteral(JSON.stringify(snapshot))}::jsonb, ${sqlLiteral("0".repeat(64))}
      );
    `);
    expect(setup.status).toBe(0);

    const migrationResult = runSql(`
      BEGIN;
      SET LOCAL search_path TO "${invalidSchemaName}";
      ${migration}
      COMMIT;
    `);
    expect(migrationResult.status).not.toBe(0);
    expect(migrationResult.stderr).toContain("FloorMapRevision snapshot integrity check failed");

    const retained = runSql(`
      SET search_path TO "${invalidSchemaName}";
      SELECT json_build_object(
        'snapshotUrl', revision."snapshot" #>> '{floorPlan,imageUrl}',
        'snapshotSha256', revision."snapshotSha256",
        'publicUrlColumnCount', (
          SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema = '${invalidSchemaName}' AND table_name = 'FloorAsset' AND column_name = 'publicUrl'
        )
      )
      FROM "FloorMapRevision" AS revision WHERE revision."id" = 'revision-2';
    `, ["-qAt", "-v", "ON_ERROR_STOP=1"]);
    expect(retained.status).toBe(0);
    expect(JSON.parse(retained.stdout.trim().split("\n").at(-1)!)).toEqual({
      snapshotUrl: publicUrl,
      snapshotSha256: "0".repeat(64),
      publicUrlColumnCount: 1
    });
  });

  it.each([
    {
      target: "FloorPlan",
      schemaName: unmatchedPlanSchemaName,
      floorPlanUrl: "https://legacy.example/floors/floor-unmatched/plan.png",
      revisionUrl: "",
      expectedCounts: "found 1 unmatched FloorPlan URL(s) and 0 unmatched FloorMapRevision URL(s)"
    },
    {
      target: "FloorMapRevision",
      schemaName: unmatchedRevisionSchemaName,
      floorPlanUrl: "",
      revisionUrl: "https://legacy.example/floors/floor-unmatched/revision.png",
      expectedCounts: "found 0 unmatched FloorPlan URL(s) and 1 unmatched FloorMapRevision URL(s)"
    }
  ])("aborts atomically when $target retains an unmatched legacy URL", ({
    target, schemaName: unmatchedSchemaName, floorPlanUrl, revisionUrl, expectedCounts
  }) => {
    const matchedPublicUrl = "https://objects.example/floor-assets/floors/floor-unmatched/map.png";
    const snapshot = parseFloorEditorSnapshot({
      version: 2,
      floorPlan: {
        imageUrl: revisionUrl,
        sourceType: revisionUrl ? "image" : "none",
        originalFileUrl: null,
        renderedImageUrl: null,
        width: 640,
        height: 480,
        gridSize: 10
      },
      fixtures: [],
      objects: []
    });
    const snapshotSha256 = hashFloorEditorSnapshot(snapshot);
    const setup = runSql(`
      CREATE SCHEMA "${unmatchedSchemaName}";
      SET search_path TO "${unmatchedSchemaName}";
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
      INSERT INTO "FloorAsset" VALUES (
        'asset-map', 'floor-unmatched', 'pending', ${sqlLiteral(matchedPublicUrl)}, now()
      );
      INSERT INTO "FloorPlan" VALUES ('floor-unmatched', ${sqlLiteral(floorPlanUrl)}, '', NULL);
      INSERT INTO "FloorMapRevision" VALUES (
        'revision-unmatched', 'floor-unmatched', ${sqlLiteral(JSON.stringify(snapshot))}::jsonb,
        ${sqlLiteral(snapshotSha256)}
      );
    `);
    expect(setup.status).toBe(0);

    const migrationResult = runSql(`
      BEGIN;
      SET LOCAL search_path TO "${unmatchedSchemaName}";
      ${migration}
      COMMIT;
    `);
    expect(migrationResult.status).not.toBe(0);
    expect(migrationResult.stderr).toContain("Floor asset private URL migration blocked");
    expect(migrationResult.stderr).toContain(target);
    expect(migrationResult.stderr).toContain(expectedCounts);

    const retained = runSql(`
      SET search_path TO "${unmatchedSchemaName}";
      SELECT json_build_object(
        'floorPlanImageUrl', plan."imageUrl",
        'floorPlanOriginalFileUrl', plan."originalFileUrl",
        'revisionImageUrl', revision."snapshot" #>> '{floorPlan,imageUrl}',
        'snapshotSha256', revision."snapshotSha256",
        'publicUrlColumnCount', (
          SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema = '${unmatchedSchemaName}' AND table_name = 'FloorAsset' AND column_name = 'publicUrl'
        ),
        'uploadExpiresAtColumnCount', (
          SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema = '${unmatchedSchemaName}' AND table_name = 'FloorAsset' AND column_name = 'uploadExpiresAt'
        )
      )
      FROM "FloorPlan" AS plan
      JOIN "FloorMapRevision" AS revision ON revision."floorId" = plan."floorId";
    `, ["-qAt", "-v", "ON_ERROR_STOP=1"]);
    expect(retained.status).toBe(0);
    expect(JSON.parse(retained.stdout.trim().split("\n").at(-1)!)).toEqual({
      floorPlanImageUrl: floorPlanUrl,
      floorPlanOriginalFileUrl: "",
      revisionImageUrl: revisionUrl,
      snapshotSha256,
      publicUrlColumnCount: 1,
      uploadExpiresAtColumnCount: 0
    });
  });

  function runSql(sql: string, args: string[] = ["-q", "-v", "ON_ERROR_STOP=1"]) {
    return spawnSync("psql", [...args, psqlDatabaseUrl!], { encoding: "utf8", input: sql });
  }
});

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
