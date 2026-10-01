import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Test } from "@nestjs/testing";
import { Prisma, MonitoringIncidentType } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { MonitoringIncidentsService } from "./monitoring-incidents.service";
import { MonitoringIncidentsModule } from "./monitoring-incidents.module";
import { AuthService } from "../auth/auth.service";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { RedisProvider } from "../redis/redis.provider";

const ownedDatabase = process.env.MONITORING_INCIDENTS_DISPOSABLE_TEST === "1";
// Keep the existing CI URL opt-in, but never consume it in self-owned mode.
let databaseUrl = ownedDatabase ? undefined : process.env.MONITORING_INCIDENTS_TEST_DATABASE_URL;
(ownedDatabase || databaseUrl ? describe : describe.skip)("monitoring incident PostgreSQL API behavior", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>> | undefined;
  let ownedDirectory: string | undefined;
  let prisma: PrismaService;
  let access: SiteAccessService;
  let audit: AuditService;
  let service: MonitoringIncidentsService;
  let admin: AuthenticatedUser;
  let viewer: AuthenticatedUser;
  let siteId: string;
  let fixtureId: string;
  let gatewayId: string;
  const openedAt = new Date("2026-09-11T00:00:00.000Z");

  beforeAll(async () => {
    if (ownedDatabase) {
      cluster = await disposablePostgres();
      databaseUrl = cluster.database();
      expect(new URL(databaseUrl).hostname).toBe("127.0.0.1");
      expect(new URL(databaseUrl).pathname).toMatch(/^\/watermark_\d+$/);
      const dataDirectory = cluster.sql(databaseUrl, "SHOW data_directory");
      expect(dataDirectory.startsWith(join(realpathSync("/tmp"), "gateway-watermark-"))).toBe(true);
      expect(dataDirectory.endsWith("/data")).toBe(true);
      ownedDirectory = dirname(dataDirectory);
      expect(cluster.sql(databaseUrl, "SELECT current_database() || ':' || inet_server_port()"))
        .toBe(`${new URL(databaseUrl).pathname.slice(1)}:${new URL(databaseUrl).port}`);
      expect(cluster.sql(databaseUrl, "SELECT count(*) FROM pg_tables WHERE schemaname='public'")).toBe("0");
      // Match the existing CI database's UTC session contract. initdb otherwise
      // inherits the host zone, affecting unchanged raw incident tuple cursors.
      cluster.sql(databaseUrl, `ALTER DATABASE "${new URL(databaseUrl).pathname.slice(1)}" SET timezone TO 'UTC'`);
      const deployment = cluster.deploy(databaseUrl);
      expect(deployment.stderr + deployment.stdout).not.toMatch(/Error:|P30\d\d/);
      expect(deployment.status).toBe(0);
      const cascadeParents = JSON.parse(cluster.sql(databaseUrl, `SELECT json_agg(confrelid::regclass::text ORDER BY confrelid::regclass::text)
        FROM pg_constraint WHERE conrelid='"MonitoringIncidentReadReceipt"'::regclass AND contype='f' AND confdeltype='c'`));
      expect(cascadeParents).toEqual(['"MonitoringIncident"', '"User"']);
      expect(cluster.sql(databaseUrl, `SELECT indexdef FROM pg_indexes WHERE tablename='MonitoringIncidentReadReceipt'
        AND indexname='MonitoringIncidentReadReceipt_userId_idx'`)).toContain('("userId")');
      console.info("Task2 owned PostgreSQL", { dataDirectory, databaseUrl,
        appliedMigrations: cluster.sql(databaseUrl, 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'),
        receiptTable: cluster.sql(databaseUrl, `SELECT to_regclass('"MonitoringIncidentReadReceipt"')`), cascadeParents,
        publicTables: cluster.sql(databaseUrl, "SELECT count(*) FROM pg_tables WHERE schemaname='public'") });
    }
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    access = new SiteAccessService(prisma);
    audit = new AuditService(prisma);
    service = new MonitoringIncidentsService(prisma, access, audit);
  }, 60_000);

  beforeEach(async () => {
    const org = await prisma.organization.create({ data: { name: "P1 test", type: "customer" } });
    const createUser = async (role: "admin" | "viewer"): Promise<AuthenticatedUser> => {
      const user = await prisma.user.create({ data: { organizationId: org.id, role, name: role, loginId: `${role}_${randomUUID()}`, passwordHash: "unused" } });
      return { ...user, organizationType: "customer" };
    };
    admin = await createUser("admin"); viewer = await createUser("viewer");
    const site = await prisma.site.create({ data: { name: "P1 site", organizationId: org.id, adminUserId: admin.id } });
    siteId = site.id;
    await prisma.siteMembership.create({ data: { siteId, userId: viewer.id, accessLevel: "read" } });
    const floor = await prisma.floor.create({ data: { siteId, name: "floor", level: 1 } });
    const gateway = await prisma.gateway.create({ data: { siteId, name: "gateway", serialNumber: randomUUID(), firmwareVersion: "test", lastHeartbeatAt: new Date() } });
    gatewayId = gateway.id;
    const node = await prisma.meshNode.create({ data: { gatewayId, meshAddress: "0100", firmwareVersion: "test" } });
    const fixture = await prisma.fixture.create({ data: { siteId, floorId: floor.id, meshNodeId: node.id, gatewayId, name: "fixture", ratedWatt: 20, x: 0, y: 0, status: "online", lastSeenAt: new Date() } });
    fixtureId = fixture.id;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    try { await prisma?.$disconnect(); }
    finally {
      cluster?.stop();
      if (ownedDirectory) {
        expect(existsSync(ownedDirectory)).toBe(false);
        console.info("Task2 owned PostgreSQL cleanup", { directory: ownedDirectory, exists: false });
      }
    }
  });

  const createIncident = (type: MonitoringIncidentType = "fixture_stale", extra: Partial<Prisma.MonitoringIncidentUncheckedCreateInput> = {}) => {
    const targetKey = type === "gateway_offline" ? `gateway:${gatewayId}` : `fixture:${fixtureId}`;
    return prisma.monitoringIncident.create({ data: {
      siteId, type, targetKey, fixtureId: type === "gateway_offline" ? null : fixtureId,
      gatewayId: type === "gateway_offline" ? gatewayId : null,
      activeKey: `${siteId}:${type}:${targetKey}`, openedAt, lastObservedAt: openedAt, ...extra
    } });
  };
  const patch = (id: string, updatedAt: Date, action: Record<string, unknown>) => service.update(admin, siteId, id, { expectedUpdatedAt: updatedAt.toISOString(), ...action });
  const markRead = (user: AuthenticatedUser, incidentId: string, targetSite = siteId) =>
    service.markRead(user, targetSite, incidentId);
  const receiptCount = async () => (await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) FROM "MonitoringIncidentReadReceipt" WHERE "userId" = ${viewer.id}`)[0].count;

  it("read_receipt_is_actor_scoped_idempotent_and_filter_independent", async () => {
    const incident = await createIncident();
    const resolved = await createIncident("gateway_offline", { status: "resolved", activeKey: null,
      resolvedAt: new Date(), resolutionKind: "automatic_recovery" });
    expect(await service.list(viewer, siteId, { status: "open", limit: 1 }))
      .toMatchObject({ activeCount: 1, unreadCount: 2, incidents: [{ id: incident.id, isRead: false, readAt: null }] });
    expect(await receiptCount()).toBe(0n);
    const first = await markRead(viewer, incident.id);
    expect(first).toEqual({ incidentId: incident.id, isRead: true, readAt: expect.any(String) });
    const duplicate = await markRead(viewer, incident.id);
    expect(duplicate).toEqual(first);
    expect(await service.list(viewer, siteId, { status: "resolved", type: "gateway_offline", limit: 1 }))
      .toMatchObject({ unreadCount: 1, incidents: [{ id: resolved.id, isRead: false, readAt: null }] });
    expect(await service.list(admin, siteId, {})).toMatchObject({ unreadCount: 2 });
    expect((await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: incident.id } })).updatedAt).toEqual(incident.updatedAt);
    // Polling updates the occurrence without resetting either receipt or revision.
    await prisma.$executeRaw`UPDATE "MonitoringIncident" SET "lastObservedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "id" = ${incident.id}`;
    expect(await service.list(viewer, siteId, {}))
      .toMatchObject({ incidents: expect.arrayContaining([expect.objectContaining({ id: incident.id, isRead: true, readAt: first.readAt })]) });
    await prisma.monitoringIncident.update({ where: { id: incident.id }, data: {
      status: "resolved", activeKey: null, resolvedAt: new Date(), resolutionKind: "automatic_recovery"
    } });
    const recurrence = await createIncident();
    expect(await service.list(viewer, siteId, { status: "open", limit: 1 }))
      .toMatchObject({ unreadCount: 2, incidents: [{ id: recurrence.id, isRead: false, readAt: null }] });
    const freshService = new MonitoringIncidentsService(prisma, new SiteAccessService(prisma), audit);
    expect(await freshService.list(viewer, siteId, { status: "resolved" }))
      .toMatchObject({ incidents: expect.arrayContaining([expect.objectContaining({ id: incident.id, isRead: true, readAt: first.readAt })]) });
  });

  it("preserves the first UTC DB readAt for concurrent PUT without touching operational state", async () => {
    const incident = await createIncident();
    const [{ before }] = await prisma.$queryRaw<Array<{ before: Date }>>`SELECT transaction_timestamp() AT TIME ZONE 'UTC' AS before`;
    const results = await Promise.all([markRead(viewer, incident.id), markRead(viewer, incident.id)]);
    expect(results[0]).toEqual(results[1]);
    expect(Date.parse(results[0].readAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(await receiptCount()).toBe(1n);
    expect(await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: incident.id } }))
      .toMatchObject({ status: "open", updatedAt: incident.updatedAt, acknowledgedAt: null, acknowledgedByUserId: null });
    const [{ expression }] = await prisma.$queryRaw<Array<{ expression: string }>>`
      SELECT pg_get_expr(adbin, adrelid) AS expression FROM pg_attrdef
      WHERE adrelid = '"MonitoringIncidentReadReceipt"'::regclass
        AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = '"MonitoringIncidentReadReceipt"'::regclass AND attname = 'readAt')`;
    expect(expression).toContain("CURRENT_TIMESTAMP AT TIME ZONE 'UTC'");
    // Test the DB default under a non-UTC connection too, independently of the
    // application's authorization route and its unchanged UTC cursor contract.
    const adminRead = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Seoul'");
      return tx.monitoringIncidentReadReceipt.create({ data: { incidentId: incident.id, userId: admin.id } });
    });
    const [{ after }] = await prisma.$queryRaw<Array<{ after: Date }>>`SELECT transaction_timestamp() AT TIME ZONE 'UTC' AS after`;
    expect(adminRead.readAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(adminRead.readAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("hides cross-site incidents and missing incidents from a read-only viewer", async () => {
    const otherSite = await prisma.site.create({ data: { organizationId: admin.organizationId, name: "other" } });
    const otherGateway = await prisma.gateway.create({ data: { siteId: otherSite.id, name: "other", serialNumber: randomUUID(), firmwareVersion: "test" } });
    const other = await prisma.monitoringIncident.create({ data: { siteId: otherSite.id, type: "gateway_offline",
      gatewayId: otherGateway.id, targetKey: `gateway:${otherGateway.id}`, activeKey: `${otherSite.id}:gateway_offline:gateway:${otherGateway.id}` } });
    await expect(markRead(viewer, other.id)).rejects.toMatchObject({ status: 404 });
    await expect(markRead(viewer, other.id, otherSite.id)).rejects.toMatchObject({ status: 404 });
    await expect(markRead(viewer, randomUUID())).rejects.toMatchObject({ status: 404 });
    expect(await receiptCount()).toBe(0n);
  });

  it.each(["membership", "disabled", "password", "deleted"])(
    "read_receipt_races_revocation_parent_delete_and_user_delete reauthorizes %s after precheck", async change => {
      const incident = await createIncident();
      const assert = access.assert.bind(access);
      jest.spyOn(access, "assert").mockImplementationOnce(async (...args) => {
        const result = await assert(...args);
        if (change === "membership") await prisma.siteMembership.deleteMany({ where: { userId: viewer.id, siteId } });
        else if (change === "deleted") await prisma.user.delete({ where: { id: viewer.id } });
        else await prisma.user.update({ where: { id: viewer.id }, data: change === "disabled" ? { status: "disabled" } : { mustChangePassword: true } });
        return result;
      });
      await expect(markRead(viewer, incident.id)).rejects.toMatchObject({ status: change === "password" ? 403 : 404 });
      expect(await receiptCount()).toBe(0n);
    });

  it.each(["MonitoringIncident", "User", "Site"])("waits for a preceding %s deletion and inserts no orphan", async table => {
    const incident = await createIncident();
    const competitor = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    const deleted = gate(), release = gate(), attempted = gate();
    const deletion = competitor.$transaction(async tx => {
      if (table === "User") await tx.user.delete({ where: { id: viewer.id } });
      else if (table === "Site") await tx.site.delete({ where: { id: siteId } });
      else await tx.monitoringIncident.delete({ where: { id: incident.id } });
      deleted.release(); await release.promise;
    }, { timeout: 10_000 });
    try {
      await deleted.promise;
      interceptTransaction({ beforeQuery: async sql => { if (sql.includes(`FROM "${table}"`)) attempted.release(); } });
      const reading = markRead(viewer, incident.id).then(value => ({ value }), reason => ({ reason }));
      await Promise.race([reading, attempted.promise]);
      release.release(); await deletion;
      expect(await reading).toMatchObject({ reason: { status: 404 } });
      expect(await receiptCount()).toBe(0n);
    } finally { release.release(); await deletion; await competitor.$disconnect(); }
  });

  it("cascades incident, target, site and User deletion without touching another actor receipt", async () => {
    const incident = await createIncident();
    await markRead(viewer, incident.id); await markRead(admin, incident.id);
    await prisma.user.delete({ where: { id: viewer.id } });
    expect(await receiptCount()).toBe(0n);
    expect((await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "MonitoringIncidentReadReceipt" WHERE "incidentId" = ${incident.id}`)[0].count).toBe(1n);
    await prisma.fixture.delete({ where: { id: fixtureId } });
    expect((await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "MonitoringIncidentReadReceipt" WHERE "incidentId" = ${incident.id}`)[0].count).toBe(0n);
    const siteIncident = await createIncident("gateway_offline"); await markRead(admin, siteIncident.id);
    await prisma.site.delete({ where: { id: siteId } });
    expect((await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "MonitoringIncidentReadReceipt" WHERE "incidentId" = ${siteIncident.id}`)[0].count).toBe(0n);
  });

  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }
  function interceptTransaction(hooks: { beforeQuery?: (sql: string) => Promise<void>; beforeWrite?: () => Promise<void>; beforeReceiptWrite?: () => Promise<void> }) {
    const transaction = prisma.$transaction.bind(prisma);
    jest.spyOn(prisma, "$transaction").mockImplementationOnce((operation: any) => transaction(async (tx) => operation(new Proxy(tx, {
      get(target, key) {
        if (key === "$queryRaw") return async (...args: unknown[]) => {
          await hooks.beforeQuery?.((args[0] as { sql?: string }).sql ?? "");
          return Reflect.apply(target.$queryRaw, target, args);
        };
        if (key === "monitoringIncident") return new Proxy(target.monitoringIncident, {
          get(delegate, method) {
            if (method !== "update") return Reflect.get(delegate, method);
            return async (args: Prisma.MonitoringIncidentUpdateArgs) => { await hooks.beforeWrite?.(); return delegate.update(args); };
          }
        });
        if (key === "monitoringIncidentReadReceipt") return new Proxy(target.monitoringIncidentReadReceipt, {
          get(delegate, method) {
            if (method !== "upsert") return Reflect.get(delegate, method);
            return async (args: Prisma.MonitoringIncidentReadReceiptUpsertArgs) => { await hooks.beforeReceiptWrite?.(); return delegate.upsert(args); };
          }
        });
        return Reflect.get(target, key);
      }
    })), { timeout: 10_000 }));
  }

  it.each(["membership", "password", "incident", "user", "site"])(
    "holds authorization and parent locks until the receipt commit against %s", async change => {
      const incident = await createIncident();
      const competitor = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
      const held = gate(), release = gate();
      interceptTransaction({ beforeReceiptWrite: async () => { held.release(); await release.promise; } });
      const reading = markRead(viewer, incident.id);
      try {
        await held.promise;
        await expect(competitor.$transaction(async tx => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
          if (change === "membership") await tx.siteMembership.deleteMany({ where: { userId: viewer.id, siteId } });
          else if (change === "password") await tx.user.update({ where: { id: viewer.id }, data: { mustChangePassword: true } });
          else if (change === "incident") await tx.monitoringIncident.delete({ where: { id: incident.id } });
          else if (change === "site") await tx.site.delete({ where: { id: siteId } });
          else await tx.user.delete({ where: { id: viewer.id } });
        })).rejects.toThrow(/lock timeout/);
      } finally { release.release(); await competitor.$disconnect(); }
      expect(await reading).toMatchObject({ incidentId: incident.id, isRead: true });
      if (change === "incident") await prisma.monitoringIncident.delete({ where: { id: incident.id } });
      if (change === "user") await prisma.user.delete({ where: { id: viewer.id } });
      if (change === "site") await prisma.site.delete({ where: { id: siteId } });
      expect(await receiptCount()).toBe(["incident", "user", "site"].includes(change) ? 0n : 1n);
    });

  it("waits for a preceding heartbeat commit before checking fixture-stale recovery", async () => {
    const incident = await createIncident();
    await prisma.fixture.update({ where: { id: fixtureId }, data: { lastSeenAt: null } });
    await prisma.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: null } });
    const competitor = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    const heartbeatWritten = gate(); const releaseHeartbeat = gate(); const gatewayAttempted = gate();
    const heartbeat = competitor.$transaction(async (tx) => {
      await tx.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: new Date() } });
      heartbeatWritten.release();
      await releaseHeartbeat.promise;
    }, { timeout: 10_000 });
    try {
      await heartbeatWritten.promise;
      interceptTransaction({ beforeQuery: async (sql) => { if (sql.includes('FROM "Gateway"')) gatewayAttempted.release(); } });
      const resolution = patch(incident.id, incident.updatedAt, { action: "resolve", note: "확인" }).then(
        (value) => ({ status: "fulfilled" as const, value }), (reason: unknown) => ({ status: "rejected" as const, reason })
      );
      // Old code reaches a wrong resolved result; fixed code first waits on the
      // dependency lock. Either event releases the competing transaction safely.
      await Promise.race([resolution, gatewayAttempted.promise]);
      releaseHeartbeat.release();
      await heartbeat;
      expect(await resolution).toMatchObject({ status: "rejected", reason: { response: { code: "INCIDENT_STILL_ACTIVE" } } });
      expect((await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe("open");
    } finally { releaseHeartbeat.release(); await heartbeat; await competitor.$disconnect(); }
  });

  it("holds the heartbeat dependency stable until a recovery write commits", async () => {
    const incident = await createIncident();
    await prisma.fixture.update({ where: { id: fixtureId }, data: { lastSeenAt: null } });
    await prisma.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: null } });
    const competitor = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    const beforeWrite = gate(); const releaseWrite = gate();
    interceptTransaction({ beforeWrite: async () => { beforeWrite.release(); await releaseWrite.promise; } });
    const resolution = patch(incident.id, incident.updatedAt, { action: "resolve", note: "Gateway 장애로 전환" });
    try {
      await beforeWrite.promise;
      await expect(competitor.$transaction(async (tx) => {
        // The timeout tests an actual conflicting row lock without a timed sleep.
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
        await tx.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: new Date() } });
      })).rejects.toThrow(/lock timeout/);
    } finally { releaseWrite.release(); await competitor.$disconnect(); }
    expect(await resolution).toMatchObject({ status: "resolved" });
    await prisma.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: new Date() } });
    expect((await prisma.gateway.findUniqueOrThrow({ where: { id: gatewayId } })).lastHeartbeatAt).not.toBeNull();
  });

  it("allows ingestion Gateway FK key-share while resolution waits for Fixture", async () => {
    const incident = await createIncident();
    const competitor = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    const fixtureLocked = gate(); const fixtureAttempted = gate();
    const ingestion = competitor.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Fixture" WHERE "id" = ${fixtureId} FOR UPDATE`;
      fixtureLocked.release();
      await fixtureAttempted.promise;
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
      // This is the lock mode acquired by ProcessedGatewayEvent's Gateway FK.
      await tx.$queryRaw`SELECT "id" FROM "Gateway" WHERE "id" = ${gatewayId} FOR KEY SHARE`;
      await tx.fixture.update({ where: { id: fixtureId }, data: { lastSeenAt: new Date() } });
    }, { timeout: 10_000 });
    try {
      await fixtureLocked.promise;
      interceptTransaction({ beforeQuery: async (sql) => { if (sql.includes('FROM "Fixture"')) fixtureAttempted.release(); } });
      const resolution = patch(incident.id, incident.updatedAt, { action: "resolve", note: "수신 복구" });
      await ingestion;
      expect(await resolution).toMatchObject({ status: "resolved" });
    } finally { fixtureAttempted.release(); await competitor.$disconnect(); }
  });

  it("rejects a gateway mapping change committed before the Fixture lock", async () => {
    const incident = await createIncident();
    const competitor = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    let detached = false;
    interceptTransaction({ beforeQuery: async (sql) => {
      if (!detached && sql.includes('FROM "Gateway"')) {
        detached = true;
        await competitor.fixture.update({ where: { id: fixtureId }, data: { meshNodeId: null, gatewayId: null } });
      }
    } });
    try {
      await expect(patch(incident.id, incident.updatedAt, { action: "resolve", note: "확인" }))
        .rejects.toMatchObject({ status: 409, response: { code: "INCIDENT_TARGET_CHANGED" } });
      expect((await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe("open");
      expect(await prisma.auditLog.count({ where: { targetId: incident.id } })).toBe(0);
    } finally { await competitor.$disconnect(); }
  });

  it("returns Site defaults to read users and applies audited policy changes only for managers", async () => {
    const policy = await service.getPolicy(viewer, siteId);
    // Current migrations changed the default from the old 180s to 1200s.
    expect(policy).toMatchObject({ gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 1200 });
    const input = { gatewayOfflineAfterSeconds: 30, fixtureStaleAfterSeconds: 3600, expectedUpdatedAt: policy.updatedAt.toISOString() };
    await expect(service.updatePolicy(viewer, siteId, input)).rejects.toMatchObject({ status: 403 });
    const saved = await service.updatePolicy(admin, siteId, input);
    expect(saved).toMatchObject({ gatewayOfflineAfterSeconds: 30, fixtureStaleAfterSeconds: 3600 });
    expect(saved.updatedAt.getTime()).toBeGreaterThan(policy.updatedAt.getTime());
    await expect(service.updatePolicy(admin, siteId, input)).rejects.toMatchObject({ response: { code: "MONITORING_POLICY_CONFLICT" }, status: 409 });
    expect(await prisma.auditLog.count({ where: { siteId, action: "monitoring_policy.updated", actorId: admin.id, outcome: "success" } })).toBe(1);
  });
  it("hides out-of-site resources from reads and writes", async () => {
    const incident = await createIncident();
    const outsider = { ...viewer, id: randomUUID() };
    await expect(service.getPolicy(outsider, siteId)).rejects.toMatchObject({ status: 404 });
    await expect(service.list(outsider, siteId, {})).rejects.toMatchObject({ status: 404 });
    const otherSite = await prisma.site.create({ data: { organizationId: admin.organizationId, name: "other" } });
    await expect(service.update(admin, otherSite.id, incident.id, { action: "acknowledge", expectedUpdatedAt: incident.updatedAt.toISOString() })).rejects.toMatchObject({ status: 404 });
    await expect(patch(randomUUID(), incident.updatedAt, { action: "acknowledge" })).rejects.toMatchObject({ status: 404 });
  });
  it("lists active-first newest with bounded cursor pagination and safe actor/target summaries", async () => {
    const older = await createIncident("fixture_stale", { openedAt: new Date("2026-09-10T00:00:00Z"), assignedToUserId: viewer.id });
    const newer = await createIncident("fixture_fault", { status: "acknowledged", acknowledgedAt: new Date() });
    const resolved = await createIncident("gateway_offline", { status: "resolved", activeKey: null, resolvedAt: new Date(), resolutionKind: "automatic_recovery", openedAt: new Date("2026-09-12T00:00:00Z"), lastObservedAt: new Date("2026-09-12T00:00:00Z") });
    const first = await service.list(viewer, siteId, { limit: "1" });
    expect(first.incidents.map((row: { id: string }) => row.id)).toEqual([newer.id]);
    expect(first.activeCount).toBe(2);
    expect(first.unreadCount).toBe(3);
    await markRead(viewer, newer.id);
    const second = await service.list(viewer, siteId, { limit: "1", cursor: first.nextCursor });
    expect(second.unreadCount).toBe(2);
    expect(second.incidents[0]).toMatchObject({ id: older.id, target: { kind: "fixture", id: fixtureId, name: "fixture" }, assignedTo: { id: viewer.id, name: "viewer" } });
    expect(JSON.stringify(second)).not.toMatch(/passwordHash|organizationType|mustChangePassword/);
    const third = await service.list(viewer, siteId, { cursor: second.nextCursor });
    expect(third.unreadCount).toBe(2);
    expect(third.incidents.map((row: { id: string }) => row.id)).toEqual([resolved.id]);
    expect(third.nextCursor).toBeNull();
    expect((await service.list(viewer, siteId, { type: "fixture_fault", status: "acknowledged" })).incidents.map((row: { id: string }) => row.id)).toEqual([newer.id]);
  });
  it("acknowledges, assigns and unassigns active incidents and retains actors on resolve", async () => {
    const incident = await createIncident();
    const ack = await patch(incident.id, incident.updatedAt, { action: "acknowledge" });
    expect(ack).toMatchObject({ status: "acknowledged", acknowledgedBy: { id: admin.id } });
    await expect(patch(incident.id, ack.updatedAt, { action: "acknowledge" })).rejects.toMatchObject({ status: 409 });
    const assigned = await patch(incident.id, ack.updatedAt, { action: "assign", userId: viewer.id });
    expect(assigned.assignedTo).toMatchObject({ id: viewer.id });
    const unassigned = await patch(incident.id, assigned.updatedAt, { action: "assign", userId: null });
    expect(unassigned.assignedTo).toBeNull();
    const resolved = await patch(incident.id, unassigned.updatedAt, { action: "resolve", note: "정상 수신 확인" });
    expect(resolved).toMatchObject({ status: "resolved", resolutionKind: "operator_confirmed", resolutionNote: "정상 수신 확인", acknowledgedBy: { id: admin.id }, resolvedBy: { id: admin.id } });
    expect((await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: incident.id } })).activeKey).toBeNull();
    await expect(patch(incident.id, resolved.updatedAt, { action: "assign", userId: admin.id })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.auditLog.count({ where: { siteId, targetId: incident.id, outcome: "success" } })).toBe(4);
  });
  it.each(["gateway_offline", "fixture_stale", "fixture_fault", "command_failed"] as const)("rechecks live %s condition before operator resolution", async (type) => {
    const incident = await createIncident(type);
    if (type === "gateway_offline") await prisma.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: null } });
    else await prisma.fixture.update({ where: { id: fixtureId }, data: {
      ...(type === "fixture_stale" ? { lastSeenAt: null } : {}),
      ...(type === "fixture_fault" ? { healthFaultCodes: [1], healthLastSeenAt: new Date() } : {}),
      ...(type === "command_failed" ? { statusReason: "command_failed", reportedStatusReason: "command_failed" } : {})
    } });
    await expect(patch(incident.id, incident.updatedAt, { action: "resolve", note: "확인" })).rejects.toMatchObject({ status: 409, response: { code: "INCIDENT_STILL_ACTIVE" } });
    expect(await prisma.auditLog.count({ where: { targetId: incident.id } })).toBe(0);
  });
  it("rejects disabled and nonmember assignees but accepts the active assigned admin", async () => {
    const incident = await createIncident();
    await prisma.user.update({ where: { id: viewer.id }, data: { status: "disabled" } });
    await expect(patch(incident.id, incident.updatedAt, { action: "assign", userId: viewer.id })).rejects.toMatchObject({ status: 400, response: { code: "INVALID_INCIDENT_ASSIGNEE" } });
    await expect(patch(incident.id, incident.updatedAt, { action: "assign", userId: randomUUID() })).rejects.toMatchObject({ status: 400 });
    expect((await patch(incident.id, incident.updatedAt, { action: "assign", userId: admin.id })).assignedTo).toMatchObject({ id: admin.id });
  });
  it("checks freshness at the time the target lock is acquired, not before waiting", async () => {
    const incident = await createIncident("gateway_offline");
    const startedAt = Date.now();
    await prisma.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: new Date(startedAt - 80_000) } });
    const clock = jest.spyOn(Date, "now").mockReturnValue(startedAt);
    const transaction = prisma.$transaction.bind(prisma);
    // Keep the real database operation; simulate 20 seconds elapsing while its
    // target lock was pending, without a slow and nondeterministic timed sleep.
    jest.spyOn(prisma, "$transaction").mockImplementationOnce((operation: any) => transaction(async (tx) => operation(new Proxy(tx, {
      get(target, key) {
        if (key !== "$queryRaw") return Reflect.get(target, key);
        return async (...args: unknown[]) => {
          const rows = await Reflect.apply(target.$queryRaw, target, args);
          if ((args[0] as { sql?: string }).sql?.includes('FROM "Gateway"')) clock.mockReturnValue(startedAt + 20_000);
          return rows;
        };
      }
    }))));
    await expect(patch(incident.id, incident.updatedAt, { action: "resolve", note: "확인" })).rejects.toMatchObject({ response: { code: "INCIDENT_STILL_ACTIVE" } });
  });
  it("admits exactly one concurrent change using the same revision", async () => {
    const incident = await createIncident();
    const results = await Promise.allSettled([patch(incident.id, incident.updatedAt, { action: "acknowledge" }), patch(incident.id, incident.updatedAt, { action: "assign", userId: viewer.id })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409, response: { code: "INCIDENT_CONFLICT" } } });
    expect(await prisma.auditLog.count({ where: { targetId: incident.id } })).toBe(1);
  });
  it("reauthorizes a removed/disabled caller after the request precheck", async () => {
    const incident = await createIncident();
    const realAssert = access.assert.bind(access);
    jest.spyOn(access, "assert").mockImplementationOnce(async (...args) => {
      const result = await realAssert(...args);
      // The production admin invariant requires removing the assignment before
      // disabling its user; reproduce that legitimate operator workflow.
      await prisma.site.update({ where: { id: siteId }, data: { adminUserId: null } });
      await prisma.user.update({ where: { id: admin.id }, data: { status: "disabled" } });
      return result;
    });
    await expect(patch(incident.id, incident.updatedAt, { action: "acknowledge" })).rejects.toMatchObject({ status: 404 });
    expect((await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe("open");
  });
  it("rolls back state changes when audit insertion fails", async () => {
    const incident = await createIncident();
    jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(patch(incident.id, incident.updatedAt, { action: "acknowledge" })).rejects.toThrow("audit unavailable");
    expect((await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe("open");
  });
  it("enforces active uniqueness, lifecycle, type and tenant constraints", async () => {
    const first = await createIncident();
    await expect(createIncident()).rejects.toMatchObject({ code: "P2002" });
    for (const data of [
      { activeKey: null }, { activeKey: "forged" }, { targetKey: "forged" },
      { gatewayId }, { status: "acknowledged" }, { resolvedAt: new Date() },
      { lastObservedAt: new Date("2020-01-01") }
    ] as Prisma.MonitoringIncidentUpdateInput[]) {
      await expect(prisma.monitoringIncident.update({ where: { id: first.id }, data })).rejects.toThrow();
    }
    const other = await prisma.site.create({ data: { organizationId: admin.organizationId, name: "other" } });
    await expect(createIncident("fixture_fault", { siteId: other.id, activeKey: `${other.id}:fixture_fault:fixture:${fixtureId}` })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.site.update({ where: { id: siteId }, data: { gatewayOfflineAfterSeconds: 29 } })).rejects.toThrow();
    await expect(prisma.site.update({ where: { id: siteId }, data: { fixtureStaleAfterSeconds: 3601 } })).rejects.toThrow();
  });
  it("retains history with null actors after User deletion and cascades target deletion", async () => {
    const incident = await createIncident("fixture_fault", { status: "acknowledged", acknowledgedAt: new Date(), acknowledgedByUserId: viewer.id, assignedToUserId: viewer.id });
    const history = await createIncident("gateway_offline", { status: "resolved", activeKey: null, resolvedAt: new Date(), resolvedByUserId: viewer.id, resolutionKind: "operator_confirmed", resolutionNote: "확인" });
    await prisma.user.delete({ where: { id: viewer.id } });
    expect(await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: incident.id } })).toMatchObject({ status: "acknowledged", acknowledgedByUserId: null, assignedToUserId: null });
    expect(await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: history.id } })).toMatchObject({ status: "resolved", resolvedByUserId: null, resolutionNote: "확인" });
    await prisma.fixture.delete({ where: { id: fixtureId } });
    expect(await prisma.monitoringIncident.count({ where: { id: incident.id } })).toBe(0);
    await prisma.site.delete({ where: { id: siteId } });
    expect(await prisma.monitoringIncident.count({ where: { id: history.id } })).toBe(0);
  });
  it("serves authenticated policy and incident routes with capability enforcement", async () => {
    const module = await Test.createTestingModule({ imports: [MonitoringIncidentsModule] })
      .overrideProvider(PrismaService).useValue(prisma)
      // These routes use the real session DB guard, not Redis login/MFA flows.
      // Do not initialize or connect an ambient Redis for unrelated module hooks.
      .overrideProvider(RedisProvider).useValue({ getClient: () => { throw new Error("Redis is outside incident route test scope"); } }).compile();
    const app = module.createNestApplication();
    try {
      await app.listen(0, "127.0.0.1");
      const base = `${await app.getUrl()}/sites/${siteId}`;
      const cookies = new Map<string, string>();
      for (const user of [admin, viewer]) {
        const token = randomUUID();
        await prisma.session.create({ data: { userId: user.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000) } });
        cookies.set(user.id, `${AuthService.sessionCookieName}=${token}`);
      }
      expect((await fetch(`${base}/monitoring-policy`)).status).toBe(401);
      const response = await fetch(`${base}/monitoring-policy`, { headers: { cookie: cookies.get(viewer.id)! } });
      expect(response.status).toBe(200);
      const policy = await response.json() as { updatedAt: string };
      const body = JSON.stringify({ expectedUpdatedAt: policy.updatedAt, gatewayOfflineAfterSeconds: 60, fixtureStaleAfterSeconds: 120 });
      expect((await fetch(`${base}/monitoring-policy`, { method: "PATCH", headers: { cookie: cookies.get(viewer.id)!, "content-type": "application/json" }, body })).status).toBe(403);
      expect((await fetch(`${base}/monitoring-policy`, { method: "PATCH", headers: { cookie: cookies.get(admin.id)!, "content-type": "application/json" }, body })).status).toBe(200);
      const incident = await createIncident();
      const acknowledged = await fetch(`${base}/monitoring-incidents/${incident.id}`, { method: "PATCH", headers: { cookie: cookies.get(admin.id)!, "content-type": "application/json" }, body: JSON.stringify({ action: "acknowledge", expectedUpdatedAt: incident.updatedAt.toISOString() }) });
      expect(acknowledged.status).toBe(200);
      expect(await acknowledged.json()).toMatchObject({ id: incident.id, status: "acknowledged" });
      const listing = await fetch(`${base}/monitoring-incidents?status=acknowledged&limit=10`, { headers: { cookie: cookies.get(viewer.id)! } });
      expect(listing.status).toBe(200);
      expect(await listing.json()).toMatchObject({ activeCount: 1, incidents: [{ id: incident.id }], nextCursor: null });
      const readUrl = `${base}/monitoring-incidents/${incident.id}/read`;
      expect((await fetch(readUrl, { method: "PUT" })).status).toBe(401);
      const readResponse = await fetch(readUrl, { method: "PUT", headers: { cookie: cookies.get(viewer.id)! } });
      expect(readResponse.status).toBe(200);
      expect(await readResponse.json()).toMatchObject({ incidentId: incident.id, isRead: true, readAt: expect.any(String) });
      const overridden = await fetch(readUrl, { method: "PUT", headers: { cookie: cookies.get(viewer.id)!, "content-type": "application/json" }, body: JSON.stringify({ userId: admin.id }) });
      expect(overridden.status).toBe(400);
      expect((await fetch(`${base}/monitoring-incidents/not-a-uuid/read`, { method: "PUT", headers: { cookie: cookies.get(viewer.id)! } })).status).toBe(400);
      const expired = randomUUID();
      await prisma.session.create({ data: { userId: viewer.id, tokenHash: createHash("sha256").update(expired).digest("hex"), expiresAt: new Date(Date.now() - 1000) } });
      expect((await fetch(readUrl, { method: "PUT", headers: { cookie: `${AuthService.sessionCookieName}=${expired}` } })).status).toBe(401);
      await prisma.user.update({ where: { id: viewer.id }, data: { mustChangePassword: true } });
      expect((await fetch(readUrl, { method: "PUT", headers: { cookie: cookies.get(viewer.id)! } })).status).toBe(403);
    } finally { await app.close(); }
  });
});
