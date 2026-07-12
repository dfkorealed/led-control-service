import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { SitesService } from "./sites.service";

describe("SitesService", () => {
  const prisma = {
    site: {
      findFirst: jest.fn()
    },
    fixture: { findMany: jest.fn() }
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a site dashboard with floors, fixtures, groups, and summary", async () => {
    prisma.site.findFirst.mockResolvedValue({
      id: "site-1",
      name: "Demo Site",
      gateways: [
        {
          id: "gateway-1",
          name: "Gateway B2",
          serialNumber: "GW-DEMO-001",
          firmwareVersion: "mock-1.0.0",
          lastHeartbeatAt: new Date()
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
      groups: [{ id: "group-1", name: "Entrance", groupFixtures: [{ fixtureId: "fixture-1" }] }]
    });
    prisma.fixture.findMany.mockResolvedValue([
      {
        id: "fixture-1", floorId: "floor-1", name: "L1", x: 10, y: 20, brightness: 70, status: "online",
        ratedWatt: "40", rssi: -58, hopCount: 1, commandSuccessRate: 0.98,
        lastSeenAt: new Date("2026-07-01T00:00:00.000Z"),
        meshNode: { gateway: { id: "gateway-1", name: "Gateway B2", lastHeartbeatAt: new Date() } }
      },
      {
        id: "fixture-2", floorId: "floor-1", name: "L2", x: 30, y: 40, brightness: 0, status: "fault",
        ratedWatt: "40", rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: null, meshNode: null
      }
    ]);

    const moduleRef = await Test.createTestingModule({
      providers: [SitesService, { provide: PrismaService, useValue: prisma }]
    }).compile();

    const service = moduleRef.get(SitesService);
    const dashboard = await service.getDefaultDashboard("organization-1");

    expect(prisma.site.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "organization-1" } })
    );
    expect(dashboard.summary.totalFixtures).toBe(2);
    expect(dashboard.summary.onlineFixtures).toBe(1);
    expect(dashboard.summary.faultFixtures).toBe(1);
    expect(dashboard.floors[0].fixtures[0].brightness).toBe(70);
    expect(dashboard.floors[0].fixtures[0].rssi).toBe(-58);
    expect(dashboard.floors[0].fixtures[0]).toMatchObject({
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
  });

  it("returns an empty dashboard when the organization has no site yet", async () => {
    prisma.site.findFirst.mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      providers: [SitesService, { provide: PrismaService, useValue: prisma }]
    }).compile();

    const service = moduleRef.get(SitesService);
    const dashboard = await service.getDefaultDashboard("organization-1");

    expect(dashboard).toEqual({
      site: { id: "", name: "현장 미등록" },
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
});
