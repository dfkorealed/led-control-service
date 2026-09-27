import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { MonitoringIncidentReconcilerService } from "../monitoring-incidents/monitoring-incident-reconciler.service";
import { PrismaService } from "../prisma/prisma.service";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { FixtureFreshnessService } from "./fixture-freshness.service";

const runDisposable = process.env.FIXTURE_FRESHNESS_SCALE_DISPOSABLE_POSTGRES === "1";
(runDisposable ? describe : describe.skip)("fixture freshness large-site PostgreSQL transition", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>> | undefined;
  let prisma: PrismaService;
  const now = new Date("2026-09-12T00:10:00.000Z");

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl).status).toBe(0);
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl } } });
  }, 60_000);

  afterAll(async () => { await prisma?.$disconnect(); cluster?.stop(); });

  it("atomically transitions 6001 fixtures within the five-second site budget and projects only online-to-offline once", async () => {
    const org = await prisma.organization.create({ data: { name: "scale disposable", type: "customer" } });
    const site = await prisma.site.create({ data: { organizationId: org.id, name: "large site" } });
    const floor = await prisma.floor.create({ data: { siteId: site.id, name: "floor", level: 1 } });
    const gateway = await prisma.gateway.create({ data: { siteId: site.id, name: "gateway",
      serialNumber: randomUUID(), firmwareVersion: "test", lastHeartbeatAt: null } });
    // Set-based seed keeps the test focused on sweep cost, not Prisma insert overhead.
    await prisma.$executeRaw(Prisma.sql`
      WITH nodes AS (
        INSERT INTO "MeshNode" ("id", "gatewayId", "meshAddress", "firmwareVersion", "updatedAt")
        SELECT gen_random_uuid()::text, ${gateway.id}, n::text, 'test', ${now}
        FROM generate_series(1, 6001) AS n
        RETURNING "id", "meshAddress"
      )
      INSERT INTO "Fixture" ("id", "siteId", "floorId", "gatewayId", "meshNodeId", "name",
        "ratedWatt", "x", "y", "status", "statusReason", "reportedStatus", "reportedStatusReason", "lastSeenAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${site.id}, ${floor.id}, ${gateway.id}, n."id", n."meshAddress",
        20, 0, 0, CASE WHEN n."meshAddress" = '6000' THEN 'offline'::"FixtureStatus"
          WHEN n."meshAddress" = '6001' THEN 'fault'::"FixtureStatus" ELSE 'online'::"FixtureStatus" END,
        'reported', 'online'::"FixtureStatus", 'reported', ${now}, ${now}
      FROM nodes n
    `);
    const worker = new FixtureFreshnessService(prisma, new MonitoringIncidentReconcilerService());
    const log = jest.spyOn((worker as any).logger, "error").mockImplementation(() => undefined);

    const firstSweep = await worker.markStaleFixtures(now);
    expect(log).not.toHaveBeenCalled();
    expect(firstSweep).toEqual({ gatewayOffline: 6001, fixtureStale: 0 });
    expect(await prisma.fixture.count({ where: { siteId: site.id, status: "offline", statusReason: "gateway_offline" } })).toBe(6001);
    // The preexisting projection also emits fault→offline, but never offline→offline.
    expect(await prisma.monitoringActivity.count({ where: { siteId: site.id, kind: "fixture_offline" } })).toBe(6000);
    expect(await prisma.monitoringActivity.count({ where: { siteId: site.id, displayName: "1" } })).toBe(1);
    expect(await prisma.monitoringIncident.count({ where: { siteId: site.id, type: "gateway_offline", activeKey: { not: null } } })).toBe(1);

    expect(await worker.markStaleFixtures(now)).toEqual({ gatewayOffline: 0, fixtureStale: 0 });
    expect(await prisma.monitoringActivity.count({ where: { siteId: site.id } })).toBe(6000);
    expect(await prisma.monitoringActivity.count({ where: { siteId: site.id, displayName: "1" } })).toBe(1);
  }, 60_000);
});
