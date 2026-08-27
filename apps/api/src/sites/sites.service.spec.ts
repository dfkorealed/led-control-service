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
    assert: jest.fn(),
    listAccessibleSiteIds: jest.fn()
  };
  const user: AuthenticatedUser = {
    id: "user-1",
    organizationId: "organization-1",
    organizationType: "customer",
    loginId: "fixture_user",
    name: "Admin",
    role: "admin",
    status: "active"
  };

  beforeEach(() => {
    jest.clearAllMocks();
    siteAccess.assert.mockResolvedValue({ id: "site-1" });
    siteAccess.listAccessibleSiteIds.mockResolvedValue(["site-1"]);
  });

  it("returns a site dashboard with floors, fixtures, groups, and summary", async () => {
    prisma.site.findFirst.mockResolvedValue({
      id: "site-1",
      name: "Demo Site",
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
        ratedWatt: "40", rssi: -58, hopCount: 1, commandSuccessRate: 0.98,
        lastSeenAt: new Date("2026-07-01T00:00:00.000Z"),
        healthFaultCodes: [], healthLastSeenAt: new Date("2026-07-01T00:00:01.000Z"),
        meshNode: { gateway: { id: "gateway-1", name: "Gateway B2", lastHeartbeatAt: new Date() } }
      },
      {
        id: "fixture-2", floorId: "floor-1", name: "L2", x: 30, y: 40, brightness: 0, status: "fault",
        ratedWatt: "40", rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: null, meshNode: null
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

    expect(siteAccess.assert).toHaveBeenCalledWith(user, "site-1", "read");
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
    expect(dashboard.floors[0].fixtures[0].brightness).toBe(70);
    expect(dashboard.floors[0].fixtures[0].rssi).toBe(-58);
    expect(dashboard.floors[0].fixtures[0]).toMatchObject({
      health: { faultCodes: [], observedAt: "2026-07-01T00:00:01.000Z" },
      gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
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
        averageBrightness: 0
      },
      floors: [],
      groups: [],
      gateways: []
    });
  });

  it("keeps a gateway online when its heartbeat is exactly 90 seconds old", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-11T00:05:00.000Z"));
    const heartbeatAtBoundary = new Date("2026-07-11T00:03:30.000Z");
    const boundaryPrisma: any = {
      site: {
        findFirst: jest.fn().mockResolvedValue({
          id: "site-1",
          name: "Boundary Site",
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

  it("does not reveal an explicitly requested inaccessible site dashboard", async () => {
    siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));
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
