import { NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { FloorMapService } from "./floor-map.service";

describe("FloorMapService", () => {
  const siteId = "00000000-0000-4000-8000-000000000002";
  const floorId = "00000000-0000-4000-8000-000000000003";
  const user: AuthenticatedUser = {
    id: "00000000-0000-4000-8000-000000000001",
    organizationId: "org-1",
    organizationType: "customer",
    loginId: "fixture_user",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    status: "active"
  };
  const mapObject = {
    id: "object-1",
    floorId,
    type: "rectangle",
    x: 10,
    y: 20,
    width: 30,
    height: 40,
    rotation: 0,
    points: null,
    text: null,
    strokeColor: "#111111",
    fillColor: null,
    strokeWidth: 2,
    fontSize: null,
    zIndex: 1,
    locked: false,
    visible: true,
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
    updatedAt: new Date("2026-08-19T00:00:00.000Z")
  };

  it("returns an accessible floor snapshot with only the read model fields", async () => {
    const prisma: any = {
      floor: {
        findFirst: jest.fn().mockResolvedValue({
          id: floorId,
          siteId,
          mapRevision: 3,
          floorPlan: {
            imageUrl: "/assets/floor.png",
            sourceType: "image",
            originalFileUrl: null,
            renderedImageUrl: null,
            width: 1600,
            height: 900
          },
          mapObjects: [mapObject]
        })
      }
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: siteId }) };
    const service = new FloorMapService(prisma, siteAccess as never);

    await expect(service.getSnapshot(user, siteId, floorId)).resolves.toEqual({
      floorId,
      revision: 3,
      width: 1600,
      height: 900,
      floorPlan: {
        imageUrl: "/assets/floor.png",
        sourceType: "image",
        originalFileUrl: null,
        renderedImageUrl: null,
        width: 1600,
        height: 900
      },
      objects: [{
        id: "object-1",
        type: "rectangle",
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        rotation: 0,
        points: null,
        text: null,
        strokeColor: "#111111",
        fillColor: null,
        strokeWidth: 2,
        fontSize: null,
        zIndex: 1,
        locked: false,
        visible: true
      }]
    });
    expect(siteAccess.assert).toHaveBeenCalledWith(user, siteId, "read");
    expect(prisma.floor.findFirst).toHaveBeenCalledWith({
      where: { id: floorId, siteId },
      include: {
        floorPlan: true,
        mapObjects: {
          where: { visible: true },
          orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }]
        }
      }
    });
  });

  it("uses the default canvas size when no floor plan is registered", async () => {
    const prisma: any = {
      floor: {
        findFirst: jest.fn().mockResolvedValue({
          id: floorId,
          siteId,
          mapRevision: 0,
          floorPlan: null,
          mapObjects: []
        })
      }
    };
    const service = new FloorMapService(prisma, { assert: jest.fn() } as never);

    await expect(service.getSnapshot(user, siteId, floorId)).resolves.toMatchObject({
      floorId,
      width: 1200,
      height: 800,
      floorPlan: null
    });
  });

  it("returns the same opaque 404 for absent and inaccessible floors", async () => {
    const absent = new FloorMapService(
      { floor: { findFirst: jest.fn().mockResolvedValue(null) } } as never,
      { assert: jest.fn() } as never
    );
    const inaccessible = new FloorMapService(
      {
        floor: {
          findFirst: jest.fn().mockResolvedValue({
            id: floorId,
            siteId,
            mapRevision: 0,
            floorPlan: null,
            mapObjects: []
          })
        }
      } as never,
      { assert: jest.fn().mockRejectedValue(new NotFoundException("site not found")) } as never
    );

    const absentError = await absent.getSnapshot(user, siteId, floorId).catch((error: unknown) => error) as NotFoundException;
    const inaccessibleError = await inaccessible.getSnapshot(user, siteId, floorId).catch((error: unknown) => error) as NotFoundException;

    expect(absentError).toBeInstanceOf(NotFoundException);
    expect(inaccessibleError).toBeInstanceOf(NotFoundException);
    expect(inaccessibleError.getResponse()).toEqual(absentError.getResponse());
  });
});
