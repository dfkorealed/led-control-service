import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/auth.types";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { recordMonitoringActivity } from "./monitoring-activity.projection";
import { MonitoringActivityService } from "./monitoring-activity.service";

const enabled = process.env.MONITORING_ACTIVITY_TEST === "1";

(enabled ? describe : describe.skip)("MonitoringActivity on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let siteId: string, floorId: string, otherFloorId: string;
  const user = { id: "00000000-0000-4000-8000-000000000004" } as AuthenticatedUser;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const migrated = cluster.deploy(url);
    expect(migrated.stderr + migrated.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(migrated.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` });
    await db.$executeRawUnsafe("SET TIME ZONE 'Asia/Seoul'");
  }, 60_000);
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
    const organizationId = randomUUID(); siteId = randomUUID(); floorId = randomUUID(); otherFloorId = randomUUID();
    await db.organization.create({ data: { id: organizationId, name: "Activity fixture" } });
    await db.site.create({ data: { id: siteId, organizationId, name: "Factory" } });
    await db.floor.createMany({ data: [
      { id: floorId, siteId, name: "B1", level: -1 },
      { id: otherFloorId, siteId, name: "1F", level: 1 }
    ] });
  });

  function service() {
    return new MonitoringActivityService(db as never, { assert: async () => ({ id: siteId }) } as never);
  }

  it("deduplicates a source per floor and keeps safe snapshots after fixture/floor deletion", async () => {
    const sourceKey = randomUUID();
    const input = { siteId, floorId, sourceType: "fixture_state" as const, sourceKey,
      kind: "fixture_status_changed" as const, fixtureId: randomUUID(), displayName: "원래 이름", status: "online" as const };
    await db.$transaction(async tx => {
      await recordMonitoringActivity(tx, input);
      await recordMonitoringActivity(tx, input);
      await recordMonitoringActivity(tx, { ...input, floorId: otherFloorId });
    });
    await expect(db.$transaction(tx => recordMonitoringActivity(tx, { ...input, sourceKey: randomUUID(),
      payload: { private: true } } as never))).rejects.toThrow();
    await expect(db.$transaction(tx => recordMonitoringActivity(tx, { ...input, sourceKey: randomUUID(),
      kind: "command_result" } as never))).rejects.toThrow();
    expect(await db.monitoringActivity.count()).toBe(2);
    const rows = await db.monitoringActivity.findMany({ select: { recordedAt: true } });
    expect(rows.every(row => row.recordedAt >= new Date(Date.now() - 60_000) && row.recordedAt <= new Date())).toBe(true);
    await db.floor.delete({ where: { id: floorId } });
    expect(await db.monitoringActivity.findFirst({ where: { floorId }, select: { displayName: true, fixtureId: true } }))
      .toEqual({ displayName: "원래 이름", fixtureId: input.fixtureId });
  });

  it("rejects a floor belonging to another site and scopes source deduplication by site", async () => {
    const otherSiteId = randomUUID(), sameKey = randomUUID();
    await db.site.create({ data: { id: otherSiteId, organizationId: (await db.site.findUniqueOrThrow({ where: { id: siteId } })).organizationId, name: "Other" } });
    const otherSiteFloorId = randomUUID();
    await db.floor.create({ data: { id: otherSiteFloorId, siteId: otherSiteId, name: "B1", level: -1 } });
    await expect(db.$transaction(tx => recordMonitoringActivity(tx, {
      siteId, floorId: otherSiteFloorId, sourceType: "fixture_state", sourceKey: sameKey,
      kind: "fixture_offline"
    }))).rejects.toThrow();
    await db.$transaction(tx => recordMonitoringActivity(tx, {
      siteId, floorId, sourceType: "fixture_state", sourceKey: sameKey, kind: "fixture_offline"
    }));
    // Historical activity retains its floor snapshot; a later replacement floor may reuse that ID in another site.
    await db.floor.delete({ where: { id: floorId } });
    await db.floor.delete({ where: { id: otherSiteFloorId } });
    await db.floor.create({ data: { id: floorId, siteId: otherSiteId, name: "Replacement", level: -1, status: "archived" } });
    await db.$transaction(tx => recordMonitoringActivity(tx, {
      siteId: otherSiteId, floorId, sourceType: "fixture_state", sourceKey: sameKey,
      kind: "fixture_offline"
    }));
    expect(await db.monitoringActivity.count({ where: { sourceKey: sameKey } })).toBe(2);
    const activity = await service().list(user, otherSiteId, floorId, { limit: 5 });
    expect(activity.items).toHaveLength(1);
  });

  it.each(["UTC", "Asia/Seoul", "America/New_York"])(
    "stores Prisma and direct SQL activity from the UTC DB clock in %s", async zone => {
    const [{ before }] = await db.$queryRaw<Array<{ before: Date }>>`
      SELECT (transaction_timestamp() AT TIME ZONE 'UTC') AS before`;
    const sourceKey = randomUUID();
    const directKey = randomUUID();
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
      const [session] = await tx.$queryRawUnsafe<Array<{ TimeZone: string }>>("SHOW TIME ZONE");
      expect(session?.TimeZone).toBe(zone);
      await recordMonitoringActivity(tx, { siteId, floorId, sourceType: "fixture_state",
        sourceKey, kind: "fixture_offline" });
      await tx.$executeRaw`
        INSERT INTO "MonitoringActivity" ("id", "siteId", "floorId", "sourceType", "sourceKey", "kind")
        VALUES (${randomUUID()}, ${siteId}, ${floorId}, 'fixture_state', ${directKey}, 'fixture_online')`;
    });
    const rows = await db.monitoringActivity.findMany({ where: { sourceKey: { in: [sourceKey, directKey] } } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.recordedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(row.recordedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  it("deploys a session-independent UTC recordedAt default", async () => {
    const [row] = await db.$queryRawUnsafe<Array<{ expression: string }>>(`
      SELECT pg_get_expr(adbin, adrelid) AS expression FROM pg_attrdef
      WHERE adrelid = '"MonitoringActivity"'::regclass
        AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = '"MonitoringActivity"'::regclass
          AND attname = 'recordedAt')`);
    expect(row.expression).toContain("CURRENT_TIMESTAMP AT TIME ZONE 'UTC'");
  });

  it("lets the UTC DB default timestamp a Prisma projection producer", async () => {
    class RollbackFixture extends Error {}
    const sentinel = new Date("2001-02-03T04:05:06.000Z");
    try {
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`ALTER TABLE "MonitoringActivity"
          ALTER COLUMN "recordedAt" SET DEFAULT TIMESTAMP '2001-02-03 04:05:06'`);
        const sourceKey = randomUUID();
        await recordMonitoringActivity(tx, { siteId, floorId, sourceType: "fixture_state",
          sourceKey, kind: "fixture_online" });
        const row = await tx.monitoringActivity.findFirstOrThrow({ where: { sourceKey } });
        expect(row.recordedAt).toEqual(sentinel);
        throw new RollbackFixture();
      });
    } catch (error) {
      if (!(error instanceof RollbackFixture)) throw error;
    }
  });

  it("uses DB time for visible rows, cursor expiry and response metadata despite a fast or slow API clock", async () => {
    const [{ dbNow, cutoff }] = await db.$queryRaw<Array<{ dbNow: Date; cutoff: Date }>>`
      SELECT (transaction_timestamp() AT TIME ZONE 'UTC') AS "dbNow",
        ((transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '3 months') AS cutoff`;
    const expired = await db.monitoringActivity.create({ data: {
      siteId, floorId, sourceType: "fixture_state", sourceKey: "expired", kind: "fixture_offline",
      recordedAt: new Date(cutoff.getTime() - 30_000)
    } });
    const fresh = await db.monitoringActivity.create({ data: {
      siteId, floorId, sourceType: "fixture_state", sourceKey: "fresh", kind: "fixture_online",
      recordedAt: new Date(cutoff.getTime() + 30_000)
    } });
    await db.monitoringActivity.create({ data: {
      siteId, floorId, sourceType: "fixture_state", sourceKey: "newest", kind: "fixture_online",
      recordedAt: new Date(cutoff.getTime() + 31_000)
    } });
    for (const offset of [60_000, -60_000]) {
      jest.useFakeTimers({ doNotFake: ["hrtime", "nextTick", "performance", "queueMicrotask",
        "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate"] });
      jest.setSystemTime(new Date(dbNow.getTime() + offset));
      try {
        const page = await service().list(user, siteId, floorId, { limit: 1 });
        expect(Math.abs(new Date(page.generatedAt).getTime() - dbNow.getTime())).toBeLessThan(10_000);
        expect(Math.abs(new Date(page.retainedFrom).getTime() - cutoff.getTime())).toBeLessThan(10_000);
        const next = await service().list(user, siteId, floorId, { limit: 5, cursor: page.nextCursor! });
        expect(next.items.map(item => item.id)).toContain(fresh.id);
        expect(next.items.map(item => item.id)).not.toContain(expired.id);
      } finally {
        jest.useRealTimers();
      }
    }
  });

  it.each([
    ["2026-01-31T15:04:05.123Z", "2025-10-31T15:04:05.123Z"],
    ["2026-02-28T15:04:05.123Z", "2025-11-28T15:04:05.123Z"],
    ["2026-05-31T15:04:05.123Z", "2026-02-28T15:04:05.123Z"]
  ])("uses the exact UTC DB month-end cutoff at %s under non-UTC sessions", async (nowIso, cutoffIso) => {
    for (const zone of ["UTC", "Asia/Seoul", "America/New_York"]) {
      await db.$executeRawUnsafe(`SET TIME ZONE '${zone}'`);
      const [result] = await db.$queryRaw<Array<{ cutoff: Date; beforeExpired: boolean;
        exactExpired: boolean; afterExpired: boolean }>>`
        WITH clock AS (SELECT ((${new Date(nowIso)}::timestamptz AT TIME ZONE 'UTC')
          - INTERVAL '3 months') AS cutoff)
        SELECT cutoff, cutoff - INTERVAL '1 millisecond' < cutoff AS "beforeExpired",
          cutoff < cutoff AS "exactExpired",
          cutoff + INTERVAL '1 millisecond' < cutoff AS "afterExpired" FROM clock`;
      expect(result).toEqual({ cutoff: new Date(cutoffIso), beforeExpired: true,
        exactExpired: false, afterExpired: false });
    }
    await db.$executeRawUnsafe("SET TIME ZONE 'Asia/Seoul'");
  });

  it("deletes activity with explicit site removal but not Gateway removal while the site remains", async () => {
    const sourceKey = randomUUID();
    const activity = await db.monitoringActivity.create({ data: {
      siteId, floorId, sourceType: "fixture_state", sourceKey,
      kind: "fixture_status_changed", recordedAt: new Date("2026-09-25T01:00:00.000Z")
    } });
    const gateway = await db.gateway.create({ data: { siteId, name: "Gateway", serialNumber: randomUUID(), firmwareVersion: "test" } });
    await db.gateway.delete({ where: { id: gateway.id } });
    expect(await db.monitoringActivity.findUnique({ where: { id: activity.id } })).toMatchObject({ id: activity.id, sourceKey });
    await db.site.delete({ where: { id: siteId } });
    expect(await db.monitoringActivity.count({ where: { id: activity.id } })).toBe(0);
  });
});
