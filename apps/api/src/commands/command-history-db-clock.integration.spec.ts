import { BadRequestException, GoneException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import type { AuthenticatedUser } from "../auth/auth.types";
import { inspectCommandHistoryReadiness } from "./command-history-rollout";
import { CommandStatusService } from "./command-status.service";

const enabled = process.env.COMMAND_HISTORY_DB_CLOCK_TEST === "1";

(enabled ? describe : describe.skip)("Command GET DB-clock boundary on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let ownedDirectory: string | undefined;
  let siteId: string;
  let service: CommandStatusService;
  const user: AuthenticatedUser = { id: randomUUID(), organizationId: randomUUID(), organizationType: "customer",
    loginId: "clock-reader", name: "Clock reader", role: "admin", status: "active", mustChangePassword: false };

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect(new URL(url).pathname).toMatch(/^\/watermark_\d+$/);
    const dataDirectory = cluster.sql(url, "SHOW data_directory");
    expect(dataDirectory.startsWith(join(realpathSync("/tmp"), "gateway-watermark-"))).toBe(true);
    expect(dataDirectory.endsWith("/data")).toBe(true);
    ownedDirectory = dirname(dataDirectory);
    expect(cluster.sql(url, "SELECT current_database() || ':' || inet_server_port()"))
      .toBe(`${new URL(url).pathname.slice(1)}:${new URL(url).port}`);
    expect(cluster.sql(url, "SELECT count(*) FROM pg_tables WHERE schemaname='public'")).toBe("0");
    const deployed = cluster.deploy(url);
    expect(deployed.stderr + deployed.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(deployed.status).toBe(0);
    console.info("Task2 command owned PostgreSQL", { dataDirectory, databaseUrl: url,
      appliedMigrations: cluster.sql(url, 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL') });
    db = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` });
    const organization = await db.organization.create({ data: { name: "Command DB-clock test" } });
    const site = await db.site.create({ data: { organizationId: organization.id, name: "Clock site" } });
    siteId = site.id;
    service = new CommandStatusService(db as never, { assert: jest.fn().mockResolvedValue(site) } as never);
  }, 40_000);
  afterAll(async () => {
    try { await db?.$disconnect(); }
    finally {
      cluster?.stop();
      if (ownedDirectory) {
        expect(existsSync(ownedDirectory)).toBe(false);
        console.info("Task2 command PostgreSQL cleanup", { directory: ownedDirectory, exists: false });
      }
    }
  });
  beforeEach(async () => {
    await db.command.deleteMany({ where: { siteId } });
    process.env.COMMAND_HISTORY_RETENTION_ENABLED = "1";
  });
  afterEach(() => {
    delete process.env.COMMAND_HISTORY_RETENTION_ENABLED;
    delete process.env.COMMAND_RECOVERY_ACTIONS_ENABLED;
    delete process.env.COMMAND_RECOVERY_PUBLISHER_READY;
  });

  async function dbBoundary() {
    const [clock] = await db.$queryRaw<Array<{ generatedAt: Date; retainedFrom: Date }>>`
      SELECT transaction_timestamp() AT TIME ZONE 'UTC' AS "generatedAt",
        (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '3 months' AS "retainedFrom"`;
    return clock;
  }

  async function insertCommand(createdAt: Date, outcome: "applied" | "unknown" | "pending") {
    return db.command.create({ data: { siteId, clientRequestId: randomUUID(), requestFingerprint: randomUUID(),
      targetType: "fixtures", targetFixtureIds: [], brightness: 30, status: "acknowledged", outcome, createdAt } });
  }

  it("filters authorized site-local dates in SQL and traverses 1000 equal-time command rows", async () => {
    await db.site.update({ where: { id: siteId }, data: { timeZone: "Asia/Seoul" } });
    const dateService = new CommandStatusService(db as never, {
      assert: async () => db.site.findUniqueOrThrow({ where: { id: siteId } })
    } as never);
    const [{ date, start, end }] = await db.$queryRaw<Array<{ date: string; start: Date; end: Date }>>`
      WITH day AS (SELECT (transaction_timestamp() AT TIME ZONE 'Asia/Seoul')::date - 1 AS date)
      SELECT to_char(date, 'YYYY-MM-DD') AS date,
        (date::timestamp AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'UTC' AS start,
        ((date + 1)::timestamp AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'UTC' AS end FROM day`;
    const tiedAt = new Date(start.getTime() + 12 * 60 * 60 * 1000 + 123);
    const ids = Array.from({ length: 1001 }, () => randomUUID()), startId = randomUUID();
    const data = (id: string, createdAt: Date) => ({ id, siteId, clientRequestId: randomUUID(), requestFingerprint: randomUUID(),
      targetType: "fixtures" as const, targetFixtureIds: [], brightness: 30, status: "acknowledged" as const, outcome: "applied" as const, createdAt });
    await db.command.createMany({ data: [
      ...ids.map(id => data(id, tiedAt)), data(startId, start),
      data(randomUUID(), new Date(start.getTime() - 1)), data(randomUUID(), end)
    ] });
    const input = { siteId, limit: 1000, fromDate: date, toDate: date };
    const first = await dateService.listCommands(user, input);
    expect(first.items.map(row => row.id)).toEqual(ids.sort().reverse().slice(0, 1000));
    expect(first.items.every(row => row.createdAt === tiedAt.toISOString())).toBe(true);
    expect(first.retentionEnabled).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(dateService.listCommands(user, { ...input, limit: 500, cursor: first.nextCursor! }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(dateService.listCommands({ ...user, id: randomUUID() }, { ...input, cursor: first.nextCursor! }))
      .rejects.toBeInstanceOf(BadRequestException);
    const second = await dateService.listCommands(user, { ...input, cursor: first.nextCursor! });
    expect(second.items.map(row => row.id)).toEqual([ids[1000], startId]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(1002);
  });

  it("uses DB time rather than fast/slow API host time for list, detail, cursor and metadata", async () => {
    await db.$executeRawUnsafe(`SET TIME ZONE 'UTC'`);
    const clock = await dbBoundary();
    const fresh = await insertCommand(new Date(clock.retainedFrom.getTime() + 30_000), "applied");
    const expired = await insertCommand(new Date(clock.retainedFrom.getTime() - 30_000), "applied");
    const fastHost = new Date(clock.generatedAt.getTime() + 60_000);
    const slowHost = new Date(clock.generatedAt.getTime() - 60_000);
    for (const hostNow of [fastHost, slowHost]) {
      const list = await service.listCommands(user, { siteId }, hostNow);
      expect(list.items.map((item) => item.id)).toEqual([fresh.id]);
      expect(Math.abs(new Date(list.generatedAt!).getTime() - clock.generatedAt.getTime())).toBeLessThan(10_000);
      expect(Math.abs(new Date(list.generatedAt!).getTime() - hostNow.getTime())).toBeGreaterThan(30_000);
      expect(Math.abs(new Date(list.retainedFrom!).getTime() - clock.retainedFrom.getTime())).toBeLessThan(10_000);
      const detail = await service.getCommand(user, fresh.id, hostNow);
      expect(detail).toMatchObject({ id: fresh.id, generatedAt: expect.any(String), retainedFrom: expect.any(String) });
      expect(Math.abs(Date.parse((detail as any).generatedAt) - clock.generatedAt.getTime())).toBeLessThan(10_000);
      await expect(service.getCommand(user, expired.id, hostNow)).rejects.toBeInstanceOf(GoneException);
    }
    const expiredCursor = Buffer.from(JSON.stringify({ id: expired.id, createdAt: expired.createdAt.toISOString() })).toString("base64url");
    await expect(service.listCommands(user, { siteId, cursor: expiredCursor }, slowHost)).rejects.toMatchObject({
      response: { code: "command_history_cursor_expired" }, status: 400
    });
  });

  it("exposes DB anchors with rollout OFF while preserving old unresolved detail and history", async () => {
    delete process.env.COMMAND_HISTORY_RETENTION_ENABLED;
    const clock = await dbBoundary();
    const old = await insertCommand(new Date("2020-01-01T00:00:00Z"), "unknown");
    const detail = await service.getCommand(user, old.id, new Date("1900-01-01"));
    expect(detail).toMatchObject({ id: old.id, retentionEnabled: false, brightness: 30, generatedAt: expect.any(String) });
    expect(Math.abs(Date.parse(detail.generatedAt!) - clock.generatedAt.getTime())).toBeLessThan(10_000);
    expect(await service.listCommands(user, { siteId })).toMatchObject({ retentionEnabled: false, items: [{ id: old.id }] });
  });

  it.each(["UTC", "Asia/Seoul", "America/New_York"])(
    "compares an unheld row against the UTC TIMESTAMP cutoff in DB session %s", async (zone) => {
      await db.$executeRawUnsafe(`SET TIME ZONE '${zone}'`);
      const clock = await dbBoundary();
      const fresh = await insertCommand(new Date(clock.retainedFrom.getTime() + 30_000), "unknown");
      const list = await service.listCommands(user, { siteId }, new Date(clock.generatedAt.getTime() + 60_000));
      expect(list.generatedAt).toEqual(expect.any(String));
      expect(list.items.map((item) => item.id)).toContain(fresh.id);
      const expired = await insertCommand(new Date(clock.retainedFrom.getTime() - 30_000), "unknown");
      const retained = await service.listCommands(user, { siteId }, new Date(clock.generatedAt.getTime() - 60_000));
      expect(retained.generatedAt).toEqual(expect.any(String));
      expect(retained.items.map((item) => item.id)).toEqual([fresh.id]);
      await expect(service.getCommand(user, expired.id)).rejects.toBeInstanceOf(GoneException);
    }
  );

  it("preflight rejects old unheld pending and unknown rows and passes after removal", async () => {
    const clock = await dbBoundary();
    const old = await insertCommand(new Date(clock.retainedFrom.getTime() - 30_000), "unknown");
    const pending = await insertCommand(new Date(clock.retainedFrom.getTime() - 30_000), "pending");
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return inspectCommandHistoryReadiness(tx);
    })).rejects.toThrow("unheld old commands: 2");
    await db.command.delete({ where: { id: old.id } });
    await db.command.delete({ where: { id: pending.id } });
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return inspectCommandHistoryReadiness(tx);
    })).resolves.toMatchObject({ unheldCount: 0, sampleIds: [] });
  });
});
