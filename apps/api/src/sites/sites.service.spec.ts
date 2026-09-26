import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { SitesService } from "./sites.service";

describe("SitesService", () => {
  const prisma = {
    site: {
      findFirst: jest.fn()
    },
    fixture: { findMany: jest.fn() }
  };
  const siteAccess = {
    capabilities: jest.fn(),
    listAccessibleSiteIds: jest.fn()
  };
  const user: AuthenticatedUser = {
    id: "user-1",
    organizationId: "organization-1",
    organizationType: "customer",
    loginId: "fixture_user",
    name: "Admin",
    role: "admin",
    mustChangePassword: false,
    status: "active"
  };

  beforeEach(() => {
    jest.clearAllMocks();
    siteAccess.capabilities.mockResolvedValue({ read: true, control: true, manage: true, commission: true });
    siteAccess.listAccessibleSiteIds.mockResolvedValue(["site-1"]);
  });

  it("returns a site dashboard with floors, fixtures, groups, and summary", async () => {
    prisma.site.findFirst.mockResolvedValue({
      id: "site-1",
      name: "Demo Site",
      gatewayOfflineAfterSeconds: 90,
      fixtureStaleAfterSeconds: 1200,
      address: "Seoul",
      tariffKwhRate: "160.00",
      timeZone: "Asia/Seoul",
      organization: { name: "Customer A" },
      gateways: [
        {
          id: "gateway-1",
          name: "Gateway B2",
          serialNumber: "GW-DEMO-001",
          firmwareVersion: "mock-1.0.0",
          lastHeartbeatAt: new Date(),
          meshControlGroups: [
            {
              id: "mesh-floor-1",
              targetType: "floor",
              targetId: "floor-1",
              status: "ready",
              configurationVersion: 3,
              lastError: null
            },
            {
              id: "mesh-group-1",
              targetType: "fixture_group",
              targetId: "group-1",
              status: "failed",
              configurationVersion: 4,
              lastError: "subscription rejected"
            }
          ]
        }
      ],
      floors: [
        {
          id: "floor-1",
          name: "B2",
          level: -2,
          floorPlan: { imageUrl: "/demo.svg", width: 1200, height: 800, version: 1 },
          fixtures: [
            {
              id: "fixture-1",
              name: "L1",
              x: 10,
              y: 20,
              brightness: 70,
              status: "online",
              ratedWatt: "40",
              rssi: -58,
              hopCount: 1,
              commandSuccessRate: 0.98,
              lastSeenAt: new Date("2026-07-01T00:00:00.000Z"),
              meshNode: { gateway: { id: "gateway-1", name: "Gateway B2", lastHeartbeatAt: new Date() } }
            },
            {
              id: "fixture-2",
              name: "L2",
              x: 30,
              y: 40,
              brightness: 0,
              status: "fault",
              ratedWatt: "40",
              rssi: null,
              hopCount: null,
              commandSuccessRate: null,
              lastSeenAt: null,
              meshNode: null
            }
          ]
        }
      ],
      groups: [
        {
          id: "group-1",
          name: "Entrance",
          floorId: "floor-1",
          gatewayId: "gateway-1",
          lifecycleStatus: "active",
          groupFixtures: [{ fixtureId: "fixture-1" }]
        },
        {
          id: "group-retired",
          name: "Old zone",
          floorId: "floor-1",
          gatewayId: "gateway-1",
          lifecycleStatus: "retired",
          groupFixtures: [{ fixtureId: "fixture-2" }]
        },
        {
          id: "group-invalid",
          name: "Legacy invalid",
          floorId: null,
          gatewayId: null,
          lifecycleStatus: "invalid",
          groupFixtures: []
        }
      ]
    });
    prisma.fixture.findMany.mockResolvedValue([
      {
        id: "fixture-1", floorId: "floor-1", name: "L1", x: 10, y: 20, brightness: 70, status: "online",
        reportedStatus: "online", reportedStatusReason: "reported",
        ratedWatt: "40", rssi: -58, hopCount: 1, commandSuccessRate: 0.98,
        lastSeenAt: new Date(),
        lastUnreachableAt: null,
        bioControlMode: "sensor", bioConfiguredBrightness: null, bioRawHighBrightness: 127,
        healthFaultCodes: [], healthLastSeenAt: new Date("2026-07-01T00:00:01.000Z"),
        meshNode: {
          gateway: { id: "gateway-1", name: "Gateway B2", lastHeartbeatAt: new Date() },
          vehicleSensorCapabilityStatus: "supported",
          vehicleSensorCapabilityVerifiedAt: new Date("2026-08-31T00:00:00.000Z")
        }
      },
      {
        id: "fixture-2", floorId: "floor-1", name: "L2", x: 30, y: 40, brightness: 0, status: "online",
        reportedStatus: "online", reportedStatusReason: "reported",
        ratedWatt: "40", rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: null, lastUnreachableAt: null,
        bioControlMode: null, bioConfiguredBrightness: null, bioRawHighBrightness: null, meshNode: null,
        healthFaultCodes: [1], healthLastSeenAt: new Date("2026-07-01T00:00:02.000Z")
      }
    ]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        SitesService,
        { provide: PrismaService, useValue: prisma },
        { provide: SiteAccessService, useValue: siteAccess }
      ]
    }).compile();

    const service = moduleRef.get(SitesService);
    const dashboard = await (service as any).getDashboard(user, "site-1", true);

    expect(siteAccess.capabilities).toHaveBeenCalledWith(user, "site-1");
    expect(dashboard.capabilities).toEqual({ read: true, control: true, manage: true, commission: true });
    expect(dashboard.site).toEqual({
      id: "site-1",
      name: "Demo Site",
      customerName: "Customer A",
      installationStatus: "installed",
      address: "Seoul",
      tariffKwhRate: 160,
      timeZone: "Asia/Seoul"
    });
    expect(dashboard.summary.totalFixtures).toBe(2);
    expect(dashboard.summary.onlineFixtures).toBe(1);
    expect(dashboard.summary.faultFixtures).toBe(1);
    expect(dashboard.floors[0].fixtures[1].status).toBe("fault");
    expect(dashboard.floors[0].fixtures[0].brightness).toBe(70);
    expect(dashboard.floors[0].fixtures[0].rssi).toBe(-58);
    expect(dashboard.floors[0].fixtures[0]).toMatchObject({
      health: { faultCodes: [], observedAt: "2026-07-01T00:00:01.000Z" },
      bioControlMode: "sensor",
      bioConfiguredBrightness: null,
      bioRawHighBrightness: 127,
      gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
      vehicleSensorCapabilityStatus: "supported",
      vehicleSensorCapabilityVerifiedAt: "2026-08-31T00:00:00.000Z",
      controllable: true,
      controlBlockReason: null
    });
    expect(dashboard.floors[0].fixtures[1]).toMatchObject({
      gateway: null,
      controllable: false,
      controlBlockReason: "fixture_unmapped"
    });
    expect(dashboard.gateways[0]).toMatchObject({
      id: "gateway-1",
      serialNumber: "GW-DEMO-001",
      connectionStatus: "online"
    });
    expect(dashboard.floors[0].meshControlGroups).toEqual([{
      gatewayId: "gateway-1",
      status: "ready",
      version: 3,
      error: null
    }]);
    expect(dashboard.groups).toEqual([{
      id: "group-1",
      name: "Entrance",
      floorId: "floor-1",
      gatewayId: "gateway-1",
      lifecycleStatus: "active",
      fixtureCount: 1,
      fixtureIds: ["fixture-1"],
      meshControlGroup: {
        status: "failed",
        version: 4,
        error: "subscription rejected"
      }
    }]);
  });

  it("counts every active floor from registered fixtures even when fixture details are omitted", async () => {
    prisma.site.findFirst.mockResolvedValue({
      id: "site-1", name: "Site", organization: { name: "Customer" },
      address: null, tariffKwhRate: null, timeZone: "Asia/Seoul",
      gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 1200,
      gateways: [], groups: [],
      floors: [
        { id: "f1", name: "B1", level: -1, mapRevision: 9, floorPlan: { sourceType: "none" },
          mapDocument: { activeGeneration: { elementCount: 0 } }, cadScene: null, mapObjects: [] },
        { id: "f2", name: "1F", level: 1, mapRevision: 2, floorPlan: null,
          mapDocument: { activeGeneration: { elementCount: 3 } }, cadScene: null, mapObjects: [] }
      ]
    });
    prisma.fixture.findMany.mockResolvedValue([
      { floorId: "f1", brightness: 20, reportedStatus: "online", reportedStatusReason: "reported",
        lastSeenAt: null, lastUnreachableAt: null, healthFaultCodes: [], healthLastSeenAt: null, meshNode: null },
      { floorId: "f1", brightness: 40, reportedStatus: "fault", reportedStatusReason: "reported",
        lastSeenAt: null, lastUnreachableAt: null, healthFaultCodes: [], healthLastSeenAt: null, meshNode: null },
      { floorId: "f2", brightness: 60, reportedStatus: "offline", reportedStatusReason: "reported",
        lastSeenAt: null, lastUnreachableAt: null, healthFaultCodes: [], healthLastSeenAt: null, meshNode: null }
    ]);

    const dashboard = await new SitesService(prisma as never, siteAccess as never).getDashboardById("site-1", false);
    expect(dashboard.summary).toEqual({ totalFixtures: 3, onlineFixtures: 1, faultFixtures: 1, offlineFixtures: 1, averageBrightness: 40 });
    expect(dashboard.floors.map((floor) => ({ id: floor.id, summary: floor.summary, mapRevision: floor.mapRevision,
      mapConfigured: floor.mapConfigured, fixtureCount: floor.fixtures.length }))).toEqual([
      { id: "f1", summary: { totalFixtures: 2, onlineFixtures: 1, faultFixtures: 1, offlineFixtures: 0 },
        mapRevision: 9, mapConfigured: false, fixtureCount: 0 },
      { id: "f2", summary: { totalFixtures: 1, onlineFixtures: 0, faultFixtures: 0, offlineFixtures: 1 },
        mapRevision: 2, mapConfigured: true, fixtureCount: 0 }
    ]);
    expect(prisma.fixture.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.fixture.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ floorId: true, reportedStatus: true, brightness: true })
    }));
  });

  it("recognizes legacy plan, CAD and visible legacy object without counting an empty map revision", async () => {
    prisma.site.findFirst.mockResolvedValue({
      id: "site-1", name: "Site", organization: { name: "Customer" }, address: null,
      tariffKwhRate: null, timeZone: "Asia/Seoul", gateways: [], groups: [],
      floors: [
        { id: "empty", name: "empty", level: 0, mapRevision: 4, floorPlan: { sourceType: "none" }, mapDocument: null, cadScene: null, mapObjects: [] },
        { id: "plan", name: "plan", level: 1, mapRevision: 1, floorPlan: { sourceType: "image" }, mapDocument: null, cadScene: null, mapObjects: [] },
        { id: "cad", name: "cad", level: 2, mapRevision: 1, floorPlan: null, mapDocument: null, cadScene: { status: "active", primitiveCount: 5 }, mapObjects: [] },
        { id: "object", name: "object", level: 3, mapRevision: 1, floorPlan: null, mapDocument: null, cadScene: null, mapObjects: [{ id: "visible" }] }
      ]
    });
    prisma.fixture.findMany.mockResolvedValue([]);
    const result = await new SitesService(prisma as never, siteAccess as never).getDashboardById("site-1", false);
    expect(result.floors.map((floor) => floor.mapConfigured)).toEqual([false, true, true, true]);
  });

  it("treats a document without an active generation as an unconfigured map", async () => {
    prisma.site.findFirst.mockResolvedValue({
      id: "site-1", name: "Site", organization: { name: "Customer" }, address: null,
      tariffKwhRate: null, timeZone: "Asia/Seoul", gateways: [], groups: [],
      floors: [{
        id: "reset", name: "Reset", level: 0, mapRevision: 4, floorPlan: null,
        mapDocument: { activeGeneration: null }, cadScene: null, mapObjects: []
      }]
    });
    prisma.fixture.findMany.mockResolvedValue([]);

    const result = await new SitesService(prisma as never, siteAccess as never).getDashboardById("site-1", false);
    expect(result.floors[0]).toMatchObject({ mapRevision: 4, mapConfigured: false });
  });

  it("returns the existing empty dashboard shape when the default route has no accessible sites", async () => {
    siteAccess.listAccessibleSiteIds.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        SitesService,
        { provide: PrismaService, useValue: prisma },
        { provide: SiteAccessService, useValue: siteAccess }
      ]
    }).compile();

    const service = moduleRef.get(SitesService);
    const dashboard = await (service as any).getDefaultDashboard(user);

    expect(siteAccess.listAccessibleSiteIds).toHaveBeenCalledWith(user);
    expect(prisma.site.findFirst).not.toHaveBeenCalled();
    expect(dashboard).toEqual({
      generatedAt: expect.any(String),
      monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 1200 },
      site: {
        id: "",
        name: "현장 미등록",
        customerName: "",
        installationStatus: "pending",
        address: null,
        tariffKwhRate: null,
        timeZone: "Asia/Seoul"
      },
      summary: {
        totalFixtures: 0,
        onlineFixtures: 0,
        faultFixtures: 0,
        offlineFixtures: 0,
        averageBrightness: 0
      },
      capabilities: { read: false, control: false, manage: false, commission: false },
      floors: [],
      groups: [],
      gateways: []
    });
  });

  it.each([
    ["assigned admin", { ...user, role: "admin" as const }, { read: true, control: true, manage: true, commission: true }],
    ["read member", { ...user, id: "read-user", role: "viewer" as const }, { read: true, control: false, manage: false, commission: false }],
    ["control member", { ...user, id: "control-user", role: "viewer" as const }, { read: true, control: true, manage: false, commission: false }]
  ])("returns the persisted capability matrix for a %s dashboard", async (_label, actor, capabilities) => {
    siteAccess.capabilities.mockResolvedValueOnce(capabilities);
    const service = new (SitesService as any)(prisma, siteAccess);
    jest.spyOn(service, "getDashboardById").mockResolvedValue({ site: { id: "site-1" } });

    await expect(service.getDashboard(actor, "site-1")).resolves.toEqual({
      site: { id: "site-1" },
      capabilities
    });
    expect(siteAccess.capabilities).toHaveBeenCalledWith(actor, "site-1");
  });

  it("scopes dashboard floors, groups, fixture rows, and aggregate summary to active floors", async () => {
    prisma.site.findFirst.mockResolvedValue({
      id: "site-1",
      name: "Active Site",
      address: "Seoul",
      tariffKwhRate: "160.00",
      timeZone: "Asia/Seoul",
      organization: { name: "Customer A" },
      gateways: [],
      floors: [],
      groups: []
    });
    prisma.fixture.findMany.mockResolvedValue([]);
    const service = new (SitesService as any)(prisma, siteAccess);

    await service.getDashboardById("site-1", true);
    await service.getDashboardById("site-1", false);

    expect(prisma.site.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        floors: expect.objectContaining({ where: { status: "active" } }),
        groups: expect.objectContaining({
          where: { lifecycleStatus: "active", floor: { is: { status: "active" } } }
        })
      })
    }));
    expect(prisma.fixture.findMany.mock.calls[0][0]).toEqual(expect.objectContaining({
      where: { floor: { siteId: "site-1", status: "active" } }
    }));
    expect(prisma.fixture.findMany.mock.calls[1][0]).toEqual(expect.objectContaining({
      where: { floor: { siteId: "site-1", status: "active" } }
    }));
  });

  it("keeps a gateway online when its heartbeat is exactly 90 seconds old", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-11T00:05:00.000Z"));
    const heartbeatAtBoundary = new Date("2026-07-11T00:03:30.000Z");
    const boundaryPrisma: any = {
      site: {
        findFirst: jest.fn().mockResolvedValue({
          id: "site-1",
          name: "Boundary Site",
          gatewayOfflineAfterSeconds: 90,
          fixtureStaleAfterSeconds: 1200,
          address: "Seoul",
          tariffKwhRate: "160.00",
          timeZone: "Asia/Seoul",
          organization: { name: "Customer A" },
          gateways: [{ id: "gateway-1", name: "Gateway B2", serialNumber: "GW-1", firmwareVersion: "1.0", lastHeartbeatAt: heartbeatAtBoundary }],
          floors: [{ id: "floor-1", name: "B2", level: -2, floorPlan: null }],
          groups: []
        })
      },
      fixture: { findMany: jest.fn().mockResolvedValue([]) }
    };
    const service = new (SitesService as any)(boundaryPrisma, { assert: jest.fn() });

    const dashboard = await service.getDashboardById("site-1", true);

    expect(dashboard.gateways[0].connectionStatus).toBe("online");
    jest.useRealTimers();
  });

  it.each([[30_000, "online"], [30_001, "offline"]] as const)(
    "uses the Site policy and one generatedAt for gateway age %s", async (age, connectionStatus) => {
      const now = new Date("2026-09-12T00:10:00.000Z");
      jest.useFakeTimers().setSystemTime(now);
      try {
        const gateway = { id: "g", name: "g", lastHeartbeatAt: new Date(now.getTime() - age) };
        prisma.site.findFirst.mockResolvedValue({
          id: "site-1", organization: { name: "test" }, address: null, tariffKwhRate: null,
          gatewayOfflineAfterSeconds: 30, fixtureStaleAfterSeconds: 60,
          floors: [{ id: "f", floorPlan: null }], groups: [], gateways: [gateway]
        });
        prisma.fixture.findMany.mockResolvedValue([{ id: "light", floorId: "f", status: "online", brightness: 20,
          reportedStatus: "online", reportedStatusReason: "reported", lastSeenAt: now, lastUnreachableAt: null,
          healthFaultCodes: [], healthLastSeenAt: now, meshNode: { gateway } }]);
        const result = await new SitesService(prisma as never, siteAccess as never).getDashboardById("site-1");
        expect(result).toMatchObject({
          generatedAt: "2026-09-12T00:10:00.000Z",
          monitoringPolicy: { gatewayOfflineAfterSeconds: 30, fixtureStaleAfterSeconds: 60 },
          gateways: [{ connectionStatus }],
          floors: [{ fixtures: [{ gateway: { connectionStatus } }] }]
        });
      } finally { jest.useRealTimers(); }
    }
  );

  it("does not reveal an explicitly requested inaccessible site dashboard", async () => {
    siteAccess.capabilities.mockRejectedValue(new NotFoundException("site not found"));
    const service = new (SitesService as any)(prisma, siteAccess);

    await expect(service.getDashboard(user, "other-site")).rejects.toThrow("site not found");
  });

  it("lists only accessible sites with customer and site names", async () => {
    siteAccess.listAccessibleSiteIds.mockResolvedValue(["site-1"]);
    (prisma.site as any).findMany = jest.fn().mockResolvedValue([
      { id: "site-1", name: "Factory A", organization: { name: "Customer A" } }
    ]);
    const service = new (SitesService as any)(prisma, siteAccess);

    await expect(service.listSites(user)).resolves.toEqual([
      { id: "site-1", customerName: "Customer A", name: "Factory A" }
    ]);
  });
});
