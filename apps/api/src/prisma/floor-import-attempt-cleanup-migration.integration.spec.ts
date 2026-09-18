import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { disposablePostgres } from "../../test/support/disposable-postgres";

const priorMigrationName = "20260917130000_floor_import_attempt_cleanup";
const terminalMigrationName = "20260917140000_floor_import_attempt_cleanup_terminal";

jest.setTimeout(120_000);

describe("floor import attempt cleanup terminal migration", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;

  beforeAll(async () => { cluster = await disposablePostgres(); });
  afterAll(() => cluster?.stop());

  it("staged-upgrades the prior tombstone schema without changing existing rows or its checksum", () => {
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl, priorMigrationName).status).toBe(0);
    seedAttemptRows(cluster, databaseUrl);
    const priorChecksum = migrationChecksum(cluster, databaseUrl, priorMigrationName);

    const upgrade = cluster.deploy(databaseUrl, terminalMigrationName);

    expect(upgrade.status).toBe(0);
    expect(upgrade.stderr).not.toContain("Error");
    expect(migrationChecksum(cluster, databaseUrl, priorMigrationName)).toBe(priorChecksum);
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) || ':' || count(*) FILTER (WHERE "cleanedAt" IS NULL) || ':' ||
        count(*) FILTER (WHERE "lastCleanedAt" IS NOT NULL) || ':' ||
        count(*) FILTER (WHERE "committedAt" IS NOT NULL)
      FROM "FloorImportAttemptCleanup";
    `)).toBe("3:3:1:1");

    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportAttemptCleanup"
      SET "lastCleanedAt" = TIMESTAMP '2026-09-17 00:05:00',
        "nextAttemptAt" = TIMESTAMP '2026-09-17 00:20:00',
        "updatedAt" = TIMESTAMP '2026-09-17 00:05:00'
      WHERE "jobId" = 'job-active' AND "attemptCount" = 1;
    `)).not.toThrow();
    expect(cluster.sql(databaseUrl, `
      SELECT ("cleanedAt" IS NULL)::text || ':' || "nextAttemptAt"::text
      FROM "FloorImportAttemptCleanup"
      WHERE "jobId" = 'job-active' AND "attemptCount" = 1;
    `)).toBe("true:2026-09-17 00:20:00");
  });

  it("clean-replays the migration chain through the terminal migration", () => {
    const databaseUrl = cluster.database();

    const replay = cluster.deploy(databaseUrl, terminalMigrationName);

    expect(replay.status).toBe(0);
    expect(replay.stderr).not.toContain("Error");
    expect(cluster.sql(databaseUrl, `
      SELECT string_agg(migration_name, ',' ORDER BY migration_name)
      FROM "_prisma_migrations"
      WHERE migration_name IN ('${priorMigrationName}', '${terminalMigrationName}')
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
    `)).toBe(`${priorMigrationName},${terminalMigrationName}`);
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'FloorImportAttemptCleanup'
        AND column_name = 'cleanedAt';
    `)).toBe("1");
  });

  it("rejects invalid terminal combinations and accepts a released cleaned tombstone", () => {
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl, terminalMigrationName).status).toBe(0);
    seedAttemptRows(cluster, databaseUrl);

    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportAttemptCleanup"
      SET "cleanedAt" = TIMESTAMP '2026-09-17 00:30:00'
      WHERE "jobId" = 'job-active' AND "attemptCount" = 1;
    `)).toThrow(/FloorImportAttemptCleanup_terminal_check/);
    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportAttemptCleanup"
      SET "cleanedAt" = TIMESTAMP '2026-09-17 00:30:00',
        "leaseOwner" = 'cleaner', "leaseExpiresAt" = TIMESTAMP '2026-09-17 00:31:00'
      WHERE "jobId" = 'job-cleaned-once' AND "attemptCount" = 2;
    `)).toThrow(/FloorImportAttemptCleanup_terminal_check/);
    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportAttemptCleanup"
      SET "lastCleanedAt" = TIMESTAMP '2026-09-17 00:29:00',
        "cleanedAt" = TIMESTAMP '2026-09-17 00:30:00'
      WHERE "jobId" = 'job-committed' AND "attemptCount" = 3;
    `)).toThrow(/FloorImportAttemptCleanup_terminal_check/);

    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportAttemptCleanup"
      SET "lastCleanedAt" = TIMESTAMP '2026-09-17 00:29:00',
        "cleanedAt" = TIMESTAMP '2026-09-17 00:30:00',
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL
      WHERE "jobId" = 'job-active' AND "attemptCount" = 1;
    `)).not.toThrow();
    expect(cluster.sql(databaseUrl, `
      SELECT ("cleanedAt" IS NOT NULL AND "lastCleanedAt" IS NOT NULL
        AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)::text
      FROM "FloorImportAttemptCleanup"
      WHERE "jobId" = 'job-active' AND "attemptCount" = 1;
    `)).toBe("true");
  });

  it("catalogs terminal CHECK, identity indexes, UTC defaults, and nullable lifecycle columns", () => {
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl, terminalMigrationName).status).toBe(0);

    const constraints = cluster.sql(databaseUrl, `
      SELECT string_agg(conname, ',' ORDER BY conname)
      FROM pg_constraint
      WHERE conrelid = '"FloorImportAttemptCleanup"'::regclass;
    `);
    for (const name of [
      "FloorImportAttemptCleanup_attempt_check",
      "FloorImportAttemptCleanup_key_check",
      "FloorImportAttemptCleanup_lease_pair",
      "FloorImportAttemptCleanup_pkey",
      "FloorImportAttemptCleanup_terminal_check"
    ]) expect(constraints).toContain(name);

    const terminalDefinition = cluster.sql(databaseUrl, `
      SELECT pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = '"FloorImportAttemptCleanup"'::regclass
        AND conname = 'FloorImportAttemptCleanup_terminal_check';
    `);
    expect(terminalDefinition).toContain('NOT (("committedAt" IS NOT NULL) AND ("cleanedAt" IS NOT NULL))');
    expect(terminalDefinition).toContain('"lastCleanedAt" IS NOT NULL');
    expect(terminalDefinition).toContain('"leaseOwner" IS NULL');
    expect(terminalDefinition).toContain('"leaseExpiresAt" IS NULL');

    const indexes = cluster.sql(databaseUrl, `
      SELECT string_agg(indexname, ',' ORDER BY indexname)
      FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'FloorImportAttemptCleanup';
    `);
    for (const name of [
      "FloorImportAttemptCleanup_assetId_key",
      "FloorImportAttemptCleanup_nextAttemptAt_leaseExpiresAt_idx",
      "FloorImportAttemptCleanup_objectKey_key",
      "FloorImportAttemptCleanup_pkey"
    ]) expect(indexes).toContain(name);
    expect(cluster.sql(databaseUrl, `
      SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = '"FloorImportAttemptCleanup"'::regclass AND contype = 'p';
    `)).toContain('PRIMARY KEY ("jobId", "attemptCount")');

    const columns = cluster.sql(databaseUrl, `
      SELECT string_agg(column_name || ':' || is_nullable || ':' || COALESCE(column_default, ''), E'\\n' ORDER BY column_name)
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'FloorImportAttemptCleanup'
        AND column_name IN (
          'cleanedAt', 'committedAt', 'lastCleanedAt', 'leaseOwner', 'leaseExpiresAt',
          'nextAttemptAt', 'createdAt'
        );
    `);
    for (const nullable of ["cleanedAt", "committedAt", "lastCleanedAt", "leaseExpiresAt", "leaseOwner"]) {
      expect(columns).toContain(`${nullable}:YES:`);
    }
    expect(columns).toMatch(/createdAt:NO:.*CURRENT_TIMESTAMP.*AT TIME ZONE.*UTC/);
    expect(columns).toMatch(/nextAttemptAt:NO:.*CURRENT_TIMESTAMP.*AT TIME ZONE.*UTC/);
  });

  it("rolls back atomically on lock timeout and succeeds after the failed migration is resolved and retried", async () => {
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl, priorMigrationName).status).toBe(0);
    seedAttemptRows(cluster, databaseUrl);
    const writer = startPsql(databaseUrl, "floor_import_cleanup_terminal_writer", `
      BEGIN;
      UPDATE "FloorImportAttemptCleanup" SET "updatedAt" = CURRENT_TIMESTAMP
      WHERE "jobId" = 'job-active' AND "attemptCount" = 1;
      SELECT pg_sleep(20);
      ROLLBACK;
    `);
    await waitForTableLock(cluster, databaseUrl, "floor_import_cleanup_terminal_writer");

    const startedAt = Date.now();
    const blocked = cluster.deploy(databaseUrl, terminalMigrationName);
    const elapsedMs = Date.now() - startedAt;
    cluster.sql(databaseUrl, `
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE application_name = 'floor_import_cleanup_terminal_writer' AND pid <> pg_backend_pid();
    `);
    await writer.completed;

    expect(blocked.status).not.toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(8_000);
    expect(elapsedMs).toBeLessThan(20_000);
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'FloorImportAttemptCleanup'
        AND column_name = 'cleanedAt';
    `)).toBe("0");
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM pg_constraint
      WHERE conrelid = '"FloorImportAttemptCleanup"'::regclass
        AND conname = 'FloorImportAttemptCleanup_terminal_check';
    `)).toBe("0");
    expect(cluster.sql(databaseUrl, `SELECT count(*) FROM "FloorImportAttemptCleanup";`)).toBe("3");

    const resolved = resolveRolledBack(databaseUrl);
    expect(resolved.status).toBe(0);
    const retry = cluster.deploy(databaseUrl, terminalMigrationName);
    expect(retry.status).toBe(0);
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'FloorImportAttemptCleanup'
        AND column_name = 'cleanedAt';
    `)).toBe("1");
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM pg_constraint
      WHERE conrelid = '"FloorImportAttemptCleanup"'::regclass
        AND conname = 'FloorImportAttemptCleanup_terminal_check';
    `)).toBe("1");
    expect(cluster.sql(databaseUrl, `SELECT count(*) FROM "FloorImportAttemptCleanup";`)).toBe("3");
  });
});

function seedAttemptRows(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string
) {
  cluster.sql(databaseUrl, `
    INSERT INTO "FloorImportAttemptCleanup" (
      "jobId", "floorId", "attemptCount", "assetId", "objectKey", "nextAttemptAt",
      "lastCleanedAt", "committedAt", "updatedAt"
    ) VALUES
      (
        'job-active', 'floor-active', 1, 'asset-active',
        'floors/floor-active/job-active-attempt-1.svg', TIMESTAMP '2026-09-17 00:00:00',
        NULL, NULL, TIMESTAMP '2026-09-17 00:00:00'
      ),
      (
        'job-cleaned-once', 'floor-cleaned', 2, 'asset-cleaned',
        'floors/floor-cleaned/job-cleaned-once-attempt-2.svg', TIMESTAMP '2026-09-17 00:15:00',
        TIMESTAMP '2026-09-17 00:00:00', NULL, TIMESTAMP '2026-09-17 00:00:00'
      ),
      (
        'job-committed', 'floor-committed', 3, 'asset-committed',
        'floors/floor-committed/job-committed-attempt-3.svg', TIMESTAMP '2026-09-17 00:15:00',
        NULL, TIMESTAMP '2026-09-17 00:01:00', TIMESTAMP '2026-09-17 00:01:00'
      );
  `);
}

function migrationChecksum(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  migrationName: string
) {
  return cluster.sql(databaseUrl, `
    SELECT checksum FROM "_prisma_migrations" WHERE migration_name = '${migrationName}';
  `);
}

function startPsql(databaseUrl: string, applicationName: string, sql: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  const child = spawn("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", url.toString(), "-c", sql], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = ""; let stderr = "";
  child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  return {
    completed: new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", status => resolve({ status, stdout, stderr }));
    })
  };
}

async function waitForTableLock(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  applicationName: string
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (cluster.sql(databaseUrl, `
      SELECT count(*)
      FROM pg_locks AS lock
      JOIN pg_class AS relation ON relation.oid = lock.relation
      JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
      WHERE activity.application_name = '${applicationName}'
        AND relation.relname = 'FloorImportAttemptCleanup'
        AND lock.mode = 'RowExclusiveLock' AND lock.granted;
    `) === "1") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("cleanup terminal writer did not acquire its table lock");
}

function resolveRolledBack(databaseUrl: string) {
  return spawnSync(process.execPath, [
    require.resolve("prisma/build/index.js"),
    "migrate", "resolve", "--rolled-back", terminalMigrationName,
    "--schema", join(__dirname, "../../prisma/schema.prisma")
  ], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8", timeout: 30_000
  });
}
