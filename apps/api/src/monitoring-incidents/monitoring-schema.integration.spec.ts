import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const databaseUrl = process.env.MONITORING_INCIDENTS_TEST_DATABASE_URL;
const requestScopeIndexName = "MonitoringRefreshRequest_requester_floor_createdAt_idx";

describe("monitoring refresh migration artifacts", () => {
  it("keeps the request cooldown index name stable and below PostgreSQL's identifier limit", () => {
    const apiRoot = join(__dirname, "../..");
    const schemaPath = join(apiRoot, "prisma/schema.prisma");
    const migration = readFileSync(join(apiRoot,
      "prisma/migrations/20260918100000_monitoring_manual_refresh/migration.sql"), "utf8");
    const diff = spawnSync("pnpm", ["exec", "prisma", "migrate", "diff", "--from-empty",
      `--to-schema-datamodel=${schemaPath}`, "--script"], { cwd: apiRoot, encoding: "utf8" });

    expect(diff.status).toBe(0);
    expect(diff.stdout).toContain(`CREATE INDEX "${requestScopeIndexName}"`);
    expect(migration).toContain(`CREATE INDEX "${requestScopeIndexName}"`);
    expect(Buffer.byteLength(requestScopeIndexName, "utf8")).toBeLessThanOrEqual(63);
  });
});

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
          'MonitoringRefresh', 'MonitoringRefreshBatch', 'MonitoringRefreshFixture', 'MonitoringRefreshRequest'
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
          '"MonitoringRefreshRequest"'::regclass,
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
          'MonitoringRefreshRequest_pkey',
          'MonitoringRefreshRequest_siteId_fkey',
          'MonitoringRefreshRequest_floorId_siteId_fkey',
          'MonitoringRefreshRequest_requestedById_fkey',
          'MonitoringRefreshRequest_refreshId_siteId_floorId_fkey',
          'MonitoringRefreshRequest_identity_check',
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
          'MqttOutbox_row_shape_check',
          'MqttOutbox_monitoringRefreshBatchId_fkey'
        ) ORDER BY conname
      `,
      prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN (
          'MonitoringRefresh', 'MonitoringRefreshBatch', 'MonitoringRefreshFixture', 'MonitoringRefreshRequest', 'MqttOutbox'
        ) AND indexname IN (
          'MonitoringRefresh_siteId_requestedById_clientRequestId_key',
          'MonitoringRefresh_id_siteId_key',
          'MonitoringRefresh_id_siteId_floorId_key',
          'MonitoringRefresh_siteId_floorId_status_idx',
          'MonitoringRefresh_createdAt_idx',
          'MonitoringRefreshBatch_gatewayId_sequence_key',
          'MonitoringRefreshBatch_id_refreshId_key',
          'MonitoringRefreshBatch_idempotencyKey_key',
          'MonitoringRefreshBatch_refreshId_status_idx',
          'MonitoringRefreshFixture_batchId_status_idx',
          'MonitoringRefreshFixture_fixtureId_idx',
          'MonitoringRefreshRequest_refreshId_idx',
          'MonitoringRefreshRequest_requester_floor_createdAt_idx',
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
      { table_name: "MonitoringRefreshFixture" },
      { table_name: "MonitoringRefreshRequest" }
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
      "MonitoringRefreshRequest_floorId_siteId_fkey",
      "MonitoringRefreshRequest_identity_check",
      "MonitoringRefreshRequest_pkey",
      "MonitoringRefreshRequest_refreshId_siteId_floorId_fkey",
      "MonitoringRefreshRequest_requestedById_fkey",
      "MonitoringRefreshRequest_siteId_fkey",
      "MqttOutbox_row_shape_check",
      "MqttOutbox_monitoringRefreshBatchId_fkey"
    ].sort());
    expect(indexes.map(({ indexname }) => indexname)).toEqual([
      "MonitoringRefresh_siteId_requestedById_clientRequestId_key",
      "MonitoringRefresh_id_siteId_key",
      "MonitoringRefresh_id_siteId_floorId_key",
      "MonitoringRefresh_siteId_floorId_status_idx",
      "MonitoringRefresh_createdAt_idx",
      "MonitoringRefreshBatch_gatewayId_sequence_key",
      "MonitoringRefreshBatch_id_refreshId_key",
      "MonitoringRefreshBatch_idempotencyKey_key",
      "MonitoringRefreshBatch_refreshId_status_idx",
      "MonitoringRefreshFixture_batchId_status_idx",
      "MonitoringRefreshFixture_fixtureId_idx",
      "MonitoringRefreshRequest_refreshId_idx",
      "MonitoringRefreshRequest_requester_floor_createdAt_idx",
      "MqttOutbox_monitoringRefreshBatchId_key"
    ].sort());
    expect(fixtureColumn).toEqual([{ is_nullable: "YES" }]);
  });

  it("binds request aliases to one requester key and the refresh's exact site/floor scope", async () => {
    const id = randomUUID();
    const organization = await prisma.organization.create({ data: { name: `monitoring-refresh-alias-${id}`, type: "customer" } });
    const user = await prisma.user.create({ data: {
      organizationId: organization.id,
      loginId: `alias_${id}`,
      name: "Alias requester",
      passwordHash: "unused",
      role: "viewer"
    } });
    const [firstSite, secondSite] = await Promise.all([
      prisma.site.create({ data: { organizationId: organization.id, name: `first-${id}` } }),
      prisma.site.create({ data: { organizationId: organization.id, name: `second-${id}` } })
    ]);

    try {
      const [firstFloor, otherFloor, secondSiteFloor] = await Promise.all([
        prisma.floor.create({ data: { siteId: firstSite.id, name: "first", level: 1 } }),
        prisma.floor.create({ data: { siteId: firstSite.id, name: "other", level: 2 } }),
        prisma.floor.create({ data: { siteId: secondSite.id, name: "second-site", level: 1 } })
      ]);
      const firstRefresh = await prisma.monitoringRefresh.create({ data: {
        siteId: firstSite.id, floorId: firstFloor.id, requestedById: user.id, clientRequestId: randomUUID(),
        totalFixtures: 0, deadlineAt: new Date(Date.now() + 30_000)
      } });
      const secondRefresh = await prisma.monitoringRefresh.create({ data: {
        siteId: firstSite.id, floorId: firstFloor.id, requestedById: user.id, clientRequestId: randomUUID(),
        totalFixtures: 0, deadlineAt: new Date(Date.now() + 30_000)
      } });
      const requestId = randomUUID();
      await prisma.monitoringRefreshRequest.create({ data: {
        siteId: firstSite.id,
        floorId: firstFloor.id,
        requestedById: user.id,
        clientRequestId: requestId,
        refreshId: firstRefresh.id
      } });

      await expect(prisma.monitoringRefreshRequest.create({ data: {
        siteId: firstSite.id,
        floorId: firstFloor.id,
        requestedById: user.id,
        clientRequestId: requestId,
        refreshId: secondRefresh.id
      } })).rejects.toMatchObject({ code: "P2002" });
      await expect(prisma.monitoringRefreshRequest.create({ data: {
        siteId: firstSite.id,
        floorId: otherFloor.id,
        requestedById: user.id,
        clientRequestId: randomUUID(),
        refreshId: firstRefresh.id
      } })).rejects.toMatchObject({ code: "P2003" });
      await expect(prisma.monitoringRefreshRequest.create({ data: {
        siteId: secondSite.id,
        floorId: secondSiteFloor.id,
        requestedById: user.id,
        clientRequestId: randomUUID(),
        refreshId: firstRefresh.id
      } })).rejects.toMatchObject({ code: "P2003" });
      await expect(prisma.$executeRawUnsafe(`
        INSERT INTO "MonitoringRefreshRequest" (
          "siteId", "floorId", "requestedById", "clientRequestId", "refreshId"
        ) VALUES (
          '${firstSite.id}', '${firstFloor.id}', '${user.id}', '', '${firstRefresh.id}'
        )
      `)).rejects.toMatchObject({ code: "P2010" });
    } finally {
      await prisma.site.deleteMany({ where: { id: { in: [firstSite.id, secondSite.id] } } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.organization.delete({ where: { id: organization.id } });
    }
  });

  it("rejects an outbox with both command and monitoring-refresh owners and an unpublished completed batch", async () => {
    const id = randomUUID();
    const organization = await prisma.organization.create({ data: { name: `monitoring-refresh-${id}` } });
    const site = await prisma.site.create({ data: { organizationId: organization.id, name: `site-${id}` } });

    try {
      const [floor, gateway] = await Promise.all([
        prisma.floor.create({ data: { siteId: site.id, name: `floor-${id}`, level: 1 } }),
        prisma.gateway.create({ data: { siteId: site.id, name: `gateway-${id}`, serialNumber: id, firmwareVersion: "test" } })
      ]);
      const refresh = await prisma.monitoringRefresh.create({
        data: {
          siteId: site.id,
          floorId: floor.id,
          clientRequestId: randomUUID(),
          totalFixtures: 0,
          deadlineAt: new Date(Date.now() + 30_000)
        }
      });
      const [batch, command] = await Promise.all([
        prisma.monitoringRefreshBatch.create({
          data: {
            refreshId: refresh.id,
            siteId: site.id,
            gatewayId: gateway.id,
            sequence: 1n,
            idempotencyKey: randomUUID(),
            targetFixtureIds: []
          }
        }),
        prisma.command.create({
          data: {
            siteId: site.id,
            clientRequestId: randomUUID(),
            requestFingerprint: "monitoring-refresh-schema-test",
            targetType: "fixture",
            brightness: 0
          }
        })
      ]);
      const dispatch = await prisma.commandDispatch.create({
        data: { commandId: command.id, gatewayId: gateway.id, idempotencyKey: randomUUID(), sequence: 1n }
      });

      await expect(prisma.$executeRawUnsafe(`
        DO $$ BEGIN
          INSERT INTO "MqttOutbox" (
            "id", "dispatchId", "monitoringRefreshBatchId", "topic", "payload", "updatedAt"
          ) VALUES (
            '${randomUUID()}', '${dispatch.id}', '${batch.id}', 'test/monitoring-refresh', '{}'::jsonb, CURRENT_TIMESTAMP
          );
          RAISE EXCEPTION 'outbox owner shape was not enforced';
        EXCEPTION WHEN check_violation THEN
          IF CONSTRAINT_NAME <> 'MqttOutbox_row_shape_check' THEN RAISE; END IF;
        END $$;
      `)).resolves.toBeDefined();

      await expect(prisma.$executeRawUnsafe(`
        DO $$ BEGIN
          INSERT INTO "MonitoringRefreshBatch" (
            "id", "refreshId", "siteId", "gatewayId", "sequence", "idempotencyKey", "targetFixtureIds",
            "status", "completedAt", "updatedAt"
          ) VALUES (
            '${randomUUID()}', '${refresh.id}', '${site.id}', '${gateway.id}', 2, '${randomUUID()}', '[]'::jsonb,
            'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          );
          RAISE EXCEPTION 'completed batch publication shape was not enforced';
        EXCEPTION WHEN check_violation THEN
          IF CONSTRAINT_NAME <> 'MonitoringRefreshBatch_status_check' THEN RAISE; END IF;
        END $$;
      `)).resolves.toBeDefined();
    } finally {
      await prisma.site.delete({ where: { id: site.id } });
      await prisma.organization.delete({ where: { id: organization.id } });
    }
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
