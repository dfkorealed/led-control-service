import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { SitesService } from "./sites.service";

describe("SitesService", () => {
  const prisma = {
    site: {
      findFirstOrThrow: jest.fn()
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a site dashboard with floors, fixtures, groups, and summary", async () => {
    prisma.site.findFirstOrThrow.mockResolvedValue({
      id: "site-1",
      name: "Demo Site",
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
              lastSeenAt: new Date("2026-07-01T00:00:00.000Z")
            },
            {
              id: "fixture-2",
              name: "L2",
              x: 30,
              y: 40,
              brightness: 0,
              status: "fault",
              ratedWatt: "40",
              lastSeenAt: null
            }
          ]
        }
      ],
      groups: [{ id: "group-1", name: "Entrance", groupFixtures: [{ fixtureId: "fixture-1" }] }]
    });

    const moduleRef = await Test.createTestingModule({
      providers: [SitesService, { provide: PrismaService, useValue: prisma }]
    }).compile();

    const service = moduleRef.get(SitesService);
    const dashboard = await service.getDefaultDashboard();

    expect(dashboard.summary.totalFixtures).toBe(2);
    expect(dashboard.summary.onlineFixtures).toBe(1);
    expect(dashboard.summary.faultFixtures).toBe(1);
    expect(dashboard.floors[0].fixtures[0].brightness).toBe(70);
  });
});
