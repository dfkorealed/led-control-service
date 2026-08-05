import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
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
        {
          provide: SiteAccessService,
          useValue: {
            assert: jest.fn().mockResolvedValue({ id: ids.siteId, organizationId: ids.organizationId }),
            ...siteAccessOverrides
          }
        },
        { provide: AuditService, useValue: { record: jest.fn() } }
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

describe("FloorEditorService atomic revisions", () => {
  const floorId = "00000000-0000-4000-8000-000000000103";
  const siteId = "00000000-0000-4000-8000-000000000102";
  const fixtureId = "00000000-0000-4000-8000-000000000104";
  const missingFixtureId = "00000000-0000-4000-8000-000000000199";
  const objectId = "00000000-0000-4000-8000-000000000105";
  const deletedObjectId = "00000000-0000-4000-8000-000000000106";
  const user = {
    id: "00000000-0000-4000-8000-000000000101",
    organizationId: "service-provider-1",
    organizationType: "service_provider" as const,
    email: "operator@example.com",
    name: "Operator",
    role: "operator" as const,
    status: "active" as const
  };
  const canonicalFloor = {
    id: floorId,
    siteId,
    name: "B2",
    level: -2,
    mapRevision: 4,
    floorPlan: {
      id: "floor-plan-1",
      floorId,
      imageUrl: "https://assets.example/b2.png",
      sourceType: "image",
      originalFileUrl: null,
      renderedImageUrl: "https://assets.example/b2-rendered.png",
      width: 1200,
      height: 800,
      version: 3
    },
    fixtures: [{
      id: fixtureId,
      name: "B2-L01",
      ratedWatt: "40.00",
      x: 130,
      y: 250,
      size: 24,
      brightness: 80,
      status: "online"
    }],
    mapObjects: [{
      id: objectId,
      floorId,
      type: "rectangle",
      x: 140,
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
      visible: true,
      createdAt: new Date("2026-07-20T00:00:00.000Z")
    }]
  };
  const saveInput = {
    expectedRevision: 3,
    floorPlan: {
      imageUrl: "https://assets.example/b2.png",
      sourceType: "image" as const,
      originalFileUrl: null,
      renderedImageUrl: "https://assets.example/b2-rendered.png",
      width: 1200,
      height: 800
    },
    fixtureUpdates: [{ id: fixtureId, x: 130, y: 250, size: 24 }],
    objectCreates: [{
      type: "text",
      x: 10,
      y: 20,
      width: null,
      height: null,
      rotation: 0,
      points: null,
      text: "입구",
      strokeColor: "#111111",
      fillColor: null,
      strokeWidth: 2,
      fontSize: 18,
      zIndex: 11,
      locked: false,
      visible: true
    }],
    objectUpdates: [{ id: objectId, patch: { x: 140 } }],
    objectDeletes: [deletedObjectId]
  };

  function createTransactionClient(overrides: Record<string, unknown> = {}) {
    const tx: any = {
      floor: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(canonicalFloor)
      },
      floorPlan: {
        upsert: jest.fn().mockResolvedValue(canonicalFloor.floorPlan),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      floorAsset: { count: jest.fn().mockResolvedValue(2) },
      fixture: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve((where.id.in as string[]).filter((id) => id === fixtureId).map((id) => ({ id })))
        ),
        update: jest.fn().mockResolvedValue({ id: fixtureId })
      },
      floorMapObject: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve((where.id.in as string[]).map((id) => ({ id })))
        ),
        create: jest.fn().mockResolvedValue({ id: "created-object-1" }),
        update: jest.fn().mockResolvedValue({ id: objectId }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      floorMapRevision: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "revision-4", ...data })),
        findUnique: jest.fn(),
        findMany: jest.fn()
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) }
    };
    for (const [key, value] of Object.entries(overrides)) {
      tx[key] = { ...tx[key], ...(value as Record<string, unknown>) };
    }
    return tx;
  }

  async function createAtomicService(options: {
    tx?: any;
    siteAccessAssert?: jest.Mock;
    revisionList?: unknown[];
  } = {}) {
    const tx = options.tx ?? createTransactionClient();
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId }) },
      floorMapRevision: {
        findMany: jest.fn().mockResolvedValue(options.revisionList ?? [])
      },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (callback: (client: unknown) => unknown) => callback(tx))
    };
    const siteAccess = {
      assert: options.siteAccessAssert ?? jest.fn().mockResolvedValue({ id: siteId, organizationId: "customer-organization-1" })
    };
    const auditService = new AuditService(prisma);
    const moduleRef = await Test.createTestingModule({
      providers: [
        FloorEditorService,
        { provide: PrismaService, useValue: prisma },
        { provide: SiteAccessService, useValue: siteAccess },
        { provide: AuditService, useValue: auditService }
      ]
    }).compile();
    return { service: moduleRef.get(FloorEditorService) as any, prisma, siteAccess, tx };
  }

  it("rejects a stale save revision without committing normalized rows, revision, or audit", async () => {
    const tx = createTransactionClient({ floor: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } });
    const { service, prisma } = await createAtomicService({ tx });

    await expect(service.saveEditorState(user, floorId, saveInput)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.fixture.update).not.toHaveBeenCalled();
    expect(tx.floorMapObject.create).not.toHaveBeenCalled();
    expect(tx.floorMapRevision.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("saves normalized rows, revision, and audit in one Serializable transaction", async () => {
    const { service, prisma, tx } = await createAtomicService();

    const result = await service.saveEditorState(user, floorId, saveInput);

    expect(result.floor).toMatchObject({ id: floorId, mapRevision: 4 });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
    expect(tx.floor.updateMany).toHaveBeenCalledWith({
      where: { id: floorId, mapRevision: 3 },
      data: { mapRevision: { increment: 1 } }
    });
    expect(tx.fixture.update).toHaveBeenCalledWith({ where: { id: fixtureId }, data: { x: 130, y: 250, size: 24 } });
    expect(tx.floorMapRevision.create).toHaveBeenCalledWith({ data: expect.objectContaining({ floorId, revision: 4 }) });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "customer-organization-1",
        siteId,
        actorId: user.id,
        action: "floor_editor.saved",
        targetType: "floor",
        targetId: floorId,
        outcome: "success"
      })
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    ["fixture", { fixture: { findMany: jest.fn().mockResolvedValue([]) } }],
    ["object", { floorMapObject: { findMany: jest.fn().mockResolvedValue([{ id: objectId }]) } }]
  ])("rejects a %s from another floor before attempting the optimistic mutation", async (_kind, override) => {
    const tx = createTransactionClient(override);
    const { service } = await createAtomicService({ tx });

    await expect(service.saveEditorState(user, floorId, saveInput)).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.floor.updateMany).not.toHaveBeenCalled();
    expect(tx.floorMapRevision.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects non-ready floor plan assets before attempting the optimistic mutation", async () => {
    const tx = createTransactionClient({ floorAsset: { count: jest.fn().mockResolvedValue(1) } });
    const { service } = await createAtomicService({ tx });

    await expect(service.saveEditorState(user, floorId, saveInput)).rejects.toThrow("ready floor assets");

    expect(tx.floor.updateMany).not.toHaveBeenCalled();
    expect(tx.floorPlan.upsert).not.toHaveBeenCalled();
    expect(tx.floorMapRevision.create).not.toHaveBeenCalled();
  });

  it.each([
    ["fixture update IDs", { ...saveInput, fixtureUpdates: [saveInput.fixtureUpdates[0], saveInput.fixtureUpdates[0]] }],
    ["object update IDs", { ...saveInput, objectUpdates: [saveInput.objectUpdates[0], saveInput.objectUpdates[0]] }],
    ["object delete IDs", { ...saveInput, objectDeletes: [deletedObjectId, deletedObjectId] }],
    ["object update/delete IDs", { ...saveInput, objectDeletes: [objectId] }]
  ])("rejects duplicate %s before opening a transaction", async (_label, input) => {
    const { service, prisma } = await createAtomicService();

    await expect(service.saveEditorState(user, floorId, input)).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("stores a deterministic canonical snapshot and SHA-256 regardless of query ordering", async () => {
    const reversedFloor = {
      ...canonicalFloor,
      fixtures: [
        { ...canonicalFloor.fixtures[0], id: missingFixtureId, name: "B2-L02" },
        canonicalFloor.fixtures[0]
      ],
      mapObjects: [
        { ...canonicalFloor.mapObjects[0], id: deletedObjectId, zIndex: 1 },
        canonicalFloor.mapObjects[0]
      ]
    };
    const tx = createTransactionClient({ floor: { findUnique: jest.fn().mockResolvedValue(reversedFloor) } });
    const { service } = await createAtomicService({ tx });

    await service.saveEditorState(user, floorId, saveInput);

    const revisionData = tx.floorMapRevision.create.mock.calls[0][0].data;
    expect(revisionData.snapshot).toEqual({
      floorPlan: {
        imageUrl: "https://assets.example/b2.png",
        sourceType: "image",
        originalFileUrl: null,
        renderedImageUrl: "https://assets.example/b2-rendered.png",
        width: 1200,
        height: 800
      },
      fixtures: [
        { id: fixtureId, name: "B2-L01", ratedWatt: "40.00", x: 130, y: 250, size: 24 },
        { id: missingFixtureId, name: "B2-L02", ratedWatt: "40.00", x: 130, y: 250, size: 24 }
      ],
      objects: [
        {
          id: objectId, type: "rectangle", x: 140, y: 120, width: 240, height: 160, rotation: 0,
          points: null, text: null, strokeColor: "#0b63e5", fillColor: "#f8fafc", strokeWidth: 2,
          fontSize: null, zIndex: 10, locked: false, visible: true
        },
        {
          id: deletedObjectId, type: "rectangle", x: 140, y: 120, width: 240, height: 160, rotation: 0,
          points: null, text: null, strokeColor: "#0b63e5", fillColor: "#f8fafc", strokeWidth: 2,
          fontSize: null, zIndex: 1, locked: false, visible: true
        }
      ]
    });
    expect(revisionData.snapshotSha256).toBe("4bff6853255f4cbe4ed2365792773aff9086e7449a6ac01cae7db55423f832cb");
  });

  it("lists revisions with read access and hides cross-tenant floors before reading revisions", async () => {
    const revisions = [{ id: "revision-4", revision: 4, changedBy: user.id }];
    const { service, prisma, siteAccess } = await createAtomicService({ revisionList: revisions });

    await expect(service.listEditorRevisions(user, floorId)).resolves.toBe(revisions);
    expect(siteAccess.assert).toHaveBeenCalledWith(user, siteId, "read");

    siteAccess.assert.mockRejectedValueOnce(new NotFoundException("site not found"));
    await expect(service.listEditorRevisions(user, floorId)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.floorMapRevision.findMany).toHaveBeenCalledTimes(1);
  });

  it("rejects restore expectedRevision conflicts without partial writes", async () => {
    const tx = createTransactionClient({
      floor: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      floorMapRevision: {
        findUnique: jest.fn().mockResolvedValue({ revision: 1, snapshot: { floorPlan: null, fixtures: [], objects: [] } })
      }
    });
    const { service } = await createAtomicService({ tx });

    await expect(service.restoreEditorRevision(user, floorId, 1, { expectedRevision: 3 }))
      .rejects.toBeInstanceOf(ConflictException);

    expect(tx.floorPlan.deleteMany).not.toHaveBeenCalled();
    expect(tx.floorMapObject.deleteMany).not.toHaveBeenCalled();
    expect(tx.floorMapRevision.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("restores only existing fixtures, reports missing fixtures, and audits in the same transaction", async () => {
    const snapshot = {
      floorPlan: null,
      fixtures: [
        { id: fixtureId, name: "Old L01", ratedWatt: "30.00", x: 10, y: 20, size: 18 },
        { id: missingFixtureId, name: "Removed L02", ratedWatt: "30.00", x: 30, y: 40, size: 18 }
      ],
      objects: canonicalFloor.mapObjects.map(({ floorId: _floorId, createdAt: _createdAt, ...object }) => object)
    };
    const tx = createTransactionClient({
      floorMapRevision: { findUnique: jest.fn().mockResolvedValue({ revision: 1, snapshot }) }
    });
    const { service, prisma } = await createAtomicService({ tx });

    const result = await service.restoreEditorRevision(user, floorId, 1, { expectedRevision: 3 });

    expect(result.skippedFixtureIds).toEqual([missingFixtureId]);
    expect(tx.fixture.update).toHaveBeenCalledTimes(1);
    expect(tx.fixture.update).toHaveBeenCalledWith({
      where: { id: fixtureId },
      data: { name: "Old L01", ratedWatt: "30.00", x: 10, y: 20, size: 18 }
    });
    expect(tx.floorMapRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ floorId, revision: 4, restoredFromRevision: 1 })
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "floor_editor.restored", metadata: expect.objectContaining({ revision: 4, restoredFromRevision: 1 }) })
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    [new NotFoundException("site not found"), NotFoundException],
    [new ForbiddenException("site capability denied"), ForbiddenException]
  ])("does not open a save transaction when site manage access is denied", async (error, expectedType) => {
    const { service, prisma } = await createAtomicService({ siteAccessAssert: jest.fn().mockRejectedValue(error) });

    await expect(service.saveEditorState(user, floorId, saveInput)).rejects.toBeInstanceOf(expectedType);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
