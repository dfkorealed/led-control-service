import { gatewayDimmingCommandV2CompatibilitySchema } from "@led-control/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(join(
  __dirname,
  "../../prisma/migrations/20260819094000_extend_command_targets/migration.sql"
), "utf8");
const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");

describe("command target migration contract", () => {
  it("runs every preflight before DDL inside one explicit transaction", () => {
    expect(migration.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(migration.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(migration.indexOf("DO $$")).toBeLessThan(migration.indexOf('ALTER TABLE "Command"'));
  });

  it("backfills authoritative command fixture snapshots from persisted fixture results", () => {
    expect(migration).toMatch(/UPDATE "Command"\s+AS command[\s\S]*?jsonb_agg\(DISTINCT result\."fixtureId"/);
    expect(migration).toMatch(/dispatch\."commandId" = command\."id"/);
    expect(migration).toMatch(/COALESCE\(\([\s\S]*?\), '\[\]'::jsonb\)/);
  });

  it("backfills physical dispatch mode from fixture result count", () => {
    expect(migration).toMatch(/UPDATE "CommandDispatch"\s+AS dispatch[\s\S]*?COUNT\(result\."fixtureId"\)[\s\S]*?\) <= 1 THEN 'unicast'[\s\S]*?ELSE 'parallel_unicast'/);
  });

  it("normalizes every legacy outbox to a strict physical fixture payload", () => {
    expect(migration).toMatch(/IF EXISTS \([\s\S]*?FROM "MqttOutbox" AS outbox[\s\S]*?NOT EXISTS \([\s\S]*?FROM "CommandFixtureResult" AS result/);
    expect(migration).toContain("cannot migrate MqttOutbox without CommandFixtureResult targets");
    expect(migration).toMatch(/HAVING COUNT\(result\."fixtureId"\) > 1000/);
    expect(migration).toContain("cannot migrate MqttOutbox with more than 1000 fixture targets");
    expect(migration).toMatch(/UPDATE "MqttOutbox" AS outbox\s+SET "payload" = jsonb_build_object/);
    expect(migration).not.toMatch(/SET "payload" = \([\s\S]*?\)\s*\|\|/);
    expect(migration).not.toContain("'expiresAt'");
    expect(migration).toContain(`'commandId', outbox."payload"->'commandId'`);
    expect(migration).toContain(`'requestedAt', outbox."payload"->'requestedAt'`);
    expect(migration).toContain(`WHEN outbox."payload"->>'targetType' = 'fixture'`);
    expect(migration).toContain(`ELSE 'fixtures'`);
    expect(migration).toContain(`'targetId', CASE`);
    expect(migration).toContain(`ELSE 'null'::jsonb`);
    expect(migration).toContain(`'targetFixtureIds', dispatch_targets."fixtureIds"`);
    expect(migration).toContain(`'deliveryMode', dispatch_targets."deliveryMode"`);
    const migratedLegacyGroup = {
      commandId: "11111111-1111-4111-8111-111111111111",
      dispatchId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      sequence: 1,
      siteId: "44444444-4444-4444-8444-444444444444",
      gatewayId: "55555555-5555-4555-8555-555555555555",
      targetType: "fixtures",
      targetId: null,
      targetFixtureIds: [
        "66666666-6666-4666-8666-666666666661",
        "66666666-6666-4666-8666-666666666662"
      ],
      deliveryMode: "parallel_unicast",
      brightness: 65,
      requestedBy: "77777777-7777-4777-8777-777777777777",
      requestedAt: "2026-07-11T00:00:00.000Z"
    };
    expect(gatewayDimmingCommandV2CompatibilitySchema.parse(migratedLegacyGroup)).toEqual(migratedLegacyGroup);
  });

  it("declares the mesh group snapshot relation and lookup index", () => {
    expect(schema).toMatch(/meshControlGroupId\s+String\?/);
    expect(schema).toMatch(/meshControlGroupVersion\s+Int\?/);
    expect(schema).toMatch(/meshControlGroup\s+MeshControlGroup\?\s+@relation\(fields: \[meshControlGroupId, gatewayId\], references: \[id, gatewayId\], onDelete: Restrict\)/);
    expect(schema).toContain("@@index([meshControlGroupId, status])");
    expect(migration).toContain('ADD COLUMN "meshControlGroupId" TEXT');
    expect(migration).toContain('ADD COLUMN "meshControlGroupVersion" INTEGER');
    expect(migration).toContain('CREATE INDEX "CommandDispatch_meshControlGroupId_status_idx"');
    expect(migration).toContain('ADD CONSTRAINT "CommandDispatch_meshControlGroupId_gatewayId_fkey"');
    expect(migration).toContain('FOREIGN KEY ("meshControlGroupId", "gatewayId") REFERENCES "MeshControlGroup"("id", "gatewayId")');
  });
});
