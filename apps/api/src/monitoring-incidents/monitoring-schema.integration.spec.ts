import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const databaseUrl = process.env.MONITORING_INCIDENTS_TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)("monitoring policy/incident migration", () => {
  let prisma: PrismaClient;
  beforeAll(() => { prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } }); });
  afterAll(async () => prisma?.$disconnect());

  it("stores durable reported fixture state separately from operational freshness", async () => {
    const columns = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Fixture'
      AND column_name IN ('reportedStatus', 'reportedStatusReason') ORDER BY column_name
    `;
    expect(columns).toEqual([
      { column_name: "reportedStatus", is_nullable: "NO" },
      { column_name: "reportedStatusReason", is_nullable: "YES" }
    ]);
  });

  it("adds policy defaults and the incident store to the migrated database", async () => {
    const columns = await prisma.$queryRaw<{ column_name: string; column_default: string }[]>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Site'
      AND column_name IN ('gatewayOfflineAfterSeconds', 'fixtureStaleAfterSeconds') ORDER BY column_name
    `;
    expect(columns).toEqual([
      { column_name: "fixtureStaleAfterSeconds", column_default: "1200" },
      { column_name: "gatewayOfflineAfterSeconds", column_default: "90" }
    ]);
    const [table] = await prisma.$queryRaw<{ present: boolean }[]>`
      SELECT to_regclass('public."MonitoringIncident"') IS NOT NULL AS present
    `;
    expect(table.present).toBe(true);
  });

  it("persists the monitoring refresh aggregate with durable constraints and relations", async () => {
    const [tables, enums, constraints, indexes, fixtureColumn] = await Promise.all([
      prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN (
          'MonitoringRefresh', 'MonitoringRefreshBatch', 'MonitoringRefreshFixture'
        ) ORDER BY table_name
      `,
      prisma.$queryRaw<{ typname: string; enumlabel: string }[]>`
        SELECT t.typname, e.enumlabel FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname IN (
          'MonitoringRefreshStatus', 'MonitoringRefreshBatchStatus', 'MonitoringRefreshFixtureStatus'
        ) ORDER BY t.typname, e.enumsortorder
      `,
      prisma.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conrelid IN (
          '"MonitoringRefresh"'::regclass,
          '"MonitoringRefreshBatch"'::regclass,
          '"MonitoringRefreshFixture"'::regclass,
          '"MqttOutbox"'::regclass
        ) AND conname IN (
          'MonitoringRefresh_pkey',
          'MonitoringRefresh_siteId_fkey',
          'MonitoringRefresh_floorId_siteId_fkey',
          'MonitoringRefresh_requestedById_fkey',
          'MonitoringRefresh_counters_check',
          'MonitoringRefresh_status_check',
          'MonitoringRefreshBatch_pkey',
          'MonitoringRefreshBatch_refreshId_siteId_fkey',
          'MonitoringRefreshBatch_gatewayId_siteId_fkey',
          'MonitoringRefreshBatch_targetFixtureIds_check',
          'MonitoringRefreshBatch_status_check',
          'MonitoringRefreshFixture_pkey',
          'MonitoringRefreshFixture_refreshId_siteId_fkey',
          'MonitoringRefreshFixture_batchId_refreshId_fkey',
          'MonitoringRefreshFixture_fixtureId_siteId_fkey',
          'MonitoringRefreshFixture_status_check',
          'MqttOutbox_monitoringRefreshBatchId_fkey'
        ) ORDER BY conname
      `,
      prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN (
          'MonitoringRefresh', 'MonitoringRefreshBatch', 'MonitoringRefreshFixture', 'MqttOutbox'
        ) AND indexname IN (
          'MonitoringRefresh_siteId_requestedById_clientRequestId_key',
          'MonitoringRefresh_id_siteId_key',
          'MonitoringRefresh_siteId_floorId_status_idx',
          'MonitoringRefresh_createdAt_idx',
          'MonitoringRefreshBatch_gatewayId_sequence_key',
          'MonitoringRefreshBatch_id_refreshId_key',
          'MonitoringRefreshBatch_idempotencyKey_key',
          'MonitoringRefreshBatch_refreshId_status_idx',
          'MonitoringRefreshFixture_batchId_status_idx',
          'MonitoringRefreshFixture_fixtureId_idx',
          'MqttOutbox_monitoringRefreshBatchId_key'
        ) ORDER BY indexname
      `,
      prisma.$queryRaw<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Fixture' AND column_name = 'lastUnreachableAt'
      `
    ]);

    expect(tables).toEqual([
      { table_name: "MonitoringRefresh" },
      { table_name: "MonitoringRefreshBatch" },
      { table_name: "MonitoringRefreshFixture" }
    ]);
    expect(enums).toEqual([
      { typname: "MonitoringRefreshBatchStatus", enumlabel: "pending" },
      { typname: "MonitoringRefreshBatchStatus", enumlabel: "published" },
      { typname: "MonitoringRefreshBatchStatus", enumlabel: "completed" },
      { typname: "MonitoringRefreshBatchStatus", enumlabel: "failed" },
      { typname: "MonitoringRefreshBatchStatus", enumlabel: "expired" },
      { typname: "MonitoringRefreshFixtureStatus", enumlabel: "pending" },
      { typname: "MonitoringRefreshFixtureStatus", enumlabel: "online" },
      { typname: "MonitoringRefreshFixtureStatus", enumlabel: "offline" },
      { typname: "MonitoringRefreshFixtureStatus", enumlabel: "unverified" },
      { typname: "MonitoringRefreshStatus", enumlabel: "pending" },
      { typname: "MonitoringRefreshStatus", enumlabel: "completed" },
      { typname: "MonitoringRefreshStatus", enumlabel: "partial" },
      { typname: "MonitoringRefreshStatus", enumlabel: "failed" },
      { typname: "MonitoringRefreshStatus", enumlabel: "expired" }
    ]);
    expect(constraints.map(({ conname }) => conname)).toEqual([
      "MonitoringRefreshBatch_gatewayId_siteId_fkey",
      "MonitoringRefreshBatch_pkey",
      "MonitoringRefreshBatch_refreshId_siteId_fkey",
      "MonitoringRefreshBatch_status_check",
      "MonitoringRefreshBatch_targetFixtureIds_check",
      "MonitoringRefreshFixture_batchId_refreshId_fkey",
      "MonitoringRefreshFixture_fixtureId_siteId_fkey",
      "MonitoringRefreshFixture_pkey",
      "MonitoringRefreshFixture_refreshId_siteId_fkey",
      "MonitoringRefreshFixture_status_check",
      "MonitoringRefresh_counters_check",
      "MonitoringRefresh_floorId_siteId_fkey",
      "MonitoringRefresh_pkey",
      "MonitoringRefresh_requestedById_fkey",
      "MonitoringRefresh_siteId_fkey",
      "MonitoringRefresh_status_check",
      "MqttOutbox_monitoringRefreshBatchId_fkey"
    ].sort());
    expect(indexes.map(({ indexname }) => indexname)).toEqual([
      "MonitoringRefresh_siteId_requestedById_clientRequestId_key",
      "MonitoringRefresh_id_siteId_key",
      "MonitoringRefresh_siteId_floorId_status_idx",
      "MonitoringRefresh_createdAt_idx",
      "MonitoringRefreshBatch_gatewayId_sequence_key",
      "MonitoringRefreshBatch_id_refreshId_key",
      "MonitoringRefreshBatch_idempotencyKey_key",
      "MonitoringRefreshBatch_refreshId_status_idx",
      "MonitoringRefreshFixture_batchId_status_idx",
      "MonitoringRefreshFixture_fixtureId_idx",
      "MqttOutbox_monitoringRefreshBatchId_key"
    ].sort());
    expect(fixtureColumn).toEqual([{ is_nullable: "YES" }]);
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

  it("adds BIO presence metadata, exact range checks, and an atomic checkpoint", () => {
    const migration = readFileSync(join(__dirname,
      "../../prisma/migrations/20260918120000_bio_fixture_presence_polling/migration.sql"), "utf8")
      .replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, "");
    const url = new URL(databaseUrl!);
    const password = decodeURIComponent(url.password);
    url.password = ""; url.searchParams.delete("schema");
    const result = spawnSync("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", "--dbname", url.toString()], {
      encoding: "utf8", env: { ...process.env, PGPASSWORD: password }, input: `
        BEGIN;
        CREATE SCHEMA presence_upgrade_${process.pid};
        SET LOCAL search_path TO presence_upgrade_${process.pid};
        CREATE TABLE "Site" ("id" TEXT PRIMARY KEY, "fixtureStaleAfterSeconds" INTEGER NOT NULL DEFAULT 180);
        CREATE TABLE "Fixture" ("id" TEXT PRIMARY KEY);
        INSERT INTO "Site" ("id") VALUES ('legacy');
        ${migration}
        INSERT INTO "Site" ("id") VALUES ('new');
        SELECT "id" || '|' || "fixtureStaleAfterSeconds" FROM "Site" ORDER BY "id";
        SELECT conname FROM pg_constraint WHERE conrelid = '"Fixture"'::regclass AND contype = 'c' ORDER BY conname;
        SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'Fixture' ORDER BY indexname;
        DO $$ BEGIN
          INSERT INTO "Fixture" ("id", "bioControlMode") VALUES ('bad-mode', 'guess');
          RAISE EXCEPTION 'control-mode check was not enforced';
        EXCEPTION WHEN check_violation THEN NULL; END $$;
        DO $$ BEGIN
          INSERT INTO "Fixture" ("id", "bioConfiguredBrightness") VALUES ('bad-configured', 101);
          RAISE EXCEPTION 'configured-brightness check was not enforced';
        EXCEPTION WHEN check_violation THEN NULL; END $$;
        DO $$ BEGIN
          INSERT INTO "Fixture" ("id", "bioRawHighBrightness") VALUES ('bad-raw', 256);
          RAISE EXCEPTION 'raw-brightness check was not enforced';
        EXCEPTION WHEN check_violation THEN NULL; END $$;
        DO $$ BEGIN
          INSERT INTO "Fixture" ("id", "lastPresenceEventId") VALUES ('partial-checkpoint', 'event');
          RAISE EXCEPTION 'presence checkpoint check was not enforced';
        EXCEPTION WHEN check_violation THEN NULL; END $$;
        INSERT INTO "Fixture" ("id") VALUES ('all-null-checkpoint');
        INSERT INTO "Fixture" ("id", "lastPresenceEventId", "lastPresenceSequence", "lastPresenceOccurredAt")
          VALUES ('complete-checkpoint', 'event', 1, '2026-09-14T00:00:00Z');
        ROLLBACK;`
    });
    expect(result.stderr).not.toContain("ERROR");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("legacy|1200");
    expect(result.stdout).toContain("new|1200");
    expect(result.stdout).toContain("Fixture_bioControlMode_check");
    expect(result.stdout).toContain("Fixture_bioConfiguredBrightness_check");
    expect(result.stdout).toContain("Fixture_bioRawHighBrightness_check");
    expect(result.stdout).toContain("Fixture_presenceCheckpoint_check");
    expect(result.stdout).toContain("Fixture_lastPresenceEventId_key");
  });

  it("backfills reported state without changing operational state or revisions and defaults new fixtures offline", () => {
    const migration = readFileSync(join(__dirname, "../../prisma/migrations/20260912110000_fixture_reported_state/migration.sql"), "utf8")
      .replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, "");
    const url = new URL(databaseUrl!);
    const password = decodeURIComponent(url.password);
    url.password = ""; url.searchParams.delete("schema");
    const result = spawnSync("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", "--dbname", url.toString()], {
      encoding: "utf8", env: { ...process.env, PGPASSWORD: password }, input: `
        BEGIN;
        CREATE SCHEMA reported_upgrade_${process.pid};
        SET LOCAL search_path TO reported_upgrade_${process.pid};
        CREATE TYPE "FixtureStatus" AS ENUM ('online', 'offline', 'fault');
        CREATE TABLE "Fixture" ("id" TEXT PRIMARY KEY, "status" "FixtureStatus" NOT NULL DEFAULT 'offline',
          "statusReason" TEXT, "updatedAt" TEXT NOT NULL DEFAULT 'unchanged');
        INSERT INTO "Fixture" ("id", "status", "statusReason") VALUES
          ('online', 'online', 'reported'), ('fault', 'fault', 'command_failed'),
          ('stale', 'offline', 'gateway_offline'), ('waiting', 'offline', 'provisioning_waiting_state');
        ${migration}
        INSERT INTO "Fixture" ("id") VALUES ('new');
        SELECT "id" || '|' || "reportedStatus" || '|' || COALESCE("reportedStatusReason", 'NULL') || '|' ||
          "status" || '|' || "updatedAt" FROM "Fixture" ORDER BY "id";
        ROLLBACK;`
    });
    expect(result.stderr).not.toContain("ERROR");
    expect(result.status).toBe(0);
    for (const row of ["online|online|reported|online|unchanged", "fault|fault|command_failed|fault|unchanged",
      "stale|offline|gateway_offline|offline|unchanged", "waiting|offline|provisioning_waiting_state|offline|unchanged",
      "new|offline|NULL|offline|unchanged"]) expect(result.stdout).toContain(row);
  });
});
