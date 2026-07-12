import { BadRequestException, NotFoundException } from "@nestjs/common";
import { FixturesService } from "./fixtures.service";

describe("FixturesService", () => {
  it("returns a tenant-scoped cursor page with gateway readiness", async () => {
    const heartbeat = new Date();
    const prisma: any = {
      floor: { findFirst: jest.fn().mockResolvedValue({ id: "floor-1" }) },
      fixture: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "fixture-1",
            name: "L1",
            x: 10,
            y: 20,
            size: 20,
            ratedWatt: "40.00",
            brightness: 70,
            status: "online",
            statusReason: "reported",
            rssi: -60,
            hopCount: 1,
            commandSuccessRate: 0.99,
            lastSeenAt: new Date("2026-07-12T00:00:00.000Z"),
            meshNode: { gateway: { id: "gateway-1", name: "Gateway B2", lastHeartbeatAt: heartbeat } }
          },
          { id: "fixture-2" }
        ])
      }
    };
    const service = new FixturesService(prisma);

    const result = await service.getFloorFixtures("floor-1", "org-1", { limit: 1 });

    expect(prisma.floor.findFirst).toHaveBeenCalledWith({
      where: { id: "floor-1", site: { organizationId: "org-1" } },
      select: { id: true }
    });
    expect(prisma.fixture.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { floorId: "floor-1" }, orderBy: { id: "asc" }, take: 2 })
    );
    expect(result).toMatchObject({
      items: [
        {
          id: "fixture-1",
          gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
          controllable: true,
          controlBlockReason: null
        }
      ],
      nextCursor: "fixture-1"
    });
  });

  it("rejects a floor outside the user's organization", async () => {
    const prisma: any = { floor: { findFirst: jest.fn().mockResolvedValue(null) }, fixture: { findMany: jest.fn() } };

    await expect(new FixturesService(prisma).getFloorFixtures("other-floor", "org-1", {})).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(prisma.fixture.findMany).not.toHaveBeenCalled();
  });

  it.each([0, 201])("rejects invalid page limit %s", async (limit) => {
    const service = new FixturesService({} as never);
    await expect(service.getFloorFixtures("floor-1", "org-1", { limit })).rejects.toBeInstanceOf(BadRequestException);
  });
});
