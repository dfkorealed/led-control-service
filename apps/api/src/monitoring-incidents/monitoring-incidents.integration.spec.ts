import { createHash, randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { Prisma, MonitoringIncidentType } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { MonitoringIncidentsService } from "./monitoring-incidents.service";
import { MonitoringIncidentsModule } from "./monitoring-incidents.module";
import { AuthService } from "../auth/auth.service";

const databaseUrl = process.env.MONITORING_INCIDENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("monitoring incident PostgreSQL API behavior", () => {
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

  beforeAll(() => {
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    access = new SiteAccessService(prisma);
    audit = new AuditService(prisma);
    service = new MonitoringIncidentsService(prisma, access, audit);
  });

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
  afterAll(async () => prisma?.$disconnect());

  const createIncident = (type: MonitoringIncidentType = "fixture_stale", extra: Partial<Prisma.MonitoringIncidentUncheckedCreateInput> = {}) => {
    const targetKey = type === "gateway_offline" ? `gateway:${gatewayId}` : `fixture:${fixtureId}`;
    return prisma.monitoringIncident.create({ data: {
      siteId, type, targetKey, fixtureId: type === "gateway_offline" ? null : fixtureId,
      gatewayId: type === "gateway_offline" ? gatewayId : null,
      activeKey: `${siteId}:${type}:${targetKey}`, openedAt, lastObservedAt: openedAt, ...extra
    } });
  };
  const patch = (id: string, updatedAt: Date, action: Record<string, unknown>) => service.update(admin, siteId, id, { expectedUpdatedAt: updatedAt.toISOString(), ...action });

  it("returns Site defaults to read users and applies audited policy changes only for managers", async () => {
    const policy = await service.getPolicy(viewer, siteId);
    expect(policy).toMatchObject({ gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 });
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
    const second = await service.list(viewer, siteId, { limit: "1", cursor: first.nextCursor });
    expect(second.incidents[0]).toMatchObject({ id: older.id, target: { kind: "fixture", id: fixtureId, name: "fixture" }, assignedTo: { id: viewer.id, name: "viewer" } });
    expect(JSON.stringify(second)).not.toMatch(/passwordHash|organizationType|mustChangePassword/);
    const third = await service.list(viewer, siteId, { cursor: second.nextCursor });
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
      ...(type === "command_failed" ? { statusReason: "command_failed" } : {})
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
    const module = await Test.createTestingModule({ imports: [MonitoringIncidentsModule] }).overrideProvider(PrismaService).useValue(prisma).compile();
    const app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    try {
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
    } finally { await app.close(); }
  });
});
