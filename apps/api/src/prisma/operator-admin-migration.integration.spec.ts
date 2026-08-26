import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const migrationPath = join(
  __dirname,
  "../../prisma/migrations/20260827090000_operator_admin_account_flow/migration.sql"
);
const schemaPath = join(__dirname, "../../prisma/schema.prisma");
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const schema = readFileSync(schemaPath, "utf8");
const databaseUrl = process.env.OPERATOR_ADMIN_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describe("operator/admin migration static contract", () => {
  it("declares the login id and site-admin Prisma source of truth", () => {
    expect(schema).toMatch(/loginId\s+String\s+@unique/);
    expect(schema).toMatch(/email\s+String\?\s+@unique/);
    expect(schema).toMatch(/administeredSite\s+Site\?\s+@relation\("SiteAdmin"\)/);
    expect(schema).toMatch(/adminUserId\s+String\?\s+@unique/);
    expect(schema).toMatch(/admin\s+User\?\s+@relation\("SiteAdmin", fields: \[adminUserId\], references: \[id\], onDelete: Restrict\)/);
    expect(schema).toMatch(/address\s+String\?/);
    expect(schema).toMatch(/tariffKwhRate\s+Decimal\?\s+@db.Decimal\(10, 2\)/);
  });

  it("orders nullable additions, guarded backfill, and final constraints in one transaction", () => {
    expect(migration.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(migration.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(migration).toContain('ADD COLUMN "loginId" TEXT');
    expect(migration).toContain('ADD COLUMN "adminUserId" TEXT');
    expect(migration).toContain('ALTER COLUMN "address" DROP NOT NULL');
    expect(migration).toContain('ALTER COLUMN "tariffKwhRate" DROP NOT NULL');
    expect(migration).toMatch(/lower\(btrim\("email"\)\)/);
    expect(migration).toContain("loginId collision");
    expect(migration).toContain("operator account count");
    expect(migration).toContain("ambiguous customer admin/site ownership");
    expect(migration.indexOf('ADD COLUMN "loginId" TEXT')).toBeLessThan(migration.indexOf("DO $$"));
    expect(migration.indexOf("DO $$")).toBeLessThan(migration.indexOf('ALTER COLUMN "loginId" SET NOT NULL'));
    expect(migration).toContain('ADD CONSTRAINT "User_loginId_format_check"');
    expect(migration).toContain('CREATE UNIQUE INDEX "User_loginId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "Site_adminUserId_key"');
    expect(migration).toContain('ADD CONSTRAINT "Site_adminUserId_fkey"');
    expect(migration).toContain('FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE RESTRICT');
  });
});

describeWithPostgres("operator/admin migration PostgreSQL rehearsal", () => {
  const schemas: string[] = [];

  afterAll(() => {
    for (const schemaName of schemas) runSql(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  });

  it("rejects normalized login id collisions before enforcing uniqueness", () => {
    const schemaName = createIsolatedSchema("login_id_collision");
    installLegacyTables(schemaName);
    seedLegacyUsers(schemaName, ["Admin@Example.com", " admin@example.com "]);

    const result = applyOperatorAdminMigration(schemaName);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("loginId collision");
    expect(query(schemaName, loginIdColumnCountSql())).toBe("0");
  });

  it("backfills only an unambiguous one-admin one-site customer", () => {
    const schemaName = createIsolatedSchema("unambiguous_customer");
    installLegacyTables(schemaName);
    const { adminId, siteId } = seedLegacyCustomer(schemaName, { admins: 1, sites: 1 });

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    expect(readSiteAdminId(schemaName, siteId)).toBe(adminId);
  });

  function createIsolatedSchema(suffix: string) {
    const schemaName = `operator_admin_migration_${process.pid}_${Date.now()}_${suffix}`.toLowerCase();
    schemas.push(schemaName);
    runSql(`CREATE SCHEMA "${schemaName}";`);
    return schemaName;
  }

  function installLegacyTables(schemaName: string) {
    execute(schemaName, `
      CREATE TYPE "OrganizationType" AS ENUM ('service_provider', 'customer');
      CREATE TYPE "UserRole" AS ENUM ('operator', 'admin', 'viewer');
      CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');
      CREATE TABLE "Organization" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "type" "OrganizationType" NOT NULL
      );
      CREATE TABLE "User" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "email" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "passwordHash" TEXT NOT NULL,
        "role" "UserRole" NOT NULL,
        "status" "UserStatus" NOT NULL DEFAULT 'active'
      );
      CREATE TABLE "Site" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "address" TEXT NOT NULL,
        "tariffKwhRate" DECIMAL(10, 2) NOT NULL
      );
    `);
  }

  function seedLegacyUsers(schemaName: string, emails: string[]) {
    execute(schemaName, `INSERT INTO "Organization" ("id", "name", "type") VALUES ('customer-1', 'Customer', 'customer');`);
    for (const [index, email] of emails.entries()) {
      execute(schemaName, `
        INSERT INTO "User" ("id", "organizationId", "email", "name", "passwordHash", "role")
        VALUES ('user-${index}', 'customer-1', '${sqlLiteral(email)}', 'Admin ${index}', 'hash', 'viewer');
      `);
    }
  }

  function seedLegacyCustomer(schemaName: string, input: { admins: number; sites: number }) {
    const adminId = "admin-1";
    const siteId = "site-1";
    execute(schemaName, `INSERT INTO "Organization" ("id", "name", "type") VALUES ('customer-1', 'Customer', 'customer');`);
    for (let index = 0; index < input.admins; index += 1) {
      execute(schemaName, `
        INSERT INTO "User" ("id", "organizationId", "email", "name", "passwordHash", "role")
        VALUES ('admin-${index + 1}', 'customer-1', 'admin-${index + 1}@example.com', 'Admin ${index + 1}', 'hash', 'admin');
      `);
    }
    for (let index = 0; index < input.sites; index += 1) {
      execute(schemaName, `
        INSERT INTO "Site" ("id", "organizationId", "name", "address", "tariffKwhRate")
        VALUES ('site-${index + 1}', 'customer-1', 'Site ${index + 1}', 'Legacy address', 150.00);
      `);
    }
    return { adminId, siteId };
  }

  function applyOperatorAdminMigration(schemaName: string) {
    return runSql(`SET search_path TO "${schemaName}";\n${migration}`);
  }

  function readSiteAdminId(schemaName: string, siteId: string) {
    return query(schemaName, `SELECT "adminUserId" FROM "Site" WHERE "id" = '${siteId}';`);
  }

  function execute(schemaName: string, sql: string) {
    const result = runSql(`SET search_path TO "${schemaName}";\n${sql}`);
    if (result.status !== 0) throw new Error(result.stderr);
  }

  function query(schemaName: string, sql: string) {
    const result = runSql(`SET search_path TO "${schemaName}";\n${sql}`, ["-qAt"]);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  function runSql(sql: string, extraArgs: string[] = ["-q"]) {
    return spawnSync("psql", [...extraArgs, "-v", "ON_ERROR_STOP=1", databaseUrl!], {
      encoding: "utf8",
      input: sql
    });
  }
});

function loginIdColumnCountSql() {
  return `
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'User'
      AND column_name = 'loginId';
  `;
}

function sqlLiteral(value: string) {
  return value.replaceAll("'", "''");
}
