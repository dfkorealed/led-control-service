import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { FloorEditorService } from "./floor-editor.service";
import { hashEditorLeaseToken } from "./editor-lease-token";

describe("FloorEditorService", () => {
  const ids = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    siteId: "00000000-0000-4000-8000-000000000002",
    floorId: "00000000-0000-4000-8000-000000000003"
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

  async function createService(prismaOverrides: Record<string, unknown> = {}) {
    const prisma: any = {
      floor: {
        findUnique: jest.fn().mockResolvedValue({
          id: ids.floorId,
          siteId: ids.siteId,
          name: "B2",
          level: -2,
          mapRevision: 4,
          floorPlan: null,
          fixtures: [],
          mapObjects: []
        }),
        update: jest.fn()
      },
      floorPlan: { upsert: jest.fn(), deleteMany: jest.fn() },
      floorAsset: { count: jest.fn().mockResolvedValue(0) },
      fixture: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn()
      },
      floorMapObject: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        createMany: jest.fn()
      },
      floorMapRevision: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{
          mapRevision: 0,
          editorLeaseFence: 7,
          editorLeaseTokenHash: hashEditorLeaseToken("lease-token"),
          editorLeaseExpiresAt: new Date(Date.now() + 60_000)
        }])
        .mockResolvedValue([{ dbNow: new Date() }]),
      ...prismaOverrides
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        FloorEditorService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SiteAccessService,
          useValue: {
            assert: jest.fn().mockResolvedValue({ id: ids.siteId, organizationId: ids.organizationId })
          }
        },
        { provide: AuditService, useValue: { record: jest.fn() } }
      ]
    }).compile();

    return { service: moduleRef.get(FloorEditorService), prisma, siteAccess: moduleRef.get(SiteAccessService) };
  }

  it("returns editor state for an authorized floor", async () => {
    const { service, prisma } = await createService();

    await expect(service.getEditorState(ids.floorId, assignedOperator)).resolves.toMatchObject({
      floor: { id: ids.floorId, mapRevision: 4 }
    });
    expect(prisma.floor.findUnique).toHaveBeenCalledWith({
      where: { id: ids.floorId },
      include: {
        floorPlan: true,
        fixtures: { orderBy: { name: "asc" } },
        mapObjects: { orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }] }
      }
    });
  });

  it("preserves opaque access when the floor does not exist", async () => {
    const { service } = await createService({
      floor: {
        findUnique: jest.fn().mockResolvedValue(null)
      }
    });

    await expect(service.getEditorState(ids.floorId, assignedOperator)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("FloorEditorService atomic revisions", () => {
  const floorId = "00000000-0000-4000-8000-000000000103";
  const siteId = "00000000-0000-4000-8000-000000000102";
  const fixtureId = "00000000-0000-4000-8000-000000000104";
  const missingFixtureId = "00000000-0000-4000-8000-000000000199";
  const objectId = "00000000-0000-4000-8000-000000000105";
  const deletedObjectId = "00000000-0000-4000-8000-000000000106";
  const leaseToken = "lease-token";
  const leaseFence = 7;
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
      originalFileUrl: "https://assets.example/b2.png",
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
    leaseToken,
    leaseFence,
    floorPlan: {
      imageUrl: "https://assets.example/b2.png",
      sourceType: "image" as const,
      originalFileUrl: "https://assets.example/b2.png",
      renderedImageUrl: "https://assets.example/b2-rendered.png",
      width: 1200,
      height: 800
    },
    fixtureUpdates: [{ id: fixtureId, x: 130, y: 250, size: 24 }],
    objectCreates: [{
      type: "text" as const,
      x: 10,
      y: 20,
      width: 120,
      height: 40,
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
        update: jest.fn().mockResolvedValue({ id: floorId }),
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
          Promise.resolve((where.id.in as string[]).map((id) => ({
            id,
            type: "rectangle",
            width: 240,
            height: 160,
            points: null
          })))
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
      auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) },
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{
          mapRevision: 3,
          editorLeaseFence: leaseFence,
          editorLeaseTokenHash: hashEditorLeaseToken(leaseToken),
          editorLeaseExpiresAt: new Date(Date.now() + 60_000)
        }])
        .mockResolvedValue([{ dbNow: new Date() }])
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (key === "$queryRaw") {
        tx.$queryRaw = value;
        continue;
      }
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
      floorMapObject: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve((where.id.in as string[]).map((id) => ({
            id,
            type: "rectangle",
            width: 240,
            height: 160,
            points: null
          })))
        )
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
    const tx = createTransactionClient({
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{
          mapRevision: 2,
          editorLeaseFence: leaseFence,
          editorLeaseTokenHash: hashEditorLeaseToken(leaseToken),
          editorLeaseExpiresAt: new Date(Date.now() + 60_000)
        }])
        .mockResolvedValue([{ dbNow: new Date() }])
    });
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
    expect(tx.floor.update).toHaveBeenCalledWith({
      where: { id: floorId },
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

    expect(tx.floor.update).not.toHaveBeenCalled();
    expect(tx.floorMapRevision.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects non-ready floor plan assets before attempting the optimistic mutation", async () => {
    const tx = createTransactionClient({ floorAsset: { count: jest.fn().mockResolvedValue(1) } });
    const { service } = await createAtomicService({ tx });

    await expect(service.saveEditorState(user, floorId, saveInput)).rejects.toThrow("ready floor assets");

    expect(tx.floor.update).not.toHaveBeenCalled();
    expect(tx.floorPlan.upsert).not.toHaveBeenCalled();
    expect(tx.floorMapRevision.create).not.toHaveBeenCalled();
  });

  it.each([
    ["points on a rectangle", { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
    ["triangle without three points", { type: "triangle" }]
  ])("rejects %s before the optimistic mutation", async (_label, patch) => {
    const tx = createTransactionClient();
    const { service } = await createAtomicService({ tx });

    await expect(service.saveEditorState(user, floorId, {
      ...saveInput,
      objectUpdates: [{ id: objectId, patch }]
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.floor.update).not.toHaveBeenCalled();
    expect(tx.floorMapObject.update).not.toHaveBeenCalled();
  });

  it.each([
    ["nullable rectangle width", { width: null }],
    ["nonzero line height", { type: "line", height: 5 }],
    ["incomplete rectangle-to-line transition", { type: "line" }]
  ])("rejects merged object geometry for %s before optimistic mutation", async (_label, patch) => {
    const tx = createTransactionClient();
    const { service, prisma } = await createAtomicService({ tx });

    await expect(service.saveEditorState(user, floorId, {
      ...saveInput,
      floorPlan: undefined,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [{ id: objectId, patch }],
      objectDeletes: []
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.floor.update).not.toHaveBeenCalled();
    expect(tx.floorMapObject.update).not.toHaveBeenCalled();
  });

  it.each([2_147_483_648, "1e100", 0, 1.5])(
    "rejects authorized invalid restore revision %s after access and before revision query",
    async (revision) => {
      const { service, prisma, siteAccess, tx } = await createAtomicService();

      await expect(service.restoreEditorRevision(user, floorId, revision as never, {
        expectedRevision: 3,
        leaseToken,
        leaseFence
      })).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.floor.findUnique).toHaveBeenCalledWith({ where: { id: floorId }, select: { siteId: true } });
      expect(siteAccess.assert).toHaveBeenCalledWith(user, siteId, "manage");
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.floorMapRevision.findUnique).not.toHaveBeenCalled();
    }
  );

  it.each(["cross-tenant", "unassigned"])(
    "returns opaque 404 for %s invalid restore revisions before parsing or revision query",
    async () => {
      const accessError = new NotFoundException("site not found");
      const tx = createTransactionClient();
      const { service, prisma } = await createAtomicService({
        tx,
        siteAccessAssert: jest.fn().mockRejectedValue(accessError)
      });

      await expect(service.restoreEditorRevision(user, floorId, "2147483648" as never, {
        expectedRevision: 3,
        leaseToken,
        leaseFence
      })).rejects.toBe(accessError);

      expect(prisma.floor.findUnique).toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.floorMapRevision.findUnique).not.toHaveBeenCalled();
    }
  );

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

  it.each([
    ["blank fixture name", { ...saveInput, fixtureUpdates: [{ id: fixtureId, name: "   " }] }],
    ["invalid rated watt", { ...saveInput, fixtureUpdates: [{ id: fixtureId, ratedWatt: "not-a-number" }] }],
    ["blank object type", {
      ...saveInput,
      objectCreates: [{ ...saveInput.objectCreates[0], type: "   " }]
    }],
    ["blank object color", {
      ...saveInput,
      objectUpdates: [{ id: objectId, patch: { fillColor: "   " } }]
    }]
  ])("rejects %s before opening a mutation transaction", async (_label, input) => {
    const { service, prisma, tx } = await createAtomicService();

    await expect(service.saveEditorState(user, floorId, input)).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.floor.update).not.toHaveBeenCalled();
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
        originalFileUrl: "https://assets.example/b2.png",
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
    expect(revisionData.snapshotSha256).toBe("faba9c7c806314da6599b8c40fe2f4e7c2c479ba2869bcdf4d53e7914e9415cf");
  });

  it("saves a deterministic snapshot when persisted rows use legacy none and nullable geometry", async () => {
    const legacyFloor = {
      ...canonicalFloor,
      floorPlan: {
        ...canonicalFloor.floorPlan,
        imageUrl: "",
        sourceType: "none" as const,
        originalFileUrl: null,
        renderedImageUrl: null
      },
      mapObjects: [{
        ...canonicalFloor.mapObjects[0],
        type: "legacy-shape",
        width: null,
        height: null
      }]
    };
    const tx = createTransactionClient({ floor: { findUnique: jest.fn().mockResolvedValue(legacyFloor) } });
    const { service } = await createAtomicService({ tx });

    await expect(service.saveEditorState(user, floorId, {
      expectedRevision: 3,
      leaseToken,
      leaseFence,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).resolves.toMatchObject({
      floor: { floorPlan: { sourceType: "none", imageUrl: "" } },
      objects: [{ type: "legacy-shape", width: 0, height: 0 }]
    });

    expect(tx.floorMapRevision.create.mock.calls[0][0].data.snapshot).toMatchObject({
      floorPlan: { sourceType: "none", originalFileUrl: null, renderedImageUrl: null },
      objects: [{ type: "legacy-shape", width: null, height: null }]
    });
  });

  it("rejects unsafe persisted object points as 400 and rolls back the optimistic mutation", async () => {
    const unsafeFloor = {
      ...canonicalFloor,
      mapObjects: [{ ...canonicalFloor.mapObjects[0], points: { x: 1, y: 2 } }]
    };
    const tx = createTransactionClient({ floor: { findUnique: jest.fn().mockResolvedValue(unsafeFloor) } });
    const { service } = await createAtomicService({ tx });

    await expect(service.saveEditorState(user, floorId, {
      expectedRevision: 3,
      leaseToken,
      leaseFence,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.floorMapRevision.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("returns editor objects in stable zIndex and createdAt order while snapshot hashing stays ID canonical", async () => {
    const lowerZObject = {
      ...canonicalFloor.mapObjects[0],
      id: deletedObjectId,
      zIndex: 1,
      createdAt: new Date("2026-07-21T00:00:00.000Z")
    };
    const tx = createTransactionClient({
      floor: {
        findUnique: jest.fn().mockResolvedValue({
          ...canonicalFloor,
          mapObjects: [canonicalFloor.mapObjects[0], lowerZObject]
        })
      }
    });
    const { service } = await createAtomicService({ tx });

    const result = await service.saveEditorState(user, floorId, saveInput);

    expect(result.objects.map((object: { id: string }) => object.id)).toEqual([deletedObjectId, objectId]);
    expect(tx.floorMapRevision.create.mock.calls[0][0].data.snapshot.objects.map((object: { id: string }) => object.id))
      .toEqual([objectId, deletedObjectId]);
  });

  it("paginates revisions and returns only a tenant-safe actor display name", async () => {
    const revisions = [
      {
        id: "revision-4",
        revision: 4,
        snapshotSha256: "hash-4",
        changeSummary: { fixtureUpdates: 1 },
        changedBy: user.id,
        restoredFromRevision: null,
        createdAt: new Date("2026-07-22T00:00:00.000Z"),
        user: { id: user.id, name: "Provider Operator", email: user.email, organizationId: "service-provider-1" }
      },
      {
        id: "revision-3",
        revision: 3,
        snapshotSha256: "hash-3",
        changeSummary: {},
        changedBy: "customer-admin-id",
        restoredFromRevision: null,
        createdAt: new Date("2026-07-21T00:00:00.000Z"),
        user: { id: "customer-admin-id", name: "Customer Admin", email: "admin@customer.test", organizationId: "customer-organization-1" }
      }
    ];
    const { service, prisma, siteAccess } = await createAtomicService({ revisionList: revisions });

    await expect(service.listEditorRevisions(user, floorId, { cursor: "5", limit: "1" })).resolves.toEqual({
      items: [{
        revision: 4,
        snapshotSha256: "hash-4",
        changeSummary: { fixtureUpdates: 1 },
        restoredFromRevision: null,
        createdAt: new Date("2026-07-22T00:00:00.000Z"),
        actor: { displayName: "서비스 운영자" }
      }],
      nextCursor: 4
    });
    expect(siteAccess.assert).toHaveBeenCalledWith(user, siteId, "read");
    expect(prisma.floorMapRevision.findMany).toHaveBeenCalledWith({
      where: { floorId, revision: { lt: 5 } },
      orderBy: { revision: "desc" },
      take: 2,
      select: expect.objectContaining({
        user: { select: { name: true, organizationId: true } }
      })
    });
    expect(JSON.stringify(await service.listEditorRevisions(user, floorId, { limit: "1" }))).not.toMatch(
      /changedBy|customer-admin-id|operator@example\.com|admin@customer\.test|revision-4/
    );

    siteAccess.assert.mockRejectedValueOnce(new NotFoundException("site not found"));
    await expect(service.listEditorRevisions(user, floorId, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.floorMapRevision.findMany).toHaveBeenCalledTimes(2);
  });

  it("rejects restore expectedRevision conflicts without partial writes", async () => {
    const tx = createTransactionClient({
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{
          mapRevision: 2,
          editorLeaseFence: leaseFence,
          editorLeaseTokenHash: hashEditorLeaseToken(leaseToken),
          editorLeaseExpiresAt: new Date(Date.now() + 60_000)
        }])
        .mockResolvedValue([{ dbNow: new Date() }]),
      floorMapRevision: {
        findUnique: jest.fn().mockResolvedValue({ revision: 1, snapshot: { floorPlan: null, fixtures: [], objects: [] } })
      }
    });
    const { service } = await createAtomicService({ tx });

    await expect(service.restoreEditorRevision(user, floorId, 1, {
      expectedRevision: 3,
      leaseToken,
      leaseFence
    })).rejects.toBeInstanceOf(ConflictException);

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

    const result = await service.restoreEditorRevision(user, floorId, 1, {
      expectedRevision: 3,
      leaseToken,
      leaseFence
    });

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
      data: expect.objectContaining({
        action: "floor_editor.restored",
        metadata: expect.objectContaining({ revision: 4, restoredFromRevision: 1 })
      })
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("restores legacy none floor plans and nullable object geometry", async () => {
    const snapshot = {
      floorPlan: {
        imageUrl: "",
        sourceType: "none",
        originalFileUrl: null,
        renderedImageUrl: null,
        width: 1200,
        height: 800
      },
      fixtures: [],
      objects: [{
        id: objectId,
        type: "legacy-shape",
        x: 10,
        y: 20,
        width: null,
        height: null,
        rotation: 0,
        points: null,
        text: null,
        strokeColor: "#111111",
        fillColor: null,
        strokeWidth: 2,
        fontSize: null,
        zIndex: 0,
        locked: false,
        visible: true
      }]
    };
    const tx = createTransactionClient({
      floorMapRevision: { findUnique: jest.fn().mockResolvedValue({ revision: 1, snapshot }) }
    });
    const { service } = await createAtomicService({ tx });

    await expect(service.restoreEditorRevision(user, floorId, 1, {
      expectedRevision: 3,
      leaseToken,
      leaseFence
    })).resolves.toBeDefined();

    expect(tx.floorPlan.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ floorId, sourceType: "none", imageUrl: "" })
    }));
    expect(tx.floorMapObject.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ floorId, type: "legacy-shape", width: null, height: null })]
    });
  });

  it("rejects unsafe legacy revision data before optimistic restore mutation", async () => {
    const snapshot = {
      floorPlan: null,
      fixtures: [],
      objects: [{
        id: objectId,
        type: "rectangle",
        x: 10,
        y: 20,
        width: null,
        height: null,
        rotation: 0,
        points: { x: 1, y: 2 },
        text: null,
        strokeColor: "#111111",
        fillColor: null,
        strokeWidth: 2,
        fontSize: null,
        zIndex: 0,
        locked: false,
        visible: true
      }]
    };
    const tx = createTransactionClient({
      floorMapRevision: { findUnique: jest.fn().mockResolvedValue({ revision: 1, snapshot }) }
    });
    const { service } = await createAtomicService({ tx });

    await expect(service.restoreEditorRevision(user, floorId, 1, {
      expectedRevision: 3,
      leaseToken,
      leaseFence
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.floor.update).not.toHaveBeenCalled();
    expect(tx.floorMapObject.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    [new NotFoundException("site not found"), NotFoundException],
    [new ForbiddenException("site capability denied"), ForbiddenException]
  ])("does not open a save transaction when site manage access is denied", async (error, expectedType) => {
    const { service, prisma } = await createAtomicService({ siteAccessAssert: jest.fn().mockRejectedValue(error) });

    await expect(service.saveEditorState(user, floorId, saveInput)).rejects.toBeInstanceOf(expectedType);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects leaseFence values above PostgreSQL int4 before opening a transaction", async () => {
    const { service, prisma } = await createAtomicService();

    await expect(service.saveEditorState(user, floorId, {
      ...saveInput,
      leaseFence: 2_147_483_648
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("requires the current authoritative lease inside the revision increment", async () => {
    const tx = createTransactionClient({
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{
          mapRevision: 3,
          editorLeaseFence: 8,
          editorLeaseTokenHash: hashEditorLeaseToken("successor-token"),
          editorLeaseExpiresAt: new Date(Date.now() + 60_000)
        }])
        .mockResolvedValue([{ dbNow: new Date() }])
    });
    const { service } = await createAtomicService({ tx });

    await expect(service.saveEditorState(user, floorId, {
      ...saveInput,
      leaseToken: "stale-token",
      leaseFence: 7
    })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.floor.update).not.toHaveBeenCalled();
  });

  it("rejects an expired authoritative lease using database time after the row lock is acquired", async () => {
    const tx = createTransactionClient({
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{
          mapRevision: 3,
          editorLeaseFence: leaseFence,
          editorLeaseTokenHash: hashEditorLeaseToken(leaseToken),
          editorLeaseExpiresAt: new Date("2026-08-10T00:00:00.000Z")
        }])
        .mockResolvedValue([{ dbNow: new Date("2026-08-10T00:00:00.001Z") }])
    });
    const { service } = await createAtomicService({ tx });

    await expect(service.saveEditorState(user, floorId, saveInput)).rejects.toThrow("floor editor lease is no longer active");
    expect(tx.floor.update).not.toHaveBeenCalled();
  });
});
