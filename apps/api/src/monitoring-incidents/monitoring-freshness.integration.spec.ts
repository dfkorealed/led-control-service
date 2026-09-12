import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { FixtureFreshnessService } from "../fixtures/fixture-freshness.service";
import { MonitoringIncidentsService } from "./monitoring-incidents.service";
import { MonitoringIncidentReconcilerService } from "./monitoring-incident-reconciler.service";

const databaseUrl = process.env.MONITORING_INCIDENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("Site freshness PostgreSQL lifecycle", () => {
  let prisma: PrismaService;
  let worker: FixtureFreshnessService;
  let reconciler: MonitoringIncidentReconcilerService;
  let incidents: MonitoringIncidentsService;
  let admin: AuthenticatedUser;
  let strict: { id: string; gatewayId: string; fixtureId: string; floorId: string };
  let lenient: typeof strict;
  const now = new Date("2026-09-12T00:10:00.000Z");
  const at = (offset: number) => new Date(now.getTime() + offset);
  beforeAll(() => {
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    reconciler = new MonitoringIncidentReconcilerService();
    worker = new (FixtureFreshnessService as any)(prisma, reconciler);
    incidents = new MonitoringIncidentsService(prisma, new SiteAccessService(prisma), new AuditService(prisma));
  });
  beforeEach(async () => {
    const org = await prisma.organization.create({ data: { name: "freshness disposable", type: "customer" } });
    const user = await prisma.user.create({ data: {
      organizationId: org.id, role: "admin", name: "admin", loginId: "p1_" + randomUUID(), passwordHash: "unused"
    } });
    admin = { ...user, organizationType: "customer" };
    const makeSite = async (name: string, gatewayOfflineAfterSeconds: number, fixtureStaleAfterSeconds: number) => {
      const site = await prisma.site.create({ data: {
        organizationId: org.id, name, gatewayOfflineAfterSeconds, fixtureStaleAfterSeconds,
        ...(name === "strict" ? { adminUserId: admin.id } : {})
      } });
      const floor = await prisma.floor.create({ data: { siteId: site.id, name: "floor", level: 1 } });
      const gateway = await prisma.gateway.create({ data: { siteId: site.id, name: "gateway",
        serialNumber: randomUUID(), firmwareVersion: "test", lastHeartbeatAt: now } });
      const node = await prisma.meshNode.create({ data: { gatewayId: gateway.id, meshAddress: "0100", firmwareVersion: "test" } });
      const fixture = await prisma.fixture.create({ data: { siteId: site.id, floorId: floor.id, gatewayId: gateway.id,
        meshNodeId: node.id, name: "light", ratedWatt: 20, x: 0, y: 0, status: "online", statusReason: "reported", lastSeenAt: now } });
      return { id: site.id, gatewayId: gateway.id, fixtureId: fixture.id, floorId: floor.id };
    };
    strict = await makeSite("strict", 30, 60);
    lenient = await makeSite("lenient", 120, 240);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.site.deleteMany({ where: { id: { in: [strict.id, lenient.id] } } });
  });
  afterAll(() => prisma?.$disconnect());
  const fixture = (site = strict) => prisma.fixture.findUniqueOrThrow({ where: { id: site.fixtureId } });
  const active = (site = strict) => prisma.monitoringIncident.findMany({ where: { siteId: site.id, activeKey: { not: null } }, orderBy: { type: "asc" } });
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }
  function interceptSiteQuery(before: (table: string) => void) {
    const transaction = prisma.$transaction.bind(prisma);
    jest.spyOn(prisma, "$transaction").mockImplementation((operation: any) => transaction(async (tx) => operation(new Proxy(tx, {
      get(target, key) {
        if (key === "$queryRaw") return async (sql: Prisma.Sql) => {
          if (sql.values.includes(strict.id)) before(/FROM "(\w+)"/.exec(sql.sql)?.[1] ?? "");
          return target.$queryRaw(sql);
        };
        return Reflect.get(target, key);
      }
    })), { timeout: 10_000 }));
  }

  it("keeps exact policy boundaries fresh, expires +1ms, and moves gateway-offline to fixture-stale on heartbeat recovery", async () => {
    for (const site of [strict, lenient]) {
      await prisma.gateway.update({ where: { id: site.gatewayId }, data: { lastHeartbeatAt: at(-30_000) } });
      await prisma.fixture.update({ where: { id: site.fixtureId }, data: { lastSeenAt: at(-60_000) } });
    }
    await worker.markStaleFixtures(now);
    expect(await fixture()).toMatchObject({ status: "online", statusReason: "reported" });
    expect(await active()).toHaveLength(0);
    await worker.markStaleFixtures(at(1));
    expect(await fixture()).toMatchObject({ status: "offline", statusReason: "gateway_offline" });
    expect(await fixture(lenient)).toMatchObject({ status: "online", statusReason: "reported" });
    expect(await active()).toMatchObject([{ type: "gateway_offline", gatewayId: strict.gatewayId }]);
    expect(await active(lenient)).toHaveLength(0);
    await prisma.gateway.update({ where: { id: strict.gatewayId }, data: { lastHeartbeatAt: at(2) } });
    await worker.markStaleFixtures(at(2));
    expect(await fixture()).toMatchObject({ status: "offline", statusReason: "fixture_stale" });
    expect(await active()).toMatchObject([{ type: "fixture_stale", fixtureId: strict.fixtureId }]);
    expect(await prisma.monitoringIncident.findFirst({ where: { siteId: strict.id, type: "gateway_offline" } }))
      .toMatchObject({ status: "resolved", activeKey: null, resolutionKind: "automatic_recovery" });
  });

  it("preserves acknowledgement, assignee and revision while observing, resolves recovery, and creates a new occurrence", async () => {
    await prisma.fixture.update({ where: { id: strict.fixtureId }, data: { lastSeenAt: at(-60_001) } });
    await worker.markStaleFixtures(now);
    expect(await active()).toHaveLength(1);
    const opened = (await active())[0];
    const acknowledged = await incidents.update(admin, strict.id, opened.id, { action: "acknowledge", expectedUpdatedAt: opened.updatedAt.toISOString() });
    const assigned = await incidents.update(admin, strict.id, opened.id, { action: "assign", userId: admin.id, expectedUpdatedAt: acknowledged.updatedAt.toISOString() });
    await worker.markStaleFixtures(at(1000));
    const observed = (await active())[0];
    expect(observed).toMatchObject({ id: opened.id, status: "acknowledged", assignedToUserId: admin.id,
      acknowledgedByUserId: admin.id, acknowledgedAt: assigned.acknowledgedAt, updatedAt: assigned.updatedAt,
      lastObservedAt: at(1000) });
    await prisma.fixture.update({ where: { id: strict.fixtureId }, data: { lastSeenAt: at(2000), status: "online", statusReason: "reported" } });
    await worker.markStaleFixtures(at(2000));
    expect(await active()).toHaveLength(0);
    const resolved = await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: opened.id } });
    expect(resolved).toMatchObject({ status: "resolved", activeKey: null, resolutionKind: "automatic_recovery",
      resolvedByUserId: null, assignedToUserId: admin.id, acknowledgedByUserId: admin.id });
    expect(resolved.updatedAt.getTime()).toBeGreaterThan(assigned.updatedAt.getTime());
    await prisma.gateway.update({ where: { id: strict.gatewayId }, data: { lastHeartbeatAt: at(70_000) } });
    await worker.markStaleFixtures(at(70_000));
    expect(await active()).toMatchObject([{ status: "open", type: "fixture_stale", acknowledgedAt: null, assignedToUserId: null }]);
    expect((await active())[0].id).not.toBe(opened.id);
    expect(await prisma.monitoringIncident.count({ where: { siteId: strict.id, type: "fixture_stale" } })).toBe(2);
  });

  it("observes Health and command failures independently, excludes waiting/unmapped stale, and clears recovered conditions", async () => {
    await prisma.fixture.update({ where: { id: strict.fixtureId }, data: {
      healthFaultCodes: [1], healthLastSeenAt: now, statusReason: "command_failed"
    } });
    const waitingNode = await prisma.meshNode.create({ data: { gatewayId: strict.gatewayId, meshAddress: "0101", firmwareVersion: "test" } });
    const waiting = await prisma.fixture.create({ data: { siteId: strict.id, floorId: strict.floorId,
      gatewayId: strict.gatewayId, meshNodeId: waitingNode.id,
      name: "waiting", ratedWatt: 20, x: 0, y: 0, status: "offline", statusReason: "provisioning_waiting_state" } });
    await prisma.fixture.create({ data: { siteId: strict.id, floorId: strict.floorId, name: "unmapped",
      ratedWatt: 20, x: 0, y: 0, status: "offline", lastSeenAt: null } });
    await worker.markStaleFixtures(now);
    expect(await active()).toMatchObject([{ type: "fixture_fault", fixtureId: strict.fixtureId }, { type: "command_failed", fixtureId: strict.fixtureId }]);
    expect(await prisma.fixture.findUnique({ where: { id: waiting.id } })).toMatchObject({ statusReason: "provisioning_waiting_state" });
    await prisma.fixture.update({ where: { id: strict.fixtureId }, data: {
      healthFaultCodes: [], healthLastSeenAt: at(1), statusReason: "reported"
    } });
    await worker.markStaleFixtures(at(1));
    expect(await active()).toHaveLength(0);
    expect(await prisma.monitoringIncident.count({ where: { siteId: strict.id, status: "resolved", resolutionKind: "automatic_recovery" } })).toBe(2);
    await prisma.gateway.update({ where: { id: strict.gatewayId }, data: { lastHeartbeatAt: null } });
    await worker.markStaleFixtures(at(2));
    expect(await active()).toMatchObject([{ type: "gateway_offline", gatewayId: strict.gatewayId }]);
    expect(await prisma.fixture.findUnique({ where: { id: waiting.id } })).toMatchObject({ statusReason: "provisioning_waiting_state" });
  });

  it("serializes two worker instances and a manual acknowledgement without duplicate active incidents or lost revision", async () => {
    await prisma.fixture.update({ where: { id: strict.fixtureId }, data: { lastSeenAt: null } });
    const second = new (FixtureFreshnessService as any)(prisma, reconciler) as FixtureFreshnessService;
    await Promise.all([worker.markStaleFixtures(now), second.markStaleFixtures(now)]);
    expect(await active()).toHaveLength(1);
    const opened = (await active())[0];
    const [, acknowledged] = await Promise.all([
      second.markStaleFixtures(at(1)),
      incidents.update(admin, strict.id, opened.id, { action: "acknowledge", expectedUpdatedAt: opened.updatedAt.toISOString() })
    ]);
    expect(await active()).toMatchObject([{ id: opened.id, status: "acknowledged", updatedAt: acknowledged.updatedAt,
      acknowledgedByUserId: admin.id, lastObservedAt: at(1) }]);
  });

  it("rolls back Site state changes if reconciliation fails", async () => {
    await prisma.gateway.update({ where: { id: strict.gatewayId }, data: { lastHeartbeatAt: null } });
    const reconcile = reconciler.reconcile.bind(reconciler);
    jest.spyOn(reconciler, "reconcile").mockImplementation((tx, site, time) => {
      if (site.id === strict.id) throw new Error("incident unavailable");
      return reconcile(tx, site, time);
    });
    await expect(worker.markStaleFixtures(now)).rejects.toThrow("incident unavailable");
    expect(await fixture()).toMatchObject({ status: "online", statusReason: "reported" });
    expect(await active()).toHaveLength(0);
  });

  it("applies each Site fixture threshold at exactly the boundary and one millisecond beyond", async () => {
    await prisma.fixture.update({ where: { id: strict.fixtureId }, data: { lastSeenAt: at(-60_000) } });
    await prisma.fixture.update({ where: { id: lenient.fixtureId }, data: { lastSeenAt: at(-240_000) } });
    await worker.markStaleFixtures(now);
    expect(await active()).toHaveLength(0);
    expect(await active(lenient)).toHaveLength(0);
    await worker.markStaleFixtures(at(1));
    expect(await fixture()).toMatchObject({ statusReason: "fixture_stale" });
    expect(await fixture(lenient)).toMatchObject({ statusReason: "fixture_stale" });
    expect(await active()).toMatchObject([{ type: "fixture_stale" }]);
    expect(await active(lenient)).toMatchObject([{ type: "fixture_stale" }]);
    // A delayed older observation cannot move lastObservedAt backwards.
    await worker.markStaleFixtures(at(2));
    await worker.markStaleFixtures(at(1));
    expect((await active())[0].lastObservedAt).toEqual(at(2));
  });

  it("waits for a preceding heartbeat commit before choosing gateway or fixture incident", async () => {
    await prisma.fixture.update({ where: { id: strict.fixtureId }, data: { lastSeenAt: null } });
    await prisma.gateway.update({ where: { id: strict.gatewayId }, data: { lastHeartbeatAt: null } });
    const competitor = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    const heartbeatWritten = gate(); const releaseHeartbeat = gate(); const gatewayAttempted = gate();
    const heartbeat = competitor.$transaction(async (tx) => {
      await tx.gateway.update({ where: { id: strict.gatewayId }, data: { lastHeartbeatAt: now } });
      heartbeatWritten.release();
      await releaseHeartbeat.promise;
    }, { timeout: 10_000 });
    try {
      await heartbeatWritten.promise;
      interceptSiteQuery((table) => { if (table === "Gateway") gatewayAttempted.release(); });
      const sweep = worker.markStaleFixtures(now);
      await Promise.race([sweep, gatewayAttempted.promise]);
      releaseHeartbeat.release();
      await heartbeat;
      await sweep;
      expect(await fixture()).toMatchObject({ statusReason: "fixture_stale" });
      expect(await active()).toMatchObject([{ type: "fixture_stale" }]);
    } finally { releaseHeartbeat.release(); await heartbeat; await competitor.$disconnect(); }
  });

  it("allows ingestion Gateway FK key-share while waiting for Fixture and reads the committed state", async () => {
    await prisma.fixture.update({ where: { id: strict.fixtureId }, data: { lastSeenAt: null } });
    const competitor = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    const fixtureLocked = gate(); const fixtureAttempted = gate();
    const ingestion = competitor.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Fixture" WHERE "id" = ${strict.fixtureId} FOR UPDATE`;
      fixtureLocked.release();
      await fixtureAttempted.promise;
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
      await tx.$queryRaw`SELECT "id" FROM "Gateway" WHERE "id" = ${strict.gatewayId} FOR KEY SHARE`;
      await tx.fixture.update({ where: { id: strict.fixtureId }, data: { lastSeenAt: now, status: "online", statusReason: "reported" } });
    }, { timeout: 10_000 });
    try {
      await fixtureLocked.promise;
      interceptSiteQuery((table) => { if (table === "Fixture") fixtureAttempted.release(); });
      const sweep = worker.markStaleFixtures(now);
      await ingestion;
      await sweep;
      expect(await active()).toHaveLength(0);
      expect(await fixture()).toMatchObject({ status: "online", statusReason: "reported" });
    } finally { fixtureAttempted.release(); await competitor.$disconnect(); }
  });

  it("holds heartbeat state through reconciliation commit while another Site remains writable", async () => {
    await prisma.fixture.update({ where: { id: strict.fixtureId }, data: { lastSeenAt: null } });
    const competitor = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    const beforeIncident = gate(); const releaseIncident = gate();
    const reconcile = reconciler.reconcile.bind(reconciler);
    jest.spyOn(reconciler, "reconcile").mockImplementation(async (tx, site, time) => {
      if (site.id === strict.id) { beforeIncident.release(); await releaseIncident.promise; }
      return reconcile(tx, site, time);
    });
    const sweep = worker.markStaleFixtures(now);
    try {
      await beforeIncident.promise;
      await expect(competitor.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
        await tx.gateway.update({ where: { id: strict.gatewayId }, data: { lastHeartbeatAt: null } });
      })).rejects.toThrow(/lock timeout/);
      await competitor.gateway.update({ where: { id: lenient.gatewayId }, data: { lastHeartbeatAt: now } });
    } finally { releaseIncident.release(); await sweep; await competitor.$disconnect(); }
    expect(await active()).toMatchObject([{ type: "fixture_stale" }]);
  });
});
