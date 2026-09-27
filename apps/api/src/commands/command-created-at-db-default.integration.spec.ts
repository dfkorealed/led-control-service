import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { disposablePostgres } from "../../test/support/disposable-postgres";

const enabled = process.env.COMMAND_CREATED_AT_DB_DEFAULT_TEST === "1";
const migrationName = "20260927130000_command_created_at_db_clock_default";

(enabled ? describe : describe.skip)("Command.createdAt DB-owned UTC default on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let siteId: string;
  let legacyId: string;
  const legacyCreatedAt = new Date("2026-05-31T12:34:56.123Z");

  async function createCommand(client: Pick<PrismaClient, "command">, createdAt?: Date) {
    return client.command.create({ data: { siteId, clientRequestId: randomUUID(), requestFingerprint: randomUUID(),
      targetType: "fixtures", targetFixtureIds: [], brightness: 30, status: "acknowledged", outcome: "applied",
      ...(createdAt ? { createdAt } : {}) } });
  }

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const before = cluster.deploy(url, "20260927120000");
    expect(before.stderr + before.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(before.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` });
    const organization = await db.organization.create({ data: { name: "Command createdAt legacy row" } });
    const site = await db.site.create({ data: { organizationId: organization.id, name: "Clock site" } });
    siteId = site.id;
    legacyId = (await createCommand(db, legacyCreatedAt)).id;
    const after = cluster.deploy(url);
    expect(after.stderr + after.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(after.status).toBe(0);
  }, 50_000);
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });

  it("preserves an existing Command row and installs a session-independent UTC default", async () => {
    const legacy = await db.command.findUniqueOrThrow({ where: { id: legacyId } });
    expect(legacy.createdAt).toEqual(legacyCreatedAt);
    const [definition] = await db.$queryRaw<Array<{ expression: string }>>`
      SELECT pg_get_expr(adbin, adrelid) AS expression FROM pg_attrdef
      WHERE adrelid = '"Command"'::regclass
        AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = '"Command"'::regclass
          AND attname = 'createdAt')`;
    expect(definition.expression).toContain("CURRENT_TIMESTAMP AT TIME ZONE 'UTC'");
  });

  it.each(["UTC", "Asia/Seoul", "America/New_York"])(
    "uses the DB UTC clock for a direct SQL default with session timezone %s", async (zone) => {
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
        const [clock] = await tx.$queryRaw<Array<{ dbNow: Date }>>`
          SELECT transaction_timestamp() AT TIME ZONE 'UTC' AS "dbNow"`;
        const [inserted] = await tx.$queryRaw<Array<{ createdAt: Date }>>`
          INSERT INTO "Command" ("id", "siteId", "clientRequestId", "requestFingerprint",
            "targetType", "targetFixtureIds", "brightness", "status", "outcome", "updatedAt")
          VALUES (${randomUUID()}, ${siteId}, ${randomUUID()}, ${randomUUID()},
            'fixtures', '[]'::jsonb, 30, 'acknowledged', 'applied', CURRENT_TIMESTAMP)
          RETURNING "createdAt"`;
        expect(Math.abs(inserted.createdAt.getTime() - clock.dbNow.getTime())).toBeLessThan(1000);
      });
    }
  );

  it.each([-60_000, 60_000])("leaves Prisma create at the DB default despite API clock offset %i ms", async offset => {
    class RollbackFixture extends Error {}
    const sentinel = new Date("2001-02-03T04:05:06.000Z");
    try {
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`ALTER TABLE "Command"
          ALTER COLUMN "createdAt" SET DEFAULT TIMESTAMP '2001-02-03 04:05:06'`);
        const hostTime = new Date(Date.now() + offset);
        // Prisma's interactive transaction needs the real microtask/clock plumbing;
        // fake only the API-visible wall clock, as in the other DB-clock suites.
        jest.useFakeTimers({ doNotFake: ["hrtime", "nextTick", "performance", "queueMicrotask",
          "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate"] });
        jest.setSystemTime(hostTime);
        try {
          const inserted = await createCommand(tx as never);
          expect(inserted.createdAt).toEqual(sentinel);
          expect(Math.abs(inserted.createdAt.getTime() - hostTime.getTime())).toBeGreaterThan(60_000);
        } finally {
          jest.useRealTimers();
        }
        throw new RollbackFixture();
      });
    } catch (error) {
      if (!(error instanceof RollbackFixture)) throw error;
    }
  });

  it("keeps the UTC month-end cutoff and migration reapplication idempotent", async () => {
    const [window] = await db.$queryRaw<Array<{ cutoff: Date }>>`
      SELECT (TIMESTAMP '2026-05-31 12:34:56.123' - INTERVAL '3 months') AS cutoff`;
    expect(window.cutoff).toEqual(new Date("2026-02-28T12:34:56.123Z"));
    const sql = readFileSync(join(__dirname, "../../prisma/migrations", migrationName, "migration.sql"), "utf8");
    await db.$executeRawUnsafe(sql);
    await db.$executeRawUnsafe(sql);
    expect((await db.command.findUniqueOrThrow({ where: { id: legacyId } })).createdAt).toEqual(legacyCreatedAt);
  });
});
