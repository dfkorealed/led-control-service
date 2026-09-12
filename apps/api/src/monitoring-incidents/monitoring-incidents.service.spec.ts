import { MonitoringIncidentsService } from "./monitoring-incidents.service";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../auth/auth.types";

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
      id: "fixture", gatewayId: "gateway", lastSeenAt: null, statusReason: null,
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
