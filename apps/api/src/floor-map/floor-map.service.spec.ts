import { NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { FloorMapService } from "./floor-map.service";

describe("FloorMapService", () => {
  const siteId = "00000000-0000-4000-8000-000000000002";
  const floorId = "00000000-0000-4000-8000-000000000003";
  const fixtureId = "00000000-0000-4000-8000-000000000004";
  const slotId = "00000000-0000-4000-8000-000000000005";
  const user: AuthenticatedUser = {
    id: "00000000-0000-4000-8000-000000000001",
    organizationId: "org-1",
    organizationType: "customer",
    loginId: "fixture_user",
    name: "Admin",
    role: "admin",
    mustChangePassword: false,
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
          mapObjects: [mapObject],
          fixtures: [
            {
              id: fixtureId,
              name: "B1-L001",
              x: 999,
              y: 998,
              size: 20,
              lightSlot: { id: slotId, x: 320, y: 240 }
            },
            {
              id: "00000000-0000-4000-8000-000000000006",
              name: "B1-L002",
              x: 640,
              y: 420,
              size: 24,
              lightSlot: null
            }
          ]
        })
      }
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: siteId }) };
    const service = new FloorMapService(prisma, siteAccess as never);

    const snapshot = await service.getSnapshot(user, siteId, floorId);

    expect(snapshot).toEqual({
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
        height: 900,
        gridSize: 10
      },
      cadScene: null,
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
      }],
      fixtures: [
        { id: fixtureId, name: "B1-L001", x: 320, y: 240, size: 20 },
        { id: "00000000-0000-4000-8000-000000000006", name: "B1-L002", x: 640, y: 420, size: 24 }
      ]
    });
    expect(snapshot).not.toHaveProperty("lightSlots");
    expect(siteAccess.assert).toHaveBeenCalledWith(user, siteId, "read");
    expect(prisma.floor.findFirst).toHaveBeenCalledWith({
      where: { id: floorId, siteId },
      include: {
        floorPlan: true,
        cadScene: true,
        mapObjects: {
          where: { visible: true },
          orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }]
        },
        fixtures: {
          where: { placementStatus: "placed" },
          orderBy: { id: "asc" },
          select: {
            id: true,
            name: true,
            x: true,
            y: true,
            size: true,
            lightSlot: { select: { id: true, x: true, y: true } }
          }
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
          mapObjects: [],
          fixtures: []
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

  it("reads a persisted CAD floor plan through the map snapshot contract", async () => {
    const sourceImportJobId = "00000000-0000-4000-8000-000000000007";
    const manifestAssetId = "00000000-0000-4000-8000-000000000008";
    const sceneId = "00000000-0000-4000-8000-000000000009";
    const prisma: any = {
      floor: {
        findFirst: jest.fn().mockResolvedValue({
          id: floorId,
          siteId,
          mapRevision: 4,
          floorPlan: {
            imageUrl: "",
            sourceType: "cad",
            originalFileUrl: null,
            renderedImageUrl: null,
            width: 16_384,
            height: 8_192,
            gridSize: 80
          },
          cadScene: {
            id: sceneId,
            version: 2,
            sourceImportJobId,
            width: 16_384,
            height: 8_192,
            tileSize: 512,
            primitiveCount: 30_000,
            tileCount: 64,
            manifestAssetId
          },
          mapObjects: [],
          fixtures: []
        })
      }
    };
    const service = new FloorMapService(prisma, { assert: jest.fn().mockResolvedValue({ id: siteId }) } as never);

    await expect(service.getSnapshot(user, siteId, floorId)).resolves.toMatchObject({
      revision: 4,
      floorPlan: {
        sourceType: "cad",
        imageUrl: "",
        width: 16_384,
        height: 8_192,
        gridSize: 80
      },
      cadScene: {
        id: sceneId,
        version: 2,
        sourceImportJobId,
        width: 16_384,
        height: 8_192,
        tileSize: 512,
        primitiveCount: 30_000,
        tileCount: 64,
        manifestAssetId,
        manifestContentPath: `/floors/${floorId}/import-jobs/${sourceImportJobId}/scene/manifest/content`,
        tileContentPathTemplate: `/floors/${floorId}/import-jobs/${sourceImportJobId}/scene/tiles/{lod}/{tileX}/{tileY}/{part}/content`,
        statePath: `/sites/${siteId}/floors/${floorId}/cad-scene`
      }
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
            mapObjects: [],
            fixtures: []
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
