import { PrismaClient } from "@prisma/client";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

// Opt-in starts its own cluster and never consumes DATABASE_URL or an existing DB.
const enabled = process.env.REPORT_MIGRATION_SAFETY_TEST === "1";
const apiRoot = join(__dirname, "../../..");
const source = join(apiRoot, "prisma");
const reportMigrations = ["20260912_statistics_p2_reports", "20260913_report_object_cleanup_ledger", "20260914_report_delete_tombstone_guard"];
const siteId = "11111111-1111-4111-8111-111111111111";
const reportId = "22222222-2222-4222-8222-222222222222";
const key = (format = "xlsx", attempt = 1) => `reports/${siteId}/${reportId}/attempt-${attempt}.${format}`;

(enabled ? describe : describe.skip)("report migration safety on a disposable PostgreSQL cluster", () => {
  let directory: string;
  let port: number;
  let started = false;
  let sequence = 0;

  beforeAll(async () => {
    // This Unix-only PostgreSQL fixture uses /tmp instead of ambient TMPDIR.
    // Resolve its symlink and validate the entire generated path before pg_ctl
    // can interpolate it into a shell command or server options.
    directory = mkdtempSync(join(realpathSync("/tmp"), "report-migration-safety-"));
    expect(directory).toMatch(/^\/[A-Za-z0-9/_-]+$/);
    port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("missing ephemeral port"));
        server.close(() => resolve(address.port));
      });
    });
    checked("initdb", ["-D", join(directory, "data"), "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
    checked("pg_ctl", ["-D", join(directory, "data"), "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "start"]);
    started = true;
  }, 30_000);

  afterAll(() => {
    if (started) checked("pg_ctl", ["-D", join(directory, "data"), "-m", "immediate", "-w", "stop"]);
    // Only the mkdtemp-owned directory is removed, after its server has stopped.
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function url(database: string) { return `postgresql://postgres@127.0.0.1:${port}/${database}`; }
  function database() {
    const name = `report_safety_${sequence++}`;
    sql(url("postgres"), `CREATE DATABASE "${name}"`);
    return url(name);
  }
  function migrationCopy(through = reportMigrations[2]) {
    const copy = mkdtempSync(join(directory, "migrations-"));
    cpSync(source, copy, { recursive: true });
    for (const name of readdirSync(join(copy, "migrations"))) {
      if (/^\d/.test(name) && name > through) rmSync(join(copy, "migrations", name), { recursive: true });
    }
    return copy;
  }
  function deploy(db: string, copy: string) {
    return spawnSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", join(copy, "schema.prisma")], {
      cwd: directory, env: { ...process.env, DATABASE_URL: db }, encoding: "utf8", timeout: 30_000
    });
  }
  function success(db: string, copy: string) {
    const result = deploy(db, copy);
    expect(result.stderr + result.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(result.status).toBe(0);
  }
  function preflight(db: string, phase = "pre") {
    const result = spawnSync(process.execPath, [join(apiRoot, "scripts/check-report-migration-preflight.mjs"), `--phase=${phase}`], {
      cwd: directory, env: { ...process.env, DATABASE_URL: db }, encoding: "utf8", timeout: 15_000
    });
    // A missing script cannot masquerade as a successful fail-closed diagnosis.
    expect(result.stdout.trim()).toMatch(/^\{/);
    return { status: result.status, ...JSON.parse(result.stdout) as { ok: boolean; issues: { code: string }[] } };
  }
  function legacy(db: string, keys: unknown) {
    sql(db, `INSERT INTO "SiteDeletionCleanup" ("id", "siteId", "inventoryIds", "objectKeys", "updatedAt")
      VALUES ('cleanup', '${siteId}', '[]', '${JSON.stringify(keys).replaceAll("'", "''")}', now())`);
  }
  function seedReport(db: string) {
    sql(db, `INSERT INTO "Organization" ("id", "name", "type", "updatedAt") VALUES ('org', 'test', 'customer', now());
      INSERT INTO "Site" ("id", "organizationId", "name", "updatedAt") VALUES ('${siteId}', 'org', 'test', now());
      INSERT INTO "EnergyReportJob" ("id", "siteId", "requestedByActorId", "requestedByLoginIdSnapshot", "requestHash", "format", "requestSnapshot", "updatedAt")
      VALUES ('${reportId}', '${siteId}', 'actor', 'actor', repeat('a', 64), 'xlsx', '{}', now());`);
  }

  it("replays real migrate deploy from clean and rejects a missing post-deploy delete guard", () => {
    const db = database();
    expect(preflight(db)).toMatchObject({ status: 0, ok: true });
    success(db, migrationCopy("20260927090000_pdf_only_energy_reports"));
    expect(preflight(db, "post")).toMatchObject({ status: 0, ok: true });
    sql(db, 'ALTER TABLE "EnergyReportJob" DISABLE TRIGGER "EnergyReportJob_preserve_objects_before_delete"');
    expect(preflight(db, "post")).toMatchObject({ status: 1, issues: expect.arrayContaining([{ code: "delete_trigger_missing_or_disabled" }]) });
    sql(db, 'DROP TRIGGER "EnergyReportJob_preserve_objects_before_delete" ON "EnergyReportJob"');
    expect(preflight(db, "post")).toMatchObject({ status: 1, ok: false, issues: expect.arrayContaining([{ code: "delete_trigger_missing_or_disabled" }]) });
  }, 30_000);

  it("clears every historical report and preserves the XLSX cleanup ledger before narrowing the enum", () => {
    const db = database();
    success(db, migrationCopy("20260925150000_landing_oauth_generation"));
    seedReport(db);
    sql(db, `INSERT INTO "EnergyReportJob" ("id", "siteId", "requestedByActorId", "requestedByLoginIdSnapshot", "requestHash", "format", "requestSnapshot", "updatedAt")
      VALUES ('33333333-3333-4333-8333-333333333333', '${siteId}', 'actor', 'actor', repeat('b', 64), 'pdf', '{}', now());`);
    sql(db, `INSERT INTO "EnergyReportObjectCleanup" ("reportId", "siteId", "objectKeys", "nextAttemptAt", "updatedAt")
      VALUES ('44444444-4444-4444-8444-444444444444', '${siteId}', '["reports/${siteId}/44444444-4444-4444-8444-444444444444/attempt-1.xlsx"]', now(), now());`);
    success(db, migrationCopy("20260927090000_pdf_only_energy_reports"));
    expect(preflight(db, "post")).toMatchObject({ status: 0, ok: true });
    expect(sql(db, 'SELECT count(*) FROM "EnergyReportJob"')).toBe("0");
    expect(JSON.parse(sql(db, `SELECT "objectKeys" FROM "EnergyReportObjectCleanup" WHERE "reportId" = '${reportId}'`)))
      .toEqual([key(), key("xlsx", 2), key("xlsx", 3)]);
    expect(sql(db, 'SELECT count(*) FROM "EnergyReportObjectCleanup"')).toBe("3");
    expect(sql(db, `SELECT enumlabel FROM pg_enum WHERE enumtypid = '"EnergyReportFormat"'::regtype`)).toBe("pdf");
  }, 60_000);

  it("requires the PDF-only reset migration in the post-deploy gate", () => {
    const db = database();
    success(db, migrationCopy("20260925150000_landing_oauth_generation"));
    expect(preflight(db, "post")).toMatchObject({ status: 1, issues: expect.arrayContaining([{ code: "report_migrations_pending" }]) });
  }, 30_000);

  it("rejects report rows recreated after the PDF-only reset", () => {
    const db = database();
    success(db, migrationCopy("20260927090000_pdf_only_energy_reports"));
    sql(db, `INSERT INTO "Organization" ("id", "name", "type", "updatedAt") VALUES ('org', 'test', 'customer', now());
      INSERT INTO "Site" ("id", "organizationId", "name", "updatedAt") VALUES ('${siteId}', 'org', 'test', now());
      INSERT INTO "EnergyReportJob" ("id", "siteId", "requestedByActorId", "requestedByLoginIdSnapshot", "requestHash", "format", "requestSnapshot", "updatedAt")
      VALUES ('${reportId}', '${siteId}', 'actor', 'actor', repeat('a', 64), 'pdf', '{}', now());`);
    expect(preflight(db, "post")).toMatchObject({ status: 1, issues: expect.arrayContaining([{ code: "report_history_not_empty" }]) });
  }, 30_000);

  it("rejects an XLSX enum value reintroduced after the PDF-only reset", () => {
    const db = database();
    success(db, migrationCopy("20260927090000_pdf_only_energy_reports"));
    sql(db, 'ALTER TYPE "EnergyReportFormat" ADD VALUE \'xlsx\'');
    expect(preflight(db, "post")).toMatchObject({ status: 1, issues: expect.arrayContaining([{ code: "report_format_not_pdf_only" }]) });
  }, 30_000);

  it("upgrades 20260911 history and preserves all three attempt keys from completed cleanup", () => {
    const db = database();
    success(db, migrationCopy("20260911999999"));
    legacy(db, [key()]);
    sql(db, 'UPDATE "SiteDeletionCleanup" SET "completedAt" = now()');
    expect(preflight(db)).toMatchObject({ status: 0, ok: true });
    success(db, migrationCopy());
    expect(JSON.parse(sql(db, 'SELECT "objectKeys" FROM "EnergyReportObjectCleanup"'))).toEqual([key(), key("xlsx", 2), key("xlsx", 3)]);
    expect(sql(db, 'SELECT count(*) FROM "SiteDeletionCleanup" WHERE "completedAt" IS NOT NULL')).toBe("1");
    expect(preflight(db, "post")).toMatchObject({ status: 1, issues: expect.arrayContaining([{ code: "report_migrations_pending" }]) });
    sql(db, 'DELETE FROM "EnergyReportObjectCleanup"');
    expect(preflight(db, "post")).toMatchObject({ status: 1, issues: expect.arrayContaining([{ code: "legacy_report_backfill_missing" }]) });
    sql(db, 'ALTER TABLE "EnergyReportJob" DROP CONSTRAINT "EnergyReportJob_attempt_check"');
    expect(preflight(db, "post")).toMatchObject({ status: 1, issues: expect.arrayContaining([{ code: "report_constraint_missing" }]) });
  }, 30_000);

  it.each([
    ["scalar", "not-an-array", "legacy_object_keys_not_array"],
    ["multiple formats", [key(), key("pdf")], "legacy_report_key_count_exceeded"]
  ])("rejects legacy %s without changing data or migration history", (_name, keys, code) => {
    const db = database();
    success(db, migrationCopy(reportMigrations[0]));
    legacy(db, keys);
    const before = sql(db, 'SELECT "objectKeys" FROM "SiteDeletionCleanup"');
    const history = sql(db, 'SELECT count(*) FROM "_prisma_migrations"');
    expect(preflight(db)).toMatchObject({ status: 1, ok: false, issues: expect.arrayContaining([{ code }]) });
    expect(sql(db, 'SELECT "objectKeys" FROM "SiteDeletionCleanup"')).toBe(before);
    expect(sql(db, 'SELECT count(*) FROM "_prisma_migrations"')).toBe(history);
    const failed = deploy(db, migrationCopy(reportMigrations[1]));
    expect(failed.status).not.toBe(0);
    expect(sql(db, `SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '${reportMigrations[1]}' AND finished_at IS NULL AND rolled_back_at IS NULL`)).toBe("1");
  }, 30_000);

  it.each(reportMigrations)("records injected failure and blocks blind retry of %s", (migration) => {
    const db = database();
    const prior = migration === reportMigrations[0] ? "20260911999999" : reportMigrations[reportMigrations.indexOf(migration) - 1];
    success(db, migrationCopy(prior));
    if (migration !== reportMigrations[0]) seedReport(db);
    legacy(db, [key()]);
    const copy = migrationCopy(migration);
    const file = join(copy, "migrations", migration, "migration.sql");
    const original = readFileSync(file, "utf8");
    // Edit only a disposable copy. For the explicit transaction, fail after the
    // trigger and a DELETE side effect but before COMMIT to prove both roll back.
    const injected = migration === reportMigrations[2]
      ? original.replace("\nCOMMIT;", `\nDELETE FROM "EnergyReportJob" WHERE "id" = '${reportId}';\nSELECT 1 / 0;\nCOMMIT;`)
      : `${original}\nSELECT 1 / 0;`;
    writeFileSync(file, injected);
    const logOffset = readFileSync(join(directory, "postgres.log"), "utf8").length;
    const result = deploy(db, copy);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(directory, "postgres.log"), "utf8").slice(logOffset)).toContain("ERROR:  division by zero");
    expect(sql(db, `SELECT finished_at IS NULL AND rolled_back_at IS NULL FROM "_prisma_migrations" WHERE migration_name = '${migration}'`)).toBe("t");
    // Prisma 6.19.3 attempts its log UPDATE inside the aborted explicit
    // transaction. The unfinished row survives with NULL logs: never trust
    // non-null logs as the predicate for failure detection or recovery.
    expect(sql(db, `SELECT logs IS NULL FROM "_prisma_migrations" WHERE migration_name = '${migration}'`)).toBe(migration === reportMigrations[2] ? "t" : "f");
    expect(preflight(db)).toMatchObject({ status: 1, ok: false, issues: expect.arrayContaining([{ code: "unfinished_migration" }]) });
    const retry = deploy(db, migrationCopy(migration));
    expect(retry.status).not.toBe(0);
    expect(retry.stderr + retry.stdout).toContain("P3009");
    if (migration === reportMigrations[0]) expect(sql(db, `SELECT to_regclass('"EnergyReportJob"') IS NULL`)).toBe("t");
    if (migration === reportMigrations[1]) expect(sql(db, `SELECT to_regclass('"EnergyReportObjectCleanup"') IS NULL`)).toBe("t");
    if (migration === reportMigrations[2]) {
      expect(sql(db, `SELECT count(*) FROM pg_trigger WHERE tgname = 'EnergyReportJob_preserve_objects_before_delete'`)).toBe("0");
      expect(sql(db, 'SELECT count(*) FROM "EnergyReportJob"')).toBe("1");
      expect(sql(db, 'SELECT count(*) FROM "EnergyReportObjectCleanup"')).toBe("0");
    }
    const recovered = database();
    success(recovered, migrationCopy("20260927090000_pdf_only_energy_reports"));
    expect(preflight(recovered, "post")).toMatchObject({ status: 0, ok: true });
  }, 45_000);

  it("detects partially committed legacy catalog state even without a failed history row", () => {
    const db = database();
    success(db, migrationCopy("20260911999999"));
    // Simulates a statement-by-statement runner or interrupted manual recovery.
    sql(db, `CREATE TYPE "EnergyReportStatus" AS ENUM ('queued')`);
    expect(preflight(db)).toMatchObject({ status: 1, ok: false, issues: expect.arrayContaining([{ code: "unexpected_report_catalog" }]) });
  }, 30_000);

  it("fails closed on a committed legacy prefix and refuses its unsafe automatic retry", () => {
    const db = database();
    success(db, migrationCopy(reportMigrations[0]));
    legacy(db, [key()]);
    const copy = migrationCopy(reportMigrations[1]);
    const file = join(copy, "migrations", reportMigrations[1], "migration.sql");
    const original = readFileSync(file, "utf8");
    const insertion = original.indexOf('INSERT INTO "EnergyReportObjectCleanup"');
    // A deliberate test-only commit models an alternate statement-at-a-time
    // runner/manual recovery. Native Prisma's original batch rolled back above;
    // this case must not be reported as the untouched migration's behavior.
    writeFileSync(file, `BEGIN;\n${original.slice(0, insertion)}\nCOMMIT;\nSELECT 1 / 0;\n${original.slice(insertion)}`);
    expect(deploy(db, copy).status).not.toBe(0);
    expect(sql(db, `SELECT to_regclass('"EnergyReportObjectCleanup"') IS NOT NULL`)).toBe("t");
    expect(sql(db, 'SELECT count(*) FROM "EnergyReportObjectCleanup"')).toBe("0");
    expect(sql(db, 'SELECT count(*) FROM "SiteDeletionCleanup"')).toBe("1");
    expect(preflight(db)).toMatchObject({ status: 1, issues: expect.arrayContaining([
      { code: "unfinished_migration" }, { code: "unexpected_report_catalog" }
    ]) });
    const retry = deploy(db, migrationCopy());
    expect(retry.status).not.toBe(0);
    expect(retry.stdout + retry.stderr).toContain("P3009");
  }, 30_000);

  it("times out migration table-lock contention and blocks writers until the guard commits", async () => {
    const db = database();
    success(db, migrationCopy(reportMigrations[1]));
    seedReport(db);
    const connection = new PrismaClient({ datasourceUrl: db });
    try {
      await connection.$transaction(async tx => {
        await tx.$executeRawUnsafe('LOCK TABLE "EnergyReportJob" IN ROW EXCLUSIVE MODE');
        const timeoutUrl = new URL(db);
        timeoutUrl.searchParams.set("options", "-c lock_timeout=250ms");
        const logOffset = readFileSync(join(directory, "postgres.log"), "utf8").length;
        const result = deploy(timeoutUrl.toString(), migrationCopy());
        expect(result.status).not.toBe(0);
        expect(readFileSync(join(directory, "postgres.log"), "utf8").slice(logOffset)).toContain("ERROR:  canceling statement due to lock timeout");
      }, { timeout: 30_000 });
      expect(sql(db, `SELECT count(*) FROM pg_trigger WHERE tgname = 'EnergyReportJob_preserve_objects_before_delete'`)).toBe("0");
      // A fresh database is the test's recovery boundary, never migrate resolve
      // on persistent/user data. The next transaction holds the real SQL lock.
      const clean = database();
      success(clean, migrationCopy(reportMigrations[1]));
      seedReport(clean);
      const owner = new PrismaClient({ datasourceUrl: clean });
      let writer: ReturnType<typeof spawn> | undefined;
      let writerResult: Promise<number | null> | undefined;
      try {
        await owner.$transaction(async tx => {
          await tx.$executeRawUnsafe('LOCK TABLE "EnergyReportJob" IN SHARE ROW EXCLUSIVE MODE');
          writer = spawn("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", clean], { stdio: ["pipe", "pipe", "pipe"] });
          writerResult = new Promise(resolve => writer!.once("close", resolve));
          writer.stdin!.end(`SET application_name = 'report_safety_writer'; DELETE FROM "EnergyReportJob" WHERE "id" = '${reportId}';`);
          const deadline = Date.now() + 5_000;
          let waiting = false;
          while (Date.now() < deadline && !waiting) {
            waiting = sql(clean, `SELECT count(*) FROM pg_stat_activity WHERE application_name = 'report_safety_writer' AND wait_event_type = 'Lock'`) === "1";
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
          }
          expect(waiting).toBe(true);
          expect(sql(clean, 'SELECT count(*) FROM "EnergyReportJob"')).toBe("1");
          // Execute the unchanged migration body inside the already-owned lock.
          // psql runs it on a separate connection only in the deploy cases above.
          const body = readFileSync(join(source, "migrations", reportMigrations[2], "migration.sql"), "utf8");
          const functionStart = body.indexOf('CREATE FUNCTION');
          const triggerStart = body.indexOf('CREATE TRIGGER');
          await tx.$executeRawUnsafe(body.slice(functionStart, triggerStart));
          await tx.$executeRawUnsafe(body.slice(triggerStart, body.lastIndexOf("COMMIT;")));
        }, { timeout: 15_000 });
        expect(await writerResult).toBe(0);
        expect(sql(clean, 'SELECT count(*) FROM "EnergyReportJob"')).toBe("0");
        expect(JSON.parse(sql(clean, 'SELECT "objectKeys" FROM "EnergyReportObjectCleanup"'))).toEqual([key(), key("xlsx", 2), key("xlsx", 3)]);
      } finally {
        if (writer?.exitCode === null) writer.kill();
        await owner.$disconnect();
      }
    } finally { await connection.$disconnect(); }
  }, 45_000);
});

function checked(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

function sql(databaseUrl: string, input: string) {
  const result = spawnSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", databaseUrl], { input, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return result.stdout.trim();
}
