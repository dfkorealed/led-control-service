import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Prisma } from "@prisma/client";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { MonitoringIncidentsService } from "./monitoring-incidents.service";

// This suite deliberately has no external database URL fallback.
(process.env.MONITORING_INCIDENTS_DISPOSABLE_TEST === "1" ? describe : describe.skip)("durable personal alarm dismissal PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let directory: string;
  let prisma: PrismaService;
  let access: SiteAccessService;
  let list: MonitoringIncidentsService;
  let dismissal: { dismiss(user: AuthenticatedUser, site: string, id: string): Promise<any>;
    dismissAll(user: AuthenticatedUser, site: string, input: unknown): Promise<any> };
  let viewer: AuthenticatedUser;
  let other: AuthenticatedUser;
  let foreignAdmin: AuthenticatedUser;
  let siteId: string;
  let otherSite: string;
  let fixtureId: string;
  let otherFixtureId: string;
  const date = new Date("2026-09-01T00:00:00.000Z");
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect(new URL(url).pathname).toMatch(/^\/watermark_\d+$/);
    const data = cluster.sql(url, "SHOW data_directory");
    expect(data.startsWith(join(realpathSync("/tmp"), "gateway-watermark-"))).toBe(true);
    expect(data.endsWith("/data")).toBe(true);
    directory = dirname(data);
    expect(cluster.sql(url, "SELECT current_database() || ':' || inet_server_port()"))
      .toBe(`${new URL(url).pathname.slice(1)}:${new URL(url).port}`);
    expect(cluster.sql(url, "SELECT count(*) FROM pg_tables WHERE schemaname='public'")).toBe("0");
    const deployment = cluster.deploy(url);
    expect(deployment.status).toBe(0);
    console.info("owned migrations", { applied: cluster.sql(url, 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL') });
    prisma = new PrismaService({ datasources: { db: { url } } });
    access = new SiteAccessService(prisma);
    list = new MonitoringIncidentsService(prisma, access, new AuditService(prisma));
  }, 60_000);
  beforeEach(async () => {
    // A missing migration fails an actual SQL contract before loading new code;
    // this also makes the initial RED independent of TS collection errors.
    const [tables] = await prisma.$queryRaw<any[]>`SELECT to_regclass('"MonitoringIncidentDismissal"')::text AS dismissal,
      to_regclass('"MonitoringIncidentDismissalRequest"')::text AS request`;
    expect(tables).toEqual({ dismissal: '"MonitoringIncidentDismissal"', request: '"MonitoringIncidentDismissalRequest"' });
    const { MonitoringIncidentDismissalService } = require("./monitoring-incident-dismissal.service");
    dismissal = new MonitoringIncidentDismissalService(prisma, access);
    const org = await prisma.organization.create({ data: { name: "dismiss test", type: "customer" } });
    async function user(role: "viewer" | "admin"): Promise<AuthenticatedUser> {
      return { ...await prisma.user.create({ data: { organizationId: org.id, role, name: role,
        loginId: `dismiss_${randomUUID()}`, passwordHash: "unused" } }), organizationType: "customer" };
    }
    viewer = await user("viewer"); other = await user("viewer");
    siteId = (await prisma.site.create({ data: { organizationId: org.id, name: "site", adminUserId: (await user("admin")).id } })).id;
    foreignAdmin = await user("admin");
    otherSite = (await prisma.site.create({ data: { organizationId: org.id, name: "other", adminUserId: foreignAdmin.id } })).id;
    for (const actor of [viewer, other])
      await prisma.siteMembership.create({ data: { siteId, userId: actor.id, accessLevel: "read" } });
    const floor = await prisma.floor.create({ data: { siteId, name: "floor", level: 1 } });
    fixtureId = (await prisma.fixture.create({ data: { siteId, floorId: floor.id, name: "fixture", ratedWatt: 20, x: 0, y: 0 } })).id;
    const otherFloor = await prisma.floor.create({ data: { siteId: otherSite, name: "other", level: 1 } });
    otherFixtureId = (await prisma.fixture.create({ data: { siteId: otherSite, floorId: otherFloor.id, name: "other", ratedWatt: 20, x: 0, y: 0 } })).id;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    try { await prisma?.$disconnect(); } finally { cluster?.stop(); }
    if (directory) expect(existsSync(directory)).toBe(false);
    console.info("owned PostgreSQL stopped and removed");
  });
  const incident = (extra: Partial<Prisma.MonitoringIncidentUncheckedCreateInput> = {}, tx = prisma) => tx.monitoringIncident.create({ data: {
    siteId, fixtureId, type: "fixture_stale", targetKey: `fixture:${fixtureId}`, activeKey: null,
    status: "resolved", resolutionKind: "automatic_recovery", resolvedAt: date, openedAt: date, lastObservedAt: date, ...extra
  } });
  const ledger = async (key: string) => (await prisma.$queryRaw<any[]>`SELECT * FROM "MonitoringIncidentDismissalRequest"
    WHERE "siteId"=${siteId} AND "userId"=${viewer.id} AND "clientRequestId"=${key}::uuid`)[0];
  const count = async () => Number((await prisma.$queryRaw<any[]>`SELECT count(*) FROM "MonitoringIncidentDismissal" WHERE "userId"=${viewer.id}`)[0].count);
  // Interpose at the database transaction boundary, after the real commit. No
  // production seam and no simulated effects: every SQL and authorization runs.
  function afterReservation(work: () => Promise<void>) {
    const transaction = prisma.$transaction.bind(prisma);
    let calls = 0;
    jest.spyOn(prisma, "$transaction").mockImplementation((callback: any, options: any) =>
      transaction(callback, options).then(async result => { if (++calls === 1) await work(); return result; }) as any);
  }
  it("dismiss never creates read receipts or changes incident revision", async () => {
    const before = await incident({ status: "open", resolvedAt: null, resolutionKind: null, activeKey: `${siteId}:fixture_stale:fixture:${fixtureId}` });
    const result = await dismissal.dismiss(viewer, siteId, before.id);
    expect(result).toMatchObject({ incidentId: before.id, isDismissed: true });
    expect(await dismissal.dismiss(viewer, siteId, before.id)).toEqual(result);
    expect(await prisma.monitoringIncidentReadReceipt.count({ where: { incidentId: before.id, userId: viewer.id } })).toBe(0);
    expect(await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await list.list(viewer, siteId, { view: "personal" })).toMatchObject({ incidents: [], unreadCount: 0, activeCount: 1 });
    expect(await list.list(viewer, siteId, {})).toMatchObject({ unreadCount: 1, activeCount: 1, incidents: [{ isDismissed: true, isRead: false }] });
    expect(await list.list(other, siteId, { view: "personal" })).toMatchObject({ unreadCount: 1, activeCount: 1, incidents: [{ isDismissed: false }] });
    await prisma.monitoringIncident.update({ where: { id: before.id }, data: { lastObservedAt: new Date() } });
    expect((await list.list(viewer, siteId, { view: "personal" })).incidents).toHaveLength(0);
    const next = await incident();
    expect((await list.list(viewer, siteId, { view: "personal" })).incidents.map(x => x.id)).toEqual([next.id]);
  });
  it("retry after frozen snapshot failure never includes later arrivals", async () => {
    const first = await incident(), key = randomUUID();
    afterReservation(async () => { throw new Error("lost after durable reservation"); });
    await expect(dismissal.dismissAll(viewer, siteId, { clientRequestId: key })).rejects.toThrow("lost after durable reservation");
    const frozen = await ledger(key);
    expect(frozen).toMatchObject({ targetIncidentIds: [first.id], dismissedCount: null, completedAt: null });
    expect(await count()).toBe(0);
    jest.restoreAllMocks();
    const later = await incident();
    const result = await dismissal.dismissAll(viewer, siteId, { clientRequestId: key });
    expect(result).toMatchObject({ dismissedCount: 1, snapshotAt: frozen.snapshotAt.toISOString() });
    expect(await dismissal.dismissAll(viewer, siteId, { clientRequestId: key })).toEqual(result);
    expect((await list.list(viewer, siteId, { view: "personal" })).incidents.map(x => x.id)).toEqual([later.id]);
  });
  it("late committing backdated incident remains visible", async () => {
    const first = await incident(), key = randomUUID();
    let release!: () => void, ready!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const lateId = randomUUID();
    // The producer transaction starts before freeze but inserts/commits later.
    // An already-inserted row would hold Site FK KEY SHARE and delay FOR UPDATE.
    const writer = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1`;
      ready(); await barrier;
      await incident({ id: lateId, openedAt: new Date("2000-01-01T00:00:00Z"), createdAt: new Date("2000-01-01T00:00:00Z") }, tx as PrismaService);
    });
    await entered;
    afterReservation(async () => { release(); await writer; });
    try {
      const result = await dismissal.dismissAll(viewer, siteId, { clientRequestId: key });
      expect(result.dismissedCount).toBe(1);
      expect((await ledger(key)).targetIncidentIds).toEqual([first.id]);
      expect((await list.list(viewer, siteId, { view: "personal" })).incidents.map(x => x.id)).toEqual([lateId]);
    } finally { release(); await writer; }
  });
  it("concurrent duplicate requests reuse one snapshot", async () => {
    const first = await incident(), key = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => dismissal.dismissAll(viewer, siteId, { clientRequestId: key })));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0].dismissedCount).toBe(1);
    expect((await ledger(key)).targetIncidentIds).toEqual([first.id]); expect(await count()).toBe(1);
  });
  it("UUID casing retries replay one canonical stored response", async () => {
    await incident(); const key = randomUUID();
    const first = await dismissal.dismissAll(viewer, siteId, { clientRequestId: key.toUpperCase() });
    expect(first.clientRequestId).toBe(key);
    await incident();
    expect(await dismissal.dismissAll(viewer, siteId, { clientRequestId: key })).toEqual(first);
  });
  it("read and unread dismissals preserve existing receipts and independent counts", async () => {
    const read = await incident(), unread = await incident();
    const receipt = await list.markRead(viewer, siteId, read.id);
    await dismissal.dismiss(viewer, siteId, read.id);
    expect(await list.list(viewer, siteId, { view: "personal" })).toMatchObject({ unreadCount: 1, incidents: [{ id: unread.id, isRead: false }] });
    await dismissal.dismissAll(viewer, siteId, { clientRequestId: randomUUID() });
    expect(await list.list(viewer, siteId, {})).toMatchObject({ unreadCount: 1 });
    expect(await list.markRead(viewer, siteId, read.id)).toEqual(receipt);
    expect(await prisma.monitoringIncidentReadReceipt.count({ where: { userId: viewer.id } })).toBe(1);
  });
  it("revocation between phases leaves durable pending reservation and zero effects", async () => {
    const first = await incident(), key = randomUUID();
    afterReservation(async () => { await prisma.siteMembership.deleteMany({ where: { siteId, userId: viewer.id } }); });
    await expect(dismissal.dismissAll(viewer, siteId, { clientRequestId: key })).rejects.toMatchObject({ status: 404 });
    expect(await ledger(key)).toMatchObject({ targetIncidentIds: [first.id], completedAt: null, dismissedCount: null });
    expect(await count()).toBe(0);
    jest.restoreAllMocks();
    await prisma.siteMembership.create({ data: { siteId, userId: viewer.id, accessLevel: "read" } });
    await incident();
    expect(await dismissal.dismissAll(viewer, siteId, { clientRequestId: key })).toMatchObject({ dismissedCount: 1 });
  });
  it("SQL effect failure rolls back all effects but retains the original durable IDs", async () => {
    const first = await incident(), second = await incident(), key = randomUUID();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION task3_fail_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'task3 effect failure'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER task3_fail_effect BEFORE UPDATE ON "MonitoringIncidentDismissalRequest"
      FOR EACH ROW EXECUTE FUNCTION task3_fail_effect()`);
    try {
      await expect(dismissal.dismissAll(viewer, siteId, { clientRequestId: key })).rejects.toMatchObject({ code: "P2010" });
      expect(await count()).toBe(0);
      expect(await ledger(key)).toMatchObject({ dismissedCount: null, completedAt: null });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER task3_fail_effect ON "MonitoringIncidentDismissalRequest"');
      await prisma.$executeRawUnsafe('DROP FUNCTION task3_fail_effect()');
    }
    const later = await incident();
    expect(await dismissal.dismissAll(viewer, siteId, { clientRequestId: key })).toMatchObject({ dismissedCount: 2 });
    expect((await ledger(key)).targetIncidentIds.sort()).toEqual([first.id, second.id].sort());
    expect((await list.list(viewer, siteId, { view: "personal" })).incidents.map(x => x.id)).toEqual([later.id]);
  });
  it("SQL freeze failure is unaccepted with zero effects and zero reservation", async () => {
    await incident(); const key = randomUUID();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION task3_fail_freeze() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'task3 freeze failure'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER task3_fail_freeze BEFORE INSERT ON "MonitoringIncidentDismissalRequest"
      FOR EACH ROW EXECUTE FUNCTION task3_fail_freeze()`);
    try {
      await expect(dismissal.dismissAll(viewer, siteId, { clientRequestId: key })).rejects.toMatchObject({ code: "P2010" });
      expect(await ledger(key)).toBeUndefined(); expect(await count()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER task3_fail_freeze ON "MonitoringIncidentDismissalRequest"');
      await prisma.$executeRawUnsafe('DROP FUNCTION task3_fail_freeze()');
    }
  });
  it.each(["disabled", "password", "membership"])("reauthorizes persisted %s changes before personal effects", async change => {
    const row = await incident();
    if (change === "membership") await prisma.siteMembership.deleteMany({ where: { userId: viewer.id } });
    else await prisma.user.update({ where: { id: viewer.id }, data: change === "disabled" ? { status: "disabled" } : { mustChangePassword: true } });
    const status = change === "password" ? 403 : 404;
    await expect(dismissal.dismiss(viewer, siteId, row.id)).rejects.toMatchObject({ status });
    await expect(dismissal.dismissAll(viewer, siteId, { clientRequestId: randomUUID() })).rejects.toMatchObject({ status });
    expect(await count()).toBe(0);
  });
  it("overlap and deleted frozen targets preserve actual insert count on replay", async () => {
    const kept = await incident(), deleted = await incident(), key = randomUUID();
    afterReservation(async () => { throw new Error("pause"); });
    await expect(dismissal.dismissAll(viewer, siteId, { clientRequestId: key })).rejects.toThrow("pause");
    jest.restoreAllMocks();
    await prisma.monitoringIncident.delete({ where: { id: deleted.id } });
    const overlappingKey = randomUUID();
    const overlap = await dismissal.dismissAll(viewer, siteId, { clientRequestId: overlappingKey });
    expect(overlap.dismissedCount).toBe(1);
    const result = await dismissal.dismissAll(viewer, siteId, { clientRequestId: key });
    expect(result.dismissedCount).toBe(0);
    await incident();
    expect(await dismissal.dismissAll(viewer, siteId, { clientRequestId: key })).toEqual(result);
    expect(await dismissal.dismissAll(viewer, siteId, { clientRequestId: overlappingKey })).toEqual(overlap);
    expect((await ledger(key)).targetIncidentIds.sort()).toEqual([kept.id, deleted.id].sort());
  });
  it("empty reservation and all pages ignore list filters while isolating site and actor", async () => {
    const empty = randomUUID();
    expect(await dismissal.dismissAll(viewer, siteId, { clientRequestId: empty })).toMatchObject({ dismissedCount: 0 });
    for (let i = 0; i < 27; i++) await incident();
    const foreign = await incident({ siteId: otherSite, fixtureId: otherFixtureId, targetKey: `fixture:${otherFixtureId}` });
    expect((await list.list(viewer, siteId, { limit: 1, status: "open" })).incidents).toHaveLength(0);
    expect(await dismissal.dismissAll(viewer, siteId, { clientRequestId: empty })).toMatchObject({ dismissedCount: 0 });
    expect(await dismissal.dismissAll(viewer, siteId, { clientRequestId: randomUUID() })).toMatchObject({ dismissedCount: 27 });
    expect((await list.list(other, siteId, { view: "personal" })).unreadCount).toBe(27);
    expect((await list.list(foreignAdmin, otherSite, { view: "personal" })).incidents.map(x => x.id)).toEqual([foreign.id]);
    await expect(dismissal.dismiss(viewer, siteId, foreign.id)).rejects.toMatchObject({ status: 404 });
    await expect(dismissal.dismissAll(viewer, otherSite, { clientRequestId: randomUUID() })).rejects.toMatchObject({ status: 404 });
  });
  it.each(["UTC", "Asia/Seoul", "America/New_York"])("stores UTC times and paginates personally in %s sessions", async zone => {
    const transaction = prisma.$transaction.bind(prisma);
    jest.spyOn(prisma, "$transaction").mockImplementation((callback: any, options: any) => transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
      expect((await tx.$queryRaw<any[]>`SELECT current_setting('TimeZone') AS zone`)[0].zone).toBe(zone);
      return callback(tx);
    }, options) as any);
    const first = await incident(), second = await incident(), third = await incident();
    const start = Date.now();
    const single = await dismissal.dismiss(viewer, siteId, first.id);
    const page = await list.list(viewer, siteId, { view: "personal", limit: 1 });
    const last = await list.list(viewer, siteId, { view: "personal", limit: 1, cursor: page.nextCursor });
    expect([page.incidents[0].id, last.incidents[0].id].sort()).toEqual([second.id, third.id].sort());
    expect(last.nextCursor).toBeNull();
    await expect(list.list(other, siteId, { view: "personal", cursor: page.nextCursor })).rejects.toMatchObject({ status: 400 });
    const key = randomUUID(), bulk = await dismissal.dismissAll(viewer, siteId, { clientRequestId: key });
    const request = await ledger(key);
    for (const stamp of [new Date(single.dismissedAt), new Date(bulk.snapshotAt), request.completedAt]) {
      expect(stamp.getTime()).toBeGreaterThanOrEqual(start - 1); expect(stamp.getTime()).toBeLessThanOrEqual(Date.now() + 1);
    }
    expect(request.snapshotAt.toISOString()).toBe(bulk.snapshotAt);
  });
  it("enforces pending/completed shape, nonnull fields, FKs, indexes and parent cascades", async () => {
    const first = await incident();
    await dismissal.dismiss(viewer, siteId, first.id);
    const key = randomUUID(); await dismissal.dismissAll(viewer, siteId, { clientRequestId: key });
    for (const data of [Prisma.sql`"dismissedCount" = NULL, "completedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`,
      Prisma.sql`"dismissedCount" = 0, "completedAt" = NULL`, Prisma.sql`"dismissedCount" = -1`,
      Prisma.sql`"snapshotAt" = NULL`, Prisma.sql`"targetIncidentIds" = NULL`]) {
      await expect(prisma.$executeRaw(Prisma.sql`UPDATE "MonitoringIncidentDismissalRequest" SET ${data}
        WHERE "clientRequestId"=${key}::uuid`)).rejects.toMatchObject({ code: "P2010" });
    }
    const fks = await prisma.$queryRaw<any[]>`SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent,
      confdeltype FROM pg_constraint WHERE conrelid IN ('"MonitoringIncidentDismissal"'::regclass, '"MonitoringIncidentDismissalRequest"'::regclass) AND contype='f'`;
    expect(fks).toHaveLength(4); expect(fks.every(row => row.confdeltype === "c")).toBe(true);
    expect(fks.map(row => row.parent).sort()).toEqual(['"MonitoringIncident"', '"Site"', '"User"', '"User"']);
    const indexes = await prisma.$queryRaw<any[]>`SELECT indexdef FROM pg_indexes WHERE indexname IN
      ('MonitoringIncidentDismissal_userId_idx', 'MonitoringIncidentDismissalRequest_userId_idx')`;
    expect(indexes).toHaveLength(2); expect(indexes.every(row => row.indexdef.includes('("userId")'))).toBe(true);
    await expect(prisma.$executeRaw`INSERT INTO "MonitoringIncidentDismissal" ("incidentId","userId") VALUES (${randomUUID()},${viewer.id})`).rejects.toMatchObject({ code: "P2010" });
    await prisma.monitoringIncident.delete({ where: { id: first.id } }); expect(await count()).toBe(0);
    expect(await ledger(key)).toBeDefined();
    await dismissal.dismiss(viewer, siteId, (await incident()).id); expect(await count()).toBe(1);
    await prisma.user.delete({ where: { id: viewer.id } });
    expect(await count()).toBe(0); expect(await ledger(key)).toBeUndefined();
    const otherKey = randomUUID(); await dismissal.dismissAll(other, siteId, { clientRequestId: otherKey });
    await prisma.site.delete({ where: { id: siteId } });
    expect((await prisma.$queryRaw<any[]>`SELECT count(*) FROM "MonitoringIncidentDismissalRequest" WHERE "siteId"=${siteId}`)[0].count).toBe(0n);
  });
});
