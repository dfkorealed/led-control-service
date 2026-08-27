import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const databaseUrl = process.env.LOGIN_ID_CONTRACT_MIGRATION_TEST_DATABASE_URL
  ?? process.env.OPERATOR_ADMIN_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describe("login id contract migration", () => {
  const apiRoot = join(__dirname, "../..");
  const schema = readFileSync(join(apiRoot, "prisma/schema.prisma"), "utf8");
  const migrationPath = join(apiRoot, "prisma/migrations/20260827100000_login_id_contract/migration.sql");
  const migration = readFileSync(migrationPath, "utf8");

  it("makes loginId required and email nullable in Prisma", () => {
    expect(schema).toMatch(/loginId\s+String\s+@unique/);
    expect(schema).toMatch(/email\s+String\?\s+@unique/);
  });

  it("re-backfills null login ids before validating and enforcing the final contract", () => {
    expect(migration).toContain('WHERE "loginId" IS NULL AND "email" IS NOT NULL');
    expect(migration).toContain('SET "loginId" = lower(btrim("email"))');
    expect(migration).toContain("invalid loginId format before contract enforcement");
    expect(migration).toContain("loginId collision before contract enforcement");
    expect(migration).toContain("loginId remains null before contract enforcement");
    expect(migration).toContain('ALTER COLUMN "loginId" SET NOT NULL');
    expect(migration).toContain('ALTER COLUMN "email" DROP NOT NULL');
    expect(migration.indexOf('SET "loginId" = lower(btrim("email"))')).toBeLessThan(migration.indexOf('ALTER COLUMN "loginId" SET NOT NULL'));
  });
});

describeWithPostgres("login id contract migration PostgreSQL rehearsal", () => {
  const apiRoot = join(__dirname, "../..");
  const task1 = readFileSync(join(apiRoot, "prisma/migrations/20260827090000_operator_admin_account_flow/migration.sql"), "utf8");
  const task2 = readFileSync(join(apiRoot, "prisma/migrations/20260827100000_login_id_contract/migration.sql"), "utf8");
  const schemas: string[] = [];
  let sequence = 0;

  afterAll(() => {
    for (const schemaName of schemas) runSql(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  });

  it("migrates a fresh Task 1 database to the final contract without losing Task 1 guards", () => {
    const schemaName = createSchema("fresh");
    installLegacyTables(schemaName);
    seedCustomerAdmin(schemaName);

    expect(apply(schemaName, task1).status).toBe(0);
    expect(apply(schemaName, task2).status).toBe(0);

    expect(query(schemaName, `SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'User' AND column_name = 'loginId';`)).toBe("NO");
    expect(query(schemaName, `SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'User' AND column_name = 'email';`)).toBe("YES");
    expect(query(schemaName, `SELECT COUNT(*) FROM pg_trigger WHERE tgrelid = '"Site"'::regclass AND tgname = 'Site_validate_admin_assignment';`)).toBe("1");
    expect(query(schemaName, `SELECT COUNT(*) FROM pg_trigger WHERE tgrelid = '"User"'::regclass AND tgname = 'User_validate_assigned_site_admin';`)).toBe("1");
    expect(query(schemaName, `SELECT COUNT(*) FROM pg_trigger WHERE tgrelid = '"Organization"'::regclass AND tgname = 'Organization_validate_assigned_site_admin';`)).toBe("1");
    expect(query(schemaName, `SELECT COUNT(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('User_loginId_key', 'User_single_operator_key', 'Site_adminUserId_key');`)).toBe("3");

    expect(run(schemaName, `INSERT INTO "User" ("id", "organizationId", "loginId", "email", "name", "passwordHash", "role", "status") VALUES ('nullable-email', 'customer-1', 'viewer_01', NULL, 'Viewer', 'hash', 'viewer', 'active');`).status).toBe(0);
    expect(run(schemaName, `INSERT INTO "User" ("id", "organizationId", "loginId", "email", "name", "passwordHash", "role", "status") VALUES ('duplicate-login', 'customer-1', 'viewer_01', NULL, 'Viewer', 'hash', 'viewer', 'active');`).status).not.toBe(0);
    expect(run(schemaName, `INSERT INTO "User" ("id", "organizationId", "email", "name", "passwordHash", "role", "status") VALUES ('missing-login', 'customer-1', NULL, 'Viewer', 'hash', 'viewer', 'active');`).status).not.toBe(0);
    expect(run(schemaName, `UPDATE "Site" SET "adminUserId" = 'nullable-email' WHERE "id" = 'site-1';`).status).not.toBe(0);
    expect(run(schemaName, `INSERT INTO "User" ("id", "organizationId", "loginId", "email", "name", "passwordHash", "role", "status") VALUES ('operator-1', 'customer-1', 'operator_01', NULL, 'Operator', 'hash', 'operator', 'active');`).status).toBe(0);
    expect(run(schemaName, `INSERT INTO "User" ("id", "organizationId", "loginId", "email", "name", "passwordHash", "role", "status") VALUES ('operator-2', 'customer-1', 'operator_02', NULL, 'Operator', 'hash', 'operator', 'disabled');`).status).not.toBe(0);
  });

  it("re-backfills a null login id written during the Task 1 expand deployment", () => {
    const schemaName = createSchema("staged_backfill");
    installLegacyTables(schemaName);
    seedCustomerAdmin(schemaName);
    expect(apply(schemaName, task1).status).toBe(0);
    expect(run(schemaName, `INSERT INTO "User" ("id", "organizationId", "loginId", "email", "name", "passwordHash", "role", "status") VALUES ('staged-viewer', 'customer-1', NULL, ' Staged.Viewer@example.com ', 'Viewer', 'hash', 'viewer', 'active');`).status).toBe(0);

    expect(apply(schemaName, task2).status).toBe(0);
    expect(query(schemaName, `SELECT "loginId" FROM "User" WHERE "id" = 'staged-viewer';`)).toBe("staged.viewer@example.com");
  });

  it.each([
    ["collision", `
      INSERT INTO "User" ("id", "organizationId", "loginId", "email", "name", "passwordHash", "role", "status") VALUES
        ('collision-1', 'customer-1', NULL, 'Collision@example.com', 'One', 'hash', 'viewer', 'active'),
        ('collision-2', 'customer-1', NULL, ' collision@example.com ', 'Two', 'hash', 'viewer', 'active');
    `, "loginId collision before contract enforcement"],
    ["invalid", `
      ALTER TABLE "User" DROP CONSTRAINT "User_loginId_format_check";
      UPDATE "User"
      SET "loginId" = NULL, "email" = 'invalid+login@example.com'
      WHERE "id" = 'admin-1';
    `, "invalid loginId format before contract enforcement"],
    ["null", `
      ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
      INSERT INTO "User" ("id", "organizationId", "loginId", "email", "name", "passwordHash", "role", "status")
      VALUES ('null-1', 'customer-1', NULL, NULL, 'Null', 'hash', 'viewer', 'active');
    `, "loginId remains null before contract enforcement"]
  ])("rolls back the final contract on a staged %s guard failure", (_label, stagedSql, failure) => {
    const schemaName = createSchema(`guard_${_label}`);
    installLegacyTables(schemaName);
    seedCustomerAdmin(schemaName);
    expect(apply(schemaName, task1).status).toBe(0);
    expect(run(schemaName, stagedSql).status).toBe(0);

    const result = apply(schemaName, task2);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(failure);
    expect(query(schemaName, `SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'User' AND column_name = 'loginId';`)).toBe("YES");
    expect(query(schemaName, `SELECT COUNT(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'User_loginId_key';`)).toBe("1");
  });

  function createSchema(suffix: string) {
    const schemaName = `login_id_contract_${process.pid}_${Date.now()}_${sequence++}_${suffix}`.toLowerCase();
    schemas.push(schemaName);
    runSql(`CREATE SCHEMA "${schemaName}";`);
    return schemaName;
  }

  function installLegacyTables(schemaName: string) {
    execute(schemaName, `
      CREATE TYPE "OrganizationType" AS ENUM ('service_provider', 'customer');
      CREATE TYPE "UserRole" AS ENUM ('operator', 'admin', 'viewer');
      CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');
      CREATE TABLE "Organization" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "type" "OrganizationType" NOT NULL);
      CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "email" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL, "passwordHash" TEXT NOT NULL, "role" "UserRole" NOT NULL, "status" "UserStatus" NOT NULL DEFAULT 'active');
      CREATE TABLE "Site" ("id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "name" TEXT NOT NULL, "address" TEXT NOT NULL, "tariffKwhRate" DECIMAL(10, 2) NOT NULL);
    `);
  }

  function seedCustomerAdmin(schemaName: string) {
    execute(schemaName, `
      INSERT INTO "Organization" ("id", "name", "type") VALUES ('customer-1', 'Customer', 'customer');
      INSERT INTO "User" ("id", "organizationId", "email", "name", "passwordHash", "role", "status") VALUES ('admin-1', 'customer-1', 'admin@example.com', 'Admin', 'hash', 'admin', 'active');
      INSERT INTO "Site" ("id", "organizationId", "name", "address", "tariffKwhRate") VALUES ('site-1', 'customer-1', 'Site', 'Address', 100.00);
    `);
  }

  function apply(schemaName: string, migration: string) {
    return run(schemaName, migration);
  }

  function execute(schemaName: string, sql: string) {
    const result = run(schemaName, sql);
    if (result.status !== 0) throw new Error(result.stderr);
  }

  function query(schemaName: string, sql: string) {
    const result = run(schemaName, sql, ["-qAt"]);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  function run(schemaName: string, sql: string, extraArgs: string[] = ["-q"]) {
    return runSql(`SET search_path TO "${schemaName}";\n${sql}`, extraArgs);
  }

  function runSql(sql: string, extraArgs: string[] = ["-q"]) {
    return spawnSync("psql", [...extraArgs, "-v", "ON_ERROR_STOP=1", databaseUrl!], { encoding: "utf8", input: sql });
  }
});
