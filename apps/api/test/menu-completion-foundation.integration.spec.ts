import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const databaseUrl = process.env.MENU_COMPLETION_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const migration = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260826_menu_completion_foundation/migration.sql"
), "utf8");
const scanOutboxMigration = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260826150000_add_provisioning_scan_outbox/migration.sql"
), "utf8");

describeWithPostgres("menu completion foundation PostgreSQL rehearsal", () => {
  const schemas: string[] = [];

  afterAll(() => {
    for (const schema of schemas) runSql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
  });

  it("backfills only valid legacy groups and guards deferred membership boundaries", () => {
    const schema = `menu_completion_${process.pid}_${Date.now()}`.toLowerCase();
    schemas.push(schema);
    runSql(`CREATE SCHEMA "${schema}";`);
    execute(schema, legacyTables());
    execute(schema, legacyRows());

    expect(runMigration(schema).status).toBe(0);
    expect(runScanOutboxMigration(schema).status).toBe(0);
    expect(query(schema, `SELECT "lifecycleStatus" FROM "FixtureGroup" WHERE "id" = 'valid';`)).toBe("active");
    expect(query(schema, `SELECT COUNT(*) FROM "FixtureGroup" WHERE "id" LIKE 'over-%' AND "lifecycleStatus" = 'invalid';`)).toBe("16");
    expect(query(schema, `SELECT "lifecycleStatus" FROM "FixtureGroup" WHERE "id" = 'cross-boundary';`)).toBe("invalid");
    expect(query(schema, `SELECT column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'FixtureGroup' AND column_name = 'lifecycleStatus';`)).toContain("active");

    execute(schema, `
      BEGIN;
      INSERT INTO "FixtureGroup" ("id", "siteId", "name", "floorId", "gatewayId")
        VALUES ('next', 'site', 'next', 'floor-a', 'gateway-a');
      INSERT INTO "GroupFixture" ("groupId", "fixtureId") VALUES ('next', 'fixture-b');
      COMMIT;
    `);
    expect(query(schema, `SELECT "lifecycleStatus" FROM "FixtureGroup" WHERE "id" = 'next';`)).toBe("active");

    const movedFromOldGroup = runSql(`SET search_path TO "${schema}";
      BEGIN;
      UPDATE "GroupFixture" SET "groupId" = 'next' WHERE "groupId" = 'valid' AND "fixtureId" = 'fixture-a';
      COMMIT;`);
    expect(movedFromOldGroup.status).not.toBe(0);
    expect(movedFromOldGroup.stderr).toContain("active FixtureGroup requires at least one member");

    const changedFixtureBoundary = runSql(`SET search_path TO "${schema}";
      BEGIN;
      UPDATE "Fixture" SET "floorId" = 'floor-b' WHERE "id" = 'fixture-a';
      COMMIT;`);
    expect(changedFixtureBoundary.status).not.toBe(0);
    expect(changedFixtureBoundary.stderr).toContain("active FixtureGroup members must match its floor and gateway");

    execute(schema, `INSERT INTO "ProvisioningSession" ("id", "gatewayId", "scanStatus") VALUES ('scan-one', 'gateway-a', 'scanning');`);
    const duplicateScanningSession = runSql(`SET search_path TO "${schema}";
      INSERT INTO "ProvisioningSession" ("id", "gatewayId", "scanStatus") VALUES ('scan-two', 'gateway-a', 'scanning');`);
    expect(duplicateScanningSession.status).not.toBe(0);
    expect(duplicateScanningSession.stderr).toContain("ProvisioningSession_single_scanning_gateway_key");

    const pendingSession = runSql(`SET search_path TO "${schema}";
      INSERT INTO "ProvisioningSession" ("id", "gatewayId", "scanStatus") VALUES ('scan-pending', 'gateway-a', 'pending');`);
    expect(pendingSession.status).not.toBe(0);
    expect(pendingSession.stderr).toContain("ProvisioningSession_single_scanning_gateway_key");
    expect(query(schema, `SELECT COUNT(*) FROM "ProvisioningScanOutbox";`)).toBe("0");
  });
});

function legacyTables() {
  return `
    CREATE TYPE "MeshControlGroupStatus" AS ENUM ('active', 'invalid');
    CREATE TABLE "Site" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "Floor" ("id" TEXT PRIMARY KEY, "siteId" TEXT NOT NULL);
    CREATE TABLE "Gateway" ("id" TEXT PRIMARY KEY, "siteId" TEXT NOT NULL);
    CREATE TABLE "MeshNode" ("id" TEXT PRIMARY KEY, "gatewayId" TEXT NOT NULL);
    CREATE TABLE "Fixture" ("id" TEXT PRIMARY KEY, "floorId" TEXT NOT NULL, "meshNodeId" TEXT);
    CREATE TABLE "FixtureGroup" ("id" TEXT PRIMARY KEY, "siteId" TEXT NOT NULL, "name" TEXT NOT NULL);
    CREATE TABLE "GroupFixture" ("groupId" TEXT NOT NULL, "fixtureId" TEXT NOT NULL, PRIMARY KEY ("groupId", "fixtureId"));
    CREATE TABLE "MeshControlGroupMember" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "ProvisioningSession" ("id" TEXT PRIMARY KEY, "gatewayId" TEXT NOT NULL);
    CREATE TABLE "Command" (
      "id" TEXT PRIMARY KEY, "siteId" TEXT NOT NULL, "requestedBy" TEXT NOT NULL,
      "targetType" TEXT NOT NULL, "targetId" TEXT, "targetFixtureIds" JSONB NOT NULL, "brightness" INTEGER NOT NULL
    );
  `;
}

function legacyRows() {
  const overLimitGroups = Array.from({ length: 16 }, (_, index) => `
    ('over-${index + 1}', 'site', 'over-${index + 1}')`).join(",");
  const overLimitMemberships = Array.from({ length: 16 }, (_, index) => `('over-${index + 1}', 'fixture-over')`).join(",");
  return `
    INSERT INTO "Site" VALUES ('site'), ('other-site');
    INSERT INTO "Floor" VALUES ('floor-a', 'site'), ('floor-b', 'site'), ('floor-cross', 'other-site');
    INSERT INTO "Gateway" VALUES ('gateway-a', 'site');
    INSERT INTO "MeshNode" VALUES ('node-a', 'gateway-a'), ('node-b', 'gateway-a'), ('node-over', 'gateway-a');
    INSERT INTO "Fixture" VALUES ('fixture-a', 'floor-a', 'node-a'), ('fixture-b', 'floor-a', 'node-b'), ('fixture-over', 'floor-a', 'node-over'), ('fixture-cross', 'floor-cross', 'node-a');
    INSERT INTO "FixtureGroup" ("id", "siteId", "name") VALUES ('valid', 'site', 'valid'), ('cross-boundary', 'site', 'cross-boundary'), ${overLimitGroups};
    INSERT INTO "GroupFixture" VALUES ('valid', 'fixture-a'), ('cross-boundary', 'fixture-cross'), ${overLimitMemberships};
  `;
}

function execute(schema: string, sql: string) {
  const result = runSql(`SET search_path TO "${schema}";\n${sql}`);
  if (result.status !== 0) throw new Error(result.stderr);
}

function query(schema: string, sql: string) {
  const result = runSql(`SET search_path TO "${schema}";\n${sql}`, ["-qAt"]);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function runMigration(schema: string) {
  return runSql(`SET search_path TO "${schema}";\n${migration}`);
}

function runScanOutboxMigration(schema: string) {
  return runSql(`SET search_path TO "${schema}";\n${scanOutboxMigration}`);
}

function runSql(sql: string, extraArgs: string[] = ["-q"]) {
  return spawnSync("psql", [...extraArgs, "-v", "ON_ERROR_STOP=1", databaseUrl!], { encoding: "utf8", input: sql });
}
