import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const migrationPath = join(__dirname, "../../prisma/migrations/20260910010000_site_user_access/migration.sql");
const schemaPath = join(__dirname, "../../prisma/schema.prisma");
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const schema = readFileSync(schemaPath, "utf8");
const databaseUrl = process.env.SITE_USER_ACCESS_MIGRATION_TEST_DATABASE_URL;
const psqlDatabaseUrl = databaseUrl?.replace(/\?schema=[^&]+$/, "");
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describe("site user access migration static contract", () => {
  it("declares access levels, password-change state, and user deletion policies", () => {
    expect(schema).toMatch(/enum SiteAccessLevel\s*\{\s*read\s*control\s*\}/);
    expect(schema).toMatch(/mustChangePassword\s+Boolean\s+@default\(false\)/);
    expect(schema).toMatch(/accessLevel\s+SiteAccessLevel\s+@default\(read\)/);
    expect(schema).toMatch(/requestedBy\s+String\?/);
    expect(schema).toMatch(/requestedById\s+String\?/);
    expect(schema).toMatch(/user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/);
    expect(schema).toMatch(/user\s+User\?\s+@relation\(fields: \[requestedBy\], references: \[id\], onDelete: SetNull\)/);
    expect(schema).toMatch(/requestedBy\s+User\?\s+@relation\("ManualOverrideRequestedBy", fields: \[requestedById\], references: \[id\], onDelete: SetNull/);
    expect(schema).toMatch(/command\s+Command\s+@relation\(fields: \[commandId\], references: \[id\], onDelete: Cascade/);
    expect(schema).not.toMatch(/@@unique\(\[id, siteId, requestedBy\]\)/);
    expect(schema).not.toMatch(/@@unique\(\[commandId, siteId, requestedById\]\)/);
    expect(schema).not.toMatch(/fields: \[commandId, siteId, requestedById\]/);
  });

  it("contains the SQL changes required for the contract", () => {
    expect(migration).toContain('CREATE TYPE "SiteAccessLevel" AS ENUM (\'read\', \'control\')');
    expect(migration).toContain('ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false');
    expect(migration).toContain('ADD COLUMN "accessLevel" "SiteAccessLevel" NOT NULL DEFAULT \'read\'');
    expect(migration).toContain('ON DELETE SET NULL');
    expect(migration).toContain('ON DELETE CASCADE');
  });
});

describeWithPostgres("site user access migration PostgreSQL rehearsal", () => {
  const schemas: string[] = [];
  let sequence = 0;

  afterAll(() => {
    for (const schemaName of schemas) runSql(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  });

  it("backfills read access and anonymizes durable command history when a user is deleted", () => {
    const schemaName = createSchema("delete_user");
    installLegacyTables(schemaName);
    seedUserHistory(schemaName);

    expect(applyMigration(schemaName).status).toBe(0);
    expect(query(schemaName, `SELECT "accessLevel"::text FROM "SiteMembership" WHERE "id" = 'membership-1';`)).toBe("read");
    expect(query(schemaName, `SELECT "mustChangePassword" FROM "User" WHERE "id" = 'user-1';`)).toBe("f");

    expect(run(schemaName, `DELETE FROM "User" WHERE "id" = 'user-1';`).status).toBe(0);
    expect(query(schemaName, `SELECT COUNT(*) FROM "Session" WHERE "userId" = 'user-1';`)).toBe("0");
    expect(query(schemaName, `SELECT COUNT(*) FROM "SiteMembership" WHERE "userId" = 'user-1';`)).toBe("0");
    expect(query(schemaName, `SELECT COALESCE("requestedBy", 'NULL') FROM "Command" WHERE "id" = 'command-1';`)).toBe("NULL");
    expect(query(schemaName, `SELECT COALESCE("requestedById", 'NULL') FROM "ManualOverride" WHERE "id" = 'override-1';`)).toBe("NULL");
    expect(query(schemaName, `SELECT "commandId" FROM "ManualOverride" WHERE "id" = 'override-1';`)).toBe("command-1");
  });

  function createSchema(suffix: string) {
    const schemaName = `site_user_access_${process.pid}_${Date.now()}_${sequence++}_${suffix}`.toLowerCase();
    schemas.push(schemaName);
    runSql(`CREATE SCHEMA "${schemaName}";`);
    return schemaName;
  }

  function installLegacyTables(schemaName: string) {
    execute(schemaName, `
      CREATE TABLE "User" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "Site" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "Session" (
        "id" TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL,
        CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id")
      );
      CREATE TABLE "SiteMembership" (
        "id" TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "siteId" TEXT NOT NULL,
        CONSTRAINT "SiteMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
        CONSTRAINT "SiteMembership_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE
      );
      CREATE TABLE "Command" (
        "id" TEXT PRIMARY KEY,
        "siteId" TEXT NOT NULL,
        "requestedBy" TEXT NOT NULL,
        CONSTRAINT "Command_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "User"("id")
      );
      CREATE UNIQUE INDEX "Command_id_siteId_requestedBy_key" ON "Command"("id", "siteId", "requestedBy");
      CREATE TABLE "ManualOverride" (
        "id" TEXT PRIMARY KEY,
        "siteId" TEXT NOT NULL,
        "commandId" TEXT NOT NULL UNIQUE,
        "requestedById" TEXT NOT NULL,
        CONSTRAINT "ManualOverride_commandId_siteId_requestedById_fkey"
          FOREIGN KEY ("commandId", "siteId", "requestedById")
          REFERENCES "Command"("id", "siteId", "requestedBy") ON DELETE CASCADE ON UPDATE RESTRICT,
        CONSTRAINT "ManualOverride_requestedById_fkey"
          FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX "ManualOverride_commandId_siteId_requestedById_key"
        ON "ManualOverride"("commandId", "siteId", "requestedById");
    `);
  }

  function seedUserHistory(schemaName: string) {
    execute(schemaName, `
      INSERT INTO "User" ("id") VALUES ('user-1');
      INSERT INTO "Site" ("id") VALUES ('site-1');
      INSERT INTO "Session" ("id", "userId") VALUES ('session-1', 'user-1');
      INSERT INTO "SiteMembership" ("id", "userId", "siteId") VALUES ('membership-1', 'user-1', 'site-1');
      INSERT INTO "Command" ("id", "siteId", "requestedBy") VALUES ('command-1', 'site-1', 'user-1');
      INSERT INTO "ManualOverride" ("id", "siteId", "commandId", "requestedById") VALUES ('override-1', 'site-1', 'command-1', 'user-1');
    `);
  }

  function applyMigration(schemaName: string) {
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
    return spawnSync("psql", [...extraArgs, "-v", "ON_ERROR_STOP=1", psqlDatabaseUrl!], { encoding: "utf8", input: sql });
  }
});
