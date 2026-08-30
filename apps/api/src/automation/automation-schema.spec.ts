import { Prisma, PrismaClient } from "@prisma/client";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationPath = join(
  __dirname,
  "../../prisma/migrations/20260829_add_lighting_automation/migration.sql"
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const scheduleListIndexMigrationPath = join(
  __dirname,
  "../../prisma/migrations/20260830_add_schedule_execution_list_index/migration.sql"
);
const scheduleListIndexMigration = existsSync(scheduleListIndexMigrationPath)
  ? readFileSync(scheduleListIndexMigrationPath, "utf8")
  : "";
const vehicleEventListIndexMigrationPath = join(
  __dirname,
  "../../prisma/migrations/20260830_add_vehicle_event_execution_list_index/migration.sql"
);
const vehicleEventListIndexMigration = existsSync(vehicleEventListIndexMigrationPath)
  ? readFileSync(vehicleEventListIndexMigrationPath, "utf8")
  : "";
const equalTimeMigrationPath = join(
  __dirname,
  "../../prisma/migrations/20260830_reject_equal_schedule_times/migration.sql"
);
const equalTimeMigration = existsSync(equalTimeMigrationPath)
  ? readFileSync(equalTimeMigrationPath, "utf8")
  : "";
const capabilityOrderingMigrationPath = join(
  __dirname,
  "../../prisma/migrations/20260830_vehicle_sensor_state_ordering/migration.sql"
);
const capabilityOrderingMigration = existsSync(capabilityOrderingMigrationPath)
  ? readFileSync(capabilityOrderingMigrationPath, "utf8")
  : "";
const nodeLocalCapabilityMigrationPath = join(
  __dirname,
  "../../prisma/migrations/20260831_node_local_capability_ack_outbox/migration.sql"
);
const nodeLocalCapabilityMigration = existsSync(nodeLocalCapabilityMigrationPath)
  ? readFileSync(nodeLocalCapabilityMigrationPath, "utf8")
  : "";
const automationMqttDeliveryMigrationPath = join(
  __dirname,
  "../../prisma/migrations/20260901_automation_mqtt_delivery/migration.sql"
);
const automationMqttDeliveryMigration = existsSync(automationMqttDeliveryMigrationPath)
  ? readFileSync(automationMqttDeliveryMigrationPath, "utf8")
  : "";
const snapshotBackedExecutionMigrationPath = join(
  __dirname,
  "../../prisma/migrations/20260902_snapshot_backed_automation_execution/migration.sql"
);
const snapshotBackedExecutionMigration = existsSync(snapshotBackedExecutionMigrationPath)
  ? readFileSync(snapshotBackedExecutionMigrationPath, "utf8")
  : "";
const prismaSchema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");
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

  it("exposes fail-closed vehicle sensor capability metadata on MeshNode", () => {
    const meshNode = Prisma.dmmf.datamodel.models.find((model) => model.name === "MeshNode");
    const capabilityEnum = Prisma.dmmf.datamodel.enums.find(
      (enumDefinition) => enumDefinition.name === "VehicleSensorCapabilityStatus"
    );

    expect(meshNode?.fields.map((field) => field.name)).toEqual(expect.arrayContaining([
      "vehicleSensorCapabilityStatus",
      "vehicleSensorCapabilityVerifiedAt",
      "vehicleSensorCapabilityRevision",
      "vehicleSensorServerBound",
      "vehicleVendorEventModelBound"
    ]));
    expect(capabilityEnum?.values.map(({ name }) => name)).toEqual([
      "unknown",
      "supported",
      "unsupported"
    ]);
  });

  it("persists ordered capability state and optional gateway event hashes through a forward migration", () => {
    const processedEvent = Prisma.dmmf.datamodel.models.find(
      (model) => model.name === "ProcessedGatewayEvent"
    );

    expect(processedEvent?.fields.map((field) => field.name)).toContain("payloadHash");
    expect(capabilityOrderingMigration.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(capabilityOrderingMigration).toContain('ADD COLUMN "vehicleSensorCapabilityRevision" BIGINT');
    expect(capabilityOrderingMigration).toContain('ADD COLUMN "vehicleSensorServerBound" BOOLEAN');
    expect(capabilityOrderingMigration).toContain('ADD COLUMN "vehicleVendorEventModelBound" BOOLEAN');
    expect(capabilityOrderingMigration).toContain('ADD COLUMN "payloadHash" TEXT');
    expect(capabilityOrderingMigration).toContain('CONSTRAINT "MeshNode_vehicle_sensor_capability_check"');
    expect(capabilityOrderingMigration).toContain('CONSTRAINT "ProcessedGatewayEvent_payload_hash_check"');
    expect(capabilityOrderingMigration).toContain("^sha256:[0-9a-f]{64}$");
    expect(capabilityOrderingMigration.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("scopes capability ledgers to MeshNode and adds a durable application ACK outbox variant", () => {
    const models = Object.fromEntries(
      Prisma.dmmf.datamodel.models.map((model) => [model.name, model.fields.map((field) => field.name)])
    );

    expect(models.ProcessedGatewayEvent).toContain("meshNodeId");
    expect(models.MqttOutbox).toContain("applicationAckKey");
    expect(nodeLocalCapabilityMigration.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(nodeLocalCapabilityMigration).toContain('ADD COLUMN "meshNodeId" TEXT');
    expect(nodeLocalCapabilityMigration).toContain('fixture."meshNodeId"');
    expect(nodeLocalCapabilityMigration).toContain("Operator remediation required before migration");
    expect(nodeLocalCapabilityMigration).toContain(
      'DROP INDEX "ProcessedGatewayEvent_gatewayId_sequence_eventType_key"'
    );
    expect(nodeLocalCapabilityMigration).toContain(
      'CREATE UNIQUE INDEX "ProcessedGatewayEvent_legacy_sequence_key"'
    );
    expect(nodeLocalCapabilityMigration).toContain(
      "WHERE \"eventType\" <> 'vehicle_sensor_capability'"
    );
    expect(nodeLocalCapabilityMigration).toContain(
      'CREATE UNIQUE INDEX "ProcessedGatewayEvent_capability_node_sequence_key"'
    );
    expect(nodeLocalCapabilityMigration).toContain(
      'ON "ProcessedGatewayEvent"("gatewayId", "meshNodeId", "sequence", "eventType")'
    );
    expect(nodeLocalCapabilityMigration).toContain(
      "WHERE \"eventType\" = 'vehicle_sensor_capability'"
    );
    expect(nodeLocalCapabilityMigration).toContain('ADD COLUMN "applicationAckKey" TEXT');
    expect(nodeLocalCapabilityMigration).toContain(
      'CREATE UNIQUE INDEX "MqttOutbox_applicationAckKey_key"'
    );
    expect(nodeLocalCapabilityMigration).toContain('CONSTRAINT "MqttOutbox_row_shape_check"');
    expect(nodeLocalCapabilityMigration.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("persists canonical execution hashes and retained config supersession state", () => {
    const models = Object.fromEntries(
      Prisma.dmmf.datamodel.models.map((model) => [model.name, model.fields.map((field) => field.name)])
    );

    expect(models.AutomationExecution).toContain("payloadHash");
    expect(models.MqttOutbox).toContain("supersededAt");
    expect(automationMqttDeliveryMigration.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(automationMqttDeliveryMigration).toContain('ADD COLUMN "payloadHash" TEXT');
    expect(automationMqttDeliveryMigration).toContain(
      'CONSTRAINT "AutomationExecution_payload_hash_check"'
    );
    expect(automationMqttDeliveryMigration).toContain("^sha256:[0-9a-f]{64}$");
    expect(automationMqttDeliveryMigration).toContain('ADD COLUMN "supersededAt" TIMESTAMP(3)');
    expect(automationMqttDeliveryMigration).toContain(
      'CREATE INDEX "MqttOutbox_automation_delivery_idx"'
    );
    expect(automationMqttDeliveryMigration).toContain('"supersededAt" IS NULL');
    expect(automationMqttDeliveryMigration.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("allows deleted execution sources only when the immutable revision snapshot proves their scope", () => {
    expect(snapshotBackedExecutionMigration.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(snapshotBackedExecutionMigration).toContain(
      'CREATE OR REPLACE FUNCTION "validate_automation_execution_source"()'
    );
    expect(snapshotBackedExecutionMigration).toContain('FROM "MqttOutbox" AS outbox');
    expect(snapshotBackedExecutionMigration).toContain('outbox."revision" = NEW."revision"');
    expect(snapshotBackedExecutionMigration).toContain("jsonb_array_elements");
    expect(snapshotBackedExecutionMigration).toContain("execution source is absent from immutable snapshot");
    expect(snapshotBackedExecutionMigration.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("indexes each schedule's latest execution in list order through a forward migration", () => {
    expect(prismaSchema).toContain(
      "@@index([lightingScheduleId, occurredAt(sort: Desc), sequence(sort: Desc)])"
    );
    expect(scheduleListIndexMigration).toContain(
      'CREATE INDEX "AutomationExecution_lightingScheduleId_occurredAt_sequence_idx"'
    );
    expect(scheduleListIndexMigration).toContain(
      '("lightingScheduleId", "occurredAt" DESC, "sequence" DESC)'
    );
  });

  it("indexes each vehicle rule's latest execution in list order through a forward migration", () => {
    expect(prismaSchema).toContain(
      "@@index([vehicleEventRuleId, occurredAt(sort: Desc), sequence(sort: Desc)])"
    );
    expect(vehicleEventListIndexMigration).toContain(
      'CREATE INDEX "AutomationExecution_vehicleEventRuleId_occurredAt_sequence_idx"'
    );
    expect(vehicleEventListIndexMigration).toContain(
      '("vehicleEventRuleId", "occurredAt" DESC, "sequence" DESC)'
    );
  });

  it("preflights equal-time schedules and pending snapshots before enforcing the DB inequality", () => {
    const lockStatement = 'LOCK TABLE "LightingSchedule", "MqttOutbox" IN SHARE MODE;';

    expect(prismaSchema).toContain("DB CHECK requires localStartTime and localEndTime to differ");
    expect(equalTimeMigration.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(equalTimeMigration).toContain(lockStatement);
    expect(equalTimeMigration).toContain('FROM "LightingSchedule"');
    expect(equalTimeMigration).toContain("jsonb_array_elements");
    expect(equalTimeMigration).toContain('outbox."publishedAt" IS NULL');
    expect(equalTimeMigration).toContain('outbox."deadLetteredAt" IS NULL');
    expect(equalTimeMigration).toContain("ERRCODE = '23514'");
    expect(equalTimeMigration).toContain("Operator remediation required before migration");
    expect(equalTimeMigration).toContain("No rows were modified");
    expect(equalTimeMigration).toContain('CHECK ("localStartTime" <> "localEndTime")');
    expect(equalTimeMigration.indexOf('FROM "LightingSchedule"')).toBeLessThan(
      equalTimeMigration.indexOf('CHECK ("localStartTime" <> "localEndTime")')
    );
    expect(equalTimeMigration.indexOf("jsonb_array_elements")).toBeLessThan(
      equalTimeMigration.indexOf('CHECK ("localStartTime" <> "localEndTime")')
    );
    expect(equalTimeMigration.indexOf(lockStatement)).toBeLessThan(
      equalTimeMigration.indexOf('FROM "LightingSchedule"')
    );
    expect(equalTimeMigration.indexOf('CHECK ("localStartTime" <> "localEndTime")')).toBeLessThan(
      equalTimeMigration.lastIndexOf("COMMIT;")
    );
    expect(equalTimeMigration.trimEnd().endsWith("COMMIT;")).toBe(true);
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
    expect(migration).toMatch(
      /CREATE FUNCTION "lock_automation_membership_statement"\(\)[\s\S]*?pg_trigger_depth\(\) = 1[\s\S]*?PERFORM "lock_automation_membership_mutation"\(\)/
    );
    for (const tableName of [
      "LightingSchedule",
      "LightingScheduleFixture",
      "VehicleEventRule",
      "VehicleEventSource",
      "VehicleEventTarget",
      "ManualOverride",
      "ManualOverrideFixture"
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE TRIGGER "${tableName}_membership_statement_lock"[\\s\\S]*?` +
          `BEFORE INSERT OR UPDATE OR DELETE ON "${tableName}"[\\s\\S]*?FOR EACH STATEMENT`
        )
      );
    }
    expect(migration).toMatch(
      /CREATE FUNCTION "maintain_lighting_schedule_target_count"\(\)[\s\S]*?pg_trigger_depth\(\) > 1/
    );
    expect(migration).toMatch(
      /CREATE FUNCTION "maintain_vehicle_event_fixture_counts"\(\)[\s\S]*?pg_trigger_depth\(\) > 1/
    );
    expect(migration).toMatch(
      /CREATE FUNCTION "maintain_manual_override_target_count"\(\)[\s\S]*?pg_trigger_depth\(\) > 1/
    );
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
        "id", "gatewayId", "meshAddress", "firmwareVersion",
        "vehicleSensorCapabilityStatus", "vehicleSensorCapabilityVerifiedAt",
        "vehicleSensorCapabilityRevision", "vehicleSensorServerBound", "vehicleVendorEventModelBound",
        "createdAt", "updatedAt"
      ) VALUES
        ('automation-schema-node-a', 'automation-schema-gateway-a', '0101', '1.0.0', 'supported', CURRENT_TIMESTAMP, 1, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-a-extra', 'automation-schema-gateway-a', '0102', '1.0.0', 'supported', CURRENT_TIMESTAMP, 1, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-a-third', 'automation-schema-gateway-a', '0104', '1.0.0', 'supported', CURRENT_TIMESTAMP, 1, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-a-fourth', 'automation-schema-gateway-a', '0105', '1.0.0', 'supported', CURRENT_TIMESTAMP, 1, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-a2', 'automation-schema-gateway-a2', '0101', '1.0.0', 'supported', CURRENT_TIMESTAMP, 1, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-free', 'automation-schema-gateway-a', '0103', '1.0.0', 'supported', CURRENT_TIMESTAMP, 1, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-move', 'automation-schema-gateway-move', '0201', '1.0.0', 'supported', CURRENT_TIMESTAMP, 1, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('automation-schema-node-b', 'automation-schema-gateway-b', '0101', '1.0.0', 'supported', CURRENT_TIMESTAMP, 1, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
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

  it("enforces vehicle sensor capability coherence and catalogs the partial latest-detection index", () => {
    expect(querySql(`
      SELECT string_agg(enum_value.enumlabel, ',' ORDER BY enum_value.enumsortorder)
      FROM pg_type AS enum_type
      JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
      WHERE enum_type.typname = 'VehicleSensorCapabilityStatus';
    `)).toBe("unknown,supported,unsupported");

    expect(querySql(`
      SELECT pg_get_constraintdef(constraint_row.oid)
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
      WHERE relation.relname = 'MeshNode'
        AND constraint_row.conname = 'MeshNode_vehicle_sensor_capability_check';
    `)).toContain("vehicleSensorCapabilityVerifiedAt");

    expectSqlFailure(`
      UPDATE "MeshNode"
      SET "vehicleSensorCapabilityStatus" = 'supported',
          "vehicleSensorCapabilityVerifiedAt" = NULL
      WHERE "id" = 'automation-schema-node-a';
    `, "supported vehicle sensor capability requires verifiedAt");
    expectSqlFailure(`
      UPDATE "MeshNode"
      SET "vehicleSensorCapabilityStatus" = 'unknown',
          "vehicleSensorCapabilityVerifiedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'automation-schema-node-a';
    `, "unknown vehicle sensor capability requires null verifiedAt");
    executeSql(`
      UPDATE "MeshNode"
      SET "vehicleSensorCapabilityStatus" = 'supported',
          "vehicleSensorCapabilityVerifiedAt" = CURRENT_TIMESTAMP,
          "vehicleSensorCapabilityRevision" = 1,
          "vehicleSensorServerBound" = true,
          "vehicleVendorEventModelBound" = true
      WHERE "id" = 'automation-schema-node-a';
      UPDATE "MeshNode"
      SET "vehicleSensorCapabilityStatus" = 'unknown',
          "vehicleSensorCapabilityVerifiedAt" = NULL,
          "vehicleSensorCapabilityRevision" = 0,
          "vehicleSensorServerBound" = false,
          "vehicleVendorEventModelBound" = false
      WHERE "id" = 'automation-schema-node-a';
      UPDATE "MeshNode"
      SET "vehicleSensorCapabilityStatus" = 'supported',
          "vehicleSensorCapabilityVerifiedAt" = CURRENT_TIMESTAMP,
          "vehicleSensorCapabilityRevision" = 1,
          "vehicleSensorServerBound" = true,
          "vehicleVendorEventModelBound" = true
      WHERE "id" = 'automation-schema-node-a';
    `);

    expectSqlFailure(`
      UPDATE "MeshNode"
      SET "vehicleSensorServerBound" = false
      WHERE "id" = 'automation-schema-node-a';
    `, "MeshNode_vehicle_sensor_capability_check");
    expectSqlFailure(`
      UPDATE "MeshNode"
      SET "vehicleSensorCapabilityRevision" = 0
      WHERE "id" = 'automation-schema-node-a';
    `, "MeshNode_vehicle_sensor_capability_check");
    expectSqlFailure(`
      BEGIN;
      UPDATE "MeshNode"
      SET "vehicleSensorCapabilityStatus" = 'unsupported',
          "vehicleSensorCapabilityVerifiedAt" = NULL,
          "vehicleSensorCapabilityRevision" = 2,
          "vehicleSensorServerBound" = true,
          "vehicleVendorEventModelBound" = true
      WHERE "id" = 'automation-schema-node-a';
      ROLLBACK;
    `, "MeshNode_vehicle_sensor_capability_check");

    executeSql(`
      INSERT INTO "ProcessedGatewayEvent" (
        "eventId", "gatewayId", "meshNodeId", "sequence", "eventType", "payloadHash", "occurredAt"
      ) VALUES (
        'automation-schema-capability-event', 'automation-schema-gateway-a', 'automation-schema-node-a', 9001,
        'vehicle_sensor_capability', NULL, CURRENT_TIMESTAMP
      ), (
        'automation-schema-capability-event-node-extra', 'automation-schema-gateway-a', 'automation-schema-node-a-extra', 9001,
        'vehicle_sensor_capability', NULL, CURRENT_TIMESTAMP
      );
    `);
    expectSqlFailure(`
      INSERT INTO "ProcessedGatewayEvent" (
        "eventId", "gatewayId", "meshNodeId", "sequence", "eventType", "occurredAt"
      ) VALUES (
        'automation-schema-capability-event-conflict', 'automation-schema-gateway-a',
        'automation-schema-node-a', 9001, 'vehicle_sensor_capability', CURRENT_TIMESTAMP
      );
    `, "ProcessedGatewayEvent_capability_node_sequence_key");
    executeSql(`
      INSERT INTO "ProcessedGatewayEvent" (
        "eventId", "gatewayId", "sequence", "eventType", "occurredAt"
      ) VALUES (
        'automation-schema-legacy-event', 'automation-schema-gateway-a', 9002,
        'legacy_schema_event', CURRENT_TIMESTAMP
      );
    `);
    expectSqlFailure(`
      INSERT INTO "ProcessedGatewayEvent" (
        "eventId", "gatewayId", "sequence", "eventType", "occurredAt"
      ) VALUES (
        'automation-schema-legacy-event-conflict', 'automation-schema-gateway-a', 9002,
        'legacy_schema_event', CURRENT_TIMESTAMP
      );
    `, "ProcessedGatewayEvent_legacy_sequence_key");
    expectSqlFailure(`
      UPDATE "ProcessedGatewayEvent"
      SET "payloadHash" = 'sha256:not-a-digest'
      WHERE "eventId" = 'automation-schema-capability-event';
    `, "ProcessedGatewayEvent_payload_hash_check");

    executeSql(`
      INSERT INTO "MqttOutbox" (
        "id", "dispatchId", "gatewayId", "applicationAckKey", "revision", "payloadHash",
        "topic", "payload", "attempts", "nextAttemptAt", "createdAt", "updatedAt"
      ) VALUES (
        'automation-schema-capability-ack', NULL, 'automation-schema-gateway-a',
        'vehicle-sensor-capability:automation-schema-gateway-a:automation-schema-capability-event',
        NULL, '${validPayloadHash}', 'sites/site/gateways/gateway/acks/capability', '{}'::jsonb,
        0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);
    expectSqlFailure(`
      INSERT INTO "MqttOutbox" (
        "id", "dispatchId", "gatewayId", "applicationAckKey", "revision", "payloadHash",
        "topic", "payload", "attempts", "nextAttemptAt", "createdAt", "updatedAt"
      ) VALUES (
        'automation-schema-invalid-capability-ack', NULL, 'automation-schema-gateway-a',
        'vehicle-sensor-capability:automation-schema-gateway-a:invalid',
        900719925, '${validPayloadHash}', 'sites/site/gateways/gateway/acks/capability', '{}'::jsonb,
        0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `, "MqttOutbox_row_shape_check");

    const capabilityIndexes = querySql(`
      SELECT string_agg(indexname || ':' || indexdef, E'\n' ORDER BY indexname)
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'ProcessedGatewayEvent'
        AND indexname IN (
          'ProcessedGatewayEvent_legacy_sequence_key',
          'ProcessedGatewayEvent_capability_node_sequence_key'
        );
    `);
    expect(capabilityIndexes).toContain(
      'ProcessedGatewayEvent_capability_node_sequence_key:CREATE UNIQUE INDEX'
    );
    expect(capabilityIndexes).toContain(
      '("gatewayId", "meshNodeId", sequence, "eventType") WHERE ("eventType" = \'vehicle_sensor_capability\'::text)'
    );
    expect(capabilityIndexes).toContain(
      'ProcessedGatewayEvent_legacy_sequence_key:CREATE UNIQUE INDEX'
    );
    expect(capabilityIndexes).toContain(
      '("gatewayId", sequence, "eventType") WHERE ("eventType" <> \'vehicle_sensor_capability\'::text)'
    );

    const indexDefinition = querySql(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'AutomationExecution'
        AND indexname = 'AutomationExecution_vehicleEventRuleId_latest_detection_idx';
    `);
    expect(indexDefinition).toContain(
      '("vehicleEventRuleId", "occurredAt" DESC, sequence DESC)'
    );
    expect(indexDefinition).toContain(
      "WHERE (kind = 'vehicle_detected'::\"AutomationExecutionKind\")"
    );

    executeSql(`
      DELETE FROM "ProcessedGatewayEvent"
      WHERE "eventId" IN (
        'automation-schema-capability-event',
        'automation-schema-capability-event-node-extra',
        'automation-schema-legacy-event'
      );
      DELETE FROM "MqttOutbox" WHERE "id" = 'automation-schema-capability-ack';
    `);
  });

  afterAll(() => {
    executeSql(`
      BEGIN;
      DELETE FROM "ProcessedGatewayEvent" WHERE "eventId" LIKE 'automation-schema-%';
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

  it.each(["schedule", "outbox"] as const)(
    "blocks a concurrent %s-first invalid writer until the migration commits, then rolls its transaction back",
    async (firstWrite) => {
      const schemaName = `automation_equal_time_${firstWrite}_race`;
      const migrationMarker = `${firstWrite}-migration-lock-held`;
      const writerMarker = `${firstWrite}-writer-started`;
      const writerApplicationName = `automation-equal-time-${firstWrite}-writer`;
      const lockStatement = 'LOCK TABLE "LightingSchedule", "MqttOutbox" IN SHARE MODE;';
      const migrationWithBarrier = equalTimeMigration.replace(
        lockStatement,
        `${lockStatement}\nSELECT '${migrationMarker}';\nSELECT pg_sleep(1);`
      );

      executeSql(equalTimeMigrationTestSchemaSql(schemaName));
      try {
        const migrationSession = startSqlSession(`
          SET application_name = 'automation-equal-time-${firstWrite}-migration';
          SET search_path TO "${schemaName}";
          ${migrationWithBarrier}
        `);
        await migrationSession.waitForOutput(migrationMarker);

        const invalidScheduleInsert = `
          INSERT INTO "LightingSchedule" (
            "id", "siteId", "gatewayId", "localStartTime", "localEndTime"
          ) VALUES (
            '${firstWrite}-schedule', 'site', 'gateway', '10:00', '10:00'
          );
        `;
        const invalidOutboxInsert = `
          INSERT INTO "MqttOutbox" (
            "id", "dispatchId", "gatewayId", "revision", "payloadHash",
            "payload", "publishedAt", "deadLetteredAt"
          ) VALUES (
            '${firstWrite}-outbox', NULL, 'gateway', 1, 'sha256:test',
            '{"schedules":[{"id":"${firstWrite}-snapshot","localStartTime":"10:00","localEndTime":"10:00"}]}'::jsonb,
            NULL, NULL
          );
        `;
        const writerSession = startSqlSession(`
          SET application_name = '${writerApplicationName}';
          SET search_path TO "${schemaName}";
          BEGIN;
          SET LOCAL lock_timeout = '3s';
          SELECT '${writerMarker}';
          ${firstWrite === "schedule" ? invalidScheduleInsert : invalidOutboxInsert}
          ${firstWrite === "outbox" ? invalidScheduleInsert : ""}
          COMMIT;
        `);
        await writerSession.waitForOutput(writerMarker);
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(querySql(`
          SELECT COALESCE(wait_event_type || ':' || wait_event, 'not-waiting')
          FROM pg_stat_activity
          WHERE application_name = '${writerApplicationName}';
        `)).toBe("Lock:relation");

        const [migrationResult, writerResult] = await Promise.all([
          migrationSession.completion,
          writerSession.completion
        ]);
        expect(migrationResult).toMatchObject({ status: 0, stderr: "" });
        expect(writerResult.status).not.toBe(0);
        expect(writerResult.stderr).toContain("LightingSchedule_local_time_distinct_check");
        expect(querySql(`
          SET search_path TO "${schemaName}";
          SELECT
            (SELECT COUNT(*) FROM "LightingSchedule") || ':' ||
            (SELECT COUNT(*) FROM "MqttOutbox") || ':' ||
            (SELECT COUNT(*)
             FROM pg_constraint AS constraint_row
             JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = '${schemaName}'
               AND constraint_row.conname = 'LightingSchedule_local_time_distinct_check');
        `)).toBe("0:0:1");
      } finally {
        executeSql(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
      }
    }
  );

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
      scheduleInsert(
        "automation-schema-equal-local-times",
        "ARRAY[1]::INTEGER[]",
        "10:00",
        "10:00"
      ),
      "LightingSchedule_local_time_distinct_check"
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

  it("installs one shared statement lock protocol on automation parents and memberships", () => {
    expect(querySql(`
      SELECT
        string_agg(table_name, ',' ORDER BY table_name) || '|' ||
        bool_and(function_name = 'lock_automation_membership_statement') || '|' ||
        bool_and(is_before_statement AND covers_all_mutations)
      FROM (
        SELECT
          relation.relname AS table_name,
          procedure.proname AS function_name,
          (trigger.tgtype & 1) = 0 AND (trigger.tgtype & 2) = 2 AS is_before_statement,
          (trigger.tgtype & 28) = 28 AS covers_all_mutations
        FROM pg_trigger AS trigger
        JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
        JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
        WHERE trigger.tgname IN (
          'LightingSchedule_membership_statement_lock',
          'LightingScheduleFixture_membership_statement_lock',
          'VehicleEventRule_membership_statement_lock',
          'VehicleEventSource_membership_statement_lock',
          'VehicleEventTarget_membership_statement_lock',
          'ManualOverride_membership_statement_lock',
          'ManualOverrideFixture_membership_statement_lock'
        )
      ) AS installed_statement_locks;
    `)).toBe(
      "LightingSchedule,LightingScheduleFixture,ManualOverride,ManualOverrideFixture," +
      "VehicleEventRule,VehicleEventSource,VehicleEventTarget|true|true"
    );
    expect(querySql(`
      SELECT
        (pg_get_functiondef('lock_automation_membership_statement()'::regprocedure)
          LIKE '%pg_trigger_depth() = 1%') || '|' ||
        (pg_get_functiondef('lock_automation_membership_statement()'::regprocedure)
          LIKE '%lock_automation_membership_mutation%') || '|' ||
        (pg_get_functiondef('lock_automation_membership_mutation()'::regprocedure)
          LIKE '%pg_advisory_xact_lock(1279607873, 1296387394)%');
    `)).toBe("true|true|true");
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

  it("accepts a new execution for a deleted source only through its immutable config revision", () => {
    executeSql(`
      BEGIN;
      ${vehicleRuleInsert("automation-schema-snapshot-history-vehicle")}
      ${vehicleSourceInsert("automation-schema-snapshot-history-vehicle", "automation-schema-fixture-a")}
      ${vehicleTargetInsert("automation-schema-snapshot-history-vehicle", "automation-schema-fixture-a")}
      INSERT INTO "MqttOutbox" (
        "id", "dispatchId", "gatewayId", "revision", "payloadHash", "topic", "payload",
        "attempts", "nextAttemptAt", "createdAt", "updatedAt"
      ) VALUES (
        'automation-schema-snapshot-history-outbox', NULL, 'automation-schema-gateway-a', 7,
        '${validPayloadHash}', 'sites/automation-schema-site-a/gateways/automation-schema-gateway-a/automation/config',
        jsonb_build_object(
          'schemaVersion', 1,
          'siteId', 'automation-schema-site-a',
          'gatewayId', 'automation-schema-gateway-a',
          'revision', 7,
          'schedules', '[]'::jsonb,
          'vehicleEventRules', jsonb_build_array(jsonb_build_object(
            'id', 'automation-schema-snapshot-history-vehicle',
            'status', 'enabled',
            'targetFixtureIds', jsonb_build_array('automation-schema-fixture-a')
          )),
          'payloadHash', '${validPayloadHash}'
        ),
        0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      DELETE FROM "VehicleEventRule" WHERE "id" = 'automation-schema-snapshot-history-vehicle';
      INSERT INTO "AutomationExecution" (
        "id", "siteId", "gatewayId", "eventId", "sequence", "revision", "ruleId",
        "lightingScheduleId", "vehicleEventRuleId", "manualOverrideId", "kind", "occurredAt",
        "payload", "payloadHash", "createdAt"
      ) VALUES (
        'automation-schema-snapshot-history-execution', 'automation-schema-site-a',
        'automation-schema-gateway-a', 'automation-schema-snapshot-history-event', 7, 7,
        'automation-schema-snapshot-history-vehicle', NULL, NULL, NULL, 'action_result',
        CURRENT_TIMESTAMP,
        jsonb_build_object(
          'sourceType', 'vehicle_event_rule',
          'sourceId', 'automation-schema-snapshot-history-vehicle',
          'results', '[]'::jsonb
        ),
        '${validPayloadHash}', CURRENT_TIMESTAMP
      );
      COMMIT;
    `);

    expect(querySql(`
      SELECT "ruleId" || ':' || COALESCE("vehicleEventRuleId", 'deleted')
      FROM "AutomationExecution"
      WHERE "id" = 'automation-schema-snapshot-history-execution';
    `)).toBe("automation-schema-snapshot-history-vehicle:deleted");

    expectSqlFailure(`
      INSERT INTO "AutomationExecution" (
        "id", "siteId", "gatewayId", "eventId", "sequence", "revision", "ruleId",
        "kind", "occurredAt", "payload", "payloadHash", "createdAt"
      ) VALUES (
        'automation-schema-unproven-history-execution', 'automation-schema-site-a',
        'automation-schema-gateway-a', 'automation-schema-unproven-history-event', 8, 8,
        'automation-schema-missing-rule', 'event_started', CURRENT_TIMESTAMP, '{}'::jsonb,
        '${validPayloadHash}', CURRENT_TIMESTAMP
      );
    `, "execution source is absent from immutable snapshot");
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

  it("serializes opposite top-level multi-row membership moves with exact counters", async () => {
    const firstScheduleId = "automation-schema-multi-row-schedule-a";
    const secondScheduleId = "automation-schema-multi-row-schedule-b";
    const thirdScheduleId = "automation-schema-multi-row-schedule-c";
    const fourthScheduleId = "automation-schema-multi-row-schedule-d";
    executeSql(`
      BEGIN;
      ${scheduleInsert(firstScheduleId)}
      ${scheduleFixtureInsert(firstScheduleId, "automation-schema-fixture-a")}
      ${scheduleFixtureInsert(firstScheduleId, "automation-schema-fixture-a-extra")}
      ${scheduleInsert(secondScheduleId)}
      ${scheduleFixtureInsert(secondScheduleId, "automation-schema-fixture-a-third")}
      ${scheduleFixtureInsert(secondScheduleId, "automation-schema-fixture-a-fourth")}
      ${scheduleInsert(thirdScheduleId)}
      ${scheduleFixtureInsert(thirdScheduleId, "automation-schema-fixture-a-third")}
      ${scheduleFixtureInsert(thirdScheduleId, "automation-schema-fixture-a-fourth")}
      ${scheduleInsert(fourthScheduleId)}
      ${scheduleFixtureInsert(fourthScheduleId, "automation-schema-fixture-a")}
      ${scheduleFixtureInsert(fourthScheduleId, "automation-schema-fixture-a-extra")}
      COMMIT;
    `);

    const firstConnection = startSqlSession(`
      BEGIN;
      SET LOCAL deadlock_timeout = '100ms';
      SET LOCAL lock_timeout = '2s';
      UPDATE "LightingScheduleFixture"
      SET "scheduleId" = CASE "scheduleId"
        WHEN '${firstScheduleId}' THEN '${secondScheduleId}'
        WHEN '${thirdScheduleId}' THEN '${fourthScheduleId}'
      END
      WHERE ("scheduleId", "fixtureId") IN (
        ('${firstScheduleId}', 'automation-schema-fixture-a'),
        ('${thirdScheduleId}', 'automation-schema-fixture-a-third')
      );
      SELECT 'automation-multi-row-first-ready';
      SELECT pg_sleep(0.5);
      COMMIT;
    `);
    await firstConnection.waitForOutput("automation-multi-row-first-ready");

    const secondConnection = startSqlSession(`
      BEGIN;
      SET LOCAL deadlock_timeout = '100ms';
      SET LOCAL lock_timeout = '2s';
      UPDATE "LightingScheduleFixture"
      SET "scheduleId" = CASE "scheduleId"
        WHEN '${secondScheduleId}' THEN '${firstScheduleId}'
        WHEN '${fourthScheduleId}' THEN '${thirdScheduleId}'
      END
      WHERE ("scheduleId", "fixtureId") IN (
        ('${secondScheduleId}', 'automation-schema-fixture-a-third'),
        ('${fourthScheduleId}', 'automation-schema-fixture-a')
      );
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
      `${firstScheduleId}:2:2\n${secondScheduleId}:2:2\n` +
      `${thirdScheduleId}:2:2\n${fourthScheduleId}:2:2`
    );
  });

  it.each([
    {
      parentKind: "schedule",
      setupSql: `
        BEGIN;
        ${scheduleInsert("automation-schema-parent-first-schedule")}
        ${scheduleFixtureInsert("automation-schema-parent-first-schedule", "automation-schema-fixture-a")}
        COMMIT;
      `,
      parentUpdateSql: `
        UPDATE "LightingSchedule"
        SET "name" = "name" || '-updated'
        WHERE "id" = 'automation-schema-parent-first-schedule';
      `,
      firstMembershipSql: scheduleFixtureInsert(
        "automation-schema-parent-first-schedule",
        "automation-schema-fixture-a-extra"
      ),
      secondMembershipSql: scheduleFixtureInsert(
        "automation-schema-parent-first-schedule",
        "automation-schema-fixture-a-third"
      ),
      counterSql: `
        SELECT schedule."targetCount" || ':' || COUNT(target.*)
        FROM "LightingSchedule" AS schedule
        LEFT JOIN "LightingScheduleFixture" AS target ON target."scheduleId" = schedule."id"
        WHERE schedule."id" = 'automation-schema-parent-first-schedule'
        GROUP BY schedule."id";
      `,
      expectedCounters: "3:3",
      cleanupSql: `DELETE FROM "LightingSchedule" WHERE "id" = 'automation-schema-parent-first-schedule';`
    },
    {
      parentKind: "vehicle event",
      setupSql: `
        BEGIN;
        ${vehicleRuleInsert("automation-schema-parent-first-vehicle")}
        ${vehicleSourceInsert("automation-schema-parent-first-vehicle", "automation-schema-fixture-a")}
        ${vehicleTargetInsert("automation-schema-parent-first-vehicle", "automation-schema-fixture-a-extra")}
        COMMIT;
      `,
      parentUpdateSql: `
        UPDATE "VehicleEventRule"
        SET "name" = "name" || '-updated'
        WHERE "id" = 'automation-schema-parent-first-vehicle';
      `,
      firstMembershipSql: vehicleSourceInsert(
        "automation-schema-parent-first-vehicle",
        "automation-schema-fixture-a-third"
      ),
      secondMembershipSql: vehicleTargetInsert(
        "automation-schema-parent-first-vehicle",
        "automation-schema-fixture-a-fourth"
      ),
      counterSql: `
        SELECT
          rule."sourceCount" || ':' || COUNT(DISTINCT source."fixtureId") || ':' ||
          rule."targetCount" || ':' || COUNT(DISTINCT target."fixtureId")
        FROM "VehicleEventRule" AS rule
        JOIN "VehicleEventSource" AS source ON source."ruleId" = rule."id"
        JOIN "VehicleEventTarget" AS target ON target."ruleId" = rule."id"
        WHERE rule."id" = 'automation-schema-parent-first-vehicle'
        GROUP BY rule."id";
      `,
      expectedCounters: "2:2:2:2",
      cleanupSql: `DELETE FROM "VehicleEventRule" WHERE "id" = 'automation-schema-parent-first-vehicle';`
    },
    {
      parentKind: "manual override",
      setupSql: `
        BEGIN;
        ${manualOverrideInsert("automation-schema-parent-first-manual", "automation-schema-command-a")}
        ${manualFixtureInsert("automation-schema-parent-first-manual", "automation-schema-fixture-a")}
        COMMIT;
      `,
      parentUpdateSql: `
        UPDATE "ManualOverride"
        SET "brightnessPercent" = 51
        WHERE "id" = 'automation-schema-parent-first-manual';
      `,
      firstMembershipSql: manualFixtureInsert(
        "automation-schema-parent-first-manual",
        "automation-schema-fixture-a-extra"
      ),
      secondMembershipSql: manualFixtureInsert(
        "automation-schema-parent-first-manual",
        "automation-schema-fixture-a-third"
      ),
      counterSql: `
        SELECT override."targetCount" || ':' || COUNT(target.*)
        FROM "ManualOverride" AS override
        LEFT JOIN "ManualOverrideFixture" AS target ON target."manualOverrideId" = override."id"
        WHERE override."id" = 'automation-schema-parent-first-manual'
        GROUP BY override."id";
      `,
      expectedCounters: "3:3",
      cleanupSql: `DELETE FROM "ManualOverride" WHERE "id" = 'automation-schema-parent-first-manual';`
    }
  ])(
    "serializes a $parentKind parent update before concurrent membership DML",
    async ({
      parentKind,
      setupSql,
      parentUpdateSql,
      firstMembershipSql,
      secondMembershipSql,
      counterSql,
      expectedCounters,
      cleanupSql
    }) => {
      executeSql(setupSql);

      const parentFirstConnection = startSqlSession(`
        BEGIN;
        SET LOCAL deadlock_timeout = '100ms';
        SET LOCAL lock_timeout = '2s';
        ${parentUpdateSql}
        SELECT 'automation-parent-first-${parentKind}';
        SELECT pg_sleep(0.5);
        ${firstMembershipSql}
        COMMIT;
      `);
      await parentFirstConnection.waitForOutput(`automation-parent-first-${parentKind}`);

      const membershipFirstConnection = startSqlSession(`
        BEGIN;
        SET LOCAL deadlock_timeout = '100ms';
        SET LOCAL lock_timeout = '2s';
        ${secondMembershipSql}
        COMMIT;
      `);
      const [parentFirstResult, membershipFirstResult] = await Promise.all([
        parentFirstConnection.completion,
        membershipFirstConnection.completion
      ]);
      const actualCounters = querySql(counterSql);
      executeSql(cleanupSql);

      const concurrencyErrors = `${parentFirstResult.stderr}\n${membershipFirstResult.stderr}`;
      expect(concurrencyErrors).not.toMatch(/deadlock detected|canceling statement due to lock timeout/);
      expect(parentFirstResult.status).toBe(0);
      expect(parentFirstResult.stderr).toBe("");
      expect(membershipFirstResult.status).toBe(0);
      expect(membershipFirstResult.stderr).toBe("");
      expect(actualCounters).toBe(expectedCounters);
    }
  );

  it("does not deadlock a membership transaction against a concurrent parent cascade delete", async () => {
    const retainedScheduleId = "automation-schema-cascade-race-retained";
    const deletedScheduleId = "automation-schema-cascade-race-deleted";
    executeSql(`
      BEGIN;
      ${scheduleInsert(retainedScheduleId)}
      ${scheduleFixtureInsert(retainedScheduleId, "automation-schema-fixture-a")}
      ${scheduleInsert(deletedScheduleId)}
      ${scheduleFixtureInsert(deletedScheduleId, "automation-schema-fixture-a-third")}
      COMMIT;
    `);

    const membershipConnection = startSqlSession(`
      BEGIN;
      SET LOCAL deadlock_timeout = '100ms';
      SET LOCAL lock_timeout = '2s';
      ${scheduleFixtureInsert(retainedScheduleId, "automation-schema-fixture-a-extra")}
      SELECT 'automation-membership-before-parent-cascade';
      SELECT pg_sleep(0.5);
      UPDATE "LightingScheduleFixture"
      SET "fixtureId" = 'automation-schema-fixture-a-fourth'
      WHERE "scheduleId" = '${deletedScheduleId}'
        AND "fixtureId" = 'automation-schema-fixture-a-third';
      COMMIT;
    `);
    await membershipConnection.waitForOutput("automation-membership-before-parent-cascade");

    const parentConnection = startSqlSession(`
      BEGIN;
      SET LOCAL deadlock_timeout = '100ms';
      SET LOCAL lock_timeout = '2s';
      DELETE FROM "LightingSchedule" WHERE "id" = '${deletedScheduleId}';
      COMMIT;
    `);
    const [membershipResult, parentResult] = await Promise.all([
      membershipConnection.completion,
      parentConnection.completion
    ]);
    const retainedCounts = querySql(`
      SELECT schedule."targetCount" || ':' || COUNT(target.*)
      FROM "LightingSchedule" AS schedule
      LEFT JOIN "LightingScheduleFixture" AS target ON target."scheduleId" = schedule."id"
      WHERE schedule."id" = '${retainedScheduleId}'
      GROUP BY schedule."id";
    `);
    const deletedParentCount = querySql(`
      SELECT COUNT(*) FROM "LightingSchedule" WHERE "id" = '${deletedScheduleId}';
    `);
    executeSql(`DELETE FROM "LightingSchedule" WHERE "id" = '${retainedScheduleId}';`);

    const concurrencyErrors = `${membershipResult.stderr}\n${parentResult.stderr}`;
    expect(concurrencyErrors).not.toMatch(/deadlock detected|canceling statement due to lock timeout/);
    expect(membershipResult.status).toBe(0);
    expect(membershipResult.stderr).toBe("");
    expect(parentResult.status).toBe(0);
    expect(parentResult.stderr).toBe("");
    expect(retainedCounts).toBe("2:2");
    expect(deletedParentCount).toBe("0");
  });

  it("keeps direct child deletes counted and rejects every final membership delete", () => {
    const scheduleId = "automation-schema-direct-delete-schedule";
    const vehicleRuleId = "automation-schema-direct-delete-vehicle";
    const manualOverrideId = "automation-schema-direct-delete-manual";
    executeSql(`
      BEGIN;
      ${scheduleInsert(scheduleId)}
      ${scheduleFixtureInsert(scheduleId, "automation-schema-fixture-a")}
      ${scheduleFixtureInsert(scheduleId, "automation-schema-fixture-a-extra")}
      ${vehicleRuleInsert(vehicleRuleId)}
      ${vehicleSourceInsert(vehicleRuleId, "automation-schema-fixture-a")}
      ${vehicleSourceInsert(vehicleRuleId, "automation-schema-fixture-a-extra")}
      ${vehicleTargetInsert(vehicleRuleId, "automation-schema-fixture-a-third")}
      ${vehicleTargetInsert(vehicleRuleId, "automation-schema-fixture-a-fourth")}
      ${manualOverrideInsert(manualOverrideId, "automation-schema-command-a")}
      ${manualFixtureInsert(manualOverrideId, "automation-schema-fixture-a")}
      ${manualFixtureInsert(manualOverrideId, "automation-schema-fixture-a-extra")}
      COMMIT;
      DELETE FROM "LightingScheduleFixture"
      WHERE "scheduleId" = '${scheduleId}' AND "fixtureId" = 'automation-schema-fixture-a-extra';
      DELETE FROM "VehicleEventSource"
      WHERE "ruleId" = '${vehicleRuleId}' AND "fixtureId" = 'automation-schema-fixture-a-extra';
      DELETE FROM "VehicleEventTarget"
      WHERE "ruleId" = '${vehicleRuleId}' AND "fixtureId" = 'automation-schema-fixture-a-fourth';
      DELETE FROM "ManualOverrideFixture"
      WHERE "manualOverrideId" = '${manualOverrideId}' AND "fixtureId" = 'automation-schema-fixture-a-extra';
    `);

    expect(querySql(`
      SELECT
        schedule."targetCount" || ':' || COUNT(DISTINCT schedule_target."fixtureId") || ':' ||
        rule."sourceCount" || ':' || COUNT(DISTINCT source."fixtureId") || ':' ||
        rule."targetCount" || ':' || COUNT(DISTINCT rule_target."fixtureId") || ':' ||
        override."targetCount" || ':' || COUNT(DISTINCT override_target."fixtureId")
      FROM "LightingSchedule" AS schedule
      JOIN "LightingScheduleFixture" AS schedule_target ON schedule_target."scheduleId" = schedule."id"
      CROSS JOIN "VehicleEventRule" AS rule
      JOIN "VehicleEventSource" AS source ON source."ruleId" = rule."id"
      JOIN "VehicleEventTarget" AS rule_target ON rule_target."ruleId" = rule."id"
      CROSS JOIN "ManualOverride" AS override
      JOIN "ManualOverrideFixture" AS override_target ON override_target."manualOverrideId" = override."id"
      WHERE schedule."id" = '${scheduleId}'
        AND rule."id" = '${vehicleRuleId}'
        AND override."id" = '${manualOverrideId}'
      GROUP BY schedule."targetCount", rule."sourceCount", rule."targetCount", override."targetCount";
    `)).toBe("1:1:1:1:1:1:1:1");

    for (const [deleteSql, expectedError] of [
      [
        `DELETE FROM "LightingScheduleFixture" WHERE "scheduleId" = '${scheduleId}';`,
        "lighting schedule requires at least one target fixture"
      ],
      [
        `DELETE FROM "VehicleEventSource" WHERE "ruleId" = '${vehicleRuleId}';`,
        "vehicle event rule requires at least one source and target fixture"
      ],
      [
        `DELETE FROM "VehicleEventTarget" WHERE "ruleId" = '${vehicleRuleId}';`,
        "vehicle event rule requires at least one source and target fixture"
      ],
      [
        `DELETE FROM "ManualOverrideFixture" WHERE "manualOverrideId" = '${manualOverrideId}';`,
        "manual override requires at least one target fixture"
      ]
    ]) {
      expectSqlFailure(`BEGIN; ${deleteSql} COMMIT;`, expectedError);
    }

    expect(querySql(`
      SELECT schedule."targetCount" || ':' || rule."sourceCount" || ':' || rule."targetCount" || ':' || override."targetCount"
      FROM "LightingSchedule" AS schedule
      CROSS JOIN "VehicleEventRule" AS rule
      CROSS JOIN "ManualOverride" AS override
      WHERE schedule."id" = '${scheduleId}'
        AND rule."id" = '${vehicleRuleId}'
        AND override."id" = '${manualOverrideId}';
    `)).toBe("1:1:1:1");

    executeSql(`
      DELETE FROM "LightingSchedule" WHERE "id" = '${scheduleId}';
      DELETE FROM "VehicleEventRule" WHERE "id" = '${vehicleRuleId}';
      DELETE FROM "ManualOverride" WHERE "id" = '${manualOverrideId}';
    `);
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

function scheduleInsert(
  id: string,
  weeklyDays = "ARRAY[1]::INTEGER[]",
  localStartTime = "10:00",
  localEndTime = "11:00"
) {
  return `
    INSERT INTO "LightingSchedule" (
      "id", "siteId", "gatewayId", "name", "status", "activeFrom", "activeUntil",
      "localStartTime", "localEndTime", "recurrenceKind", "weeklyDays", "dimmingEnabled",
      "brightnessPercent", "desiredRevision", "appliedRevision", "createdById", "updatedById",
      "createdAt", "updatedAt"
    ) VALUES (
      '${id}', 'automation-schema-site-a', 'automation-schema-gateway-a', '${id}', 'enabled',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 day',
      '${localStartTime}', '${localEndTime}', 'weekly', ${weeklyDays},
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
  const payload = options.kind === "action_result" && options.manualOverrideId
    ? `'${JSON.stringify({
        sourceType: "manual_override",
        sourceId: options.manualOverrideId,
        results: []
      })}'::jsonb`
    : "'{}'::jsonb";
  return `
    INSERT INTO "AutomationExecution" (
      "id", "siteId", "gatewayId", "eventId", "sequence", "revision", "ruleId",
      "lightingScheduleId", "vehicleEventRuleId", "manualOverrideId", "kind", "occurredAt", "payload", "createdAt"
    ) VALUES (
      '${options.id}', 'automation-schema-site-a', '${gatewayId}', '${options.eventId}', 1, 1,
      ${sqlNullable(options.ruleId)}, ${sqlNullable(options.lightingScheduleId)},
      ${sqlNullable(options.vehicleEventRuleId)}, ${sqlNullable(options.manualOverrideId)},
      '${options.kind}', CURRENT_TIMESTAMP, ${payload}, CURRENT_TIMESTAMP
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

function equalTimeMigrationTestSchemaSql(schemaName: string) {
  return `
    DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;
    CREATE SCHEMA "${schemaName}";
    CREATE TABLE "${schemaName}"."LightingSchedule" (
      "id" TEXT PRIMARY KEY,
      "siteId" TEXT NOT NULL,
      "gatewayId" TEXT NOT NULL,
      "localStartTime" TEXT NOT NULL,
      "localEndTime" TEXT NOT NULL
    );
    CREATE TABLE "${schemaName}"."MqttOutbox" (
      "id" TEXT PRIMARY KEY,
      "dispatchId" TEXT,
      "gatewayId" TEXT,
      "revision" INTEGER,
      "payloadHash" TEXT,
      "payload" JSONB NOT NULL,
      "publishedAt" TIMESTAMP,
      "deadLetteredAt" TIMESTAMP
    );
  `;
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
