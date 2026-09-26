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
    db = new PrismaClient({ datasourceUrl: url });
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
    const activity = await service().list(user, otherSiteId, floorId, { limit: 5 }, new Date());
    expect(activity.items).toHaveLength(1);
  });

  it("stores server recordedAt as UTC even when the transaction session uses Asia/Seoul", async () => {
    const before = new Date();
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Seoul'");
      const zone = await tx.$queryRawUnsafe<Array<{ TimeZone: string }>>("SHOW TIME ZONE");
      expect(zone[0]?.TimeZone).toBe("Asia/Seoul");
      await recordMonitoringActivity(tx, { siteId, floorId, sourceType: "fixture_state",
        sourceKey: randomUUID(), kind: "fixture_offline" });
    });
    const activity = await db.monitoringActivity.findFirstOrThrow({ where: { siteId, floorId } });
    expect(activity.recordedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(activity.recordedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it.each([
    ["2026-01-31T15:04:05.123Z", "2025-10-31T15:04:05.123Z"],
    ["2026-02-28T15:04:05.123Z", "2025-11-28T15:04:05.123Z"],
    ["2026-05-31T15:04:05.123Z", "2026-02-28T15:04:05.123Z"]
  ])("reads the exact UTC month-end boundary for %s under a non-UTC DB session", async (nowIso, cutoffIso) => {
    const now = new Date(nowIso);
    const cutoff = new Date(cutoffIso);
    await db.monitoringActivity.createMany({ data: [
      { siteId, floorId, sourceType: "fixture_state", sourceKey: "before", kind: "fixture_offline",
        recordedAt: new Date(cutoff.getTime() - 1) },
      { siteId, floorId, sourceType: "fixture_state", sourceKey: "exact", kind: "fixture_online", recordedAt: cutoff },
      { siteId, floorId, sourceType: "fixture_state", sourceKey: "newer", kind: "fixture_status_changed",
        recordedAt: new Date(cutoff.getTime() + 1), status: "online" }
    ] });
    const result = await service().list(user, siteId, floorId, { limit: 5 }, now);
    expect(result.retainedFrom).toBe(cutoff.toISOString());
    expect(result.items.map(item => item.kind)).toEqual(["fixture_status_changed", "fixture_online"]);
    expect(JSON.stringify(result)).not.toMatch(/sourceKey|ipAddress|payload|faultCode/);
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
