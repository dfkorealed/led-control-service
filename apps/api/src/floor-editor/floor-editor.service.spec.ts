import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { FloorEditorService } from "./floor-editor.service";

describe("FloorEditorService", () => {
  const ids = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    otherOrganizationId: "99999999-9999-4999-8999-999999999999",
    siteId: "00000000-0000-4000-8000-000000000002",
    floorId: "00000000-0000-4000-8000-000000000003",
    fixtureId: "00000000-0000-4000-8000-000000000004",
    objectId: "00000000-0000-4000-8000-000000000005"
  };

  const floor = {
    id: ids.floorId,
    siteId: ids.siteId,
    name: "B2",
    level: -2,
    site: { organizationId: ids.organizationId },
    floorPlan: {
      id: "floor-plan-1",
      floorId: ids.floorId,
      imageUrl: "/floor/b2.png",
      sourceType: "image",
      originalFileUrl: "/uploads/b2.pdf",
      renderedImageUrl: "/renders/b2.png",
      width: 1200,
      height: 800,
      version: 2
    },
    fixtures: [
      {
        id: ids.fixtureId,
        name: "B2-L01",
        ratedWatt: "40.00",
        x: 120,
        y: 240,
        status: "online",
        brightness: 80
      }
    ],
    mapObjects: [
      {
        id: ids.objectId,
        floorId: ids.floorId,
        type: "rectangle",
        x: 100,
        y: 120,
        width: 240,
        height: 160,
        rotation: 0,
        points: null,
        text: null,
        strokeColor: "#0b63e5",
        fillColor: "#f8fafc",
        strokeWidth: 2,
        fontSize: null,
        zIndex: 10,
        locked: false,
        visible: true
      }
    ]
  };

  async function createService(prismaOverrides = {}) {
    const prisma: any = {
      floor: {
        findUnique: jest.fn().mockResolvedValue(floor),
        findFirst: jest.fn().mockResolvedValue({ id: ids.floorId, site: { organizationId: ids.organizationId } })
      },
      floorPlan: {
        upsert: jest.fn()
      },
      fixture: {
        findUnique: jest.fn(),
        update: jest.fn()
      },
      floorMapObject: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn()
      },
      ...prismaOverrides
    };

    const moduleRef = await Test.createTestingModule({
      providers: [FloorEditorService, { provide: PrismaService, useValue: prisma }]
    }).compile();

    return { service: moduleRef.get(FloorEditorService), prisma };
  }

  it("returns floor editor state for the current organization", async () => {
    const { service, prisma } = await createService();

    const result = await service.getEditorState(ids.floorId, ids.organizationId);

    expect(result.floor).toMatchObject({
      id: ids.floorId,
      siteId: ids.siteId,
      name: "B2",
      level: -2
    });
    expect(result.floor.floorPlan).toMatchObject({
      sourceType: "image",
      originalFileUrl: "/uploads/b2.pdf",
      renderedImageUrl: "/renders/b2.png"
    });
    expect(result.fixtures).toHaveLength(1);
    expect(result.fixtures[0].ratedWatt).toBe(40);
    expect(result.objects).toHaveLength(1);
    expect(prisma.floor.findUnique).toHaveBeenCalledWith({
      where: { id: ids.floorId },
      include: {
        site: { select: { organizationId: true } },
        floorPlan: true,
        fixtures: { orderBy: { name: "asc" } },
        mapObjects: { orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }] }
      }
    });
  });

  it("rejects floor editor state from another organization", async () => {
    const { service } = await createService({
      floor: {
        findUnique: jest.fn().mockResolvedValue({
          ...floor,
          site: { organizationId: ids.otherOrganizationId }
        }),
        findFirst: jest.fn()
      }
    });

    await expect(service.getEditorState(ids.floorId, ids.organizationId)).rejects.toThrow("floor not found");
  });

  it("updates fixture name, ratedWatt, x, y, and size for the current organization", async () => {
    const fixture = {
      id: ids.fixtureId,
      floor: { site: { organizationId: ids.organizationId } }
    };
    const updatedFixture = {
      id: ids.fixtureId,
      name: "B2-L01-updated",
      ratedWatt: "55.50",
      x: 321,
      y: 654,
      size: 36
    };
    const { service, prisma } = await createService({
      fixture: {
        findUnique: jest.fn().mockResolvedValue(fixture),
        update: jest.fn().mockResolvedValue(updatedFixture)
      }
    });

    const result = await service.updateFixture(
      ids.fixtureId,
      { name: " B2-L01-updated ", ratedWatt: 55.5, x: 321, y: 654, size: 36 },
      ids.organizationId
    );

    expect(result).toBe(updatedFixture);
    expect(prisma.fixture.update).toHaveBeenCalledWith({
      where: { id: ids.fixtureId },
      data: { name: "B2-L01-updated", ratedWatt: "55.50", x: 321, y: 654, size: 36 }
    });
  });

  it("rejects fixture updates from another organization", async () => {
    const { service, prisma } = await createService({
      fixture: {
        findUnique: jest.fn().mockResolvedValue({
          id: ids.fixtureId,
          floor: { site: { organizationId: ids.otherOrganizationId } }
        }),
        update: jest.fn()
      }
    });

    await expect(service.updateFixture(ids.fixtureId, { x: 100 }, ids.organizationId)).rejects.toThrow(
      "fixture not found"
    );
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("creates a rectangle object in a current organization floor", async () => {
    const createdObject = {
      id: ids.objectId,
      floorId: ids.floorId,
      type: "rectangle",
      x: 10,
      y: 20,
      width: 300,
      height: 120,
      rotation: 15,
      points: [{ x: 10, y: 20 }],
      text: null,
      strokeColor: "#0f172a",
      fillColor: "#f8fafc",
      strokeWidth: 3,
      fontSize: null,
      zIndex: 4,
      locked: false,
      visible: true
    };
    const { service, prisma } = await createService({
      floorMapObject: {
        create: jest.fn().mockResolvedValue(createdObject),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn()
      }
    });

    const result = await service.createObject(
      {
        floorId: ids.floorId,
        type: "rectangle",
        x: 10,
        y: 20,
        width: 300,
        height: 120,
        rotation: 15,
        points: [{ x: 10, y: 20 }],
        strokeColor: "#0f172a",
        fillColor: "#f8fafc",
        strokeWidth: 3,
        zIndex: 4,
        locked: false,
        visible: true
      },
      ids.organizationId
    );

    expect(result).toBe(createdObject);
    expect(prisma.floorMapObject.create).toHaveBeenCalledWith({
      data: {
        floorId: ids.floorId,
        type: "rectangle",
        x: 10,
        y: 20,
        width: 300,
        height: 120,
        rotation: 15,
        points: [{ x: 10, y: 20 }],
        text: null,
        strokeColor: "#0f172a",
        fillColor: "#f8fafc",
        strokeWidth: 3,
        fontSize: null,
        zIndex: 4,
        locked: false,
        visible: true
      }
    });
  });

  it("updates a text object in the current organization", async () => {
    const object = {
      id: ids.objectId,
      type: "text",
      floor: { site: { organizationId: ids.organizationId } }
    };
    const updatedObject = {
      id: ids.objectId,
      type: "text",
      text: "입구",
      x: 80,
      y: 90,
      fontSize: 18,
      zIndex: 20,
      visible: false
    };
    const { service, prisma } = await createService({
      floorMapObject: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(object),
        update: jest.fn().mockResolvedValue(updatedObject),
        delete: jest.fn()
      }
    });

    const result = await service.updateObject(
      ids.objectId,
      { text: "입구", x: 80, y: 90, fontSize: 18, zIndex: 20, visible: false },
      ids.organizationId
    );

    expect(result).toBe(updatedObject);
    expect(prisma.floorMapObject.update).toHaveBeenCalledWith({
      where: { id: ids.objectId },
      data: { x: 80, y: 90, text: "입구", fontSize: 18, zIndex: 20, visible: false }
    });
  });

  it("deletes an object in the current organization", async () => {
    const object = {
      id: ids.objectId,
      floor: { site: { organizationId: ids.organizationId } }
    };
    const { service, prisma } = await createService({
      floorMapObject: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(object),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue(object)
      }
    });

    await expect(service.deleteObject(ids.objectId, ids.organizationId)).resolves.toEqual({ deleted: true });
    expect(prisma.floorMapObject.delete).toHaveBeenCalledWith({ where: { id: ids.objectId } });
  });
});
