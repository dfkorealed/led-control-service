import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { recordCommandOutcomeActivity } from "./command-outcome-activity";
import { backfillLegacyCommandActivitySources } from "./command-activity-source-backfill";

(process.env.COMMAND_ACTIVITY_DISPOSABLE_POSTGRES === "1" ? describe : describe.skip)(
  "command outcome activity on disposable PostgreSQL", () => {
    let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
    let db: PrismaClient;
    beforeAll(async () => {
      cluster = await disposablePostgres();
      const url = cluster.database();
      const deployed = cluster.deploy(url);
      expect(deployed.status).toBe(0);
      db = new PrismaClient({ datasourceUrl: url });
    }, 30_000);
    afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });
    beforeEach(async () => { await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE'); });
    afterEach(() => {
      delete process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED;
      delete process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION;
      delete process.env.COMMAND_SAFETY_HMAC_KEYS_JSON;
    });

    it("commits one sanitized row per floor for unknown then applied, never a pending row", async () => {
      const organization = await db.organization.create({ data: { name: "command activity", type: "customer" } });
      const site = await db.site.create({ data: { organizationId: organization.id, name: "site" } });
      const floors = await Promise.all([1, 2].map(level => db.floor.create({ data: { siteId: site.id, name: `F${level}`, level } })));
      const fixtures = await Promise.all(floors.map((floor, index) => db.fixture.create({ data: {
        siteId: site.id, floorId: floor.id, name: `L${index}`, ratedWatt: 20, x: index, y: 0
      } })));
      const command = await db.command.create({ data: { siteId: site.id, clientRequestId: randomUUID(),
        requestFingerprint: "test", targetType: "site", targetFixtureIds: fixtures.map(fixture => fixture.id),
        brightness: 70, status: "pending", outcome: "pending" } });

      await db.$transaction(async tx => {
        expect((await tx.command.updateMany({ where: { id: command.id, outcome: "pending" },
          data: { status: "failed", outcome: "unknown" } })).count).toBe(1);
        await recordCommandOutcomeActivity(tx, command.id, "pending", "unknown");
      });
      await db.$transaction(async tx => {
        expect((await tx.command.updateMany({ where: { id: command.id, outcome: "unknown" },
          data: { status: "acknowledged", outcome: "applied" } })).count).toBe(1);
        await recordCommandOutcomeActivity(tx, command.id, "unknown", "applied");
      });
      await recordCommandOutcomeActivity(db as never, command.id, "applied", "applied");
      const rows = await db.monitoringActivity.findMany({ where: { siteId: site.id },
        orderBy: [{ sourceKey: "asc" }, { floorId: "asc" }],
        select: { sourceKey: true, floorId: true, kind: true, commandOutcome: true, displayName: true, status: true } });
      expect(rows).toHaveLength(4);
      expect(rows.map(row => row.sourceKey)).toEqual([
        `${command.id}:applied`, `${command.id}:applied`, `${command.id}:unknown`, `${command.id}:unknown`
      ]);
      expect(rows.map(row => row.floorId).sort()).toEqual([...floors.map(floor => floor.id), ...floors.map(floor => floor.id)].sort());
      expect(rows.every(row => row.kind === "command_result" && row.displayName === null && row.status === null)).toBe(true);
      expect(await db.command.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ outcome: "applied" });
    });

    it("rolls back an outcome mutation when its activity projection rejects invalid source data", async () => {
      const organization = await db.organization.create({ data: { name: "rollback activity", type: "customer" } });
      const site = await db.site.create({ data: { organizationId: organization.id, name: "site" } });
      const floor = await db.floor.create({ data: { siteId: site.id, name: "F1", level: 1 } });
      const fixture = await db.fixture.create({ data: { siteId: site.id, floorId: floor.id,
        name: "L1", ratedWatt: 20, x: 0, y: 0 } });
      const command = await db.command.create({ data: { siteId: site.id, clientRequestId: randomUUID(),
        requestFingerprint: "test", targetType: "fixture", targetFixtureIds: [fixture.id],
        brightness: 70, status: "pending", outcome: "pending" } });
      await expect(db.$transaction(async tx => {
        await tx.command.update({ where: { id: command.id }, data: { status: "failed", outcome: "unknown" } });
        await recordCommandOutcomeActivity(tx, command.id, "pending", "invalid" as never);
      })).rejects.toThrow();
      expect(await db.command.findUniqueOrThrow({ where: { id: command.id } }))
        .toMatchObject({ status: "pending", outcome: "pending" });
      expect(await db.monitoringActivity.count({ where: { siteId: site.id } })).toBe(0);
    });

    it("rekeys a legacy command activity in place and writes only keyed source identities on other floors", async () => {
      process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED = "1";
      process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = "1";
      process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = JSON.stringify({
        1: randomBytes(32).toString("base64url") });
      const organization = await db.organization.create({ data: { name: "keyed activity", type: "customer" } });
      const site = await db.site.create({ data: { organizationId: organization.id, name: "site" } });
      const floors = await Promise.all([1, 2].map(level => db.floor.create({
        data: { siteId: site.id, name: `F${level}`, level } })));
      const fixtures = await Promise.all(floors.map((floor, index) => db.fixture.create({ data: {
        siteId: site.id, floorId: floor.id, name: `L${index}`, ratedWatt: 20, x: index, y: 0
      } })));
      const command = await db.command.create({ data: { siteId: site.id,
        clientRequestId: randomUUID(), requestFingerprint: "test",
        targetType: "site", targetFixtureIds: fixtures.map(fixture => fixture.id),
        brightness: 70, status: "failed", outcome: "unknown" } });
      const firstRecordedAt = new Date("2026-09-24T12:00:00.000Z");
      const legacy = await db.monitoringActivity.create({ data: { siteId: site.id,
        floorId: floors[0].id, sourceType: "command", sourceKey: `${command.id}:unknown`,
        kind: "command_result", commandOutcome: "unknown", recordedAt: firstRecordedAt } });
      await db.$transaction(tx => recordCommandOutcomeActivity(tx, command.id, "pending", "unknown"));
      const rows = await db.monitoringActivity.findMany({ where: { siteId: site.id, sourceType: "command" },
        orderBy: { floorId: "asc" } });
      expect(rows).toHaveLength(2);
      expect(rows.every(row => /^v1:hmac-sha256:[a-f0-9]{64}$/.test(row.sourceKey))).toBe(true);
      expect(rows.find(row => row.floorId === floors[0].id)).toMatchObject({
        id: legacy.id, recordedAt: firstRecordedAt });
      expect(rows.find(row => row.floorId === floors[1].id)?.id).not.toBe(legacy.id);
      expect(JSON.stringify(rows)).not.toContain(command.id);

      // A late old-key row is merged only on the same floor, preserving the
      // original record time rather than inventing a second event.
      const older = new Date(firstRecordedAt.getTime() - 1000);
      await db.monitoringActivity.create({ data: { siteId: site.id,
        floorId: floors[1].id, sourceType: "command", sourceKey: `${command.id}:unknown`,
        kind: "command_result", commandOutcome: "unknown", recordedAt: older } });
      expect(await backfillLegacyCommandActivitySources(db, 100)).toEqual({ scanned: 1, rekeyed: 1 });
      const migrated = await db.monitoringActivity.findMany({ where: { siteId: site.id, sourceType: "command" } });
      expect(migrated).toHaveLength(2);
      expect(migrated.find(row => row.floorId === floors[1].id)?.recordedAt).toEqual(older);
      expect(migrated.every(row => row.sourceKey === rows[0].sourceKey)).toBe(true);

      const oldest = new Date(older.getTime() - 1000);
      await db.monitoringActivity.create({ data: { siteId: site.id,
        floorId: floors[0].id, sourceType: "command", sourceKey: `${command.id}:unknown`,
        kind: "command_result", commandOutcome: "unknown", recordedAt: oldest } });
      await Promise.all([
        db.$transaction(tx => recordCommandOutcomeActivity(tx, command.id, "pending", "unknown")),
        backfillLegacyCommandActivitySources(db, 100)
      ]);
      const raced = await db.monitoringActivity.findMany({ where: { siteId: site.id, sourceType: "command" } });
      expect(raced).toHaveLength(2);
      expect(raced.find(row => row.floorId === floors[0].id)?.recordedAt).toEqual(oldest);
      expect(raced.every(row => row.sourceKey === rows[0].sourceKey)).toBe(true);

      const oldKey = JSON.parse(process.env.COMMAND_SAFETY_HMAC_KEYS_JSON!)[1] as string;
      process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = "2";
      process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = JSON.stringify({
        1: oldKey, 2: randomBytes(32).toString("base64url") });
      await db.$transaction(tx => recordCommandOutcomeActivity(tx, command.id, "pending", "unknown"));
      expect(await db.monitoringActivity.count({ where: { siteId: site.id } })).toBe(2);

      let releaseCutover!: () => void;
      let signalCutoverLocked!: () => void;
      const cutoverLocked = new Promise<void>(resolve => { signalCutoverLocked = resolve; });
      const cutoverReleased = new Promise<void>(resolve => { releaseCutover = resolve; });
      const cutover = db.$transaction(async tx => {
        await tx.$executeRawUnsafe('LOCK TABLE "MonitoringActivity" IN SHARE ROW EXCLUSIVE MODE');
        expect(await tx.monitoringActivity.count({ where: {
          sourceType: "command", sourceKey: `${command.id}:unknown` } })).toBe(0);
        await tx.$executeRawUnsafe('UPDATE "MonitoringCommandSourcePolicy" SET "keyedRequired" = true WHERE "id" = 1');
        signalCutoverLocked();
        await cutoverReleased;
      });
      await cutoverLocked;
      process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED = "0";
      let oldWriterSettled = false;
      const oldWriter = db.$transaction(async tx => {
        await tx.command.update({ where: { id: command.id }, data: { outcome: "applied" } });
        await recordCommandOutcomeActivity(tx, command.id, "unknown", "applied");
      }).finally(() => { oldWriterSettled = true; });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(oldWriterSettled).toBe(false);
      releaseCutover();
      await cutover;
      await expect(oldWriter).rejects.toThrow();
      expect((await db.command.findUniqueOrThrow({ where: { id: command.id } })).outcome).toBe("unknown");
      process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED = "1";
      await db.$transaction(async tx => {
        await tx.command.update({ where: { id: command.id }, data: { outcome: "applied" } });
        await recordCommandOutcomeActivity(tx, command.id, "unknown", "applied");
      });
      expect(await db.monitoringActivity.count({ where: { siteId: site.id,
        commandOutcome: "applied" } })).toBe(2);
      await db.$executeRawUnsafe('CREATE ROLE activity_runtime_probe NOLOGIN');
      await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO activity_runtime_probe');
      await db.$executeRawUnsafe('GRANT INSERT ON "MonitoringActivity" TO activity_runtime_probe');
      await expect(db.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE activity_runtime_probe');
        await tx.$queryRawUnsafe('SELECT "keyedRequired" FROM "MonitoringCommandSourcePolicy"');
      })).rejects.toThrow();
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE activity_runtime_probe');
        // The trigger can read private policy through its definer even though
        // this restricted runtime role cannot; it does not authenticate HMACs.
        await tx.$executeRaw`INSERT INTO "MonitoringActivity"
          ("id","siteId","floorId","sourceType","sourceKey","kind","commandOutcome")
          VALUES (${randomUUID()},${site.id},${floors[0].id},'command',
            ${`v2:hmac-sha256:${"c".repeat(64)}`},'command_result','applied')`;
      });
      await db.$executeRawUnsafe('UPDATE "MonitoringCommandSourcePolicy" SET "keyedRequired" = false WHERE "id" = 1');
    });

    it("limits one raw Command source across 101 floors to 100 legacy rows per pass", async () => {
      process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = "1";
      process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = JSON.stringify({ 1: randomBytes(32).toString("base64url") });
      const organization = await db.organization.create({ data: { name: "row-bound activity", type: "customer" } });
      const site = await db.site.create({ data: { organizationId: organization.id, name: "site" } });
      const floorIds = Array.from({ length: 101 }, () => randomUUID());
      await db.floor.createMany({ data: floorIds.map((id, level) => ({ id, siteId: site.id, name: `F${level}`, level })) });
      const sourceKey = `${randomUUID()}:unknown`;
      await db.monitoringActivity.createMany({ data: floorIds.map(floorId => ({
        siteId: site.id, floorId, sourceType: "command", sourceKey,
        kind: "command_result", commandOutcome: "unknown",
        recordedAt: new Date("2026-09-24T12:00:00.000Z")
      })) });

      expect(await backfillLegacyCommandActivitySources(db, 100)).toEqual({ scanned: 100, rekeyed: 100 });
      expect(await db.monitoringActivity.count({ where: { sourceKey } })).toBe(1);
      expect(await backfillLegacyCommandActivitySources(db, 100)).toEqual({ scanned: 1, rekeyed: 1 });
      expect(await db.monitoringActivity.count({ where: { sourceKey } })).toBe(0);
      expect(await db.monitoringActivity.count({ where: { siteId: site.id } })).toBe(101);
    });

    it("limits 100 multi-floor raw sources by rows and converges on the next pass", async () => {
      process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = "1";
      process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = JSON.stringify({ 1: randomBytes(32).toString("base64url") });
      const organization = await db.organization.create({ data: { name: "group-bound activity", type: "customer" } });
      const site = await db.site.create({ data: { organizationId: organization.id, name: "site" } });
      const floors = await Promise.all([0, 1].map(level => db.floor.create({
        data: { siteId: site.id, name: `F${level}`, level }
      })));
      const sourceKeys = Array.from({ length: 100 }, () => `${randomUUID()}:unknown`);
      await db.monitoringActivity.createMany({ data: sourceKeys.flatMap(sourceKey => floors.map(floor => ({
        siteId: site.id, floorId: floor.id, sourceType: "command", sourceKey,
        kind: "command_result", commandOutcome: "unknown",
        recordedAt: new Date("2026-09-24T12:00:00.000Z")
      }))) });

      expect(await backfillLegacyCommandActivitySources(db, 100)).toEqual({ scanned: 100, rekeyed: 100 });
      expect(await db.monitoringActivity.count({ where: { siteId: site.id,
        sourceKey: { in: sourceKeys } } })).toBe(100);
      expect(await backfillLegacyCommandActivitySources(db, 100)).toEqual({ scanned: 100, rekeyed: 100 });
      expect(await db.monitoringActivity.count({ where: { siteId: site.id,
        sourceKey: { in: sourceKeys } } })).toBe(0);
      expect(await db.monitoringActivity.count({ where: { siteId: site.id } })).toBe(200);
    });

    it("uses a raw-only ordered index for a large keyed activity table", async () => {
      const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'MonitoringActivity'
          AND indexname = 'MonitoringActivity_raw_command_backfill_idx'`;
      expect(indexes).toHaveLength(1);
      const organization = await db.organization.create({ data: { name: "raw index activity", type: "customer" } });
      const site = await db.site.create({ data: { organizationId: organization.id, name: "site" } });
      const floor = await db.floor.create({ data: { siteId: site.id, name: "F1", level: 1 } });
      await db.monitoringActivity.createMany({ data: Array.from({ length: 10_000 }, (_, index) => ({
        siteId: site.id, floorId: floor.id, sourceType: "command",
        sourceKey: `v1:hmac-sha256:${index.toString(16).padStart(64, "0")}`,
        kind: "command_result" as const, commandOutcome: "unknown" as const,
        recordedAt: new Date("2026-09-24T12:00:00.000Z")
      })) });
      await db.monitoringActivity.create({ data: { siteId: site.id, floorId: floor.id,
        sourceType: "command", sourceKey: `${randomUUID()}:unknown`,
        kind: "command_result", commandOutcome: "unknown",
        recordedAt: new Date("2026-09-24T12:00:00.000Z") } });
      await db.$executeRawUnsafe('ANALYZE "MonitoringActivity"');
      const plan = await db.$queryRaw<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT "siteId", "sourceKey", "floorId" FROM "MonitoringActivity"
        WHERE "sourceType" = 'command'
          AND "sourceKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(applied|not_applied|partially_applied|unknown)$'
          AND "recordedAt" >= ('2026-09-01T00:00:00Z'::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "recordedAt", "id" LIMIT 100`;
      const planText = JSON.stringify(plan[0]?.["QUERY PLAN"]);
      expect(planText).toContain("MonitoringActivity_raw_command_backfill_idx");
      expect(planText).not.toContain('"Node Type":"Seq Scan"');
      expect(planText).not.toContain('"Node Type":"Sort"');
      for (let batch = 1; batch < 10; batch++) {
        await db.monitoringActivity.createMany({ data: Array.from({ length: 10_000 }, (_, index) => ({
          siteId: site.id, floorId: floor.id, sourceType: "command",
          sourceKey: `v1:hmac-sha256:${(batch * 10_000 + index).toString(16).padStart(64, "0")}`,
          kind: "command_result" as const, commandOutcome: "unknown" as const,
          recordedAt: new Date("2026-09-24T12:00:00.000Z")
        })) });
      }
      await db.$executeRawUnsafe('ANALYZE "MonitoringActivity"');
      const largePlan = await db.$queryRaw<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT "siteId", "sourceKey", "floorId" FROM "MonitoringActivity"
        WHERE "sourceType" = 'command'
          AND "sourceKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(applied|not_applied|partially_applied|unknown)$'
          AND "recordedAt" >= ('2026-09-01T00:00:00Z'::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "recordedAt", "id" LIMIT 100`;
      const largePlanText = JSON.stringify(largePlan[0]?.["QUERY PLAN"]);
      expect(largePlanText).toContain("MonitoringActivity_raw_command_backfill_idx");
      expect(largePlanText).not.toContain('"Node Type":"Seq Scan"');
      expect(largePlanText).not.toContain('"Node Type":"Sort"');
    });
  }
);
