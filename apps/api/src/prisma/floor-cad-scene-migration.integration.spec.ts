import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { disposablePostgres } from "../../test/support/disposable-postgres";

const previousMigrationName = "20260918190000_floor_light_slot_capacity_reconciliation";
const cadSceneMigrationName = "20260918210000_add_floor_cad_scene";
const migrationName = "20260919120000_add_floor_cad_tile_part";
const schemaPath = join(__dirname, "../../prisma/schema.prisma");
const migrationPath = join(__dirname, `../../prisma/migrations/${cadSceneMigrationName}/migration.sql`);
const shardingMigrationPath = join(__dirname, `../../prisma/migrations/${migrationName}/migration.sql`);
const schema = readFileSync(schemaPath, "utf8");

jest.setTimeout(60_000);

describe("floor CAD scene Prisma schema contract", () => {
  it("declares CAD asset kinds, source type, scalar geometry, and ownership relations", () => {
    expect(enumBlock("FloorPlanSourceType")).toContain("cad");
    expect(enumBlock("FloorAssetKind")).toEqual(expect.stringContaining("cad_manifest"));
    expect(enumBlock("FloorAssetKind")).toEqual(expect.stringContaining("cad_tile"));
    expect(enumBlock("FloorAssetKind")).toEqual(expect.stringContaining("cad_region_preview"));
    expect(enumBlock("FloorImportJobStatus")).toEqual(expect.stringContaining("region_selection_required"));

    const region = modelBlock("FloorImportRegion");
    expect(region).toEqual(expect.stringContaining("@@unique([jobId, regionId])"));
    expect(region).toEqual(expect.stringContaining("onDelete: Cascade"));
    expect(region).toEqual(expect.stringContaining("onDelete: NoAction"));

    const scene = modelBlock("FloorCadScene");
    expect(scene).toEqual(expect.stringContaining("floorId"));
    expect(scene).toEqual(expect.stringContaining("sourceImportJobId"));
    expect(scene).toEqual(expect.stringContaining("manifestAssetId"));
    expect(scene).toEqual(expect.stringContaining("@unique"));
    expect(scene).toEqual(expect.stringContaining("tileSize"));
    expect(scene).toEqual(expect.stringContaining("@default(512)"));
    expect(scene).toEqual(expect.stringContaining("transformScaleX"));
    expect(scene).toEqual(expect.stringContaining("transformScaleY"));
    expect(scene).not.toMatch(/\btransformScale\s/);

    for (const model of [
      "FloorImportRegion",
      "FloorCadScene",
      "FloorCadTile",
      "FloorCadElementOverride",
      "FloorCadLayerState"
    ]) {
      expect(modelBlock(model)).not.toMatch(/\bJson\b/);
    }

    expect(modelBlock("FloorCadTile")).toEqual(expect.stringContaining("part           Int           @default(0)"));
    expect(modelBlock("FloorCadTile")).toEqual(expect.stringContaining("@@unique([sceneId, tileX, tileY, lod, part])"));
    expect(modelBlock("FloorCadElementOverride")).toEqual(expect.stringContaining("@@id([sceneId, elementId])"));
    expect(modelBlock("FloorCadLayerState")).toEqual(expect.stringContaining("@@id([sceneId, layerName])"));
  });

  it("ships the matching migration", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(existsSync(shardingMigrationPath)).toBe(true);
    const shardingMigration = readFileSync(shardingMigrationPath, "utf8");
    expect(shardingMigration).toContain('ADD COLUMN "part" INTEGER NOT NULL DEFAULT 0');
    expect(shardingMigration).toContain('("sceneId", "tileX", "tileY", "lod", "part")');
    expect(shardingMigration.indexOf('CREATE UNIQUE INDEX "FloorCadTile_sceneId_tileX_tileY_lod_part_key"'))
      .toBeLessThan(shardingMigration.indexOf('DROP INDEX "FloorCadTile_sceneId_tileX_tileY_lod_key"'));
    expect(shardingMigration).toContain('ADD CONSTRAINT "FloorCadTile_size_check_v2"');
    expect(shardingMigration).toContain('VALIDATE CONSTRAINT "FloorCadTile_size_check_v2"');
    expect(shardingMigration.indexOf('VALIDATE CONSTRAINT "FloorCadTile_size_check_v2"'))
      .toBeLessThan(shardingMigration.indexOf('DROP CONSTRAINT "FloorCadTile_size_check"'));
  });
});

describe("floor CAD tile part populated upgrade", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let databaseUrl: string;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    databaseUrl = cluster.database();
    const base = cluster.deploy(databaseUrl, cadSceneMigrationName);
    if (base.status !== 0) throw new Error(base.stderr);
    cluster.sql(databaseUrl, `
      INSERT INTO "Organization" ("id", "name", "updatedAt")
      VALUES ('organization-part-upgrade', 'CAD part upgrade', CURRENT_TIMESTAMP);
      INSERT INTO "Site" ("id", "organizationId", "name", "updatedAt")
      VALUES ('site-part-upgrade', 'organization-part-upgrade', 'CAD part upgrade site', CURRENT_TIMESTAMP);
      INSERT INTO "Floor" ("id", "siteId", "name", "level", "updatedAt")
      VALUES ('floor-scene', 'site-part-upgrade', 'CAD part upgrade floor', 1, CURRENT_TIMESTAMP);
      INSERT INTO "FloorAsset" (
        "id", "floorId", "kind", "status", "objectKey", "mimeType", "sizeBytes", "sha256", "readyAt", "updatedAt"
      ) VALUES
        ('source-scene', 'floor-scene', 'original', 'ready', 'source/upgrade.dwg', 'application/dwg', 100,
          repeat('a', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('preview-scene', 'floor-scene', 'cad_region_preview', 'ready', 'cad/preview', 'image/png', 100,
          repeat('b', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('manifest-scene', 'floor-scene', 'cad_manifest', 'ready', 'cad/manifest', 'application/octet-stream', 100,
          repeat('c', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('tile-part-0', 'floor-scene', 'cad_tile', 'ready', 'cad/tile-0', 'application/octet-stream', 100,
          repeat('d', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('tile-part-1', 'floor-scene', 'cad_tile', 'ready', 'cad/tile-1', 'application/octet-stream', 100,
          repeat('e', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('tile-part-duplicate', 'floor-scene', 'cad_tile', 'ready', 'cad/tile-duplicate', 'application/octet-stream', 100,
          repeat('f', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "FloorImportJob" ("id", "floorId", "sourceAssetId", "sourceFormat", "updatedAt")
      VALUES ('job-scene', 'floor-scene', 'source-scene', 'dwg', CURRENT_TIMESTAMP);
      ${regionInsertSql("region-scene", "job-scene", "region-upgrade", "preview-scene", true)}
      ${sceneInsertSql("scene-current", "manifest-scene")}
      INSERT INTO "FloorCadTile" (
        "id", "sceneId", "tileX", "tileY", "lod", "assetId", "primitiveCount", "byteSize",
        "minX", "minY", "maxX", "maxY", "updatedAt"
      ) VALUES (
        'tile-row-0', 'scene-current', 0, 0, 0, 'tile-part-0', 12, 2048,
        0, 0, 512, 512, CURRENT_TIMESTAMP
      );
    `);
  });

  afterAll(() => cluster?.stop());

  it("preserves populated rows and permits only distinct parts after the follow-up", () => {
    expect(cluster.sql(databaseUrl, `SELECT count(*) FROM "FloorCadTile";`)).toBe("1");
    const followUp = cluster.deploy(databaseUrl, migrationName);
    if (followUp.status !== 0) throw new Error(followUp.stderr);

    expect(cluster.sql(databaseUrl, `
      SELECT "id" || ':' || "part" || ':' || "primitiveCount" FROM "FloorCadTile";
    `)).toBe("tile-row-0:0:12");
    expect(() => cluster.sql(databaseUrl, `
      INSERT INTO "FloorCadTile" (
        "id", "sceneId", "tileX", "tileY", "lod", "part", "assetId", "primitiveCount", "byteSize",
        "minX", "minY", "maxX", "maxY", "updatedAt"
      ) VALUES (
        'tile-row-1', 'scene-current', 0, 0, 0, 1, 'tile-part-1', 8, 1024,
        0, 0, 512, 512, CURRENT_TIMESTAMP
      );
    `)).not.toThrow();
    expect(() => cluster.sql(databaseUrl, `
      INSERT INTO "FloorCadTile" (
        "id", "sceneId", "tileX", "tileY", "lod", "part", "assetId", "primitiveCount", "byteSize",
        "minX", "minY", "maxX", "maxY", "updatedAt"
      ) VALUES (
        'tile-row-zero', 'scene-current', 0, 0, 0, 2, 'tile-part-duplicate', 0, 1024,
        0, 0, 512, 512, CURRENT_TIMESTAMP
      );
    `)).toThrow(/FloorCadTile_size_check/);
    expect(() => cluster.sql(databaseUrl, `
      INSERT INTO "FloorCadTile" (
        "id", "sceneId", "tileX", "tileY", "lod", "part", "assetId", "primitiveCount", "byteSize",
        "minX", "minY", "maxX", "maxY", "updatedAt"
      ) VALUES (
        'tile-row-duplicate', 'scene-current', 0, 0, 0, 1, 'tile-part-duplicate', 8, 1024,
        0, 0, 512, 512, CURRENT_TIMESTAMP
      );
    `)).toThrow(/FloorCadTile_sceneId_tileX_tileY_lod_part_key/);
  });
});

describe("floor CAD tile part failed upgrade rollback", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let databaseUrl: string;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    databaseUrl = cluster.database();
    const base = cluster.deploy(databaseUrl, cadSceneMigrationName);
    if (base.status !== 0) throw new Error(base.stderr);
    cluster.sql(databaseUrl, `
      INSERT INTO "Organization" ("id", "name", "updatedAt")
      VALUES ('organization-part-rollback', 'CAD part rollback', CURRENT_TIMESTAMP);
      INSERT INTO "Site" ("id", "organizationId", "name", "updatedAt")
      VALUES ('site-part-rollback', 'organization-part-rollback', 'CAD part rollback site', CURRENT_TIMESTAMP);
      INSERT INTO "Floor" ("id", "siteId", "name", "level", "updatedAt")
      VALUES ('floor-part-rollback', 'site-part-rollback', 'CAD part rollback floor', 1, CURRENT_TIMESTAMP);
      INSERT INTO "FloorAsset" (
        "id", "floorId", "kind", "status", "objectKey", "mimeType", "sizeBytes", "sha256", "readyAt", "updatedAt"
      ) VALUES
        ('source-part-rollback', 'floor-part-rollback', 'original', 'ready', 'source/rollback.dwg', 'application/dwg', 100,
          repeat('a', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('preview-part-rollback', 'floor-part-rollback', 'cad_region_preview', 'ready', 'cad/rollback-preview', 'image/png', 100,
          repeat('b', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('manifest-part-rollback', 'floor-part-rollback', 'cad_manifest', 'ready', 'cad/rollback-manifest', 'application/octet-stream', 100,
          repeat('c', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('tile-part-rollback', 'floor-part-rollback', 'cad_tile', 'ready', 'cad/rollback-tile', 'application/octet-stream', 100,
          repeat('d', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "FloorImportJob" ("id", "floorId", "sourceAssetId", "sourceFormat", "updatedAt")
      VALUES ('job-part-rollback', 'floor-part-rollback', 'source-part-rollback', 'dwg', CURRENT_TIMESTAMP);
      ${regionInsertSql("region-part-rollback", "job-part-rollback", "region-rollback", "preview-part-rollback", true)}
      ${sceneInsertSql("scene-part-rollback", "manifest-part-rollback", {
        floorId: "floor-part-rollback",
        sourceImportJobId: "job-part-rollback",
        sourceRegionId: "region-part-rollback"
      })}
      INSERT INTO "FloorCadTile" (
        "id", "sceneId", "tileX", "tileY", "lod", "assetId", "primitiveCount", "byteSize",
        "minX", "minY", "maxX", "maxY", "updatedAt"
      ) VALUES (
        'tile-row-zero-before-upgrade', 'scene-part-rollback', 0, 0, 0, 'tile-part-rollback', 0, 1024,
        0, 0, 512, 512, CURRENT_TIMESTAMP
      );
    `);
  });

  afterAll(() => cluster?.stop());

  it("rolls back every schema change when an existing zero-count tile fails validation", () => {
    const followUp = cluster.deploy(databaseUrl, migrationName);
    expect(followUp.status).not.toBe(0);
    expect(cluster.sql(databaseUrl, `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'FloorCadTile' AND column_name = 'part'
      );
    `)).toBe("f");
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM pg_indexes
      WHERE indexname = 'FloorCadTile_sceneId_tileX_tileY_lod_key';
    `)).toBe("1");
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM pg_constraint
      WHERE conname = 'FloorCadTile_size_check_v2';
    `)).toBe("0");
  });
});

describe("floor CAD scene migration on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let databaseUrl: string;
  let legacyBefore: string;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    databaseUrl = cluster.database();
    const baseline = cluster.deploy(databaseUrl, previousMigrationName);
    if (baseline.status !== 0) throw new Error(baseline.stderr);

    cluster.sql(databaseUrl, `
      INSERT INTO "Organization" ("id", "name", "updatedAt")
      VALUES ('organization-cad-scene', 'CAD scene migration', CURRENT_TIMESTAMP);
      INSERT INTO "Site" ("id", "organizationId", "name", "updatedAt")
      VALUES ('site-cad-scene', 'organization-cad-scene', 'CAD scene site', CURRENT_TIMESTAMP);
      INSERT INTO "Floor" ("id", "siteId", "name", "level", "updatedAt") VALUES
        ('floor-legacy', 'site-cad-scene', 'Legacy floor', 1, CURRENT_TIMESTAMP),
        ('floor-region', 'site-cad-scene', 'Region floor', 2, CURRENT_TIMESTAMP),
        ('floor-scene', 'site-cad-scene', 'Scene floor', 3, CURRENT_TIMESTAMP),
        ('floor-other', 'site-cad-scene', 'Other floor', 4, CURRENT_TIMESTAMP),
        ('floor-race', 'site-cad-scene', 'Race floor', 5, CURRENT_TIMESTAMP);
      INSERT INTO "FloorAsset" (
        "id", "floorId", "kind", "status", "objectKey", "mimeType", "sizeBytes", "sha256", "readyAt", "updatedAt"
      ) VALUES
        ('source-region', 'floor-region', 'original', 'ready', 'source/region.dwg', 'application/dwg', 100,
          repeat('a', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('source-scene', 'floor-scene', 'original', 'ready', 'source/scene.dwg', 'application/dwg', 200,
          repeat('b', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('source-other', 'floor-other', 'original', 'ready', 'source/other.dwg', 'application/dwg', 300,
          repeat('c', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('source-race', 'floor-race', 'original', 'ready', 'source/race.dwg', 'application/dwg', 400,
          repeat('f', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "FloorImportJob" (
        "id", "floorId", "sourceAssetId", "sourceFormat", "updatedAt"
      ) VALUES
        ('job-region', 'floor-region', 'source-region', 'dwg', CURRENT_TIMESTAMP),
        ('job-scene', 'floor-scene', 'source-scene', 'dwg', CURRENT_TIMESTAMP),
        ('job-other', 'floor-other', 'source-other', 'dwg', CURRENT_TIMESTAMP),
        ('job-race', 'floor-race', 'source-race', 'dwg', CURRENT_TIMESTAMP);
    `);
    legacyBefore = legacyFingerprint();

    const migration = cluster.deploy(databaseUrl, migrationName);
    if (migration.status !== 0) throw new Error(migration.stderr);
  });

  afterAll(() => cluster?.stop());

  it("preserves existing rows while extending the enums", () => {
    expect(legacyFingerprint()).toBe(legacyBefore);
    expect(cluster.sql(databaseUrl, `
      SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
      FROM pg_enum
      WHERE enumtypid = '"FloorAssetKind"'::regtype;
    `)).toBe("original,rendered,cad_manifest,cad_tile,cad_region_preview");
    expect(cluster.sql(databaseUrl, `
      SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
      FROM pg_enum
      WHERE enumtypid = '"FloorPlanSourceType"'::regtype;
    `)).toBe("none,image,pdf,cad");
    expect(cluster.sql(databaseUrl, `
      SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
      FROM pg_enum
      WHERE enumtypid = '"FloorImportJobStatus"'::regtype;
    `)).toBe("queued,processing,region_selection_required,review_required,applying,completed,failed,cancelled");
    expect(cluster.sql(databaseUrl, `
      SELECT column_default || ':' || is_nullable
      FROM information_schema.columns
      WHERE table_name = 'FloorCadTile' AND column_name = 'part';
    `)).toBe("0:NO");
    expect(cluster.sql(databaseUrl, `
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'FloorCadTile_sceneId_tileX_tileY_lod_part_key';
    `)).toContain('("sceneId", "tileX", "tileY", lod, part)');
  });

  it("allows only a lease-free active region-selection lifecycle", () => {
    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportJob" SET
        "status" = 'region_selection_required', "stage" = 'region_selection_required',
        "progressPercent" = 60, "attemptCount" = 1,
        "startedAt" = CURRENT_TIMESTAMP, "reviewRequiredAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'job-other';
    `)).not.toThrow();

    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportJob" SET "progressPercent" = 0, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'job-other';
    `)).toThrow(/FloorImportJob_lifecycle_check/);

    cluster.sql(databaseUrl, `
      INSERT INTO "FloorAsset" (
        "id", "floorId", "kind", "status", "objectKey", "mimeType", "sizeBytes", "sha256", "readyAt", "updatedAt"
      ) VALUES (
        'source-other-second', 'floor-other', 'original', 'ready', 'source/other-second.dwg',
        'application/dwg', 301, repeat('e', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);
    expect(() => cluster.sql(databaseUrl, `
      INSERT INTO "FloorImportJob" (
        "id", "floorId", "sourceAssetId", "sourceFormat", "updatedAt"
      ) VALUES ('job-other-second', 'floor-other', 'source-other-second', 'dwg', CURRENT_TIMESTAMP);
    `)).toThrow(/FloorImportJob_floorId_active_key/);
  });

  it("persists one selected stable region per job and keeps preview assets on job cascade", () => {
    insertCadAsset("preview-region-1", "floor-region", "cad_region_preview");
    insertCadAsset("preview-region-2", "floor-region", "cad_region_preview");
    cluster.sql(databaseUrl, regionInsertSql("region-row-1", "job-region", "region-stable-1", "preview-region-1", true));
    cluster.sql(databaseUrl, regionInsertSql("region-row-2", "job-region", "region-stable-2", "preview-region-2", false));

    expect(() => cluster.sql(
      databaseUrl,
      regionInsertSql("region-row-duplicate", "job-region", "region-stable-1", null, false)
    )).toThrow(/FloorImportRegion_jobId_regionId_key/);
    expect(() => cluster.sql(
      databaseUrl,
      regionInsertSql("region-row-selected", "job-region", "region-stable-3", null, true)
    )).toThrow(/FloorImportRegion_jobId_selected_key/);
    expect(() => cluster.sql(
      databaseUrl,
      regionInsertSql("region-row-long-id", "job-region", "r".repeat(513), null, false)
    )).toThrow(/FloorImportRegion_regionId_check/);
    expect(() => cluster.sql(
      databaseUrl,
      regionInsertSql("region-row-empty", "job-region", "region-empty", null, false, { primitiveCount: 0 })
    )).toThrow(/FloorImportRegion_primitiveCount_check/);
    expect(() => cluster.sql(
      databaseUrl,
      regionInsertSql("region-row-too-large", "job-region", "region-too-large", null, false, {
        primitiveCount: 500_001
      })
    )).toThrow(/FloorImportRegion_primitiveCount_check/);
    expect(() => cluster.sql(databaseUrl, `DELETE FROM "FloorAsset" WHERE "id" = 'preview-region-1';`))
      .toThrow(/FloorImportRegion_previewAssetId_fkey/);

    cluster.sql(databaseUrl, `DELETE FROM "FloorImportJob" WHERE "id" = 'job-region';`);
    expect(cluster.sql(databaseUrl, `
      SELECT
        (SELECT count(*) FROM "FloorImportRegion" WHERE "jobId" = 'job-region') || ':' ||
        (SELECT count(*) FROM "FloorAsset" WHERE "id" IN ('preview-region-1', 'preview-region-2'));
    `)).toBe("0:2");
  });

  it("rejects cross-floor CAD assets and preserves referenced assets until the scene owner cascades", () => {
    insertCadAsset("preview-scene", "floor-scene", "cad_region_preview");
    insertCadAsset("manifest-scene", "floor-scene", "cad_manifest");
    insertCadAsset("tile-scene", "floor-scene", "cad_tile");
    insertCadAsset("manifest-other", "floor-other", "cad_manifest");
    cluster.sql(databaseUrl, regionInsertSql("region-scene", "job-scene", "region-scene-stable", "preview-scene", true));
    cluster.sql(databaseUrl, regionInsertSql("region-other", "job-other", "region-other-stable", null, true));

    expect(() => cluster.sql(databaseUrl, sceneInsertSql("scene-zero-scale-y", "manifest-scene", { transformScaleY: 0 })))
      .toThrow(/FloorCadScene_geometry_check/);
    expect(() => cluster.sql(databaseUrl, sceneInsertSql("scene-invalid", "manifest-other")))
      .toThrow(/floor CAD scene scope invariant violated/);
    expect(() => cluster.sql(databaseUrl, sceneInsertSql("scene-source-bounds", "manifest-scene", { sourceMinX: 11 })))
      .toThrow(/floor CAD scene scope invariant violated/);

    for (const options of [
      { version: 2 },
      { width: 511 },
      { height: 32_769 },
      { tileSize: 256 },
      { primitiveCount: 500_001 },
      { tileCount: 12_289 }
    ]) {
      expect(() => cluster.sql(databaseUrl, sceneInsertSql("scene-invalid-limits", "manifest-scene", options)))
        .toThrow(/FloorCadScene_dimensions_check/);
    }

    cluster.sql(databaseUrl, sceneInsertSql("scene-current", "manifest-scene"));
    for (const options of [
      { tileX: 64 },
      { tileY: 64 },
      { lod: 3 },
      { primitiveCount: 500_001 },
      { byteSize: 0 },
      { byteSize: 16 * 1_024 * 1_024 + 1 }
    ]) {
      expect(() => cluster.sql(databaseUrl, tileInsertSql("tile-invalid-limit", options)))
        .toThrow(/FloorCadTile_coordinate_check|FloorCadTile_size_check/);
    }
    expect(() => cluster.sql(databaseUrl, tileInsertSql("tile-invalid-cell", { tileX: 1 })))
      .toThrow(/floor CAD scene scope invariant violated/);

    cluster.sql(databaseUrl, tileInsertSql("tile-row"));
    cluster.sql(databaseUrl, `
      INSERT INTO "FloorCadElementOverride" ("sceneId", "elementId", "hidden", "updatedAt")
      VALUES ('scene-current', 'element-1', true, CURRENT_TIMESTAMP);
      INSERT INTO "FloorCadLayerState" ("sceneId", "layerName", "visible", "locked", "updatedAt")
      VALUES ('scene-current', 'lighting', true, false, CURRENT_TIMESTAMP);
    `);
    expect(() => cluster.sql(databaseUrl, `
      INSERT INTO "FloorCadElementOverride" ("sceneId", "elementId", "text", "updatedAt")
      VALUES ('scene-current', 'element-long-text', '${"x".repeat(65_537)}', CURRENT_TIMESTAMP);
    `)).toThrow(/FloorCadElementOverride_style_check/);

    expect(() => cluster.sql(databaseUrl, sceneInsertSql("scene-duplicate-floor", "manifest-other")))
      .toThrow(/FloorCadScene_floorId_key/);
    expect(() => cluster.sql(databaseUrl, tileInsertSql("tile-row-duplicate")))
      .toThrow(/FloorCadTile_sceneId_tileX_tileY_lod_(?:part_)?key|FloorCadTile_assetId_key/);
    expect(() => cluster.sql(databaseUrl, `DELETE FROM "FloorAsset" WHERE "id" = 'manifest-scene';`))
      .toThrow(/FloorCadScene_manifestAssetId_fkey/);
    expect(() => cluster.sql(databaseUrl, `DELETE FROM "FloorAsset" WHERE "id" = 'tile-scene';`))
      .toThrow(/FloorCadTile_assetId_fkey/);

    expect(() => cluster.sql(databaseUrl, `
      BEGIN;
      UPDATE "FloorCadScene" SET
        "floorId" = 'floor-other',
        "sourceImportJobId" = 'job-other',
        "sourceRegionId" = 'region-other',
        "manifestAssetId" = 'manifest-other',
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'scene-current';
      SET CONSTRAINTS ALL IMMEDIATE;
      ROLLBACK;
    `)).toThrow(/floor CAD scene scope invariant violated/);

    cluster.sql(databaseUrl, `DELETE FROM "FloorImportJob" WHERE "id" = 'job-scene';`);
    expect(cluster.sql(databaseUrl, `
      SELECT
        (SELECT count(*) FROM "FloorCadScene" WHERE "id" = 'scene-current') || ':' ||
        (SELECT count(*) FROM "FloorCadTile" WHERE "sceneId" = 'scene-current') || ':' ||
        (SELECT count(*) FROM "FloorCadElementOverride" WHERE "sceneId" = 'scene-current') || ':' ||
        (SELECT count(*) FROM "FloorCadLayerState" WHERE "sceneId" = 'scene-current') || ':' ||
        (SELECT count(*) FROM "FloorAsset" WHERE "id" IN ('manifest-scene', 'tile-scene'));
    `)).toBe("0:0:0:0:2");
  });

  it("serializes scene validation with concurrent manifest asset updates", async () => {
    const writer = startPsql(databaseUrl, "cad_scene_writer", `
      BEGIN;
      ${sceneInsertSql("scene-concurrent", "manifest-other", {
        floorId: "floor-other",
        sourceImportJobId: "job-other",
        sourceRegionId: "region-other"
      })}
      SELECT pg_sleep(2);
      COMMIT;
    `);
    await waitForSleep(cluster, databaseUrl, "cad_scene_writer");

    const assetUpdater = startPsql(databaseUrl, "cad_manifest_updater", `
      SET statement_timeout = '10s';
      UPDATE "FloorAsset" SET "status" = 'pending', "readyAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'manifest-other';
    `);
    await waitForBlockedWriter(cluster, databaseUrl, "cad_manifest_updater");

    const writerResult = await writer.completed;
    const updaterResult = await assetUpdater.completed;
    expect(writerResult).toMatchObject({ status: 0 });
    expect(updaterResult.status).not.toBe(0);
    expect(updaterResult.stderr).toMatch(/floor CAD scene scope invariant violated/);
    expect(cluster.sql(databaseUrl, `
      SELECT asset."status" || ':' || count(scene."id")
      FROM "FloorAsset" AS asset
      LEFT JOIN "FloorCadScene" AS scene ON scene."manifestAssetId" = asset."id"
      WHERE asset."id" = 'manifest-other'
      GROUP BY asset."status";
    `)).toBe("ready:1");
  });

  it("serializes scene insertion with referenced region and job ownership changes", async () => {
    insertCadAsset("manifest-race", "floor-race", "cad_manifest");
    cluster.sql(databaseUrl, regionInsertSql("region-race", "job-race", "region-race-stable", null, true));

    const sceneWriter = startPsql(databaseUrl, "cad_scene_race_writer", `
      BEGIN;
      ${sceneInsertSql("scene-race", "manifest-race", {
        floorId: "floor-race",
        sourceImportJobId: "job-race",
        sourceRegionId: "region-race"
      })}
      SELECT pg_sleep(2);
      COMMIT;
    `);
    await waitForSleep(cluster, databaseUrl, "cad_scene_race_writer");

    const regionDeselection = startPsql(databaseUrl, "cad_scene_race_region", `
      SET statement_timeout = '10s';
      UPDATE "FloorImportRegion" SET "selectedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'region-race';
    `);
    const jobOwnershipChange = startPsql(databaseUrl, "cad_scene_race_job", `
      SET statement_timeout = '10s';
      BEGIN;
      UPDATE "FloorAsset" SET "floorId" = 'floor-legacy', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'source-race';
      UPDATE "FloorImportJob" SET "floorId" = 'floor-legacy', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'job-race';
      COMMIT;
    `);
    await waitForBlockedWriter(cluster, databaseUrl, "cad_scene_race_region");
    await waitForBlockedWriter(cluster, databaseUrl, "cad_scene_race_job");

    const [writerResult, regionResult, jobResult] = await Promise.all([
      sceneWriter.completed,
      regionDeselection.completed,
      jobOwnershipChange.completed
    ]);
    expect(writerResult).toMatchObject({ status: 0 });
    for (const result of [regionResult, jobResult]) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/floor CAD scene scope invariant violated/);
    }
    expect(cluster.sql(databaseUrl, `
      SELECT
        (SELECT "selectedAt" IS NOT NULL FROM "FloorImportRegion" WHERE "id" = 'region-race') || ':' ||
        (SELECT "floorId" FROM "FloorImportJob" WHERE "id" = 'job-race') || ':' ||
        (SELECT count(*) FROM "FloorCadScene" WHERE "id" = 'scene-race');
    `)).toBe("true:floor-race:1");
  });

  function legacyFingerprint() {
    return cluster.sql(databaseUrl, `
      SELECT json_build_object(
        'floors', (SELECT count(*) FROM "Floor"),
        'assets', (SELECT count(*) FROM "FloorAsset"),
        'jobs', (SELECT count(*) FROM "FloorImportJob"),
        'sourceBytes', (SELECT sum("sizeBytes")::text FROM "FloorAsset")
      )::text;
    `);
  }

  function insertCadAsset(id: string, floorId: string, kind: string) {
    cluster.sql(databaseUrl, `
      INSERT INTO "FloorAsset" (
        "id", "floorId", "kind", "status", "objectKey", "mimeType", "sizeBytes", "sha256", "readyAt", "updatedAt"
      ) VALUES (
        '${id}', '${floorId}', '${kind}', 'ready', 'cad/${id}', 'application/octet-stream', 2048,
        repeat('d', 64), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);
  }
});

function enumBlock(name: string) {
  return schema.match(new RegExp(`enum ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}

function modelBlock(name: string) {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}

function regionInsertSql(
  id: string,
  jobId: string,
  regionId: string,
  previewAssetId: string | null,
  selected: boolean,
  options: { primitiveCount?: number } = {}
) {
  return `
    INSERT INTO "FloorImportRegion" (
      "id", "jobId", "regionId", "minX", "minY", "maxX", "maxY", "primitiveCount",
      "previewAssetId", "selectedAt", "updatedAt"
    ) VALUES (
      '${id}', '${jobId}', '${regionId}', 10, 20, 1010, 820, ${options.primitiveCount ?? 500},
      ${previewAssetId ? `'${previewAssetId}'` : "NULL"},
      ${selected ? "CURRENT_TIMESTAMP" : "NULL"}, CURRENT_TIMESTAMP
    );
  `;
}

type SceneInsertOptions = {
  floorId?: string;
  sourceImportJobId?: string;
  sourceRegionId?: string;
  version?: number;
  width?: number;
  height?: number;
  tileSize?: number;
  primitiveCount?: number;
  tileCount?: number;
  sourceMinX?: number;
  transformScaleY?: number;
};

function sceneInsertSql(id: string, manifestAssetId: string, options: SceneInsertOptions = {}) {
  return `
    INSERT INTO "FloorCadScene" (
      "id", "floorId", "sourceImportJobId", "sourceRegionId", "version", "status",
      "width", "height", "tileSize", "primitiveCount", "tileCount", "manifestAssetId",
      "sourceMinX", "sourceMinY", "sourceMaxX", "sourceMaxY",
      "transformScaleX", "transformScaleY", "transformTranslateX", "transformTranslateY", "updatedAt"
    ) VALUES (
      '${id}', '${options.floorId ?? "floor-scene"}', '${options.sourceImportJobId ?? "job-scene"}',
      '${options.sourceRegionId ?? "region-scene"}', ${options.version ?? 1}, 'active',
      ${options.width ?? 8192}, ${options.height ?? 6554}, ${options.tileSize ?? 512},
      ${options.primitiveCount ?? 500}, ${options.tileCount ?? 1}, '${manifestAssetId}',
      ${options.sourceMinX ?? 10}, 20, 1010, 820, 8.192, ${options.transformScaleY ?? -8.192},
      -81.92, -163.84, CURRENT_TIMESTAMP
    );
  `;
}

function tileInsertSql(
  id: string,
  options: {
    tileX?: number;
    tileY?: number;
    lod?: number;
    primitiveCount?: number;
    byteSize?: number;
  } = {}
) {
  return `
    INSERT INTO "FloorCadTile" (
      "id", "sceneId", "tileX", "tileY", "lod", "assetId", "primitiveCount", "byteSize",
      "minX", "minY", "maxX", "maxY", "updatedAt"
    ) VALUES (
      '${id}', 'scene-current', ${options.tileX ?? 0}, ${options.tileY ?? 0}, ${options.lod ?? 0},
      'tile-scene', ${options.primitiveCount ?? 12}, ${options.byteSize ?? 2048},
      0, 0, 512, 512, CURRENT_TIMESTAMP
    );
  `;
}

function startPsql(databaseUrl: string, applicationName: string, sql: string) {
  const child = spawn("psql", [
    "-X", "-qAt", "-v", "ON_ERROR_STOP=1", withApplicationName(databaseUrl, applicationName), "-c", sql
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  return {
    completed: new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", status => resolve({ status, stdout, stderr }));
    })
  };
}

async function waitForSleep(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  applicationName: string
) {
  await waitForDatabaseState(() => cluster.sql(databaseUrl, `
    SELECT count(*) FROM pg_stat_activity
    WHERE application_name = '${applicationName}' AND wait_event = 'PgSleep';
  `) === "1", `${applicationName} did not reach its transaction barrier`);
}

async function waitForBlockedWriter(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  applicationName: string
) {
  await waitForDatabaseState(() => cluster.sql(databaseUrl, `
    SELECT count(*) FROM pg_stat_activity
    WHERE application_name = '${applicationName}' AND wait_event_type = 'Lock';
  `) === "1", `${applicationName} was not blocked on the referenced asset row`);
}

async function waitForDatabaseState(predicate: () => boolean, errorMessage: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(errorMessage);
}

function withApplicationName(databaseUrl: string, applicationName: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}
