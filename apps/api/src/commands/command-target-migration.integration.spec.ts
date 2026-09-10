import { gatewayDimmingCommandV2CompatibilitySchema } from "@led-control/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const databaseUrl = process.env.COMMAND_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const migration = readFileSync(join(
  __dirname,
  "../../prisma/migrations/20260819094000_extend_command_targets/migration.sql"
), "utf8");

describeWithPostgres("command target migration PostgreSQL rehearsal", () => {
  const schemas: string[] = [];

  afterAll(() => {
    for (const schema of schemas) runSql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
  });

  it("normalizes fresh and retry payloads into the strict draft contract", () => {
    const schema = createIsolatedSchema("success");
    installLegacyTables(schema);
    seedSuccessfulMigration(schema);

    expect(runMigration(schema).status).toBe(0);

    const payloads = JSON.parse(query(schema, `
      SELECT json_agg("payload" ORDER BY "id")::text
      FROM "MqttOutbox";
    `));
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(gatewayDimmingCommandV2CompatibilitySchema.parse(payload)).toEqual(payload);
      expect(payload).not.toHaveProperty("expiresAt");
      expect(payload).not.toHaveProperty("legacyDebug");
    }
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetType: "fixture", deliveryMode: "unicast" }),
      expect.objectContaining({ targetType: "fixtures", targetId: null, deliveryMode: "parallel_unicast" })
    ]));
    expect(JSON.parse(query(schema, `
      SELECT json_agg("deliveryMode" ORDER BY "id")::text
      FROM "CommandDispatch";
    `))).toEqual(["unicast", "parallel_unicast"]);
    expect(query(schema, newConstraintCountSql())).toBe("1");
  });

  it("rolls back every schema change when a preflight guard fails", () => {
    const schema = createIsolatedSchema("guard");
    installLegacyTables(schema);
    seedMissingResult(schema);

    const result = runMigration(schema);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot migrate MqttOutbox without CommandFixtureResult targets");
    expect(query(schema, newColumnsCountSql())).toBe("0");
    expect(query(schema, newConstraintCountSql())).toBe("0");
  });

  it("rolls back earlier DDL and updates when a late migration statement fails", () => {
    const schema = createIsolatedSchema("late_failure");
    installLegacyTables(schema);
    seedOneFixture(schema, "late");
    execute(schema, `CREATE INDEX "CommandDispatch_meshControlGroupId_status_idx" ON "CommandDispatch"("id");`);

    const result = runMigration(schema);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CommandDispatch_meshControlGroupId_status_idx");
    expect(query(schema, newColumnsCountSql())).toBe("0");
    expect(query(schema, newConstraintCountSql())).toBe("0");
  });

  function createIsolatedSchema(suffix: string) {
    const schema = `command_migration_${process.pid}_${Date.now()}_${suffix}`.toLowerCase();
    schemas.push(schema);
    runSql(`CREATE SCHEMA "${schema}";`);
    return schema;
  }

  function installLegacyTables(schema: string) {
    execute(schema, `
      CREATE TABLE "Command" (
        "id" TEXT PRIMARY KEY,
        "targetId" TEXT NOT NULL
      );
      CREATE TABLE "CommandDispatch" (
        "id" TEXT PRIMARY KEY,
        "commandId" TEXT NOT NULL,
        "gatewayId" TEXT NOT NULL,
        "status" TEXT NOT NULL
      );
      CREATE TABLE "CommandFixtureResult" (
        "dispatchId" TEXT NOT NULL,
        "fixtureId" TEXT NOT NULL,
        PRIMARY KEY ("dispatchId", "fixtureId")
      );
      CREATE TABLE "MqttOutbox" (
        "id" TEXT PRIMARY KEY,
        "dispatchId" TEXT NOT NULL UNIQUE,
        "payload" JSONB NOT NULL
      );
      CREATE TABLE "MeshControlGroup" (
        "id" TEXT PRIMARY KEY,
        "gatewayId" TEXT NOT NULL,
        UNIQUE ("id", "gatewayId")
      );
    `);
  }

  function seedSuccessfulMigration(schema: string) {
    seedOneFixture(schema, "fresh");
    const retryPayload = legacyPayload({
      commandId: ids.retryCommand,
      dispatchId: ids.retryDispatch,
      targetType: "group",
      targetId: ids.group,
      expiresAt: "2026-07-11T00:00:10.000Z",
      legacyDebug: true
    });
    execute(schema, `
      INSERT INTO "Command" ("id", "targetId") VALUES ('${ids.retryCommand}', '${ids.group}');
      INSERT INTO "CommandDispatch" ("id", "commandId", "gatewayId", "status")
        VALUES ('${ids.retryDispatch}', '${ids.retryCommand}', '${ids.gateway}', 'pending');
      INSERT INTO "CommandFixtureResult" ("dispatchId", "fixtureId") VALUES
        ('${ids.retryDispatch}', '${ids.fixture2}'),
        ('${ids.retryDispatch}', '${ids.fixture3}');
      INSERT INTO "MqttOutbox" ("id", "dispatchId", "payload") VALUES
        ('outbox-retry', '${ids.retryDispatch}', '${sqlJson(retryPayload)}'::jsonb);
    `);
  }

  function seedOneFixture(schema: string, suffix: string) {
    const commandId = suffix === "fresh" ? ids.freshCommand : ids.lateCommand;
    const dispatchId = suffix === "fresh" ? ids.freshDispatch : ids.lateDispatch;
    const payload = legacyPayload({
      commandId,
      dispatchId,
      targetType: "fixture",
      targetId: ids.fixture1,
      legacyDebug: true
    });
    execute(schema, `
      INSERT INTO "Command" ("id", "targetId") VALUES ('${commandId}', '${ids.fixture1}');
      INSERT INTO "CommandDispatch" ("id", "commandId", "gatewayId", "status")
        VALUES ('${dispatchId}', '${commandId}', '${ids.gateway}', 'pending');
      INSERT INTO "CommandFixtureResult" ("dispatchId", "fixtureId")
        VALUES ('${dispatchId}', '${ids.fixture1}');
      INSERT INTO "MqttOutbox" ("id", "dispatchId", "payload")
        VALUES ('outbox-${suffix}', '${dispatchId}', '${sqlJson(payload)}'::jsonb);
    `);
  }

  function seedMissingResult(schema: string) {
    const payload = legacyPayload({
      commandId: ids.guardCommand,
      dispatchId: ids.guardDispatch,
      targetType: "fixture",
      targetId: ids.fixture1
    });
    execute(schema, `
      INSERT INTO "Command" ("id", "targetId") VALUES ('${ids.guardCommand}', '${ids.fixture1}');
      INSERT INTO "CommandDispatch" ("id", "commandId", "gatewayId", "status")
        VALUES ('${ids.guardDispatch}', '${ids.guardCommand}', '${ids.gateway}', 'pending');
      INSERT INTO "MqttOutbox" ("id", "dispatchId", "payload")
        VALUES ('outbox-guard', '${ids.guardDispatch}', '${sqlJson(payload)}'::jsonb);
    `);
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

  function runSql(sql: string, extraArgs: string[] = ["-q"]) {
    return spawnSync("psql", [...extraArgs, "-v", "ON_ERROR_STOP=1", databaseUrl!], {
      encoding: "utf8",
      input: sql
    });
  }
});

const ids = {
  gateway: "55555555-5555-4555-8555-555555555555",
  fixture1: "66666666-6666-4666-8666-666666666661",
  fixture2: "66666666-6666-4666-8666-666666666662",
  fixture3: "66666666-6666-4666-8666-666666666663",
  group: "77777777-7777-4777-8777-777777777777",
  freshCommand: "11111111-1111-4111-8111-111111111111",
  freshDispatch: "22222222-2222-4222-8222-222222222221",
  retryCommand: "11111111-1111-4111-8111-111111111112",
  retryDispatch: "22222222-2222-4222-8222-222222222222",
  guardCommand: "11111111-1111-4111-8111-111111111113",
  guardDispatch: "22222222-2222-4222-8222-222222222223",
  lateCommand: "11111111-1111-4111-8111-111111111114",
  lateDispatch: "22222222-2222-4222-8222-222222222224"
};

function legacyPayload(overrides: Record<string, unknown>) {
  return {
    commandId: ids.freshCommand,
    dispatchId: ids.freshDispatch,
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    sequence: 1,
    siteId: "44444444-4444-4444-8444-444444444444",
    gatewayId: ids.gateway,
    targetType: "fixture",
    targetId: ids.fixture1,
    targetFixtureIds: [ids.fixture1],
    brightness: 65,
    requestedBy: "88888888-8888-4888-8888-888888888888",
    requestedAt: "2026-07-11T00:00:00.000Z",
    ...overrides
  };
}

function sqlJson(value: unknown) {
  return JSON.stringify(value).replaceAll("'", "''");
}

function newColumnsCountSql() {
  return `
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND (
        (table_name = 'Command' AND column_name = 'targetFixtureIds') OR
        (table_name = 'CommandDispatch' AND column_name IN (
          'deliveryMode', 'destinationAddress', 'meshControlGroupId', 'meshControlGroupVersion'
        ))
      );
  `;
}

function newConstraintCountSql() {
  return `
    SELECT COUNT(*)
    FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND constraint_name = 'CommandDispatch_meshControlGroupId_gatewayId_fkey';
  `;
}
