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
    for (const constraint of [
      "GatewayAutomationConfiguration_gatewayId_siteId_fkey",
      "LightingSchedule_gatewayId_siteId_fkey",
      "VehicleEventRule_gatewayId_siteId_fkey",
      "ManualOverride_gatewayId_siteId_fkey",
      "AutomationExecution_gatewayId_siteId_fkey"
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }
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
      INSERT INTO "Organization" ("id", "name", "type", "createdAt", "updatedAt")
        VALUES ('automation-schema-org', 'Automation schema', 'customer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "User" (
        "id", "organizationId", "loginId", "name", "passwordHash", "role", "status", "createdAt", "updatedAt"
      ) VALUES (
        'automation-schema-user', 'automation-schema-org', 'automation-schema-user', 'Automation schema',
        'hash', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "Site" ("id", "organizationId", "name", "createdAt", "updatedAt")
        VALUES ('automation-schema-site', 'automation-schema-org', 'Automation schema', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "Gateway" (
        "id", "siteId", "name", "serialNumber", "firmwareVersion", "createdAt", "updatedAt"
      ) VALUES (
        'automation-schema-gateway', 'automation-schema-site', 'Automation schema',
        'AUTOMATION-SCHEMA-GATEWAY', '1.0.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);
  });

  afterAll(() => {
    executeSql(`
      DELETE FROM "LightingSchedule" WHERE "id" = 'automation-schema-invalid-schedule';
      DELETE FROM "Gateway" WHERE "id" = 'automation-schema-gateway';
      DELETE FROM "Site" WHERE "id" = 'automation-schema-site';
      DELETE FROM "User" WHERE "id" = 'automation-schema-user';
      DELETE FROM "Organization" WHERE "id" = 'automation-schema-org';
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
        'automation-schema-invalid-schedule', 'automation-schema-site', 'automation-schema-gateway',
        'Invalid monthly recurrence', 'enabled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        '10:00', '11:00', 'monthly', ARRAY[]::INTEGER[], true, 50, 0, 0,
        'automation-schema-user', 'automation-schema-user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LightingSchedule_recurrence_check");
  });
});

function executeSql(sql: string) {
  const result = runSql(sql);
  if (result.status !== 0) throw new Error(result.stderr);
}

function runSql(sql: string) {
  return spawnSync("psql", ["-q", "-v", "ON_ERROR_STOP=1", psqlDatabaseUrl!], {
    encoding: "utf8",
    input: sql
  });
}
