import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const databaseUrl = process.env.MONITORING_INCIDENTS_TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)("monitoring policy/incident migration", () => {
  let prisma: PrismaClient;
  beforeAll(() => { prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } }); });
  afterAll(async () => prisma?.$disconnect());

  it("adds policy defaults and the incident store to the migrated database", async () => {
    const columns = await prisma.$queryRaw<{ column_name: string; column_default: string }[]>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Site'
      AND column_name IN ('gatewayOfflineAfterSeconds', 'fixtureStaleAfterSeconds') ORDER BY column_name
    `;
    expect(columns).toEqual([
      { column_name: "fixtureStaleAfterSeconds", column_default: "180" },
      { column_name: "gatewayOfflineAfterSeconds", column_default: "90" }
    ]);
    const [table] = await prisma.$queryRaw<{ present: boolean }[]>`
      SELECT to_regclass('public."MonitoringIncident"') IS NOT NULL AS present
    `;
    expect(table.present).toBe(true);
  });

  it("preserves existing Site rows while adding defaults in an isolated upgrade schema", () => {
    const migration = readFileSync(join(__dirname, "../../prisma/migrations/20260912100000_monitoring_policy_incidents/migration.sql"), "utf8")
      .replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, "");
    const url = new URL(databaseUrl!);
    const password = decodeURIComponent(url.password);
    url.password = ""; url.searchParams.delete("schema");
    const result = spawnSync("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", "--dbname", url.toString()], {
      encoding: "utf8", env: { ...process.env, PGPASSWORD: password }, input: `
        BEGIN;
        CREATE SCHEMA monitoring_upgrade_${process.pid};
        SET LOCAL search_path TO monitoring_upgrade_${process.pid};
        CREATE TABLE "Site" ("id" TEXT PRIMARY KEY, "name" TEXT);
        CREATE TABLE "User" ("id" TEXT PRIMARY KEY);
        CREATE TABLE "Fixture" ("id" TEXT PRIMARY KEY, "siteId" TEXT);
        CREATE TABLE "Gateway" ("id" TEXT PRIMARY KEY, "siteId" TEXT, UNIQUE ("id", "siteId"));
        INSERT INTO "Site" VALUES ('legacy', '기존 현장');
        ${migration}
        SELECT "id" || '|' || "name" || '|' || "gatewayOfflineAfterSeconds" || '|' || "fixtureStaleAfterSeconds" FROM "Site";
        ROLLBACK;`
    });
    expect(result.stderr).not.toContain("ERROR");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("legacy|기존 현장|90|180");
  });
});
