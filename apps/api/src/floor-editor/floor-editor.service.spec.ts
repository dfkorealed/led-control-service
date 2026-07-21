import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { SiteAccessService } from "../access/site-access.service";
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
  const assignedOperator = {
    id: "operator-1",
    organizationId: "service-provider-1",
    organizationType: "service_provider" as const,
    email: "operator@example.com",
    name: "Operator",
    role: "operator" as const,
    status: "active" as const
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

  async function createService(prismaOverrides = {}, siteAccessOverrides = {}) {
    const prisma: any = {
      floor: {
        findUnique: jest.fn().mockResolvedValue(floor),
        findFirst: jest.fn().mockResolvedValue({ id: ids.floorId, site: { organizationId: ids.organizationId } })
      },
      floorPlan: {
        upsert: jest.fn()
      },
      floorAsset: { count: jest.fn().mockResolvedValue(0) },
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
      providers: [
        FloorEditorService,
        { provide: PrismaService, useValue: prisma },
        { provide: SiteAccessService, useValue: { assert: jest.fn(), ...siteAccessOverrides } }
      ]
    }).compile();

    return { service: moduleRef.get(FloorEditorService), prisma, siteAccess: moduleRef.get(SiteAccessService) };
  }

  it("authorizes assigned service-provider operators to read editor state by site", async () => {
    const { service, siteAccess } = await createService();

    await expect(service.getEditorState(ids.floorId, assignedOperator as never)).resolves.toMatchObject({
      floor: { id: ids.floorId }
    });

    expect(siteAccess.assert).toHaveBeenCalledWith(assignedOperator, ids.siteId, "read");
  });

  it("authorizes fixture updates with manage capability by site", async () => {
    const fixture = { id: ids.fixtureId, floor: { siteId: ids.siteId } };
    const { service, prisma, siteAccess } = await createService({
      fixture: {
        findUnique: jest.fn().mockResolvedValue(fixture),
        update: jest.fn().mockResolvedValue({ ...fixture, x: 100 })
      }
    });

    await service.updateFixture(ids.fixtureId, { x: 100 }, assignedOperator as never);

    expect(siteAccess.assert).toHaveBeenCalledWith(assignedOperator, ids.siteId, "manage");
    expect(prisma.fixture.update).toHaveBeenCalled();
  });

  it("returns floor editor state for the current organization", async () => {
    const { service, prisma } = await createService();

    const result = await service.getEditorState(ids.floorId, assignedOperator);

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
        floorPlan: true,
        fixtures: { orderBy: { name: "asc" } },
        mapObjects: { orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }] }
      }
    });
  });

  it("rejects floor editor state when site access cannot read the floor", async () => {
    const { service } = await createService({
      floor: {
        findUnique: jest.fn().mockResolvedValue({
          ...floor,
          siteId: ids.siteId
        }),
        findFirst: jest.fn()
      }
    }, { assert: jest.fn().mockRejectedValue(new NotFoundException("site not found")) });

    await expect(service.getEditorState(ids.floorId, assignedOperator)).rejects.toThrow("site not found");
  });

  it("rejects data URLs in floor plan persistence", async () => {
    const { service, prisma } = await createService();

    await expect(
      service.updateFloorPlan(ids.floorId, { imageUrl: "data:image/png;base64,AAAA", width: 1200, height: 800 }, assignedOperator)
    ).rejects.toThrow("object storage URL");
    expect(prisma.floorPlan.upsert).not.toHaveBeenCalled();
  });

  it("rejects floor plan URLs that are not ready assets of the floor", async () => {
    const { service, prisma } = await createService();

    await expect(
      service.updateFloorPlan(ids.floorId, { imageUrl: "https://assets.example/other.png", width: 1200, height: 800 }, assignedOperator)
    ).rejects.toThrow("ready floor assets");
    expect(prisma.floorAsset.count).toHaveBeenCalled();
    expect(prisma.floorPlan.upsert).not.toHaveBeenCalled();
  });

  it("updates fixture name, ratedWatt, x, y, and size for the current organization", async () => {
    const fixture = {
      id: ids.fixtureId,
      floor: { siteId: ids.siteId }
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
      assignedOperator
    );

    expect(result).toBe(updatedFixture);
    expect(prisma.fixture.update).toHaveBeenCalledWith({
      where: { id: ids.fixtureId },
      data: { name: "B2-L01-updated", ratedWatt: "55.50", x: 321, y: 654, size: 36 }
    });
  });

  it("rejects fixture updates when site access cannot manage the floor", async () => {
    const { service, prisma } = await createService({
      fixture: {
        findUnique: jest.fn().mockResolvedValue({
          id: ids.fixtureId,
          floor: { siteId: ids.siteId }
        }),
        update: jest.fn()
      }
    }, { assert: jest.fn().mockRejectedValue(new NotFoundException("site not found")) });

    await expect(service.updateFixture(ids.fixtureId, { x: 100 }, assignedOperator)).rejects.toThrow("site not found");
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
      assignedOperator
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
      floor: { siteId: ids.siteId }
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
      assignedOperator
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
      floor: { siteId: ids.siteId }
    };
    const { service, prisma } = await createService({
      floorMapObject: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(object),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue(object)
      }
    });

    await expect(service.deleteObject(ids.objectId, assignedOperator)).resolves.toEqual({ deleted: true });
    expect(prisma.floorMapObject.delete).toHaveBeenCalledWith({ where: { id: ids.objectId } });
  });
});
