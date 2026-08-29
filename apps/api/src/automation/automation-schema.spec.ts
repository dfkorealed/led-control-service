import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
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

  it("installs immutable recurrence and deferred fixture-cardinality enforcement", () => {
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
  });

  it("guards Gateway reassignment and fixture ownership changes in PostgreSQL", () => {
    expect(migration).toContain('CREATE TRIGGER "Gateway_automation_site_reassignment_guard"');
    expect(migration).toContain('OLD."siteId" IS NULL');
    expect(migration).toMatch(/MqttOutbox[\s\S]*?"publishedAt" IS NULL/);
    expect(migration).toContain('CREATE FUNCTION "validate_automation_fixture_scope"');
    expect(migration).toContain('CREATE TRIGGER "Fixture_automation_scope_change_guard"');
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
        ('automation-schema-gateway-b', 'automation-schema-site-b', 'Gateway B', 'AUTOMATION-SCHEMA-GATEWAY-B', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-gateway-config', 'automation-schema-site-a', 'Gateway config', 'AUTOMATION-SCHEMA-GATEWAY-CONFIG', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-gateway-history', 'automation-schema-site-a', 'Gateway history', 'AUTOMATION-SCHEMA-GATEWAY-HISTORY', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-gateway-outbox', 'automation-schema-site-a', 'Gateway outbox', 'AUTOMATION-SCHEMA-GATEWAY-OUTBOX', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-gateway-free', 'automation-schema-site-a', 'Gateway free', 'AUTOMATION-SCHEMA-GATEWAY-FREE', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "Floor" ("id", "siteId", "name", "level", "createdAt", "updatedAt") VALUES
        ('automation-schema-floor-a', 'automation-schema-site-a', 'Floor A', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-floor-b', 'automation-schema-site-b', 'Floor B', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "MeshNode" (
        "id", "gatewayId", "meshAddress", "firmwareVersion", "createdAt", "updatedAt"
      ) VALUES
        ('automation-schema-node-a', 'automation-schema-gateway-a', '0101', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-a2', 'automation-schema-gateway-a2', '0101', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-b', 'automation-schema-gateway-b', '0101', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "Fixture" (
        "id", "floorId", "meshNodeId", "name", "ratedWatt", "x", "y", "createdAt", "updatedAt"
      ) VALUES
        ('automation-schema-fixture-a', 'automation-schema-floor-a', 'automation-schema-node-a', 'Fixture A', 30, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
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

  it("rejects fixture snapshots outside the parent Site or Gateway", () => {
    expectSqlFailure(`
      BEGIN;
      ${scheduleInsert("automation-schema-cross-site-schedule")}
      ${scheduleFixtureInsert("automation-schema-cross-site-schedule", "automation-schema-fixture-b")}
      COMMIT;
    `, "fixture Site does not match automation owner");
    expectSqlFailure(`
      BEGIN;
      ${vehicleRuleInsert("automation-schema-cross-gateway-vehicle")}
      ${vehicleSourceInsert("automation-schema-cross-gateway-vehicle", "automation-schema-fixture-a2")}
      ${vehicleTargetInsert("automation-schema-cross-gateway-vehicle", "automation-schema-fixture-a")}
      COMMIT;
    `, "fixture Gateway does not match automation owner");
    expectSqlFailure(`
      BEGIN;
      ${manualOverrideInsert("automation-schema-unassigned-manual", "automation-schema-command-a")}
      ${manualFixtureInsert("automation-schema-unassigned-manual", "automation-schema-fixture-unassigned")}
      COMMIT;
    `, "fixture must be assigned to a MeshNode");
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
      "fixture Site change would invalidate automation references"
    );
    expectSqlFailure(
      `UPDATE "Fixture" SET "meshNodeId" = 'automation-schema-node-a2' WHERE "id" = 'automation-schema-fixture-a';`,
      "fixture Gateway change would invalidate automation references"
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

function runSql(sql: string, extraArgs: string[] = ["-q"]) {
  return spawnSync("psql", [...extraArgs, "-v", "ON_ERROR_STOP=1", psqlDatabaseUrl!], {
    encoding: "utf8",
    input: sql
  });
}
