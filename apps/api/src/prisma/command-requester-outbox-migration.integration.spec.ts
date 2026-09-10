import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const migrationPath = join(
  __dirname,
  "../../prisma/migrations/20260911090000_remove_command_requester_from_mqtt_outbox/migration.sql"
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const databaseUrl = process.env.COMMAND_REQUESTER_SCRUB_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describe("command requester outbox migration contract", () => {
  it("uses one transaction and scopes the top-level scrub to command dispatch rows", () => {
    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain('UPDATE "MqttOutbox" AS outbox');
    expect(migration).toContain('FROM "CommandDispatch" AS dispatch');
    expect(migration).toContain("outbox.\"payload\" - 'requestedBy'");
    expect(migration).toContain("jsonb_typeof(outbox.\"payload\") = 'object'");
    expect(migration).toContain("outbox.\"payload\" ? 'requestedBy'");
    expect(migration).toContain('CONSTRAINT "MqttOutbox_command_payload_no_requested_by_check"');
    expect(migration).toMatch(/"dispatchId" IS NULL[\s\S]*?jsonb_typeof\("payload"\) <> 'object'[\s\S]*?NOT \("payload" \? 'requestedBy'\)/);
  });
});

describeWithPostgres("command requester outbox migration PostgreSQL rehearsal", () => {
  const schemas: string[] = [];

  afterAll(() => {
    for (const schema of schemas) runSql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
  });

  it("scrubs historical command rows without changing config or application ACK payloads", () => {
    const schema = `command_requester_scrub_${process.pid}_${Date.now()}`.toLowerCase();
    schemas.push(schema);
    execute(`CREATE SCHEMA "${schema}";`);
    execute(`
      SET search_path TO "${schema}";
      CREATE TABLE "CommandDispatch" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "MqttOutbox" (
        "id" TEXT PRIMARY KEY,
        "dispatchId" TEXT,
        "payload" JSONB NOT NULL,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO "CommandDispatch" ("id") VALUES ('dispatch-1');
      INSERT INTO "MqttOutbox" ("id", "dispatchId", "payload") VALUES
        ('command', 'dispatch-1', '{"commandId":"command-1","requestedBy":"user-1","nested":{"requestedBy":"keep-nested"}}'),
        ('config', NULL, '{"kind":"automation-config","requestedBy":"keep-config"}'),
        ('ack', NULL, '{"kind":"application-ack","requestedBy":"keep-ack"}'),
        ('other-command-shape', 'dispatch-1', '["requestedBy","keep-array"]');
    `);

    expect(run(schema, migration).status).toBe(0);

    const rows = JSON.parse(query(schema, `
      SELECT json_object_agg("id", "payload")::text
      FROM "MqttOutbox";
    `));
    expect(rows.command).toEqual({ commandId: "command-1", nested: { requestedBy: "keep-nested" } });
    expect(rows.config).toEqual({ kind: "automation-config", requestedBy: "keep-config" });
    expect(rows.ack).toEqual({ kind: "application-ack", requestedBy: "keep-ack" });
    expect(rows["other-command-shape"]).toEqual(["requestedBy", "keep-array"]);

    const legacyReinsert = run(schema, `
      UPDATE "MqttOutbox"
      SET "payload" = jsonb_set("payload", '{requestedBy}', '"user-2"'::jsonb)
      WHERE "id" = 'command';
    `);
    expect(legacyReinsert.status).not.toBe(0);
    expect(legacyReinsert.stderr).toContain("MqttOutbox_command_payload_no_requested_by_check");

    const nonCommandUpdates = run(schema, `
      UPDATE "MqttOutbox"
      SET "payload" = jsonb_set("payload", '{postMigration}', 'true'::jsonb)
      WHERE "id" IN ('config', 'ack');
      UPDATE "MqttOutbox"
      SET "payload" = "payload" || '["post-migration"]'::jsonb
      WHERE "id" = 'other-command-shape';
    `);
    expect(nonCommandUpdates.status).toBe(0);
  });

  function query(schema: string, sql: string) {
    const result = run(schema, sql, ["-qAt"]);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  function execute(sql: string) {
    const result = runSql(sql);
    if (result.status !== 0) throw new Error(result.stderr);
  }

  function run(schema: string, sql: string, extraArgs: string[] = ["-q"]) {
    return runSql(`SET search_path TO "${schema}";\n${sql}`, extraArgs);
  }

  function runSql(sql: string, extraArgs: string[] = ["-q"]) {
    return spawnSync("psql", [...extraArgs, "-v", "ON_ERROR_STOP=1", databaseUrl!], {
      encoding: "utf8",
      input: sql
    });
  }
});
