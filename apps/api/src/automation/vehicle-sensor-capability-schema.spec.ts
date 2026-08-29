import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationPath = join(
  __dirname,
  "../../prisma/migrations/20260830_vehicle_sensor_source_invariants/migration.sql"
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const databaseUrl = process.env.AUTOMATION_SCHEMA_TEST_DATABASE_URL;
const psqlDatabaseUrl = databaseUrl?.replace(/\?schema=[^&]+$/, "");
const describeWithPostgres = databaseUrl ? describe : describe.skip;

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  site: "10000000-0000-4000-8000-000000000003",
  gateway: "10000000-0000-4000-8000-000000000004",
  floor: "10000000-0000-4000-8000-000000000005",
  primaryNode: "10000000-0000-4000-8000-000000000006",
  candidateNode: "10000000-0000-4000-8000-000000000007",
  unknownNode: "10000000-0000-4000-8000-000000000008",
  freeUnknownNode: "10000000-0000-4000-8000-000000000009",
  primaryFixture: "10000000-0000-4000-8000-000000000010",
  candidateFixture: "10000000-0000-4000-8000-000000000011",
  unknownFixture: "10000000-0000-4000-8000-000000000012",
  rule: "10000000-0000-4000-8000-000000000013",
  invalidRule: "10000000-0000-4000-8000-000000000014"
} as const;

describeWithPostgres("vehicle sensor capability PostgreSQL invariants", () => {
  jest.setTimeout(60_000);

  beforeAll(() => {
    executeSql(`
      INSERT INTO "Organization" ("id", "name", "type", "createdAt", "updatedAt")
      VALUES ('${ids.organization}', 'Capability invariant org', 'customer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "User" (
        "id", "organizationId", "loginId", "name", "passwordHash", "role", "status", "createdAt", "updatedAt"
      ) VALUES (
        '${ids.user}', '${ids.organization}', 'capability_invariant_admin', 'Capability invariant admin',
        'hash', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "Site" ("id", "organizationId", "name", "createdAt", "updatedAt")
      VALUES ('${ids.site}', '${ids.organization}', 'Capability invariant site', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "Gateway" (
        "id", "siteId", "name", "serialNumber", "firmwareVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${ids.gateway}', '${ids.site}', 'Capability invariant gateway', 'CAPABILITY-INVARIANT-GATEWAY',
        'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "Floor" ("id", "siteId", "name", "level", "createdAt", "updatedAt")
      VALUES ('${ids.floor}', '${ids.site}', 'B1', -1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "MeshNode" (
        "id", "gatewayId", "meshAddress", "firmwareVersion",
        "vehicleSensorCapabilityStatus", "vehicleSensorCapabilityVerifiedAt",
        "vehicleSensorCapabilityRevision", "vehicleSensorServerBound", "vehicleVendorEventModelBound",
        "createdAt", "updatedAt"
      ) VALUES
        ('${ids.primaryNode}', '${ids.gateway}', '0A01', 'test', 'supported', CURRENT_TIMESTAMP, 1, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('${ids.candidateNode}', '${ids.gateway}', '0A02', 'test', 'supported', CURRENT_TIMESTAMP, 1, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('${ids.unknownNode}', '${ids.gateway}', '0A03', 'test', 'unknown', NULL, 0, false, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('${ids.freeUnknownNode}', '${ids.gateway}', '0A04', 'test', 'unknown', NULL, 0, false, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "Fixture" (
        "id", "floorId", "meshNodeId", "name", "ratedWatt", "x", "y", "createdAt", "updatedAt"
      ) VALUES
        ('${ids.primaryFixture}', '${ids.floor}', '${ids.primaryNode}', 'Primary source', 20, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('${ids.candidateFixture}', '${ids.floor}', '${ids.candidateNode}', 'Candidate source', 20, 20, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('${ids.unknownFixture}', '${ids.floor}', '${ids.unknownNode}', 'Unknown source', 20, 40, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      BEGIN;
      SELECT "lock_automation_membership_mutation"();
      ${vehicleRuleInsert(ids.rule, "enabled")}
      ${vehicleSourceInsert(ids.rule, ids.primaryFixture)}
      ${vehicleTargetInsert(ids.rule, ids.candidateFixture)}
      COMMIT;
    `);
  });

  afterAll(() => {
    executeSql(`
      BEGIN;
      SELECT "lock_automation_membership_mutation"();
      DELETE FROM "VehicleEventRule" WHERE "id" IN ('${ids.rule}', '${ids.invalidRule}');
      DELETE FROM "Fixture" WHERE "id" IN ('${ids.primaryFixture}', '${ids.candidateFixture}', '${ids.unknownFixture}');
      DELETE FROM "MeshNode" WHERE "id" IN (
        '${ids.primaryNode}', '${ids.candidateNode}', '${ids.unknownNode}', '${ids.freeUnknownNode}'
      );
      DELETE FROM "Gateway" WHERE "id" = '${ids.gateway}';
      DELETE FROM "Floor" WHERE "id" = '${ids.floor}';
      DELETE FROM "Site" WHERE "id" = '${ids.site}';
      DELETE FROM "User" WHERE "id" = '${ids.user}';
      DELETE FROM "Organization" WHERE "id" = '${ids.organization}';
      COMMIT;
    `);
  });

  it("aborts migration with precise rule and node remediation for an existing invalid source", () => {
    const schemaName = "vehicle_source_preflight";
    executeSql(preflightSchemaSql(schemaName));
    try {
      const result = runSql(`SET search_path TO "${schemaName}"; ${migration}`);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("invalid vehicle event sources detected");
      expect(result.stderr).toContain("rule=preflight-rule");
      expect(result.stderr).toContain("node=preflight-node");
      expect(result.stderr).toContain("verify each listed MeshNode or remove its VehicleEventSource");
    } finally {
      executeSql(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
    }
  });

  it("catalogs statement locks and row guards on every capability mutation path", () => {
    expect(querySql(`
      SELECT string_agg(trigger_row.tgname || ':' || pg_get_triggerdef(trigger_row.oid), E'\n' ORDER BY trigger_row.tgname)
      FROM pg_trigger AS trigger_row
      WHERE NOT trigger_row.tgisinternal
        AND trigger_row.tgname IN (
          'Fixture_vehicle_sensor_capability_guard',
          'Fixture_vehicle_sensor_capability_statement_lock',
          'MeshNode_vehicle_sensor_capability_guard',
          'MeshNode_vehicle_sensor_capability_statement_lock',
          'VehicleEventRule_vehicle_sensor_capability_guard',
          'VehicleEventSource_vehicle_sensor_capability_guard'
        );
    `)).toContain("MeshNode_vehicle_sensor_capability_guard:CREATE TRIGGER");
    expect(querySql(`
      SELECT COUNT(*)
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN (
          'Fixture_vehicle_sensor_capability_guard',
          'Fixture_vehicle_sensor_capability_statement_lock',
          'MeshNode_vehicle_sensor_capability_guard',
          'MeshNode_vehicle_sensor_capability_statement_lock',
          'VehicleEventRule_vehicle_sensor_capability_guard',
          'VehicleEventSource_vehicle_sensor_capability_guard'
        );
    `)).toBe("6");
  });

  it("rejects a direct source insert whose fixture node is not verified supported", () => {
    const result = runSql(`
      BEGIN;
      SELECT "lock_automation_membership_mutation"();
      ${vehicleRuleInsert(ids.invalidRule, "disabled")}
      ${vehicleTargetInsert(ids.invalidRule, ids.candidateFixture)}
      ${vehicleSourceInsert(ids.invalidRule, ids.unknownFixture)}
      COMMIT;
    `);
    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("vehicle event source requires a verified supported MeshNode");
    } finally {
      executeSql(`DELETE FROM "VehicleEventRule" WHERE "id" = '${ids.invalidRule}';`);
    }
  });

  it("rejects direct downgrade and direct re-enable while an enabled rule resolves to the node", () => {
    const downgrade = runSql(`
      UPDATE "MeshNode"
      SET "vehicleSensorCapabilityStatus" = 'unsupported',
          "vehicleSensorCapabilityVerifiedAt" = CURRENT_TIMESTAMP,
          "vehicleSensorCapabilityRevision" = 2,
          "vehicleSensorServerBound" = false,
          "vehicleVendorEventModelBound" = false
      WHERE "id" = '${ids.primaryNode}';
    `);
    expect(downgrade.status).not.toBe(0);
    expect(downgrade.stderr).toContain("enabled vehicle event rule requires verified supported source capability");

    executeSql(`
      UPDATE "VehicleEventRule" SET "status" = 'disabled' WHERE "id" = '${ids.rule}';
      UPDATE "MeshNode"
      SET "vehicleSensorCapabilityStatus" = 'unsupported',
          "vehicleSensorCapabilityVerifiedAt" = CURRENT_TIMESTAMP,
          "vehicleSensorCapabilityRevision" = 2,
          "vehicleSensorServerBound" = false,
          "vehicleVendorEventModelBound" = false
      WHERE "id" = '${ids.primaryNode}';
    `);
    const reenable = runSql(`UPDATE "VehicleEventRule" SET "status" = 'enabled' WHERE "id" = '${ids.rule}';`);
    try {
      expect(reenable.status).not.toBe(0);
      expect(reenable.stderr).toContain("enabled vehicle event rule requires verified supported source capability");
    } finally {
      executeSql(`
        UPDATE "MeshNode"
        SET "vehicleSensorCapabilityStatus" = 'supported',
            "vehicleSensorCapabilityVerifiedAt" = CURRENT_TIMESTAMP,
            "vehicleSensorCapabilityRevision" = 1,
            "vehicleSensorServerBound" = true,
            "vehicleVendorEventModelBound" = true
        WHERE "id" = '${ids.primaryNode}';
        UPDATE "VehicleEventRule" SET "status" = 'enabled' WHERE "id" = '${ids.rule}';
      `);
    }
  });

  it("rejects reassigning an enabled source fixture to an unsupported MeshNode", () => {
    const reassignment = runSql(`
      UPDATE "Fixture" SET "meshNodeId" = '${ids.freeUnknownNode}' WHERE "id" = '${ids.primaryFixture}';
    `);
    try {
      expect(reassignment.status).not.toBe(0);
      expect(reassignment.stderr).toContain("enabled vehicle event rule requires verified supported source capability");
    } finally {
      executeSql(`UPDATE "Fixture" SET "meshNodeId" = '${ids.primaryNode}' WHERE "id" = '${ids.primaryFixture}';`);
    }
  });

  it.each(["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"] as const)(
    "serializes source-first insert against capability downgrade at %s",
    async (isolationLevel) => {
      await prepareCandidate();
      const suffix = isolationLevel.toLowerCase().replaceAll(" ", "-");
      const firstMarker = `source-first-${suffix}-held`;
      const writerName = `vehicle-source-first-${suffix}-downgrade`;
      const sourceSession = startSqlSession(`
        BEGIN ISOLATION LEVEL ${isolationLevel};
        ${vehicleSourceInsert(ids.rule, ids.candidateFixture)}
        SELECT '${firstMarker}';
        SELECT pg_sleep(1);
        COMMIT;
      `);
      await sourceSession.waitForOutput(firstMarker);
      const downgradeSession = startSqlSession(`
        SET application_name = '${writerName}';
        BEGIN ISOLATION LEVEL ${isolationLevel};
        SET LOCAL lock_timeout = '3s';
        UPDATE "MeshNode"
        SET "vehicleSensorCapabilityStatus" = 'unsupported',
            "vehicleSensorCapabilityVerifiedAt" = CURRENT_TIMESTAMP,
            "vehicleSensorCapabilityRevision" = 2,
            "vehicleSensorServerBound" = false,
            "vehicleVendorEventModelBound" = false
        WHERE "id" = '${ids.candidateNode}';
        COMMIT;
      `);
      await waitForActivity(writerName);
      expect(querySql(`
        SELECT COALESCE(wait_event_type || ':' || wait_event, 'not-waiting')
        FROM pg_stat_activity WHERE application_name = '${writerName}';
      `)).toBe("Lock:advisory");

      const [sourceResult, downgradeResult] = await Promise.all([
        sourceSession.completion,
        downgradeSession.completion
      ]);
      try {
        expect(sourceResult).toMatchObject({ status: 0, stderr: "" });
        expect(downgradeResult.status).not.toBe(0);
        expect(invariantState()).toBe("supported:1");
      } finally {
        await prepareCandidate();
      }
    }
  );

  it.each(["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"] as const)(
    "serializes downgrade-first capability change against source insert at %s",
    async (isolationLevel) => {
      await prepareCandidate();
      const suffix = isolationLevel.toLowerCase().replaceAll(" ", "-");
      const firstMarker = `downgrade-first-${suffix}-held`;
      const writerName = `vehicle-downgrade-first-${suffix}-source`;
      const downgradeSession = startSqlSession(`
        BEGIN ISOLATION LEVEL ${isolationLevel};
        UPDATE "MeshNode"
        SET "vehicleSensorCapabilityStatus" = 'unsupported',
            "vehicleSensorCapabilityVerifiedAt" = CURRENT_TIMESTAMP,
            "vehicleSensorCapabilityRevision" = 2,
            "vehicleSensorServerBound" = false,
            "vehicleVendorEventModelBound" = false
        WHERE "id" = '${ids.candidateNode}';
        SELECT '${firstMarker}';
        SELECT pg_sleep(1);
        COMMIT;
      `);
      await downgradeSession.waitForOutput(firstMarker);
      const sourceSession = startSqlSession(`
        SET application_name = '${writerName}';
        BEGIN ISOLATION LEVEL ${isolationLevel};
        SET LOCAL lock_timeout = '3s';
        ${vehicleSourceInsert(ids.rule, ids.candidateFixture)}
        COMMIT;
      `);
      await waitForActivity(writerName);
      expect(querySql(`
        SELECT COALESCE(wait_event_type || ':' || wait_event, 'not-waiting')
        FROM pg_stat_activity WHERE application_name = '${writerName}';
      `)).toBe("Lock:advisory");

      const [downgradeResult, sourceResult] = await Promise.all([
        downgradeSession.completion,
        sourceSession.completion
      ]);
      try {
        expect(downgradeResult).toMatchObject({ status: 0, stderr: "" });
        expect(sourceResult.status).not.toBe(0);
        expect(invariantState()).toBe("unsupported:0");
      } finally {
        await prepareCandidate();
      }
    }
  );

  function invariantState() {
    return querySql(`
      SELECT node."vehicleSensorCapabilityStatus"::text || ':' || COUNT(source.*)
      FROM "MeshNode" AS node
      LEFT JOIN "Fixture" AS fixture ON fixture."meshNodeId" = node."id"
      LEFT JOIN "VehicleEventSource" AS source
        ON source."fixtureId" = fixture."id" AND source."ruleId" = '${ids.rule}'
      WHERE node."id" = '${ids.candidateNode}'
      GROUP BY node."vehicleSensorCapabilityStatus";
    `);
  }

  async function prepareCandidate() {
    executeSql(`
      BEGIN;
      SELECT "lock_automation_membership_mutation"();
      DELETE FROM "VehicleEventSource"
      WHERE "ruleId" = '${ids.rule}' AND "fixtureId" = '${ids.candidateFixture}';
      UPDATE "MeshNode"
      SET "vehicleSensorCapabilityStatus" = 'supported',
          "vehicleSensorCapabilityVerifiedAt" = CURRENT_TIMESTAMP,
          "vehicleSensorCapabilityRevision" = 1,
          "vehicleSensorServerBound" = true,
          "vehicleVendorEventModelBound" = true
      WHERE "id" = '${ids.candidateNode}';
      COMMIT;
    `);
  }
});

function vehicleRuleInsert(ruleId: string, status: "enabled" | "disabled") {
  return `
    INSERT INTO "VehicleEventRule" (
      "id", "siteId", "gatewayId", "name", "status", "dimmingEnabled", "brightnessPercent",
      "holdSeconds", "desiredRevision", "appliedRevision", "createdById", "updatedById", "createdAt", "updatedAt"
    ) VALUES (
      '${ruleId}', '${ids.site}', '${ids.gateway}', '${ruleId}', '${status}', true, 50, 60, 0, 0,
      '${ids.user}', '${ids.user}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `;
}

function vehicleSourceInsert(ruleId: string, fixtureId: string) {
  return `
    INSERT INTO "VehicleEventSource" ("ruleId", "fixtureId", "siteId", "gatewayId")
    VALUES ('${ruleId}', '${fixtureId}', '${ids.site}', '${ids.gateway}');
  `;
}

function vehicleTargetInsert(ruleId: string, fixtureId: string) {
  return `
    INSERT INTO "VehicleEventTarget" ("ruleId", "fixtureId", "siteId", "gatewayId")
    VALUES ('${ruleId}', '${fixtureId}', '${ids.site}', '${ids.gateway}');
  `;
}

function preflightSchemaSql(schemaName: string) {
  return `
    DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;
    CREATE SCHEMA "${schemaName}";
    CREATE TYPE "${schemaName}"."VehicleSensorCapabilityStatus" AS ENUM ('unknown', 'supported', 'unsupported');
    CREATE TABLE "${schemaName}"."MeshNode" (
      "id" TEXT PRIMARY KEY,
      "gatewayId" TEXT NOT NULL,
      "vehicleSensorCapabilityStatus" "${schemaName}"."VehicleSensorCapabilityStatus" NOT NULL,
      "vehicleSensorCapabilityVerifiedAt" TIMESTAMP(3)
    );
    CREATE TABLE "${schemaName}"."Fixture" (
      "id" TEXT PRIMARY KEY,
      "meshNodeId" TEXT,
      "siteId" TEXT NOT NULL,
      "gatewayId" TEXT
    );
    CREATE TABLE "${schemaName}"."VehicleEventRule" (
      "id" TEXT PRIMARY KEY,
      "status" TEXT NOT NULL
    );
    CREATE TABLE "${schemaName}"."VehicleEventSource" (
      "ruleId" TEXT NOT NULL,
      "fixtureId" TEXT NOT NULL,
      "siteId" TEXT NOT NULL,
      "gatewayId" TEXT NOT NULL
    );
    CREATE FUNCTION "${schemaName}"."lock_automation_membership_mutation"()
    RETURNS VOID LANGUAGE SQL AS 'SELECT pg_advisory_xact_lock(1279607873, 1296387394)';
    INSERT INTO "${schemaName}"."MeshNode" VALUES
      ('preflight-node', 'preflight-gateway', 'unknown', NULL);
    INSERT INTO "${schemaName}"."Fixture" VALUES
      ('preflight-fixture', 'preflight-node', 'preflight-site', 'preflight-gateway');
    INSERT INTO "${schemaName}"."VehicleEventRule" VALUES ('preflight-rule', 'disabled');
    INSERT INTO "${schemaName}"."VehicleEventSource" VALUES
      ('preflight-rule', 'preflight-fixture', 'preflight-site', 'preflight-gateway');
  `;
}

function executeSql(sql: string) {
  const result = runSql(sql);
  if (result.status !== 0) throw new Error(result.stderr);
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
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(sql);

  return {
    completion: new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    }),
    waitForOutput(marker: string) {
      if (stdout.includes(marker)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}\n${stderr}`)), 3_000);
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

async function waitForActivity(applicationName: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (querySql(`SELECT COUNT(*) FROM pg_stat_activity WHERE application_name = '${applicationName}';`) === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for PostgreSQL activity: ${applicationName}`);
}

function runSql(sql: string, extraArgs: string[] = ["-q"]) {
  return spawnSync("psql", [...extraArgs, "-v", "ON_ERROR_STOP=1", psqlDatabaseUrl!], {
    encoding: "utf8",
    input: sql
  });
}
