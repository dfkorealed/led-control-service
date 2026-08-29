import { Prisma, PrismaClient } from "@prisma/client";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationPath = join(
  __dirname,
  "../../prisma/migrations/20260829_add_lighting_automation/migration.sql"
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const prisma = new PrismaClient();
const databaseUrl = process.env.AUTOMATION_SCHEMA_TEST_DATABASE_URL;
const psqlDatabaseUrl = databaseUrl?.replace(/\?schema=[^&]+$/, "");
const describeWithPostgres = databaseUrl ? describe : describe.skip;

const automationDelegateNames = [
  "gatewayAutomationConfiguration",
  "lightingSchedule",
  "lightingScheduleFixture",
  "vehicleEventRule",
  "vehicleEventSource",
  "vehicleEventTarget",
  "manualOverride",
  "manualOverrideFixture",
  "automationExecution",
  "automationExecutionFixtureResult"
] as const;

describe("automation Prisma schema contract", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("generates every automation model delegate needed by the API", () => {
    const client = prisma as unknown as Record<(typeof automationDelegateNames)[number], unknown>;

    expect(Object.fromEntries(automationDelegateNames.map((name) => [name, client[name] !== undefined]))).toEqual(
      Object.fromEntries(automationDelegateNames.map((name) => [name, true]))
    );
  });

  it("exposes projected fixture ownership and maintained cardinality counters", () => {
    const modelFields = Object.fromEntries(
      Prisma.dmmf.datamodel.models.map((model) => [model.name, model.fields.map((field) => field.name)])
    );

    expect(modelFields.Fixture).toEqual(expect.arrayContaining(["siteId", "gatewayId"]));
    expect(modelFields.LightingSchedule).toContain("targetCount");
    expect(modelFields.VehicleEventRule).toEqual(expect.arrayContaining(["sourceCount", "targetCount"]));
    expect(modelFields.ManualOverride).toContain("targetCount");
  });

  it("enforces automation ranges and recurrence shape in PostgreSQL", () => {
    expect(migration.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(migration.trimEnd().endsWith("COMMIT;")).toBe(true);

    for (const constraint of [
      "GatewayAutomationConfiguration_revision_check",
      "LightingSchedule_revision_check",
      "LightingSchedule_brightness_check",
      "LightingSchedule_active_range_check",
      "LightingSchedule_local_time_check",
      "LightingSchedule_recurrence_check",
      "VehicleEventRule_revision_check",
      "VehicleEventRule_brightness_check",
      "VehicleEventRule_hold_check",
      "ManualOverride_brightness_check",
      "ManualOverride_time_range_check",
      "AutomationExecution_revision_sequence_check",
      "AutomationExecutionFixtureResult_brightness_check"
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }
  });

  it("reuses MqttOutbox for durable config publication with one deduplication identity", () => {
    expect(migration).not.toContain('CREATE TABLE "AutomationConfigOutbox"');
    expect(migration).toContain('ALTER COLUMN "dispatchId" DROP NOT NULL');
    expect(migration).toContain('ADD COLUMN "gatewayId" TEXT');
    expect(migration).toContain('ADD COLUMN "revision" INTEGER');
    expect(migration).toContain('ADD COLUMN "payloadHash" TEXT');
    expect(migration).toContain('CREATE UNIQUE INDEX "MqttOutbox_gatewayId_revision_payloadHash_key"');
    expect(migration).toContain('CONSTRAINT "MqttOutbox_automation_identity_check"');
    expect(migration).toContain('CONSTRAINT "MqttOutbox_payload_hash_check"');
  });

  it("prevents duplicate target snapshots and cross-site gateway ownership", () => {
    for (const primaryKey of [
      'CONSTRAINT "LightingScheduleFixture_pkey" PRIMARY KEY ("scheduleId","fixtureId")',
      'CONSTRAINT "VehicleEventSource_pkey" PRIMARY KEY ("ruleId","fixtureId")',
      'CONSTRAINT "VehicleEventTarget_pkey" PRIMARY KEY ("ruleId","fixtureId")',
      'CONSTRAINT "ManualOverrideFixture_pkey" PRIMARY KEY ("manualOverrideId","fixtureId")',
      'CONSTRAINT "AutomationExecutionFixtureResult_pkey" PRIMARY KEY ("executionId","fixtureSnapshotId")'
    ]) {
      expect(migration).toContain(primaryKey);
    }

    expect(migration).toContain('CREATE UNIQUE INDEX "Gateway_id_siteId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "Command_id_siteId_requestedBy_key"');
    for (const constraint of [
      "GatewayAutomationConfiguration_gatewayId_siteId_fkey",
      "LightingSchedule_gatewayId_siteId_fkey",
      "VehicleEventRule_gatewayId_siteId_fkey",
      "ManualOverride_gatewayId_siteId_fkey",
      "AutomationExecution_gatewayId_siteId_fkey"
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }

    for (const ownerColumn of [
      'CREATE TABLE "LightingScheduleFixture"',
      'CREATE TABLE "VehicleEventSource"',
      'CREATE TABLE "VehicleEventTarget"',
      'CREATE TABLE "ManualOverrideFixture"'
    ]) {
      const tableSql = migration.slice(migration.indexOf(ownerColumn), migration.indexOf(");", migration.indexOf(ownerColumn)));
      expect(tableSql).toContain('"siteId" TEXT NOT NULL');
      expect(tableSql).toContain('"gatewayId" TEXT NOT NULL');
    }

    for (const constraint of [
      "LightingScheduleFixture_scheduleId_siteId_gatewayId_fkey",
      "VehicleEventSource_ruleId_siteId_gatewayId_fkey",
      "VehicleEventTarget_ruleId_siteId_gatewayId_fkey",
      "ManualOverrideFixture_manualOverrideId_siteId_gatewayId_fkey"
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }
  });

  it("installs immutable recurrence and deferred counter-cardinality enforcement", () => {
    expect(migration).toContain('CREATE FUNCTION "automation_weekly_days_are_unique"');
    expect(migration).toMatch(/automation_weekly_days_are_unique[\s\S]*?IMMUTABLE/);
    expect(migration).toContain('"automation_weekly_days_are_unique"("weeklyDays")');

    for (const trigger of [
      "LightingSchedule_target_cardinality",
      "LightingScheduleFixture_target_cardinality",
      "VehicleEventRule_cardinality",
      "VehicleEventSource_cardinality",
      "VehicleEventTarget_cardinality",
      "ManualOverride_target_cardinality",
      "ManualOverrideFixture_target_cardinality"
    ]) {
      expect(migration).toMatch(
        new RegExp(`CREATE CONSTRAINT TRIGGER "${trigger}"[\\s\\S]*?DEFERRABLE INITIALLY DEFERRED`)
      );
    }

    for (const counter of ["targetCount", "sourceCount"]) {
      expect(migration).toContain(`"${counter}" INTEGER NOT NULL DEFAULT 0`);
    }

    expect(migration).toContain('CREATE FUNCTION "maintain_lighting_schedule_target_count"');
    expect(migration).toContain('CREATE FUNCTION "maintain_vehicle_event_fixture_counts"');
    expect(migration).toContain('CREATE FUNCTION "maintain_manual_override_target_count"');
    expect(migration).toContain('SELECT pg_advisory_xact_lock(1279607873, 1296387394)');
    for (const functionName of [
      "maintain_lighting_schedule_target_count",
      "maintain_vehicle_event_fixture_counts",
      "maintain_manual_override_target_count"
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE FUNCTION "${functionName}"\\(\\)[\\s\\S]*?BEGIN\\s+` +
          `PERFORM "lock_automation_membership_mutation"\\(\\);`
        )
      );
    }
    expect(migration).toContain('ORDER BY "id"');
  });

  it("projects Fixture ownership and structurally constrains automation scope", () => {
    expect(migration).toContain('CREATE TRIGGER "Gateway_automation_site_reassignment_guard"');
    expect(migration).toContain('OLD."siteId" IS NULL');
    expect(migration).toMatch(/MqttOutbox[\s\S]*?"publishedAt" IS NULL/);
    expect(migration).toContain('ADD COLUMN "siteId" TEXT');
    expect(migration).toContain('ADD COLUMN "gatewayId" TEXT');
    expect(migration).toContain('CREATE TRIGGER "Fixture_owner_projection"');
    expect(migration).toContain('CREATE UNIQUE INDEX "Floor_id_siteId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "Fixture_id_siteId_gatewayId_key"');
    expect(migration).not.toMatch(
      /validate_automation_fixture_scope|prevent_(?:fixture|floor|mesh_node)_automation_scope_change/
    );

    for (const constraint of [
      "Fixture_floorId_siteId_fkey",
      "Fixture_meshNodeId_gatewayId_fkey",
      "LightingScheduleFixture_fixtureId_siteId_gatewayId_fkey",
      "VehicleEventSource_fixtureId_siteId_gatewayId_fkey",
      "VehicleEventTarget_fixtureId_siteId_gatewayId_fkey",
      "ManualOverrideFixture_fixtureId_siteId_gatewayId_fkey"
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }

    expect(migration).not.toMatch(
      /(?:GatewayAutomationConfiguration|LightingSchedule|VehicleEventRule|ManualOverride|AutomationExecution)_gatewayId_siteId_fkey[\s\S]*?ON UPDATE CASCADE/
    );
  });

  it("enforces configuration, execution source, Command owner, and terminal result state", () => {
    for (const constraint of [
      "GatewayAutomationConfiguration_state_check",
      "ManualOverride_commandId_siteId_requestedById_fkey",
      "AutomationExecutionFixtureResult_fixture_identity_check",
      "AutomationExecutionFixtureResult_terminal_status_check"
    ]) {
      expect(migration).toContain(`"${constraint}"`);
    }
    expect(migration).toContain('CREATE TRIGGER "AutomationExecution_source_check"');
    expect(migration).toContain("execution ruleId does not match source");
    expect(migration).toContain("execution source owner does not match execution owner");
  });

  it("keeps execution history when rules or fixtures are deleted", () => {
    expect(migration).toMatch(
      /AutomationExecution_lightingScheduleId_fkey[\s\S]*?REFERENCES "LightingSchedule"\("id"\) ON DELETE SET NULL/
    );
    expect(migration).toMatch(
      /AutomationExecution_vehicleEventRuleId_fkey[\s\S]*?REFERENCES "VehicleEventRule"\("id"\) ON DELETE SET NULL/
    );
    expect(migration).toMatch(
      /AutomationExecutionFixtureResult_fixtureId_fkey[\s\S]*?REFERENCES "Fixture"\("id"\) ON DELETE SET NULL/
    );
  });
});

describeWithPostgres("automation migration PostgreSQL constraints", () => {
  beforeAll(() => {
    executeSql(`
      INSERT INTO "Organization" ("id", "name", "type", "createdAt", "updatedAt") VALUES
        ('automation-schema-org-a', 'Automation schema A', 'customer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-org-b', 'Automation schema B', 'customer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "User" (
        "id", "organizationId", "loginId", "name", "passwordHash", "role", "status", "createdAt", "updatedAt"
      ) VALUES
        (
          'automation-schema-user-a', 'automation-schema-org-a', 'automation-schema-user-a', 'Automation schema A',
          'hash', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'automation-schema-user-b', 'automation-schema-org-b', 'automation-schema-user-b', 'Automation schema B',
          'hash', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );
      INSERT INTO "Site" ("id", "organizationId", "name", "createdAt", "updatedAt") VALUES
        ('automation-schema-site-a', 'automation-schema-org-a', 'Automation schema A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-site-b', 'automation-schema-org-b', 'Automation schema B', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "Gateway" (
        "id", "siteId", "name", "serialNumber", "firmwareVersion", "createdAt", "updatedAt"
      ) VALUES
        ('automation-schema-gateway-a', 'automation-schema-site-a', 'Gateway A', 'AUTOMATION-SCHEMA-GATEWAY-A', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-gateway-a2', 'automation-schema-site-a', 'Gateway A2', 'AUTOMATION-SCHEMA-GATEWAY-A2', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-gateway-move', 'automation-schema-site-a', 'Gateway move', 'AUTOMATION-SCHEMA-GATEWAY-MOVE', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-gateway-b', 'automation-schema-site-b', 'Gateway B', 'AUTOMATION-SCHEMA-GATEWAY-B', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-gateway-config', 'automation-schema-site-a', 'Gateway config', 'AUTOMATION-SCHEMA-GATEWAY-CONFIG', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-gateway-history', 'automation-schema-site-a', 'Gateway history', 'AUTOMATION-SCHEMA-GATEWAY-HISTORY', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-gateway-outbox', 'automation-schema-site-a', 'Gateway outbox', 'AUTOMATION-SCHEMA-GATEWAY-OUTBOX', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-gateway-free', 'automation-schema-site-a', 'Gateway free', 'AUTOMATION-SCHEMA-GATEWAY-FREE', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "Floor" ("id", "siteId", "name", "level", "createdAt", "updatedAt") VALUES
        ('automation-schema-floor-a', 'automation-schema-site-a', 'Floor A', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-floor-free', 'automation-schema-site-a', 'Floor free', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-floor-b', 'automation-schema-site-b', 'Floor B', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "MeshNode" (
        "id", "gatewayId", "meshAddress", "firmwareVersion", "createdAt", "updatedAt"
      ) VALUES
        ('automation-schema-node-a', 'automation-schema-gateway-a', '0101', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-a-extra', 'automation-schema-gateway-a', '0102', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-a-third', 'automation-schema-gateway-a', '0104', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-a-fourth', 'automation-schema-gateway-a', '0105', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-a2', 'automation-schema-gateway-a2', '0101', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-free', 'automation-schema-gateway-a', '0103', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-move', 'automation-schema-gateway-move', '0201', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-b', 'automation-schema-gateway-b', '0101', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "Fixture" (
        "id", "floorId", "meshNodeId", "name", "ratedWatt", "x", "y", "createdAt", "updatedAt"
      ) VALUES
        ('automation-schema-fixture-a', 'automation-schema-floor-a', 'automation-schema-node-a', 'Fixture A', 30, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-fixture-a-extra', 'automation-schema-floor-a', 'automation-schema-node-a-extra', 'Fixture A extra', 30, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-fixture-a-third', 'automation-schema-floor-a', 'automation-schema-node-a-third', 'Fixture A third', 30, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-fixture-a-fourth', 'automation-schema-floor-a', 'automation-schema-node-a-fourth', 'Fixture A fourth', 30, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-fixture-a2', 'automation-schema-floor-a', 'automation-schema-node-a2', 'Fixture A2', 30, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-fixture-b', 'automation-schema-floor-b', 'automation-schema-node-b', 'Fixture B', 30, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-fixture-unassigned', 'automation-schema-floor-a', NULL, 'Fixture unassigned', 30, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "Command" (
        "id", "siteId", "requestedBy", "clientRequestId", "requestFingerprint", "targetType",
        "targetFixtureIds", "brightness", "createdAt", "updatedAt"
      ) VALUES
        ('automation-schema-command-a', 'automation-schema-site-a', 'automation-schema-user-a', 'automation-schema-command-a', 'fingerprint-a', 'fixture', '["automation-schema-fixture-a"]', 50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-command-b', 'automation-schema-site-b', 'automation-schema-user-b', 'automation-schema-command-b', 'fingerprint-b', 'fixture', '["automation-schema-fixture-b"]', 50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-command-user-b', 'automation-schema-site-a', 'automation-schema-user-b', 'automation-schema-command-user-b', 'fingerprint-user-b', 'fixture', '["automation-schema-fixture-a"]', 50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);
  });

  afterAll(() => {
    executeSql(`
      BEGIN;
      DELETE FROM "AutomationExecution" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "LightingSchedule" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "VehicleEventRule" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "ManualOverride" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "GatewayAutomationConfiguration" WHERE "gatewayId" LIKE 'automation-schema-%';
      DELETE FROM "MqttOutbox" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "Fixture" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "MeshNode" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "Command" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "Gateway" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "Floor" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "Site" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "User" WHERE "id" LIKE 'automation-schema-%';
      DELETE FROM "Organization" WHERE "id" LIKE 'automation-schema-%';
      COMMIT;
    `);
  });

  it("rejects a monthly recurrence without its required day", () => {
    const result = runSql(`
      INSERT INTO "LightingSchedule" (
        "id", "siteId", "gatewayId", "name", "status", "activeFrom", "activeUntil",
        "localStartTime", "localEndTime", "recurrenceKind", "weeklyDays", "dimmingEnabled",
        "brightnessPercent", "desiredRevision", "appliedRevision", "createdById", "updatedById",
        "createdAt", "updatedAt"
      ) VALUES (
        'automation-schema-invalid-schedule', 'automation-schema-site-a', 'automation-schema-gateway-a',
        'Invalid monthly recurrence', 'enabled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        '10:00', '11:00', 'monthly', ARRAY[]::INTEGER[], true, 50, 0, 0,
        'automation-schema-user-a', 'automation-schema-user-a', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LightingSchedule_recurrence_check");
  });

  it("enforces synchronization state invariants while allowing the revision-zero initial row", () => {
    executeSql(configurationInsert("automation-schema-gateway-config", "PENDING", 0, 0, "NULL", "NULL", "NULL"));
    executeSql(`DELETE FROM "GatewayAutomationConfiguration" WHERE "gatewayId" = 'automation-schema-gateway-config';`);

    for (const invalidApplied of [
      configurationInsert("automation-schema-gateway-config", "APPLIED", 2, 1, `'${validPayloadHash}'`, "NULL", "CURRENT_TIMESTAMP"),
      configurationInsert("automation-schema-gateway-config", "APPLIED", 2, 2, "NULL", "NULL", "CURRENT_TIMESTAMP"),
      configurationInsert("automation-schema-gateway-config", "APPLIED", 2, 2, `'${validPayloadHash}'`, "'stale-error'", "CURRENT_TIMESTAMP"),
      configurationInsert("automation-schema-gateway-config", "APPLIED", 2, 2, `'${validPayloadHash}'`, "NULL", "NULL")
    ]) {
      expectSqlFailure(invalidApplied, "GatewayAutomationConfiguration_state_check");
    }
    executeSql(configurationInsert(
      "automation-schema-gateway-config",
      "APPLIED",
      2,
      2,
      `'${validPayloadHash}'`,
      "NULL",
      "CURRENT_TIMESTAMP"
    ));
    executeSql(`DELETE FROM "GatewayAutomationConfiguration" WHERE "gatewayId" = 'automation-schema-gateway-config';`);

    expectSqlFailure(
      configurationInsert("automation-schema-gateway-config", "REJECTED", 2, 1, `'${validPayloadHash}'`, "NULL", "NULL"),
      "GatewayAutomationConfiguration_state_check"
    );
    executeSql(configurationInsert(
      "automation-schema-gateway-config",
      "REJECTED",
      2,
      1,
      `'${validPayloadHash}'`,
      "'invalid-snapshot'",
      "NULL"
    ));
    executeSql(`DELETE FROM "GatewayAutomationConfiguration" WHERE "gatewayId" = 'automation-schema-gateway-config';`);

    expectSqlFailure(
      configurationInsert("automation-schema-gateway-config", "PENDING", 2, 2, `'${validPayloadHash}'`, "NULL", "CURRENT_TIMESTAMP"),
      "GatewayAutomationConfiguration_state_check"
    );
    executeSql(configurationInsert(
      "automation-schema-gateway-config",
      "PENDING",
      2,
      1,
      `'${validPayloadHash}'`,
      "NULL",
      "CURRENT_TIMESTAMP"
    ));
    executeSql(`DELETE FROM "GatewayAutomationConfiguration" WHERE "gatewayId" = 'automation-schema-gateway-config';`);
  });

  it("derives Fixture Site and Gateway ownership while preserving unassigned fixtures", () => {
    expect(querySql(`
      SELECT string_agg("id" || ':' || "siteId" || ':' || COALESCE("gatewayId", 'NULL'), ',' ORDER BY "id")
      FROM "Fixture"
      WHERE "id" IN ('automation-schema-fixture-a', 'automation-schema-fixture-unassigned');
    `)).toBe(
      "automation-schema-fixture-a:automation-schema-site-a:automation-schema-gateway-a," +
      "automation-schema-fixture-unassigned:automation-schema-site-a:NULL"
    );

    expectSqlFailure(`
      UPDATE "Fixture"
      SET "siteId" = 'automation-schema-site-b'
      WHERE "id" = 'automation-schema-fixture-a';
    `, "Fixture Site does not match Floor owner");
    expectSqlFailure(`
      UPDATE "Fixture"
      SET "gatewayId" = 'automation-schema-gateway-a2'
      WHERE "id" = 'automation-schema-fixture-a';
    `, "Fixture Gateway does not match MeshNode owner");
  });

  it("rejects duplicate weekdays and empty required fixture sets at commit", () => {
    expectSqlFailure(
      `${scheduleInsert("automation-schema-duplicate-weekdays", "ARRAY[1, 1]::INTEGER[]")}`,
      "LightingSchedule_recurrence_check"
    );
    expectSqlFailure(
      `BEGIN; ${scheduleInsert("automation-schema-empty-schedule")} COMMIT;`,
      "lighting schedule requires at least one target fixture"
    );
    expectSqlFailure(
      `BEGIN; ${vehicleRuleInsert("automation-schema-empty-vehicle")} COMMIT;`,
      "vehicle event rule requires at least one source and target fixture"
    );
    expectSqlFailure(
      `BEGIN; ${manualOverrideInsert("automation-schema-empty-manual", "automation-schema-command-a")} COMMIT;`,
      "manual override requires at least one target fixture"
    );
  });

  it("allows required parents and children to be created together and parent cascades to remove snapshots", () => {
    executeSql(`
      BEGIN;
      ${scheduleInsert("automation-schema-cardinality-schedule")}
      ${scheduleFixtureInsert("automation-schema-cardinality-schedule", "automation-schema-fixture-a")}
      ${vehicleRuleInsert("automation-schema-cardinality-vehicle")}
      ${vehicleSourceInsert("automation-schema-cardinality-vehicle", "automation-schema-fixture-a")}
      ${vehicleTargetInsert("automation-schema-cardinality-vehicle", "automation-schema-fixture-a")}
      ${manualOverrideInsert("automation-schema-cardinality-manual", "automation-schema-command-a")}
      ${manualFixtureInsert("automation-schema-cardinality-manual", "automation-schema-fixture-a")}
      COMMIT;
    `);

    executeSql(`
      BEGIN;
      DELETE FROM "LightingSchedule" WHERE "id" = 'automation-schema-cardinality-schedule';
      DELETE FROM "VehicleEventRule" WHERE "id" = 'automation-schema-cardinality-vehicle';
      DELETE FROM "ManualOverride" WHERE "id" = 'automation-schema-cardinality-manual';
      COMMIT;
    `);
  });

  it.each(["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"] as const)(
    "serializes concurrent deletions of the final two required schedule targets at %s",
    async (isolationLevel) => {
    const suffix = isolationLevel.toLowerCase().replaceAll(" ", "-");
    const scheduleId = `automation-schema-concurrent-schedule-${suffix}`;
    executeSql(`
      BEGIN;
      ${scheduleInsert(scheduleId)}
      ${scheduleFixtureInsert(scheduleId, "automation-schema-fixture-a")}
      ${scheduleFixtureInsert(scheduleId, "automation-schema-fixture-a-extra")}
      COMMIT;
    `);

    const firstConnection = startSqlSession(`
      BEGIN ISOLATION LEVEL ${isolationLevel};
      DELETE FROM "LightingScheduleFixture"
      WHERE "scheduleId" = '${scheduleId}'
        AND "fixtureId" = 'automation-schema-fixture-a';
      SET CONSTRAINTS "LightingScheduleFixture_target_cardinality" IMMEDIATE;
      SELECT 'automation-first-connection-ready-${suffix}';
      SELECT pg_sleep(1);
      COMMIT;
    `);
    await firstConnection.waitForOutput(`automation-first-connection-ready-${suffix}`);

    const secondConnection = runSql(`
      BEGIN ISOLATION LEVEL ${isolationLevel};
      DELETE FROM "LightingScheduleFixture"
      WHERE "scheduleId" = '${scheduleId}'
        AND "fixtureId" = 'automation-schema-fixture-a-extra';
      COMMIT;
    `);
    const firstResult = await firstConnection.completion;
    const remainingTargets = querySql(`
      SELECT COUNT(*)
      FROM "LightingScheduleFixture"
      WHERE "scheduleId" = '${scheduleId}';
    `);
    executeSql(`DELETE FROM "LightingSchedule" WHERE "id" = '${scheduleId}';`);

    expect(firstResult.status).toBe(0);
    expect(firstResult.stderr).toBe("");
    expect(secondConnection.status).not.toBe(0);
    expect(secondConnection.stderr).toMatch(
      /lighting schedule requires at least one target fixture|could not serialize access/
    );
    expect(remainingTargets).toBe("1");
  });

  it("rejects fixture snapshots outside the parent Site or Gateway", () => {
    expectSqlFailure(`
      BEGIN;
      ${scheduleInsert("automation-schema-cross-site-schedule")}
      ${scheduleFixtureInsert("automation-schema-cross-site-schedule", "automation-schema-fixture-b")}
      COMMIT;
    `, "LightingScheduleFixture_fixtureId_siteId_gatewayId_fkey");
    expectSqlFailure(`
      BEGIN;
      ${vehicleRuleInsert("automation-schema-cross-gateway-vehicle")}
      ${vehicleSourceInsert("automation-schema-cross-gateway-vehicle", "automation-schema-fixture-a2")}
      ${vehicleTargetInsert("automation-schema-cross-gateway-vehicle", "automation-schema-fixture-a")}
      COMMIT;
    `, "VehicleEventSource_fixtureId_siteId_gatewayId_fkey");
    expectSqlFailure(`
      BEGIN;
      ${manualOverrideInsert("automation-schema-unassigned-manual", "automation-schema-command-a")}
      ${manualFixtureInsert("automation-schema-unassigned-manual", "automation-schema-fixture-unassigned")}
      COMMIT;
    `, "ManualOverrideFixture_fixtureId_siteId_gatewayId_fkey");
  });

  it("blocks later fixture floor and MeshNode changes that would invalidate snapshots", () => {
    executeSql(`
      BEGIN;
      ${scheduleInsert("automation-schema-fixture-mutation-schedule")}
      ${scheduleFixtureInsert("automation-schema-fixture-mutation-schedule", "automation-schema-fixture-a")}
      COMMIT;
    `);

    expectSqlFailure(
      `UPDATE "Fixture" SET "floorId" = 'automation-schema-floor-b' WHERE "id" = 'automation-schema-fixture-a';`,
      "LightingScheduleFixture_fixtureId_siteId_gatewayId_fkey"
    );
    expectSqlFailure(
      `UPDATE "Fixture" SET "meshNodeId" = 'automation-schema-node-move' WHERE "id" = 'automation-schema-fixture-a';`,
      "LightingScheduleFixture_fixtureId_siteId_gatewayId_fkey"
    );
  });

  it("enforces ManualOverride Command Site and requester ownership", () => {
    expectSqlFailure(`
      BEGIN;
      ${manualOverrideInsert("automation-schema-cross-command-site", "automation-schema-command-b")}
      ${manualFixtureInsert("automation-schema-cross-command-site", "automation-schema-fixture-a")}
      COMMIT;
    `, "ManualOverride_commandId_siteId_requestedById_fkey");
    expectSqlFailure(`
      BEGIN;
      ${manualOverrideInsert("automation-schema-cross-command-user", "automation-schema-command-user-b")}
      ${manualFixtureInsert("automation-schema-cross-command-user", "automation-schema-fixture-a")}
      COMMIT;
    `, "ManualOverride_commandId_siteId_requestedById_fkey");
  });

  it("enforces execution owner, ruleId, kind, and source coherence", () => {
    executeSql(`
      BEGIN;
      ${vehicleRuleInsert("automation-schema-vehicle-b", "automation-schema-site-b", "automation-schema-gateway-b", "automation-schema-user-b")}
      ${vehicleSourceInsert("automation-schema-vehicle-b", "automation-schema-fixture-b", "automation-schema-site-b", "automation-schema-gateway-b")}
      ${vehicleTargetInsert("automation-schema-vehicle-b", "automation-schema-fixture-b", "automation-schema-site-b", "automation-schema-gateway-b")}
      COMMIT;
    `);
    expectSqlFailure(
      executionInsert({
        id: "automation-schema-cross-owner-execution",
        eventId: "automation-schema-cross-owner-event",
        kind: "event_started",
        ruleId: "automation-schema-vehicle-b",
        vehicleEventRuleId: "automation-schema-vehicle-b"
      }),
      "execution source owner does not match execution owner"
    );

    executeSql(`
      BEGIN;
      ${scheduleInsert("automation-schema-coherence-schedule")}
      ${scheduleFixtureInsert("automation-schema-coherence-schedule", "automation-schema-fixture-a")}
      COMMIT;
    `);
    expectSqlFailure(
      executionInsert({
        id: "automation-schema-rule-mismatch-execution",
        eventId: "automation-schema-rule-mismatch-event",
        kind: "schedule_started",
        ruleId: "automation-schema-wrong-rule",
        lightingScheduleId: "automation-schema-coherence-schedule"
      }),
      "execution ruleId does not match source"
    );
    expectSqlFailure(
      executionInsert({
        id: "automation-schema-kind-mismatch-execution",
        eventId: "automation-schema-kind-mismatch-event",
        kind: "telemetry_gap",
        ruleId: "automation-schema-coherence-schedule",
        lightingScheduleId: "automation-schema-coherence-schedule"
      }),
      "execution kind does not match source"
    );
  });

  it("preserves append-only execution history when its source is deleted", () => {
    executeSql(`
      BEGIN;
      ${scheduleInsert("automation-schema-history-schedule")}
      ${scheduleFixtureInsert("automation-schema-history-schedule", "automation-schema-fixture-a")}
      ${vehicleRuleInsert("automation-schema-history-vehicle")}
      ${vehicleSourceInsert("automation-schema-history-vehicle", "automation-schema-fixture-a")}
      ${vehicleTargetInsert("automation-schema-history-vehicle", "automation-schema-fixture-a")}
      ${manualOverrideInsert("automation-schema-history-manual", "automation-schema-command-a")}
      ${manualFixtureInsert("automation-schema-history-manual", "automation-schema-fixture-a")}
      COMMIT;
      ${executionInsert({
        id: "automation-schema-history-execution",
        eventId: "automation-schema-history-event",
        kind: "schedule_ended",
        ruleId: "automation-schema-history-schedule",
        lightingScheduleId: "automation-schema-history-schedule"
      })}
      ${executionInsert({
        id: "automation-schema-history-vehicle-execution",
        eventId: "automation-schema-history-vehicle-event",
        kind: "event_ended",
        ruleId: "automation-schema-history-vehicle",
        vehicleEventRuleId: "automation-schema-history-vehicle"
      })}
      ${executionInsert({
        id: "automation-schema-history-manual-execution",
        eventId: "automation-schema-history-manual-event",
        kind: "action_result",
        manualOverrideId: "automation-schema-history-manual"
      })}
      DELETE FROM "LightingSchedule" WHERE "id" = 'automation-schema-history-schedule';
      DELETE FROM "VehicleEventRule" WHERE "id" = 'automation-schema-history-vehicle';
      DELETE FROM "ManualOverride" WHERE "id" = 'automation-schema-history-manual';
    `);

    expect(querySql(`
      SELECT bool_and(
        CASE "id"
          WHEN 'automation-schema-history-execution'
            THEN "lightingScheduleId" IS NULL AND "ruleId" = 'automation-schema-history-schedule'
          WHEN 'automation-schema-history-vehicle-execution'
            THEN "vehicleEventRuleId" IS NULL AND "ruleId" = 'automation-schema-history-vehicle'
          WHEN 'automation-schema-history-manual-execution'
            THEN "manualOverrideId" IS NULL AND "ruleId" IS NULL
        END
      )
      FROM "AutomationExecution"
      WHERE "id" IN (
        'automation-schema-history-execution',
        'automation-schema-history-vehicle-execution',
        'automation-schema-history-manual-execution'
      );
    `)).toBe("t");
  });

  it("blocks Gateway Site reassignment for automation rows, history, and unpublished config outbox", () => {
    executeSql(configurationInsert("automation-schema-gateway-config", "PENDING", 0, 0, "NULL", "NULL", "NULL"));
    expectSqlFailure(
      `UPDATE "Gateway" SET "siteId" = 'automation-schema-site-b' WHERE "id" = 'automation-schema-gateway-config';`,
      "cannot reassign Gateway Site while automation dependencies exist"
    );

    executeSql(executionInsert({
      id: "automation-schema-gateway-history-execution",
      eventId: "automation-schema-gateway-history-event",
      gatewayId: "automation-schema-gateway-history",
      kind: "telemetry_gap"
    }));
    expectSqlFailure(
      `UPDATE "Gateway" SET "siteId" = 'automation-schema-site-b' WHERE "id" = 'automation-schema-gateway-history';`,
      "cannot reassign Gateway Site while automation dependencies exist"
    );

    executeSql(`
      INSERT INTO "MqttOutbox" (
        "id", "dispatchId", "gatewayId", "revision", "payloadHash", "topic", "payload",
        "attempts", "nextAttemptAt", "createdAt", "updatedAt"
      ) VALUES (
        'automation-schema-outbox', NULL, 'automation-schema-gateway-outbox', 1, '${validPayloadHash}',
        'gateways/automation-schema-gateway-outbox/automation/config', '{}'::jsonb,
        0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);
    expectSqlFailure(
      `UPDATE "Gateway" SET "siteId" = 'automation-schema-site-b' WHERE "id" = 'automation-schema-gateway-outbox';`,
      "cannot reassign Gateway Site while automation dependencies exist"
    );

    executeSql(`
      UPDATE "Gateway" SET "siteId" = 'automation-schema-site-b' WHERE "id" = 'automation-schema-gateway-free';
      UPDATE "Gateway" SET "siteId" = 'automation-schema-site-a' WHERE "id" = 'automation-schema-gateway-free';
    `);
  });

  it("requires fixture result identity coherence and terminal statuses", () => {
    executeSql(executionInsert({
      id: "automation-schema-result-execution",
      eventId: "automation-schema-result-event",
      kind: "telemetry_gap"
    }));
    expectSqlFailure(
      fixtureResultInsert("automation-schema-fixture-a", "automation-schema-fixture-b", "succeeded"),
      "AutomationExecutionFixtureResult_fixture_identity_check"
    );
    expectSqlFailure(
      fixtureResultInsert("automation-schema-fixture-a", "automation-schema-fixture-a", "pending"),
      "AutomationExecutionFixtureResult_terminal_status_check"
    );
    executeSql(
      fixtureResultInsert("automation-schema-fixture-a", "automation-schema-fixture-a", "timed_out")
    );
  });

  it.each([
    {
      isolationLevel: "REPEATABLE READ",
      ownerName: "Floor",
      ownerUpdate: `UPDATE "Floor" SET "siteId" = 'automation-schema-site-b' WHERE "id" = 'automation-schema-floor-a';`,
      ownerRestore: `UPDATE "Floor" SET "siteId" = 'automation-schema-site-a' WHERE "id" = 'automation-schema-floor-a';`
    },
    {
      isolationLevel: "SERIALIZABLE",
      ownerName: "Floor",
      ownerUpdate: `UPDATE "Floor" SET "siteId" = 'automation-schema-site-b' WHERE "id" = 'automation-schema-floor-a';`,
      ownerRestore: `UPDATE "Floor" SET "siteId" = 'automation-schema-site-a' WHERE "id" = 'automation-schema-floor-a';`
    },
    {
      isolationLevel: "REPEATABLE READ",
      ownerName: "MeshNode",
      ownerUpdate: `UPDATE "MeshNode" SET "gatewayId" = 'automation-schema-gateway-move' WHERE "id" = 'automation-schema-node-a';`,
      ownerRestore: `UPDATE "MeshNode" SET "gatewayId" = 'automation-schema-gateway-a' WHERE "id" = 'automation-schema-node-a';`
    },
    {
      isolationLevel: "SERIALIZABLE",
      ownerName: "MeshNode",
      ownerUpdate: `UPDATE "MeshNode" SET "gatewayId" = 'automation-schema-gateway-move' WHERE "id" = 'automation-schema-node-a';`,
      ownerRestore: `UPDATE "MeshNode" SET "gatewayId" = 'automation-schema-gateway-a' WHERE "id" = 'automation-schema-node-a';`
    }
  ] as const)(
    "keeps a concurrent scope insert consistent with a $ownerName move at $isolationLevel",
    async ({ isolationLevel, ownerName, ownerUpdate, ownerRestore }) => {
      const suffix = `${ownerName}-${isolationLevel}`.toLowerCase().replaceAll(" ", "-");
      const scheduleId = `automation-schema-scope-race-${suffix}`;
      const ownerConnection = startSqlSession(`
        BEGIN ISOLATION LEVEL ${isolationLevel};
        SELECT COUNT(*) FROM "LightingScheduleFixture";
        SELECT 'automation-owner-snapshot-${suffix}';
        SELECT pg_sleep(0.5);
        ${ownerUpdate}
        COMMIT;
      `);
      await ownerConnection.waitForOutput(`automation-owner-snapshot-${suffix}`);

      const insertResult = runSql(`
        BEGIN;
        ${scheduleInsert(scheduleId)}
        ${scheduleFixtureInsert(scheduleId, "automation-schema-fixture-a")}
        COMMIT;
      `);
      const ownerResult = await ownerConnection.completion;

      executeSql(ownerRestore);
      executeSql(`DELETE FROM "LightingSchedule" WHERE "id" = '${scheduleId}';`);

      expect(insertResult.status).toBe(0);
      expect(insertResult.stderr).toBe("");
      expect(ownerResult.status).not.toBe(0);
      expect(ownerResult.stderr).toMatch(
        /LightingScheduleFixture_fixtureId_siteId_gatewayId_fkey|could not serialize access/
      );
    }
  );

  it("serializes opposite multi-row membership moves and deletes without deadlock", async () => {
    const firstScheduleId = "automation-schema-multi-row-schedule-a";
    const secondScheduleId = "automation-schema-multi-row-schedule-b";
    const thirdScheduleId = "automation-schema-multi-row-schedule-c";
    const fourthScheduleId = "automation-schema-multi-row-schedule-d";
    executeSql(`
      BEGIN;
      ${scheduleInsert(firstScheduleId)}
      ${scheduleFixtureInsert(firstScheduleId, "automation-schema-fixture-a")}
      ${scheduleFixtureInsert(firstScheduleId, "automation-schema-fixture-a-extra")}
      ${scheduleFixtureInsert(firstScheduleId, "automation-schema-fixture-a-fourth")}
      ${scheduleInsert(secondScheduleId)}
      ${scheduleFixtureInsert(secondScheduleId, "automation-schema-fixture-a-third")}
      ${scheduleInsert(thirdScheduleId)}
      ${scheduleFixtureInsert(thirdScheduleId, "automation-schema-fixture-a")}
      ${scheduleFixtureInsert(thirdScheduleId, "automation-schema-fixture-a-extra")}
      ${scheduleFixtureInsert(thirdScheduleId, "automation-schema-fixture-a-third")}
      ${scheduleInsert(fourthScheduleId)}
      ${scheduleFixtureInsert(fourthScheduleId, "automation-schema-fixture-a-fourth")}
      COMMIT;
    `);

    const firstConnection = startSqlSession(`
      BEGIN;
      SET LOCAL deadlock_timeout = '100ms';
      SET LOCAL lock_timeout = '2s';
      UPDATE "LightingScheduleFixture"
      SET "scheduleId" = '${secondScheduleId}'
      WHERE "scheduleId" = '${firstScheduleId}'
        AND "fixtureId" = 'automation-schema-fixture-a';
      SELECT 'automation-multi-row-first-ready';
      SELECT pg_sleep(0.5);
      DELETE FROM "LightingScheduleFixture"
      WHERE "scheduleId" = '${thirdScheduleId}'
        AND "fixtureId" = 'automation-schema-fixture-a-extra';
      COMMIT;
    `);
    await firstConnection.waitForOutput("automation-multi-row-first-ready");

    const secondConnection = startSqlSession(`
      BEGIN;
      SET LOCAL deadlock_timeout = '100ms';
      SET LOCAL lock_timeout = '2s';
      UPDATE "LightingScheduleFixture"
      SET "scheduleId" = '${fourthScheduleId}'
      WHERE "scheduleId" = '${thirdScheduleId}'
        AND "fixtureId" = 'automation-schema-fixture-a-third';
      SELECT pg_sleep(0.5);
      DELETE FROM "LightingScheduleFixture"
      WHERE "scheduleId" = '${firstScheduleId}'
        AND "fixtureId" = 'automation-schema-fixture-a-fourth';
      COMMIT;
    `);
    const [firstResult, secondResult] = await Promise.all([
      firstConnection.completion,
      secondConnection.completion
    ]);
    const actualCounts = querySql(`
      SELECT schedule."id" || ':' || schedule."targetCount" || ':' || COUNT(target.*)
      FROM "LightingSchedule" AS schedule
      LEFT JOIN "LightingScheduleFixture" AS target ON target."scheduleId" = schedule."id"
      WHERE schedule."id" IN (
        '${firstScheduleId}', '${secondScheduleId}', '${thirdScheduleId}', '${fourthScheduleId}'
      )
      GROUP BY schedule."id"
      ORDER BY schedule."id";
    `);
    executeSql(`
      DELETE FROM "LightingSchedule"
      WHERE "id" IN (
        '${firstScheduleId}', '${secondScheduleId}', '${thirdScheduleId}', '${fourthScheduleId}'
      );
    `);

    const concurrencyErrors = `${firstResult.stderr}\n${secondResult.stderr}`;
    expect(concurrencyErrors).not.toMatch(/deadlock detected|canceling statement due to lock timeout/);
    expect(firstResult.status).toBe(0);
    expect(firstResult.stderr).toBe("");
    expect(secondResult.status).toBe(0);
    expect(secondResult.stderr).toBe("");
    expect(actualCounts).toBe(
      `${firstScheduleId}:1:1\n${secondScheduleId}:2:2\n` +
      `${thirdScheduleId}:1:1\n${fourthScheduleId}:2:2`
    );
  });

  it("maintains exact counters, rejects reconciliation drift, and permits parent cascades", () => {
    const firstScheduleId = "automation-schema-counter-schedule-a";
    const secondScheduleId = "automation-schema-counter-schedule-b";
    const vehicleRuleId = "automation-schema-counter-vehicle";
    const manualOverrideId = "automation-schema-counter-manual";
    executeSql(`
      BEGIN;
      ${scheduleInsert(firstScheduleId)}
      ${scheduleFixtureInsert(firstScheduleId, "automation-schema-fixture-a")}
      ${scheduleFixtureInsert(firstScheduleId, "automation-schema-fixture-a-extra")}
      ${scheduleInsert(secondScheduleId)}
      ${scheduleFixtureInsert(secondScheduleId, "automation-schema-fixture-a-third")}
      ${vehicleRuleInsert(vehicleRuleId)}
      ${vehicleSourceInsert(vehicleRuleId, "automation-schema-fixture-a")}
      ${vehicleTargetInsert(vehicleRuleId, "automation-schema-fixture-a-extra")}
      ${manualOverrideInsert(manualOverrideId, "automation-schema-command-a")}
      ${manualFixtureInsert(manualOverrideId, "automation-schema-fixture-a")}
      COMMIT;
      UPDATE "LightingScheduleFixture"
      SET "scheduleId" = '${secondScheduleId}'
      WHERE "scheduleId" = '${firstScheduleId}'
        AND "fixtureId" = 'automation-schema-fixture-a-extra';
    `);

    expect(querySql(`
      SELECT "id" || ':' || "targetCount"
      FROM "LightingSchedule"
      WHERE "id" IN ('${firstScheduleId}', '${secondScheduleId}')
      ORDER BY "id";
    `)).toBe(`${firstScheduleId}:1\n${secondScheduleId}:2`);
    expect(querySql(`
      SELECT "sourceCount" || ':' || "targetCount"
      FROM "VehicleEventRule"
      WHERE "id" = '${vehicleRuleId}';
    `)).toBe("1:1");
    expect(querySql(`
      SELECT "targetCount"
      FROM "ManualOverride"
      WHERE "id" = '${manualOverrideId}';
    `)).toBe("1");

    expectSqlFailure(`
      BEGIN;
      UPDATE "LightingSchedule" SET "targetCount" = 99 WHERE "id" = '${firstScheduleId}';
      COMMIT;
    `, "lighting schedule target counter does not match fixture rows");
    expectSqlFailure(`
      BEGIN;
      UPDATE "VehicleEventRule" SET "sourceCount" = 99 WHERE "id" = '${vehicleRuleId}';
      COMMIT;
    `, "vehicle event counters do not match fixture rows");
    expectSqlFailure(`
      BEGIN;
      UPDATE "ManualOverride" SET "targetCount" = 99 WHERE "id" = '${manualOverrideId}';
      COMMIT;
    `, "manual override target counter does not match fixture rows");
    expectSqlFailure(`
      UPDATE "LightingSchedule" SET "targetCount" = -1 WHERE "id" = '${firstScheduleId}';
    `, "LightingSchedule_target_count_check");

    expect(querySql(`
      SELECT bool_and(parent_count = child_count)
      FROM (
        SELECT schedule."targetCount" AS parent_count, COUNT(target.*)::INTEGER AS child_count
        FROM "LightingSchedule" AS schedule
        LEFT JOIN "LightingScheduleFixture" AS target ON target."scheduleId" = schedule."id"
        WHERE schedule."id" IN ('${firstScheduleId}', '${secondScheduleId}')
        GROUP BY schedule."id"
      ) AS reconciled;
    `)).toBe("t");
    expect(querySql(`
      SELECT
        rule."sourceCount" = (SELECT COUNT(*) FROM "VehicleEventSource" WHERE "ruleId" = rule."id")
        AND rule."targetCount" = (SELECT COUNT(*) FROM "VehicleEventTarget" WHERE "ruleId" = rule."id")
      FROM "VehicleEventRule" AS rule
      WHERE rule."id" = '${vehicleRuleId}';
    `)).toBe("t");
    expect(querySql(`
      SELECT override."targetCount" = (
        SELECT COUNT(*) FROM "ManualOverrideFixture" WHERE "manualOverrideId" = override."id"
      )
      FROM "ManualOverride" AS override
      WHERE override."id" = '${manualOverrideId}';
    `)).toBe("t");

    executeSql(`
      BEGIN;
      DELETE FROM "LightingSchedule" WHERE "id" IN ('${firstScheduleId}', '${secondScheduleId}');
      DELETE FROM "VehicleEventRule" WHERE "id" = '${vehicleRuleId}';
      DELETE FROM "ManualOverride" WHERE "id" = '${manualOverrideId}';
      COMMIT;
    `);
    expect(querySql(`
      SELECT
        (SELECT COUNT(*) FROM "LightingScheduleFixture" WHERE "scheduleId" IN ('${firstScheduleId}', '${secondScheduleId}'))
        + (SELECT COUNT(*) FROM "VehicleEventSource" WHERE "ruleId" = '${vehicleRuleId}')
        + (SELECT COUNT(*) FROM "VehicleEventTarget" WHERE "ruleId" = '${vehicleRuleId}')
        + (SELECT COUNT(*) FROM "ManualOverrideFixture" WHERE "manualOverrideId" = '${manualOverrideId}');
    `)).toBe("0");
  });

  it("allows harmless and unreferenced indirect ownership updates", () => {
    executeSql(`
      UPDATE "Floor" SET "siteId" = 'automation-schema-site-a' WHERE "id" = 'automation-schema-floor-a';
      UPDATE "MeshNode" SET "gatewayId" = 'automation-schema-gateway-a' WHERE "id" = 'automation-schema-node-a';
      UPDATE "Floor" SET "siteId" = 'automation-schema-site-b' WHERE "id" = 'automation-schema-floor-free';
      UPDATE "Floor" SET "siteId" = 'automation-schema-site-a' WHERE "id" = 'automation-schema-floor-free';
      UPDATE "MeshNode" SET "gatewayId" = 'automation-schema-gateway-move' WHERE "id" = 'automation-schema-node-free';
      UPDATE "MeshNode" SET "gatewayId" = 'automation-schema-gateway-a' WHERE "id" = 'automation-schema-node-free';
    `);
  });

  it("blocks a Floor Site change that indirectly invalidates automation references", () => {
    expectSqlFailure(
      `UPDATE "Floor" SET "siteId" = 'automation-schema-site-b' WHERE "id" = 'automation-schema-floor-a';`,
      "LightingScheduleFixture_fixtureId_siteId_gatewayId_fkey"
    );
  });

  it("blocks a MeshNode Gateway change that indirectly invalidates automation references", () => {
    expectSqlFailure(
      `UPDATE "MeshNode" SET "gatewayId" = 'automation-schema-gateway-move' WHERE "id" = 'automation-schema-node-a';`,
      "LightingScheduleFixture_fixtureId_siteId_gatewayId_fkey"
    );
  });
});

const validPayloadHash = `sha256:${"a".repeat(64)}`;

function configurationInsert(
  gatewayId: string,
  status: "PENDING" | "APPLIED" | "REJECTED",
  desiredRevision: number,
  appliedRevision: number,
  payloadHash: string,
  lastErrorCode: string,
  lastAppliedAt: string
) {
  return `
    INSERT INTO "GatewayAutomationConfiguration" (
      "gatewayId", "siteId", "desiredRevision", "appliedRevision", "syncStatus",
      "payloadHash", "lastErrorCode", "lastAppliedAt", "updatedAt"
    ) VALUES (
      '${gatewayId}', 'automation-schema-site-a', ${desiredRevision}, ${appliedRevision}, '${status}',
      ${payloadHash}, ${lastErrorCode}, ${lastAppliedAt}, CURRENT_TIMESTAMP
    );
  `;
}

function scheduleInsert(id: string, weeklyDays = "ARRAY[1]::INTEGER[]") {
  return `
    INSERT INTO "LightingSchedule" (
      "id", "siteId", "gatewayId", "name", "status", "activeFrom", "activeUntil",
      "localStartTime", "localEndTime", "recurrenceKind", "weeklyDays", "dimmingEnabled",
      "brightnessPercent", "desiredRevision", "appliedRevision", "createdById", "updatedById",
      "createdAt", "updatedAt"
    ) VALUES (
      '${id}', 'automation-schema-site-a', 'automation-schema-gateway-a', '${id}', 'enabled',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 day', '10:00', '11:00', 'weekly', ${weeklyDays},
      true, 50, 1, 0, 'automation-schema-user-a', 'automation-schema-user-a', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `;
}

function scheduleFixtureInsert(scheduleId: string, fixtureId: string) {
  return `
    INSERT INTO "LightingScheduleFixture" ("scheduleId", "fixtureId", "siteId", "gatewayId")
    VALUES ('${scheduleId}', '${fixtureId}', 'automation-schema-site-a', 'automation-schema-gateway-a');
  `;
}

function vehicleRuleInsert(
  id: string,
  siteId = "automation-schema-site-a",
  gatewayId = "automation-schema-gateway-a",
  userId = "automation-schema-user-a"
) {
  return `
    INSERT INTO "VehicleEventRule" (
      "id", "siteId", "gatewayId", "name", "status", "dimmingEnabled", "brightnessPercent",
      "holdSeconds", "desiredRevision", "appliedRevision", "createdById", "updatedById", "createdAt", "updatedAt"
    ) VALUES (
      '${id}', '${siteId}', '${gatewayId}', '${id}', 'enabled', true, 50, 60, 1, 0,
      '${userId}', '${userId}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `;
}

function vehicleSourceInsert(
  ruleId: string,
  fixtureId: string,
  siteId = "automation-schema-site-a",
  gatewayId = "automation-schema-gateway-a"
) {
  return `
    INSERT INTO "VehicleEventSource" ("ruleId", "fixtureId", "siteId", "gatewayId")
    VALUES ('${ruleId}', '${fixtureId}', '${siteId}', '${gatewayId}');
  `;
}

function vehicleTargetInsert(
  ruleId: string,
  fixtureId: string,
  siteId = "automation-schema-site-a",
  gatewayId = "automation-schema-gateway-a"
) {
  return `
    INSERT INTO "VehicleEventTarget" ("ruleId", "fixtureId", "siteId", "gatewayId")
    VALUES ('${ruleId}', '${fixtureId}', '${siteId}', '${gatewayId}');
  `;
}

function manualOverrideInsert(id: string, commandId: string) {
  return `
    INSERT INTO "ManualOverride" (
      "id", "siteId", "gatewayId", "commandId", "requestedById", "brightnessPercent",
      "startedAt", "overrideUntil", "createdAt", "updatedAt"
    ) VALUES (
      '${id}', 'automation-schema-site-a', 'automation-schema-gateway-a', '${commandId}',
      'automation-schema-user-a', 50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 hour',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `;
}

function manualFixtureInsert(manualOverrideId: string, fixtureId: string) {
  return `
    INSERT INTO "ManualOverrideFixture" ("manualOverrideId", "fixtureId", "siteId", "gatewayId")
    VALUES ('${manualOverrideId}', '${fixtureId}', 'automation-schema-site-a', 'automation-schema-gateway-a');
  `;
}

function executionInsert(options: {
  id: string;
  eventId: string;
  gatewayId?: string;
  kind: "schedule_started" | "schedule_ended" | "event_started" | "event_ended" | "action_result" | "telemetry_gap";
  ruleId?: string;
  lightingScheduleId?: string;
  vehicleEventRuleId?: string;
  manualOverrideId?: string;
}) {
  const gatewayId = options.gatewayId ?? "automation-schema-gateway-a";
  return `
    INSERT INTO "AutomationExecution" (
      "id", "siteId", "gatewayId", "eventId", "sequence", "revision", "ruleId",
      "lightingScheduleId", "vehicleEventRuleId", "manualOverrideId", "kind", "occurredAt", "payload", "createdAt"
    ) VALUES (
      '${options.id}', 'automation-schema-site-a', '${gatewayId}', '${options.eventId}', 1, 1,
      ${sqlNullable(options.ruleId)}, ${sqlNullable(options.lightingScheduleId)},
      ${sqlNullable(options.vehicleEventRuleId)}, ${sqlNullable(options.manualOverrideId)},
      '${options.kind}', CURRENT_TIMESTAMP, '{}'::jsonb, CURRENT_TIMESTAMP
    );
  `;
}

function fixtureResultInsert(
  fixtureSnapshotId: string,
  fixtureId: string,
  status: "pending" | "succeeded" | "timed_out"
) {
  return `
    INSERT INTO "AutomationExecutionFixtureResult" (
      "executionId", "fixtureSnapshotId", "fixtureId", "status", "occurredAt", "createdAt"
    ) VALUES (
      'automation-schema-result-execution', '${fixtureSnapshotId}', '${fixtureId}', '${status}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `;
}

function sqlNullable(value?: string) {
  return value === undefined ? "NULL" : `'${value}'`;
}

function executeSql(sql: string) {
  const result = runSql(sql);
  if (result.status !== 0) throw new Error(result.stderr);
}

function expectSqlFailure(sql: string, expectedError: string) {
  const result = runSql(sql);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(expectedError);
}

function querySql(sql: string) {
  const result = runSql(sql, ["-qAt"]);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function startSqlSession(sql: string) {
  const child = spawn("psql", ["-qAt", "-v", "ON_ERROR_STOP=1", psqlDatabaseUrl!], {
    stdio: ["pipe", "pipe", "pipe"]
  });
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
  child.stdin.end(sql);

  return {
    completion: new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    }),
    waitForOutput(marker: string) {
      if (stdout.includes(marker)) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for PostgreSQL marker: ${marker}\n${stderr}`));
        }, 3000);
        const onData = () => {
          if (!stdout.includes(marker)) return;
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          resolve();
        };
        child.stdout.on("data", onData);
      });
    }
  };
}

function runSql(sql: string, extraArgs: string[] = ["-q"]) {
  return spawnSync("psql", [...extraArgs, "-v", "ON_ERROR_STOP=1", psqlDatabaseUrl!], {
    encoding: "utf8",
    input: sql
  });
}
