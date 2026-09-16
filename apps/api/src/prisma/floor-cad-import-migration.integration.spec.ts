import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { disposablePostgres } from "../../test/support/disposable-postgres";

const baselineMigrationName = "20260916190000_floor_cad_import";
const forwardMigrationName = "20260916223000_floor_cad_import_invariants";
const expectedBaselineChecksum = "a9b86b2a0206c348c3dfe6ae087e13e861819038cb343c634ed43d03a294598a";
const baselineMigration = readFileSync(join(
  __dirname,
  `../../prisma/migrations/${baselineMigrationName}/migration.sql`
), "utf8");
const forwardMigrationPath = join(
  __dirname,
  `../../prisma/migrations/${forwardMigrationName}/migration.sql`
);
const forwardMigration = existsSync(forwardMigrationPath)
  ? readFileSync(forwardMigrationPath, "utf8")
  : "";

jest.setTimeout(60_000);

describe("floor CAD import migration invariants on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let databaseUrl: string;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    databaseUrl = cluster.database();
    cluster.sql(databaseUrl, `
      CREATE TYPE "FloorAssetKind" AS ENUM ('original', 'rendered');
      CREATE TYPE "FloorAssetStatus" AS ENUM ('pending', 'ready');
      CREATE TABLE "Floor" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "FloorAsset" (
        "id" TEXT PRIMARY KEY,
        "floorId" TEXT NOT NULL REFERENCES "Floor"("id") ON DELETE CASCADE,
        "kind" "FloorAssetKind" NOT NULL,
        "status" "FloorAssetStatus" NOT NULL DEFAULT 'pending',
        "mimeType" TEXT NOT NULL
      );
      ${baselineMigration}
      ${forwardMigration}
      INSERT INTO "Floor" ("id") VALUES ('floor-a'), ('floor-b');
      INSERT INTO "FloorAsset" ("id", "floorId", "kind", "status", "mimeType") VALUES
        ('source-dwg-a', 'floor-a', 'original', 'ready', 'application/dwg'),
        ('source-dxf-a', 'floor-a', 'original', 'ready', 'application/dxf'),
        ('source-dwg-b', 'floor-b', 'original', 'ready', 'application/dwg'),
        ('source-rendered-a', 'floor-a', 'rendered', 'ready', 'application/dwg'),
        ('source-pending-a', 'floor-a', 'original', 'pending', 'application/dwg'),
        ('source-mismatch-a', 'floor-a', 'original', 'ready', 'application/dxf'),
        ('render-svg-a', 'floor-a', 'rendered', 'ready', 'image/svg+xml'),
        ('render-svg-b', 'floor-b', 'rendered', 'ready', 'image/svg+xml'),
        ('render-original-a', 'floor-a', 'original', 'ready', 'image/svg+xml'),
        ('render-dwg-a', 'floor-a', 'rendered', 'ready', 'application/dwg'),
        ('render-pending-a', 'floor-a', 'rendered', 'pending', 'image/svg+xml');
    `);
  });

  beforeEach(() => {
    cluster.sql(databaseUrl, `TRUNCATE "FloorImportCandidate", "FloorImportJob";`);
  });

  afterAll(() => cluster?.stop());

  it("keeps the published CAD import baseline byte-for-byte stable", () => {
    expect(createHash("sha256").update(baselineMigration).digest("hex"))
      .toBe(expectedBaselineChecksum);
  });

  it("staged-upgrades a baseline database without checksum drift", () => {
    const stagedDatabaseUrl = cluster.database();
    const baseline = cluster.deploy(stagedDatabaseUrl, baselineMigrationName);
    expect(baseline.status).toBe(0);
    expect(baseline.stderr).not.toContain("Error");

    const checksumBeforeUpgrade = cluster.sql(stagedDatabaseUrl, `
      SELECT checksum FROM "_prisma_migrations"
      WHERE migration_name = '${baselineMigrationName}';
    `);
    expect(checksumBeforeUpgrade).toBe(expectedBaselineChecksum);

    seedBaselineLedger(stagedDatabaseUrl, cluster);
    const upgrade = cluster.deploy(stagedDatabaseUrl, forwardMigrationName);
    expect(upgrade.status).toBe(0);
    expect(upgrade.stderr).not.toContain("Error");
    expect(cluster.sql(stagedDatabaseUrl, `
      SELECT checksum FROM "_prisma_migrations"
      WHERE migration_name = '${baselineMigrationName}';
    `)).toBe(checksumBeforeUpgrade);
    expect(cluster.sql(stagedDatabaseUrl, `
      SELECT string_agg(migration_name, ',' ORDER BY migration_name)
      FROM "_prisma_migrations"
      WHERE migration_name IN ('${baselineMigrationName}', '${forwardMigrationName}');
    `)).toBe(`${baselineMigrationName},${forwardMigrationName}`);
    expect(cluster.sql(stagedDatabaseUrl, `
      SELECT "provider" IS NULL AND "model" IS NULL AND "inputDigest" IS NULL
      FROM "FloorImportCandidate" WHERE "id" = 'baseline-candidate';
    `)).toBe("t");
  });

  it("clean-replays the complete migration chain through the forward fix", () => {
    const cleanDatabaseUrl = cluster.database();
    const result = cluster.deploy(cleanDatabaseUrl, forwardMigrationName);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Error");
    expect(cluster.sql(cleanDatabaseUrl, `
      SELECT string_agg(migration_name, ',' ORDER BY migration_name)
      FROM "_prisma_migrations"
      WHERE migration_name IN ('${baselineMigrationName}', '${forwardMigrationName}');
    `)).toBe(`${baselineMigrationName},${forwardMigrationName}`);
  });

  it("catalogs every migration-only check, deferred asset trigger, and partial index", () => {
    const constraints = cluster.sql(databaseUrl, `
      SELECT string_agg(conname, ',' ORDER BY conname)
      FROM pg_constraint
      WHERE conrelid IN ('"FloorImportJob"'::regclass, '"FloorImportCandidate"'::regclass)
        AND contype = 'c';
    `);
    for (const name of [
      "FloorImportCandidate_ai_metadata_check",
      "FloorImportCandidate_confidence_check",
      "FloorImportCandidate_position_check",
      "FloorImportCandidate_review_check",
      "FloorImportCandidate_source_check",
      "FloorImportJob_asset_check",
      "FloorImportJob_attempt_check",
      "FloorImportJob_lease_check",
      "FloorImportJob_lifecycle_check",
      "FloorImportJob_progress_check",
      "FloorImportJob_stage_check"
    ]) expect(constraints).toContain(name);

    expect(cluster.sql(databaseUrl, `
      SELECT string_agg(tgname || ':' || tgdeferrable || ':' || tginitdeferred, ',' ORDER BY tgname)
      FROM pg_trigger
      WHERE NOT tgisinternal AND tgname IN ('FloorAsset_import_job_invariant', 'FloorImportJob_asset_invariant');
    `)).toBe("FloorAsset_import_job_invariant:true:true,FloorImportJob_asset_invariant:true:true");

    expect(cluster.sql(databaseUrl, `
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'FloorImportJob' AND indexname = 'FloorImportJob_floorId_active_key';
    `)).toBe("FloorImportJob_floorId_active_key");
  });

  it.each([
    ["a source asset from another floor", "source-dwg-b", "dwg", null],
    ["a rendered asset as source", "source-rendered-a", "dwg", null],
    ["a pending source asset", "source-pending-a", "dwg", null],
    ["a source MIME that disagrees with its format", "source-mismatch-a", "dwg", null],
    ["a rendered asset from another floor", "source-dwg-a", "dwg", "render-svg-b"],
    ["an original asset as render output", "source-dwg-a", "dwg", "render-original-a"],
    ["a DWG asset as render output", "source-dwg-a", "dwg", "render-dwg-a"],
    ["a pending render output", "source-dwg-a", "dwg", "render-pending-a"]
  ] as const)("rejects %s", (_label, sourceAssetId, sourceFormat, renderedAssetId) => {
    expect(() => cluster.sql(databaseUrl, jobInsert({
      id: "invalid-asset-job",
      sourceAssetId,
      sourceFormat,
      renderedAssetId,
      statusSql: renderedAssetId ? reviewStateSql : undefined
    }))).toThrow(/floor import job asset invariant violated/);
  });

  it("rejects changing a referenced asset so an existing job becomes invalid", () => {
    cluster.sql(databaseUrl, jobInsert({ id: "stable-job" }));
    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorAsset" SET "kind" = 'rendered' WHERE "id" = 'source-dwg-a';
    `)).toThrow(/floor import job asset invariant violated/);
  });

  it("allows a completed source asset to be analyzed by a new job", () => {
    cluster.sql(databaseUrl, jobInsert({
      id: "completed-job",
      renderedAssetId: "render-svg-a",
      statusSql: completedStateSql
    }));
    expect(() => cluster.sql(databaseUrl, jobInsert({ id: "reanalyze-job" }))).not.toThrow();
    expect(cluster.sql(databaseUrl, `SELECT count(*) FROM "FloorImportJob" WHERE "sourceAssetId" = 'source-dwg-a';`)).toBe("2");
  });

  it("accepts a ready DXF source with a supported rendered image", () => {
    expect(() => cluster.sql(databaseUrl, jobInsert({
      id: "valid-dxf-job",
      sourceAssetId: "source-dxf-a",
      sourceFormat: "dxf",
      renderedAssetId: "render-svg-a",
      statusSql: reviewStateSql
    }))).not.toThrow();
  });

  it("enforces the persisted lifecycle from queued through completed", () => {
    cluster.sql(databaseUrl, jobInsert({ id: "lifecycle-job" }));
    cluster.sql(databaseUrl, `
      UPDATE "FloorImportJob" SET
        "status" = 'processing', "stage" = 'parsing', "progressPercent" = 10, "attemptCount" = 1,
        "leaseOwner" = 'worker-1', "leaseExpiresAt" = CURRENT_TIMESTAMP + interval '1 minute',
        "startedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'lifecycle-job';
      UPDATE "FloorImportJob" SET
        "status" = 'review_required', "stage" = 'review', "progressPercent" = 100,
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "renderedAssetId" = 'render-svg-a',
        "reviewRequiredAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'lifecycle-job';
      UPDATE "FloorImportJob" SET "status" = 'applying', "stage" = 'applying', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'lifecycle-job';
      UPDATE "FloorImportJob" SET
        "status" = 'completed', "stage" = 'completed', "appliedAt" = CURRENT_TIMESTAMP,
        "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'lifecycle-job';
    `);
    expect(cluster.sql(databaseUrl, `
      SELECT "status"::text || ':' || "progressPercent" || ':' || ("leaseOwner" IS NULL)
      FROM "FloorImportJob" WHERE "id" = 'lifecycle-job';
    `)).toBe("completed:100:true");
  });

  it.each([
    ["completed", `"status" = 'completed', "progressPercent" = 0, "leaseOwner" = 'worker', "leaseExpiresAt" = CURRENT_TIMESTAMP + interval '1 minute'`],
    ["failed", `"status" = 'failed', "failureCode" = 'CAD_FAILED', "failureMessage" = 'failed'`],
    ["cancelled", `"status" = 'cancelled'`]
  ])("rejects an inconsistent %s terminal state", (_status, assignments) => {
    cluster.sql(databaseUrl, jobInsert({ id: "invalid-terminal" }));
    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportJob" SET ${assignments}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'invalid-terminal';
    `)).toThrow(/FloorImportJob_lifecycle_check/);
  });

  it("requires all AI reproducibility metadata and forbids it for rule-based candidates", () => {
    cluster.sql(databaseUrl, jobInsert({ id: "candidate-job" }));
    cluster.sql(databaseUrl, candidateInsert("rule", "rule_based", "NULL", "NULL", "NULL"));
    expect(() => cluster.sql(databaseUrl,
      candidateInsert("rule-with-ai", "rule_based", "'rules'", "'v1'", `'${"a".repeat(64)}'`)
    )).toThrow(/FloorImportCandidate_ai_metadata_check/);
    expect(() => cluster.sql(databaseUrl,
      candidateInsert("ai-missing", "ai_assisted", "NULL", "NULL", "NULL")
    )).toThrow(/FloorImportCandidate_ai_metadata_check/);
    cluster.sql(databaseUrl,
      candidateInsert("ai", "ai_assisted", "'openai'", "'cad-v1'", `'${"b".repeat(64)}'`)
    );
    expect(cluster.sql(databaseUrl, `SELECT count(*) FROM "FloorImportCandidate";`)).toBe("2");
  });
});

const completedStateSql = `
  'completed', 'completed', 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
`;
const reviewStateSql = `
  'review_required', 'review', 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL
`;

function jobInsert({
  id,
  sourceAssetId = "source-dwg-a",
  sourceFormat = "dwg",
  renderedAssetId = null,
  statusSql
}: {
  id: string;
  sourceAssetId?: string;
  sourceFormat?: "dwg" | "dxf";
  renderedAssetId?: string | null;
  statusSql?: string;
}) {
  const columns = statusSql
    ? `, "status", "stage", "progressPercent", "startedAt", "reviewRequiredAt", "appliedAt", "completedAt"`
    : "";
  const values = statusSql ? `, ${statusSql}` : "";
  return `
    INSERT INTO "FloorImportJob" (
      "id", "floorId", "sourceAssetId", "renderedAssetId", "sourceFormat", "updatedAt"${columns}
    ) VALUES (
      '${id}', 'floor-a', '${sourceAssetId}', ${renderedAssetId ? `'${renderedAssetId}'` : "NULL"},
      '${sourceFormat}', CURRENT_TIMESTAMP${values}
    );
  `;
}

function candidateInsert(
  id: string,
  detectionMethod: "rule_based" | "ai_assisted",
  provider: string,
  model: string,
  inputDigest: string
) {
  return `
    INSERT INTO "FloorImportCandidate" (
      "id", "jobId", "sourceEntityId", "layerName", "x", "y", "confidence", "detectionMethod",
      "provider", "model", "inputDigest", "updatedAt"
    ) VALUES (
      '${id}', 'candidate-job', '${id}-entity', 'LIGHT', 1, 2, 0.9, '${detectionMethod}',
      ${provider}, ${model}, ${inputDigest}, CURRENT_TIMESTAMP
    );
  `;
}

function seedBaselineLedger(
  databaseUrl: string,
  cluster: Awaited<ReturnType<typeof disposablePostgres>>
) {
  cluster.sql(databaseUrl, `
    INSERT INTO "Organization" ("id", "name", "type", "createdAt", "updatedAt")
    VALUES ('baseline-org', 'Baseline Org', 'customer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO "Site" ("id", "organizationId", "name", "createdAt", "updatedAt")
    VALUES ('baseline-site', 'baseline-org', 'Baseline Site', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO "Floor" ("id", "siteId", "name", "level", "createdAt", "updatedAt")
    VALUES ('baseline-floor', 'baseline-site', 'Baseline Floor', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO "FloorAsset" (
      "id", "floorId", "kind", "status", "objectKey", "mimeType", "sizeBytes", "sha256", "readyAt", "updatedAt"
    ) VALUES (
      'baseline-source', 'baseline-floor', 'original', 'ready', 'baseline/source.dwg',
      'application/dwg', 1, '${"c".repeat(64)}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "FloorImportJob" ("id", "floorId", "sourceAssetId", "sourceFormat", "updatedAt")
    VALUES ('baseline-job', 'baseline-floor', 'baseline-source', 'dwg', CURRENT_TIMESTAMP);
    INSERT INTO "FloorImportCandidate" (
      "id", "jobId", "sourceEntityId", "layerName", "x", "y", "confidence", "detectionMethod", "updatedAt"
    ) VALUES (
      'baseline-candidate', 'baseline-job', 'entity-1', 'LIGHT', 1, 2, 0.9, 'rule_based', CURRENT_TIMESTAMP
    );
  `);
}
