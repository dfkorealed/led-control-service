import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const migrationPath = join(__dirname, "../../prisma/migrations/20260827090000_operator_admin_account_flow/migration.sql");
const pendingSiteMigrationPath = join(__dirname, "../../prisma/migrations/20260827110000_pending_site_contract/migration.sql");
const schemaPath = join(__dirname, "../../prisma/schema.prisma");
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const pendingSiteMigration = existsSync(pendingSiteMigrationPath) ? readFileSync(pendingSiteMigrationPath, "utf8") : "";
const schema = readFileSync(schemaPath, "utf8");
const databaseUrl = process.env.OPERATOR_ADMIN_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describe("operator/admin migration static contract", () => {
  it("matches the final pending-site Prisma contract while Task 1 remains SQL-expand-only", () => {
    expect(schema).toMatch(/loginId\s+String\s+@unique/);
    expect(schema).toMatch(/email\s+String\?\s+@unique/);
    expect(schema).toMatch(/administeredSite\s+Site\?\s+@relation\("SiteAdmin"\)/);
    expect(schema).toMatch(/adminUserId\s+String\?\s+@unique/);
    expect(schema).toMatch(/admin\s+User\?\s+@relation\("SiteAdmin", fields: \[adminUserId\], references: \[id\], onDelete: Restrict\)/);
    expect(schema).toMatch(/address\s+String\?/);
    expect(schema).toMatch(/tariffKwhRate\s+Decimal\?\s+@db.Decimal\(10, 2\)/);
  });

  it("keeps legacy required columns while adding nullable login ids in one guarded transaction", () => {
    expect(migration.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(migration.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(migration).toContain('ADD COLUMN "loginId" TEXT');
    expect(migration).toContain('ADD COLUMN "adminUserId" TEXT');
    expect(migration).not.toContain('ALTER COLUMN "email" DROP NOT NULL');
    expect(migration).not.toContain('ALTER COLUMN "address" DROP NOT NULL');
    expect(migration).not.toContain('ALTER COLUMN "tariffKwhRate" DROP NOT NULL');
    expect(migration).not.toContain('ALTER COLUMN "loginId" SET NOT NULL');
    expect(migration).toMatch(/lower\(btrim\("email"\)\)/);
    expect(migration).toContain("loginId collision");
    expect(migration).toContain("operator account count");
    expect(migration).toContain("ambiguous customer admin/site ownership");
    expect(migration.indexOf('ADD COLUMN "loginId" TEXT')).toBeLessThan(migration.indexOf("DO $$"));
    expect(migration.indexOf("DO $$")).toBeLessThan(migration.indexOf('CREATE UNIQUE INDEX "User_loginId_key"'));
    expect(migration).toContain('ADD CONSTRAINT "User_loginId_format_check" CHECK ("loginId" IS NULL OR "loginId" ~');
    expect(migration).toContain('CREATE UNIQUE INDEX "User_loginId_key"');
    expect(migration).toMatch(/JOIN "User" AS admin[\s\S]*?AND admin\."status" = 'active'/);
  });

  it("drops only pending-site setup requirements in its own transactional migration", () => {
    expect(pendingSiteMigration.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(pendingSiteMigration.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(pendingSiteMigration).toContain('ALTER COLUMN "address" DROP NOT NULL');
    expect(pendingSiteMigration).toContain('ALTER COLUMN "tariffKwhRate" DROP NOT NULL');
    expect(pendingSiteMigration).not.toContain('ALTER TABLE "User"');
  });

  it("enforces one operator record and active same-customer admin invariants across all owners", () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "User_single_operator_key" ON "User"("role")');
    expect(migration).toContain('WHERE "role" = \'operator\';');
    expect(migration).not.toContain('WHERE "role" = \'operator\' AND "status" = \'active\';');
    expect(migration).toContain('CREATE FUNCTION "validate_site_admin_assignment"()');
    expect(migration).toContain('CREATE TRIGGER "Site_validate_admin_assignment"');
    expect(migration).toContain('CREATE FUNCTION "validate_assigned_site_admin_user"()');
    expect(migration).toContain('CREATE TRIGGER "User_validate_assigned_site_admin"');
    expect(migration).toContain('BEFORE UPDATE OF "role", "status", "organizationId" ON "User"');
    expect(migration).toContain('CREATE FUNCTION "validate_customer_organization_type"()');
    expect(migration).toContain('CREATE TRIGGER "Organization_validate_assigned_site_admin"');
    expect(migration).toContain('BEFORE UPDATE OF "type" ON "Organization"');
    expect(migration).toMatch(/validate_site_admin_assignment[\s\S]*?FROM "User"[\s\S]*?FOR UPDATE[\s\S]*?FROM "Organization"[\s\S]*?FOR UPDATE/);
    expect(migration).toMatch(/validate_assigned_site_admin_user[\s\S]*?FROM "Site"[\s\S]*?FOR UPDATE[\s\S]*?FROM "Organization"[\s\S]*?FOR UPDATE/);
    expect(migration).toMatch(/validate_customer_organization_type[\s\S]*?FROM "Site"[\s\S]*?FOR UPDATE[\s\S]*?FROM "User"[\s\S]*?FOR UPDATE/);
    expect(migration).not.toContain("Lock related rows in Site -> User -> Organization order");
    expect(migration).toContain("statement-level advisory gate already serialized cross-table target-row");
    expect(migration).toContain('admin."role" = \'admin\'');
    expect(migration).toContain('admin."status" = \'active\'');
    expect(migration).toContain('organization."type" = \'customer\'');
    expect(migration).toContain('CREATE UNIQUE INDEX "Site_adminUserId_key"');
    expect(migration).toContain('ADD CONSTRAINT "Site_adminUserId_fkey"');
  });

  it("serializes invariant-affecting statements before PostgreSQL locks target rows", () => {
    expect(migration).toContain('CREATE FUNCTION "serialize_admin_assignment_writes"()');
    expect(migration).toContain("PERFORM pg_advisory_xact_lock(80520260827090000);");
    expect(migration).toMatch(
      /CREATE TRIGGER "Site_serialize_admin_assignment_writes"\s+BEFORE INSERT OR UPDATE OF "adminUserId", "organizationId" ON "Site"\s+FOR EACH STATEMENT EXECUTE FUNCTION "serialize_admin_assignment_writes"\(\);/
    );
    expect(migration).toMatch(
      /CREATE TRIGGER "User_serialize_admin_assignment_writes"\s+BEFORE INSERT OR UPDATE OF "role", "status", "organizationId" ON "User"\s+FOR EACH STATEMENT EXECUTE FUNCTION "serialize_admin_assignment_writes"\(\);/
    );
    expect(migration).toMatch(
      /CREATE TRIGGER "Organization_serialize_admin_assignment_writes"\s+BEFORE INSERT OR UPDATE OF "type" ON "Organization"\s+FOR EACH STATEMENT EXECUTE FUNCTION "serialize_admin_assignment_writes"\(\);/
    );
    expect(migration.indexOf('CREATE FUNCTION "serialize_admin_assignment_writes"()')).toBeLessThan(
      migration.indexOf('CREATE FUNCTION "validate_site_admin_assignment"()')
    );
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

    expectMigrationFailure(schemaName, "loginId collision");
  });

  it("rejects an invalid normalized login id before constraints are added", () => {
    const schemaName = createIsolatedSchema("invalid_login_id");
    installLegacyTables(schemaName);
    seedLegacyUsers(schemaName, ["admin+legacy@example.com"]);

    expectMigrationFailure(schemaName, "invalid loginId format");
  });

  it("rejects duplicate operator records regardless of status", () => {
    const schemaName = createIsolatedSchema("duplicate_operator");
    installLegacyTables(schemaName);
    seedOrganization(schemaName, "provider", "Provider", "service_provider");
    seedUser(schemaName, "operator-1", "provider", "operator-1@example.com", "operator", "active");
    seedUser(schemaName, "operator-2", "provider", "operator-2@example.com", "operator", "disabled");

    expectMigrationFailure(schemaName, "operator account count");
  });

  it.each([
    ["one admin and no sites", { admins: 1, sites: 0 }],
    ["one admin and two sites", { admins: 1, sites: 2 }],
    ["two admins and one site", { admins: 2, sites: 1 }]
  ])("rolls back an ambiguous customer with %s", (_label, input) => {
    const schemaName = createIsolatedSchema(`ambiguous_${input.admins}_${input.sites}`);
    installLegacyTables(schemaName);
    seedLegacyCustomer(schemaName, input);

    expectMigrationFailure(schemaName, "ambiguous customer admin/site ownership");
  });

  it("backfills only an active unambiguous one-admin one-site customer", () => {
    const schemaName = createIsolatedSchema("unambiguous_customer");
    installLegacyTables(schemaName);
    const { adminId, siteId } = seedLegacyCustomer(schemaName, { admins: 1, sites: 1 });

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    expect(readSiteAdminId(schemaName, siteId)).toBe(adminId);
  });

  it("leaves a customer with only disabled admins unassigned", () => {
    const schemaName = createIsolatedSchema("disabled_admin");
    installLegacyTables(schemaName);
    const { siteId } = seedLegacyCustomer(schemaName, { admins: 1, sites: 1, adminStatus: "disabled" });

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    expect(readSiteAdminId(schemaName, siteId)).toBe("");
  });

  it("rejects viewer and cross-tenant site-admin assignments", () => {
    const schemaName = createIsolatedSchema("invalid_assignment");
    installLegacyTables(schemaName);
    const { siteId } = seedLegacyCustomer(schemaName, { admins: 1, sites: 1 });

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    seedUser(schemaName, "viewer-1", "customer-1", "viewer-1@example.com", "viewer", "active", "viewer-1");
    seedOrganization(schemaName, "customer-2", "Customer 2", "customer");
    seedUser(schemaName, "admin-2", "customer-2", "admin-2@example.com", "admin", "active", "admin-2");

    expect(runSqlInSchema(schemaName, `UPDATE "Site" SET "adminUserId" = 'viewer-1' WHERE "id" = '${siteId}';`).stderr)
      .toContain("site admin must be an active admin in the same customer organization");
    expect(runSqlInSchema(schemaName, `UPDATE "Site" SET "adminUserId" = 'admin-2' WHERE "id" = '${siteId}';`).stderr)
      .toContain("site admin must be an active admin in the same customer organization");
  });

  it("rejects disabled admin site-admin assignments", () => {
    const schemaName = createIsolatedSchema("disabled_assignment");
    installLegacyTables(schemaName);
    const { siteId } = seedLegacyCustomer(schemaName, { admins: 1, sites: 1 });

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    seedUser(schemaName, "disabled-admin", "customer-1", "disabled-admin@example.com", "admin", "disabled", "disabled-admin");

    expect(runSqlInSchema(schemaName, `UPDATE "Site" SET "adminUserId" = 'disabled-admin' WHERE "id" = '${siteId}';`).stderr)
      .toContain("site admin must be an active admin in the same customer organization");
  });

  it("rejects changes that would invalidate an assigned admin and allows unassign-before-disable", () => {
    const schemaName = createIsolatedSchema("assigned_admin_user_update");
    installLegacyTables(schemaName);
    const { adminId, siteId } = seedLegacyCustomer(schemaName, { admins: 1, sites: 1 });
    seedOrganization(schemaName, "customer-2", "Customer 2", "customer");

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    for (const update of [
      `UPDATE "User" SET "role" = 'viewer' WHERE "id" = '${adminId}';`,
      `UPDATE "User" SET "status" = 'disabled' WHERE "id" = '${adminId}';`,
      `UPDATE "User" SET "organizationId" = 'customer-2' WHERE "id" = '${adminId}';`
    ]) {
      const result = runSqlInSchema(schemaName, update);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("assigned site admin must remain an active admin in the same customer organization");
    }

    expect(runSqlInSchema(schemaName, `UPDATE "Site" SET "adminUserId" = NULL WHERE "id" = '${siteId}';`).status).toBe(0);
    expect(runSqlInSchema(schemaName, `UPDATE "User" SET "status" = 'disabled' WHERE "id" = '${adminId}';`).status).toBe(0);
  });

  it("rejects converting a customer with an assigned admin while allowing unrelated organization changes", () => {
    const schemaName = createIsolatedSchema("assigned_admin_organization_update");
    installLegacyTables(schemaName);
    seedLegacyCustomer(schemaName, { admins: 1, sites: 1 });

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    const typeChange = runSqlInSchema(schemaName, `UPDATE "Organization" SET "type" = 'service_provider' WHERE "id" = 'customer-1';`);
    expect(typeChange.status).not.toBe(0);
    expect(typeChange.stderr).toContain("organization with assigned site admins must remain a customer");
    expect(runSqlInSchema(schemaName, `UPDATE "Organization" SET "name" = 'Renamed customer' WHERE "id" = 'customer-1';`).status).toBe(0);
  });

  it("enforces loginId checks and operator uniqueness after migration", () => {
    const schemaName = createIsolatedSchema("post_migration_user_constraints");
    installLegacyTables(schemaName);
    const { adminId } = seedLegacyCustomer(schemaName, { admins: 1, sites: 1 });
    seedOrganization(schemaName, "provider", "Provider", "service_provider");
    seedUser(schemaName, "operator-1", "provider", "operator-1@example.com", "operator", "active");

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    expect(runSqlInSchema(schemaName, `
      INSERT INTO "User" ("id", "organizationId", "loginId", "email", "name", "passwordHash", "role", "status")
      VALUES ('invalid-login', 'customer-1', 'invalid+login', 'invalid-login@example.com', 'Invalid', 'hash', 'viewer', 'active');
    `).stderr).toContain("User_loginId_format_check");
    expect(runSqlInSchema(schemaName, `UPDATE "User" SET "loginId" = 'invalid+login' WHERE "id" = '${adminId}';`).stderr)
      .toContain("User_loginId_format_check");
    expect(runSqlInSchema(schemaName, `
      INSERT INTO "User" ("id", "organizationId", "loginId", "email", "name", "passwordHash", "role", "status")
      VALUES ('shared-login-1', 'customer-1', 'shared-login', 'shared-login-1@example.com', 'Shared 1', 'hash', 'viewer', 'active');
    `).status).toBe(0);
    expect(runSqlInSchema(schemaName, `
      INSERT INTO "User" ("id", "organizationId", "loginId", "email", "name", "passwordHash", "role", "status")
      VALUES ('shared-login-2', 'customer-1', 'shared-login', 'shared-login-2@example.com', 'Shared 2', 'hash', 'viewer', 'active');
    `).stderr).toContain("User_loginId_key");
    expect(runSqlInSchema(schemaName, `UPDATE "User" SET "loginId" = 'shared-login' WHERE "id" = '${adminId}';`).stderr)
      .toContain("User_loginId_key");
    expect(runSqlInSchema(schemaName, `
      INSERT INTO "User" ("id", "organizationId", "loginId", "email", "name", "passwordHash", "role", "status")
      VALUES ('operator-2', 'provider', 'operator-2', 'operator-2@example.com', 'Operator 2', 'hash', 'operator', 'disabled');
    `).stderr).toContain("User_single_operator_key");
  });

  it("retains the site-admin foreign key independently of the assignment trigger", () => {
    const schemaName = createIsolatedSchema("site_admin_fk");
    installLegacyTables(schemaName);
    seedLegacyCustomer(schemaName, { admins: 1, sites: 1 });

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    const result = runSqlInSchema(schemaName, `
      ALTER TABLE "Site" DISABLE TRIGGER "Site_validate_admin_assignment";
      INSERT INTO "Site" ("id", "organizationId", "adminUserId", "name", "address", "tariffKwhRate")
      VALUES ('site-missing-admin', 'customer-1', 'missing-admin', 'Missing admin', 'Legacy address', 150.00);
    `);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Site_adminUserId_fkey");
  });

  it("keeps unique site-admin assignment after a valid migration", () => {
    const schemaName = createIsolatedSchema("duplicate_assignment");
    installLegacyTables(schemaName);
    const { adminId } = seedLegacyCustomer(schemaName, { admins: 1, sites: 1 });

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    const result = runSqlInSchema(schemaName, `
      INSERT INTO "Site" ("id", "organizationId", "adminUserId", "name", "address", "tariffKwhRate")
      VALUES ('site-2', 'customer-1', '${adminId}', 'Site 2', 'Legacy address', 150.00);
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Site_adminUserId_key");
  });

  it("serializes concurrent assigned-site validation and user disable without deadlock", async () => {
    const schemaName = createIsolatedSchema("concurrent_site_user_validation");
    installLegacyTables(schemaName);
    const { adminId, siteId } = seedLegacyCustomer(schemaName, { admins: 1, sites: 1 });

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    installConcurrencyDelayTriggers(schemaName);

    const [siteValidation, disable] = await Promise.all([
      runSqlInSchemaAsync(schemaName, `UPDATE "Site" SET "adminUserId" = "adminUserId" WHERE "id" = '${siteId}';`),
      runSqlInSchemaAsync(schemaName, `UPDATE "User" SET "status" = 'disabled' WHERE "id" = '${adminId}';`)
    ]);

    expect(siteValidation.status).toBe(0);
    expect(disable.status).not.toBe(0);
    expect(`${siteValidation.stderr}\n${disable.stderr}`).not.toMatch(/40P01|deadlock detected/i);
    expect(disable.stderr).toContain("assigned site admin must remain an active admin in the same customer organization");
    expect(readInvalidSiteAdminCount(schemaName)).toBe("0");
    expect(query(schemaName, `
      SELECT COALESCE(site."adminUserId", '') || '|' || admin."status"
      FROM "Site" AS site
      JOIN "User" AS admin ON admin."id" = '${adminId}'
      WHERE site."id" = '${siteId}';
    `)).toBe("admin-1|active");
  }, 15_000);

  it("serializes concurrent assigned-site validation and organization type change without deadlock", async () => {
    const schemaName = createIsolatedSchema("concurrent_site_organization_validation");
    installLegacyTables(schemaName);
    const { siteId } = seedLegacyCustomer(schemaName, { admins: 1, sites: 1 });

    expect(applyOperatorAdminMigration(schemaName).status).toBe(0);
    installConcurrencyDelayTriggers(schemaName);

    const [siteValidation, typeChange] = await Promise.all([
      runSqlInSchemaAsync(schemaName, `UPDATE "Site" SET "adminUserId" = "adminUserId" WHERE "id" = '${siteId}';`),
      runSqlInSchemaAsync(schemaName, `UPDATE "Organization" SET "type" = 'service_provider' WHERE "id" = 'customer-1';`)
    ]);

    expect(siteValidation.status).toBe(0);
    expect(typeChange.status).not.toBe(0);
    expect(`${siteValidation.stderr}\n${typeChange.stderr}`).not.toMatch(/40P01|deadlock detected/i);
    expect(typeChange.stderr).toContain("organization with assigned site admins must remain a customer");
    expect(readInvalidSiteAdminCount(schemaName)).toBe("0");
    expect(query(schemaName, `SELECT "type" FROM "Organization" WHERE "id" = 'customer-1';`)).toBe("customer");
  }, 15_000);

  function expectMigrationFailure(schemaName: string, message: string) {
    const result = applyOperatorAdminMigration(schemaName);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(query(schemaName, loginIdColumnCountSql())).toBe("0");
    expect(query(schemaName, adminUserIdColumnCountSql())).toBe("0");
  }

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
        "email" TEXT NOT NULL UNIQUE,
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
    seedOrganization(schemaName, "customer-1", "Customer", "customer");
    for (const [index, email] of emails.entries()) {
      seedUser(schemaName, `user-${index}`, "customer-1", email, "viewer", "active");
    }
  }

  function seedLegacyCustomer(
    schemaName: string,
    input: { admins: number; sites: number; adminStatus?: "active" | "disabled" }
  ) {
    const adminId = "admin-1";
    const siteId = "site-1";
    seedOrganization(schemaName, "customer-1", "Customer", "customer");
    for (let index = 0; index < input.admins; index += 1) {
      seedUser(schemaName, `admin-${index + 1}`, "customer-1", `admin-${index + 1}@example.com`, "admin", input.adminStatus ?? "active");
    }
    for (let index = 0; index < input.sites; index += 1) {
      execute(schemaName, `
        INSERT INTO "Site" ("id", "organizationId", "name", "address", "tariffKwhRate")
        VALUES ('site-${index + 1}', 'customer-1', 'Site ${index + 1}', 'Legacy address', 150.00);
      `);
    }
    return { adminId, siteId };
  }

  function seedOrganization(schemaName: string, id: string, name: string, type: "service_provider" | "customer") {
    execute(schemaName, `INSERT INTO "Organization" ("id", "name", "type") VALUES ('${id}', '${name}', '${type}');`);
  }

  function seedUser(
    schemaName: string,
    id: string,
    organizationId: string,
    email: string,
    role: "operator" | "admin" | "viewer",
    status: "active" | "disabled",
    loginId?: string
  ) {
    const loginIdColumn = loginId ? ', "loginId"' : "";
    const loginIdValue = loginId ? `, '${sqlLiteral(loginId)}'` : "";
    execute(schemaName, `
      INSERT INTO "User" ("id", "organizationId", "email", "name", "passwordHash", "role", "status"${loginIdColumn})
      VALUES ('${id}', '${organizationId}', '${sqlLiteral(email)}', '${id}', 'hash', '${role}', '${status}'${loginIdValue});
    `);
  }

  function applyOperatorAdminMigration(schemaName: string) {
    return runSqlInSchema(schemaName, migration);
  }

  function installConcurrencyDelayTriggers(schemaName: string) {
    execute(schemaName, `
      CREATE FUNCTION "delay_admin_invariant_row_write"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        -- The 00_ trigger names run before the production row validators. Each
        -- session pauses only after PostgreSQL has locked its own target row.
        PERFORM pg_sleep(1);
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER "00_delay_site_admin_assignment"
      BEFORE UPDATE OF "adminUserId" ON "Site"
      FOR EACH ROW EXECUTE FUNCTION "delay_admin_invariant_row_write"();

      CREATE TRIGGER "00_delay_user_admin_state"
      BEFORE UPDATE OF "status" ON "User"
      FOR EACH ROW EXECUTE FUNCTION "delay_admin_invariant_row_write"();

      CREATE TRIGGER "00_delay_organization_type"
      BEFORE UPDATE OF "type" ON "Organization"
      FOR EACH ROW EXECUTE FUNCTION "delay_admin_invariant_row_write"();
    `);
  }

  function readInvalidSiteAdminCount(schemaName: string) {
    return query(schemaName, `
      SELECT COUNT(*)
      FROM "Site" AS site
      JOIN "User" AS admin ON admin."id" = site."adminUserId"
      JOIN "Organization" AS organization ON organization."id" = site."organizationId"
      WHERE admin."organizationId" <> site."organizationId"
        OR admin."role" <> 'admin'
        OR admin."status" <> 'active'
        OR organization."type" <> 'customer';
    `);
  }

  function readSiteAdminId(schemaName: string, siteId: string) {
    return query(schemaName, `SELECT "adminUserId" FROM "Site" WHERE "id" = '${siteId}';`);
  }

  function execute(schemaName: string, sql: string) {
    const result = runSqlInSchema(schemaName, sql);
    if (result.status !== 0) throw new Error(result.stderr);
  }

  function query(schemaName: string, sql: string) {
    const result = runSqlInSchema(schemaName, sql, ["-qAt"]);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  function runSqlInSchema(schemaName: string, sql: string, extraArgs: string[] = ["-q"]) {
    return runSql(`SET search_path TO "${schemaName}";\n${sql}`, extraArgs);
  }

  function runSql(sql: string, extraArgs: string[] = ["-q"]) {
    return spawnSync("psql", [...extraArgs, "-v", "ON_ERROR_STOP=1", databaseUrl!], { encoding: "utf8", input: sql });
  }

  function runSqlInSchemaAsync(schemaName: string, sql: string) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("psql", ["-q", "-v", "ON_ERROR_STOP=1", databaseUrl!], { stdio: "pipe" });
      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(`\\set VERBOSITY verbose\nSET lock_timeout = '5s';\nSET search_path TO "${schemaName}";\n${sql}`);
    });
  }
});

function loginIdColumnCountSql() {
  return `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'User' AND column_name = 'loginId';`;
}

function adminUserIdColumnCountSql() {
  return `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Site' AND column_name = 'adminUserId';`;
}

function sqlLiteral(value: string) {
  return value.replaceAll("'", "''");
}
