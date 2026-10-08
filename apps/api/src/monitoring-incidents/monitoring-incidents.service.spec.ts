import { MonitoringIncidentsService } from "./monitoring-incidents.service";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../auth/auth.types";

describe("account-scoped incident read receipts", () => {
  const siteId = "11111111-1111-4111-8111-111111111111";
  const incidentId = "22222222-2222-4222-8222-222222222222";
  const user: AuthenticatedUser = { id: "33333333-3333-4333-8333-333333333333", organizationId: "org",
    organizationType: "customer", loginId: "viewer", name: "Viewer", role: "viewer", status: "active", mustChangePassword: false };
  const readAt = new Date("2026-10-02T01:02:03.456Z");
  function setup(options: { member?: boolean; actor?: Partial<AuthenticatedUser>; incident?: boolean } = {}) {
    const receipts = new Map<string, { incidentId: string; userId: string; readAt: Date }>();
    const resolvedId = "44444444-4444-4444-8444-444444444444";
    const row = { id: incidentId, siteId, fixture: { id: "fixture", name: "Light", floorId: "floor" }, gateway: null,
      acknowledgedBy: null, assignedTo: null, resolvedBy: null, activeKey: "hidden", status: "open", openedAt: readAt, resolvedAt: null };
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      $queryRaw: jest.fn(async (sql: { sql: string }) => {
        if (sql.sql.includes('FROM "User"')) return [{ id: user.id }];
        if (sql.sql.includes('FROM "SiteMembership"')) return options.member === false ? [] : [{ id: "membership" }];
        if (sql.sql.includes('FROM "Site"')) return [{ id: siteId }];
        return options.incident === false ? [] : [{ id: incidentId }];
      }),
      site: { findUnique: jest.fn(async () => ({ id: siteId, organizationId: "org", adminUserId: null,
        memberships: options.member === false ? [] : [{ id: "membership", accessLevel: "read" }] })) },
      user: { findUnique: jest.fn(async () => ({ ...user, ...options.actor, organization: { type: "customer" } })) },
      monitoringIncident: {
        findFirst: jest.fn(async () => options.incident === false ? null : row),
        findMany: jest.fn(async () => [row]),
        count: jest.fn(async ({ where }: { where: { readReceipts?: unknown } }) => where.readReceipts
          ? [incidentId, resolvedId].filter(id => !receipts.has(`${id}:${user.id}`)).length : 1)
      },
      monitoringIncidentReadReceipt: {
        upsert: jest.fn(async ({ where }: { where: { incidentId_userId: { incidentId: string; userId: string } } }) => {
          const identity = where.incidentId_userId, key = `${identity.incidentId}:${identity.userId}`;
          if (!receipts.has(key)) receipts.set(key, { ...identity, readAt });
          return receipts.get(key)!;
        }),
        findMany: jest.fn(async ({ where }: { where: { userId: string } }) => [...receipts.values()].filter(row => row.userId === where.userId))
      },
      monitoringIncidentDismissal: { findMany: async () => [] }
    };
    const prisma = { $transaction: async (operation: (tx: unknown) => unknown) => operation(tx), site: tx.site } as unknown as PrismaService;
    const service = new MonitoringIncidentsService(prisma, new SiteAccessService(prisma), {} as AuditService);
    async function mark(actor = user, targetSite = siteId, targetIncident = incidentId) {
      return service.markRead(actor, targetSite, targetIncident);
    }
    return { service, mark, receipts };
  }

  it("read_receipt_is_actor_scoped_idempotent_and_filter_independent", async () => {
    const { mark, service } = setup();
    const before = await service.list(user, siteId, { status: "open", limit: 1 });
    expect(before).toMatchObject({ activeCount: 1, unreadCount: 2, incidents: [{ isRead: false, readAt: null }] });
    expect(await mark()).toEqual({ incidentId, isRead: true, readAt: readAt.toISOString() });
    expect(await mark()).toEqual({ incidentId, isRead: true, readAt: readAt.toISOString() });
    expect(await service.list(user, siteId, { status: "open", type: "fixture_stale", limit: 1 }))
      .toMatchObject({ activeCount: 1, unreadCount: 1, incidents: [{ id: incidentId, isRead: true, readAt: readAt.toISOString() }] });
    expect(await service.list({ ...user, id: "another-reader" }, siteId, {}))
      .toMatchObject({ incidents: [{ isRead: false, readAt: null }] });
  });

  it("allows read-only viewers without an operational mutation revision", async () => {
    expect(await setup().mark()).toEqual({ incidentId, isRead: true, readAt: readAt.toISOString() });
  });
  it.each([{ member: false }, { actor: { status: "disabled" as const } }, { incident: false }])(
    "rejects revoked membership/actor or missing incident before inserting %p", async options => {
      const { mark, receipts } = setup(options);
      await expect(mark()).rejects.toMatchObject({ status: 404 });
      expect(receipts.size).toBe(0);
    });
  it("rejects a persisted password-change requirement", async () => {
    const { mark, receipts } = setup({ actor: { mustChangePassword: true } });
    await expect(mark()).rejects.toMatchObject({ status: 403 });
    expect(receipts.size).toBe(0);
  });
  it.each([["bad-site", incidentId], [siteId, "bad-incident"]])("rejects malformed read path %s/%s", async (site, incident) => {
    const { mark, receipts } = setup();
    await expect(mark(user, site, incident)).rejects.toMatchObject({ status: 400 });
    expect(receipts.size).toBe(0);
  });
});

describe("incident resolution dependency locking", () => {
  const timestamp = new Date("2026-09-11T00:00:00.000Z");
  const user = { id: "admin", role: "admin" } as AuthenticatedUser;
  const current = {
    id: "incident", siteId: "site", type: "fixture_stale", status: "open", fixtureId: "fixture", gatewayId: null,
    openedAt: timestamp, lastObservedAt: timestamp, acknowledgedAt: null, updatedAt: timestamp
  };

  function setup(changeMapping = false) {
    const locks: string[] = [];
    let fixtureReads = 0;
    const fixture = {
      id: "fixture", gatewayId: "gateway", lastSeenAt: null, reportedStatusReason: null,
      healthFaultCodes: [], healthLastSeenAt: null, meshNode: { gateway: { lastHeartbeatAt: null } }
    };
    const tx = {
      $queryRaw: jest.fn(async (query: { sql: string }) => {
        const table = /FROM "(\w+)"/.exec(query.sql)?.[1];
        if (table) locks.push(table);
        if (table === "Gateway") expect(query.sql).toContain("FOR NO KEY UPDATE");
        return [{ id: table === "Gateway" ? "gateway" : table === "Fixture" ? "fixture" : "incident" }];
      }),
      site: { findUnique: jest.fn(async () => ({ id: "site", gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180, updatedAt: timestamp })) },
      fixture: { findFirst: jest.fn(async () => ({ ...fixture, gatewayId: changeMapping && fixtureReads++ > 0 ? "replacement" : "gateway" })) },
      gateway: { findFirst: jest.fn(async () => ({ id: "gateway", lastHeartbeatAt: null })) },
      monitoringIncident: {
        findFirst: jest.fn(async () => current), findFirstOrThrow: jest.fn(async () => current),
        update: jest.fn(async () => ({ ...current, status: "resolved", fixture: { id: "fixture", name: "fixture", floorId: "floor" }, gateway: null }))
      }
    };
    const prisma = { $transaction: async (operation: (tx: unknown) => unknown) => operation(tx) } as unknown as PrismaService;
    const access = {
      assert: async () => ({}),
      assertManageInTransaction: async () => { locks.push("Site"); return { organizationId: "organization" }; }
    } as unknown as SiteAccessService;
    const service = new MonitoringIncidentsService(prisma, access, { record: async () => ({}) } as unknown as AuditService);
    return { locks, service };
  }

  it("locks Gateway before Fixture and Incident while preserving Site-first authorization", async () => {
    const { service, locks } = setup();
    const resolved = await service.update(user, "site", "incident", { action: "resolve", note: "확인", expectedUpdatedAt: timestamp.toISOString() });
    expect(resolved.status).toBe("resolved");
    expect(locks).toEqual(["Site", "Gateway", "Fixture", "MonitoringIncident"]);
  });

  it("rejects a changed gateway mapping rather than locking a new gateway after Fixture", async () => {
    const { service, locks } = setup(true);
    await expect(service.update(user, "site", "incident", { action: "resolve", note: "확인", expectedUpdatedAt: timestamp.toISOString() }))
      .rejects.toMatchObject({ status: 409, response: { code: "INCIDENT_TARGET_CHANGED" } });
    expect(locks.filter((table) => table === "Gateway")).toHaveLength(1);
  });
});
