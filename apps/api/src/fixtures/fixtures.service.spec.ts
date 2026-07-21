import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { FixturesService } from "./fixtures.service";

describe("FixturesService", () => {
  const user: AuthenticatedUser = {
    id: "user-1", organizationId: "org-1", organizationType: "customer", email: "admin@example.com", name: "Admin", role: "admin", status: "active"
  };

  it("returns an accessible site cursor page with gateway readiness", async () => {
    const heartbeat = new Date();
    const prisma: any = {
      floor: {
        findFirst: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" })
      },
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
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new (FixturesService as any)(prisma, siteAccess);

    const result = await service.getFloorFixtures(user, "floor-1", { limit: 1 });

    expect(siteAccess.assert).toHaveBeenCalledWith(user, "site-1", "read");
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

  it("does not reveal a floor in another tenant", async () => {
    const prisma: any = {
      floor: {
        findFirst: jest.fn().mockResolvedValue({ id: "other-floor", siteId: "other-site" }),
        findUnique: jest.fn().mockResolvedValue({ id: "other-floor", siteId: "other-site" })
      },
      fixture: { findMany: jest.fn() }
    };
    const siteAccess = { assert: jest.fn().mockRejectedValue(new NotFoundException("site not found")) };

    await expect(new (FixturesService as any)(prisma, siteAccess).getFloorFixtures(user, "other-floor", {})).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(prisma.fixture.findMany).not.toHaveBeenCalled();
  });

  it.each([0, 201])("rejects invalid page limit %s", async (limit) => {
    const service = new FixturesService({} as never, {} as never);
    await expect((service as any).getFloorFixtures(user, "floor-1", { limit })).rejects.toBeInstanceOf(BadRequestException);
  });
});
