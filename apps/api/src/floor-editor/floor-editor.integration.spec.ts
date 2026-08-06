import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { FloorEditorService } from "./floor-editor.service";

const databaseUrl = process.env.FLOOR_EDITOR_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("FloorEditorService PostgreSQL transaction", () => {
  const ids = {
    providerOrganizationId: "10000000-0000-4000-8000-000000000001",
    customerOrganizationId: "10000000-0000-4000-8000-000000000002",
    otherOrganizationId: "10000000-0000-4000-8000-000000000003",
    operatorId: "10000000-0000-4000-8000-000000000004",
    viewerId: "10000000-0000-4000-8000-000000000005",
    otherAdminId: "10000000-0000-4000-8000-000000000006",
    unassignedOperatorId: "10000000-0000-4000-8000-000000000014",
    siteId: "10000000-0000-4000-8000-000000000007",
    floorId: "10000000-0000-4000-8000-000000000008",
    fixtureId: "10000000-0000-4000-8000-000000000009",
    missingFixtureId: "10000000-0000-4000-8000-000000000010",
    otherFloorId: "10000000-0000-4000-8000-000000000011",
    foreignFixtureId: "10000000-0000-4000-8000-000000000012",
    assetId: "10000000-0000-4000-8000-000000000013"
  };
  const readyAssetUrl = "https://assets.example/integration-floor.png";
  const operator = {
    id: ids.operatorId,
    organizationId: ids.providerOrganizationId,
    organizationType: "service_provider" as const,
    email: "floor-editor-operator@example.com",
    name: "Floor editor operator",
    role: "operator" as const,
    status: "active" as const
  };
  const viewer = {
    id: ids.viewerId,
    organizationId: ids.customerOrganizationId,
    organizationType: "customer" as const,
    email: "floor-editor-viewer@example.com",
    name: "Floor editor viewer",
    role: "viewer" as const,
    status: "active" as const
  };
  const otherAdmin = {
    id: ids.otherAdminId,
    organizationId: ids.otherOrganizationId,
    organizationType: "customer" as const,
    email: "floor-editor-other-admin@example.com",
    name: "Other admin",
    role: "admin" as const,
    status: "active" as const
  };
  const unassignedOperator = {
    ...operator,
    id: ids.unassignedOperatorId,
    email: "unassigned-floor-editor-operator@example.com",
    name: "Unassigned floor editor operator"
  };
  const saveInput = {
    expectedRevision: 0,
    fixtureUpdates: [{ id: ids.fixtureId, x: 20 }],
    objectCreates: [],
    objectUpdates: [],
    objectDeletes: []
  };

  let prisma: PrismaService;
  let siteAccess: SiteAccessService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    siteAccess = new SiteAccessService(prisma);

    await prisma.organization.createMany({
      data: [
        { id: ids.providerOrganizationId, name: "Provider", type: "service_provider" },
        { id: ids.customerOrganizationId, name: "Customer", type: "customer" },
        { id: ids.otherOrganizationId, name: "Other customer", type: "customer" }
      ]
    });
    await prisma.user.createMany({
      data: [
        {
          id: operator.id, organizationId: operator.organizationId, email: operator.email, name: operator.name,
          passwordHash: "test", role: operator.role, status: operator.status
        },
        {
          id: viewer.id, organizationId: viewer.organizationId, email: viewer.email, name: viewer.name,
          passwordHash: "test", role: viewer.role, status: viewer.status
        },
        {
          id: otherAdmin.id, organizationId: otherAdmin.organizationId, email: otherAdmin.email, name: otherAdmin.name,
          passwordHash: "test", role: otherAdmin.role, status: otherAdmin.status
        },
        {
          id: unassignedOperator.id, organizationId: unassignedOperator.organizationId,
          email: unassignedOperator.email, name: unassignedOperator.name,
          passwordHash: "test", role: unassignedOperator.role, status: unassignedOperator.status
        }
      ]
    });
    await prisma.site.create({
      data: {
        id: ids.siteId,
        organizationId: ids.customerOrganizationId,
        name: "Transaction site",
        address: "Test",
        tariffKwhRate: "100.00"
      }
    });
    await prisma.siteMembership.createMany({
      data: [
        { userId: ids.operatorId, siteId: ids.siteId },
        { userId: ids.viewerId, siteId: ids.siteId }
      ]
    });
    await prisma.floor.create({ data: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 } });
    await prisma.floor.create({ data: { id: ids.otherFloorId, siteId: ids.siteId, name: "B2", level: -2 } });
    await prisma.fixture.create({
      data: { id: ids.fixtureId, floorId: ids.floorId, name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10 }
    });
    await prisma.fixture.create({
      data: { id: ids.foreignFixtureId, floorId: ids.otherFloorId, name: "B2-L01", ratedWatt: "40.00", x: 10, y: 10 }
    });
    await prisma.floorAsset.create({
      data: {
        id: ids.assetId,
        floorId: ids.floorId,
        kind: "original",
        status: "ready",
        objectKey: "integration/floor.png",
        publicUrl: readyAssetUrl,
        mimeType: "image/png",
        sizeBytes: 1024n,
        sha256: "a".repeat(64),
        readyAt: new Date()
      }
    });
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany({ where: { siteId: ids.siteId } });
    await prisma.floorMapRevision.deleteMany({ where: { floorId: ids.floorId } });
    await prisma.floorMapObject.deleteMany({ where: { floorId: ids.floorId } });
    await prisma.floorPlan.deleteMany({ where: { floorId: ids.floorId } });
    await prisma.fixture.deleteMany({ where: { floorId: ids.floorId, id: { not: ids.fixtureId } } });
    await prisma.floor.update({ where: { id: ids.floorId }, data: { mapRevision: 0 } });
    await prisma.fixture.update({
      where: { id: ids.fixtureId },
      data: { name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10, size: 20 }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rolls back normalized rows and revision when transactional audit recording fails", async () => {
    const failingAudit = { record: jest.fn().mockRejectedValue(new Error("audit unavailable")) };
    const service = new FloorEditorService(prisma, siteAccess, failingAudit as never);

    await expect(service.saveEditorState(operator, ids.floorId, saveInput)).rejects.toThrow("audit unavailable");

    await expect(prisma.floor.findUniqueOrThrow({ where: { id: ids.floorId }, select: { mapRevision: true } }))
      .resolves.toEqual({ mapRevision: 0 });
    await expect(prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId }, select: { x: true } }))
      .resolves.toEqual({ x: 10 });
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(0);
  });

  it("commits one audit and revision and rejects a stale optimistic save without another commit", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.saveEditorState(operator, ids.floorId, saveInput)).resolves.toMatchObject({
      floor: { mapRevision: 1 },
      fixtures: [{ id: ids.fixtureId, x: 20 }]
    });
    await expect(service.saveEditorState(operator, ids.floorId, { ...saveInput, fixtureUpdates: [{ id: ids.fixtureId, x: 30 }] }))
      .rejects.toBeInstanceOf(ConflictException);

    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId, action: "floor_editor.saved" } })).resolves.toBe(1);
    await expect(prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId }, select: { x: true } }))
      .resolves.toEqual({ x: 20 });
  });

  it("allows revision reads for an assigned viewer but blocks manage and cross-tenant reads", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.listEditorRevisions(viewer, ids.floorId)).resolves.toEqual({ items: [], nextCursor: null });
    await expect(service.saveEditorState(viewer, ids.floorId, saveInput)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.listEditorRevisions(otherAdmin, ids.floorId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("round-trips floor plan, objects, fixtures, canonical snapshot, and hash through restore", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const rectangle = {
      type: "rectangle" as const,
      x: 10,
      y: 20,
      width: 300,
      height: 120,
      rotation: 0,
      points: null,
      text: null,
      strokeColor: "#111111",
      fillColor: "#eeeeee",
      strokeWidth: 2,
      fontSize: null,
      zIndex: 5,
      locked: false,
      visible: true
    };
    const floorPlan = {
      sourceType: "image" as const,
      imageUrl: readyAssetUrl,
      originalFileUrl: readyAssetUrl,
      renderedImageUrl: readyAssetUrl,
      width: 1200,
      height: 800
    };

    await service.saveEditorState(operator, ids.floorId, {
      expectedRevision: 0,
      floorPlan,
      fixtureUpdates: [{ id: ids.fixtureId, name: "Saved L01", ratedWatt: "55.5", x: 20, y: 30, size: 24 }],
      objectCreates: [rectangle],
      objectUpdates: [],
      objectDeletes: []
    });
    const revisionOne = await prisma.floorMapRevision.findUniqueOrThrow({
      where: { floorId_revision: { floorId: ids.floorId, revision: 1 } }
    });
    const savedObject = await prisma.floorMapObject.findFirstOrThrow({ where: { floorId: ids.floorId } });

    await service.saveEditorState(operator, ids.floorId, {
      expectedRevision: 1,
      floorPlan: null,
      fixtureUpdates: [{ id: ids.fixtureId, name: "Mutated L01", x: 99 }],
      objectCreates: [{ ...rectangle, type: "text", text: "Mutated", width: 160, height: 40, points: null }],
      objectUpdates: [],
      objectDeletes: [savedObject.id]
    });
    const restored = await service.restoreEditorRevision(operator, ids.floorId, 1, { expectedRevision: 2 });

    expect(restored).toMatchObject({
      floor: { mapRevision: 3, floorPlan },
      fixtures: [{ id: ids.fixtureId, name: "Saved L01", ratedWatt: 55.5, x: 20, y: 30, size: 24 }],
      objects: [{ id: savedObject.id, type: "rectangle", x: 10, y: 20, width: 300, height: 120 }],
      skippedFixtureIds: []
    });
    const revisionThree = await prisma.floorMapRevision.findUniqueOrThrow({
      where: { floorId_revision: { floorId: ids.floorId, revision: 3 } }
    });
    expect(revisionThree.snapshot).toEqual(revisionOne.snapshot);
    expect(revisionThree.snapshotSha256).toBe(revisionOne.snapshotSha256);
    await expect(prisma.floorMapObject.count({ where: { floorId: ids.floorId } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(3);
  });

  it("skips a fixture removed after the source revision instead of recreating it", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    await prisma.fixture.create({
      data: {
        id: ids.missingFixtureId,
        floorId: ids.floorId,
        name: "B1-L02",
        ratedWatt: "30.00",
        x: 40,
        y: 50
      }
    });
    await service.saveEditorState(operator, ids.floorId, {
      ...saveInput,
      fixtureUpdates: [{ id: ids.fixtureId, x: 20 }, { id: ids.missingFixtureId, x: 60 }]
    });
    await service.saveEditorState(operator, ids.floorId, {
      ...saveInput,
      expectedRevision: 1,
      fixtureUpdates: [{ id: ids.fixtureId, x: 30 }]
    });
    await prisma.fixture.delete({ where: { id: ids.missingFixtureId } });

    await expect(service.restoreEditorRevision(operator, ids.floorId, 1, { expectedRevision: 2 }))
      .resolves.toMatchObject({ skippedFixtureIds: [ids.missingFixtureId] });
    await expect(prisma.fixture.findUnique({ where: { id: ids.missingFixtureId } })).resolves.toBeNull();
  });

  it("rejects partial plans, non-ready assets, and foreign fixtures without changing revision state", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const invalidInputs = [
      { ...saveInput, floorPlan: { sourceType: "image" } },
      {
        ...saveInput,
        floorPlan: {
          sourceType: "image",
          imageUrl: "https://assets.example/not-ready.png",
          originalFileUrl: "https://assets.example/not-ready.png",
          renderedImageUrl: "https://assets.example/not-ready.png",
          width: 1200,
          height: 800
        }
      },
      { ...saveInput, fixtureUpdates: [{ id: ids.foreignFixtureId, x: 90 }] }
    ];

    for (const input of invalidInputs) {
      await expect(service.saveEditorState(operator, ids.floorId, input)).rejects.toThrow();
    }

    await expect(prisma.floor.findUniqueOrThrow({ where: { id: ids.floorId }, select: { mapRevision: true } }))
      .resolves.toEqual({ mapRevision: 0 });
    await expect(prisma.floorPlan.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(0);
  });

  it("round-trips legacy floor plan and nullable object rows through canonical revisions", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    await service.updateFloorPlan(ids.floorId, {
      imageUrl: "",
      sourceType: "none",
      originalFileUrl: null,
      renderedImageUrl: null,
      width: 1200,
      height: 800
    }, operator);
    await service.updateFloorPlan(ids.floorId, { width: 900 }, operator);
    const legacyObject = await prisma.floorMapObject.create({
      data: {
        floorId: ids.floorId,
        type: "legacy-shape",
        x: 10,
        y: 20,
        width: null,
        height: null
      }
    });

    await service.saveEditorState(operator, ids.floorId, {
      expectedRevision: 0,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    });
    const revisionOne = await prisma.floorMapRevision.findUniqueOrThrow({
      where: { floorId_revision: { floorId: ids.floorId, revision: 1 } }
    });

    await service.updateFloorPlan(ids.floorId, {
      imageUrl: readyAssetUrl,
      sourceType: "image",
      originalFileUrl: readyAssetUrl,
      renderedImageUrl: readyAssetUrl,
      width: 640,
      height: 480
    }, operator);
    await prisma.floorMapObject.update({
      where: { id: legacyObject.id },
      data: { type: "rectangle", width: 100, height: 80 }
    });

    const restored = await service.restoreEditorRevision(operator, ids.floorId, 1, { expectedRevision: 1 });
    expect(restored).toMatchObject({
      floor: { mapRevision: 2, floorPlan: { sourceType: "none", imageUrl: "", width: 900, height: 800 } },
      objects: [{ id: legacyObject.id, type: "legacy-shape", width: 0, height: 0 }]
    });
    const revisionTwo = await prisma.floorMapRevision.findUniqueOrThrow({
      where: { floorId_revision: { floorId: ids.floorId, revision: 2 } }
    });
    expect(revisionTwo.snapshot).toEqual(revisionOne.snapshot);
    expect(revisionTwo.snapshotSha256).toBe(revisionOne.snapshotSha256);
  });

  it("rejects invalid merged object geometry without committing revision state", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const rectangle = await prisma.floorMapObject.create({
      data: {
        floorId: ids.floorId,
        type: "rectangle",
        x: 10,
        y: 20,
        width: 100,
        height: 80
      }
    });

    await expect(service.saveEditorState(operator, ids.floorId, {
      expectedRevision: 0,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [{ id: rectangle.id, patch: { width: null } }],
      objectDeletes: []
    })).rejects.toBeInstanceOf(BadRequestException);

    await expect(prisma.floor.findUniqueOrThrow({ where: { id: ids.floorId }, select: { mapRevision: true } }))
      .resolves.toEqual({ mapRevision: 0 });
    await expect(prisma.floorMapObject.findUniqueOrThrow({ where: { id: rectangle.id }, select: { width: true } }))
      .resolves.toEqual({ width: 100 });
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(0);
  });

  it("validates effective legacy image and pdf plans before mutating persisted state", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const readyImagePlan = {
      sourceType: "image" as const,
      imageUrl: readyAssetUrl,
      originalFileUrl: readyAssetUrl,
      renderedImageUrl: readyAssetUrl,
      width: 1200,
      height: 800
    };

    await expect(service.updateFloorPlan(ids.floorId, { sourceType: "image" }, operator))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(prisma.floorPlan.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);

    await service.updateFloorPlan(ids.floorId, readyImagePlan, operator);
    const stored = await prisma.floorPlan.findUniqueOrThrow({ where: { floorId: ids.floorId } });
    for (const patch of [
      { imageUrl: "" },
      { renderedImageUrl: "https://assets.example/not-ready.png" },
      { sourceType: "pdf", originalFileUrl: null },
      {
        sourceType: "pdf",
        imageUrl: "https://assets.example/not-ready-rendered.png",
        originalFileUrl: "https://assets.example/not-ready.pdf",
        renderedImageUrl: "https://assets.example/not-ready-rendered.png"
      }
    ]) {
      await expect(service.updateFloorPlan(ids.floorId, patch as never, operator))
        .rejects.toBeInstanceOf(BadRequestException);
    }

    await expect(prisma.floorPlan.findUniqueOrThrow({ where: { floorId: ids.floorId } })).resolves.toEqual(stored);
    await expect(prisma.floor.findUniqueOrThrow({ where: { id: ids.floorId }, select: { mapRevision: true } }))
      .resolves.toEqual({ mapRevision: 0 });
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(0);
  });

  it("persists a complete legacy floor plan when concurrent patches interleave", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    await service.updateFloorPlan(ids.floorId, {
      sourceType: "image",
      imageUrl: readyAssetUrl,
      originalFileUrl: readyAssetUrl,
      renderedImageUrl: readyAssetUrl,
      width: 1200,
      height: 800
    }, operator);

    let markReadyAssetReadFinished!: () => void;
    let releaseReadyAssetRead!: () => void;
    const readyAssetReadFinished = new Promise<void>((resolve) => {
      markReadyAssetReadFinished = resolve;
    });
    const readyAssetReadRelease = new Promise<void>((resolve) => {
      releaseReadyAssetRead = resolve;
    });
    const delayedPrisma = {
      floor: prisma.floor,
      floorPlan: prisma.floorPlan,
      floorAsset: {
        count: async (args: Prisma.FloorAssetCountArgs) => {
          const count = await prisma.floorAsset.count(args);
          markReadyAssetReadFinished();
          await readyAssetReadRelease;
          return count;
        }
      }
    };
    const delayedService = new FloorEditorService(
      delayedPrisma as never,
      siteAccess,
      new AuditService(prisma)
    );

    const lastWriter = delayedService.updateFloorPlan(
      ids.floorId,
      { imageUrl: readyAssetUrl },
      operator
    );
    await readyAssetReadFinished;
    try {
      await service.updateFloorPlan(ids.floorId, {
        sourceType: "none",
        imageUrl: "",
        originalFileUrl: null,
        renderedImageUrl: null,
        width: 1200,
        height: 800
      }, operator);
    } finally {
      releaseReadyAssetRead();
    }
    await lastWriter;

    await expect(prisma.floorPlan.findUniqueOrThrow({
      where: { floorId: ids.floorId },
      select: {
        sourceType: true,
        imageUrl: true,
        originalFileUrl: true,
        renderedImageUrl: true,
        width: true,
        height: true
      }
    })).resolves.toEqual({
      sourceType: "image",
      imageUrl: readyAssetUrl,
      originalFileUrl: readyAssetUrl,
      renderedImageUrl: readyAssetUrl,
      width: 1200,
      height: 800
    });
  });

  it("preserves opaque restore access before validating an invalid revision path", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.restoreEditorRevision(otherAdmin, ids.floorId, "2147483648", { expectedRevision: 0 }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restoreEditorRevision(unassignedOperator, ids.floorId, "2147483648", { expectedRevision: 0 }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restoreEditorRevision(operator, ids.floorId, "2147483648", { expectedRevision: 0 }))
      .rejects.toBeInstanceOf(BadRequestException);

    await expect(prisma.floor.findUniqueOrThrow({ where: { id: ids.floorId }, select: { mapRevision: true } }))
      .resolves.toEqual({ mapRevision: 0 });
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
  });

  it("commits only one of two concurrent saves with the same expected revision", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    const results = await Promise.allSettled([
      service.saveEditorState(operator, ids.floorId, { ...saveInput, fixtureUpdates: [{ id: ids.fixtureId, x: 20 }] }),
      service.saveEditorState(operator, ids.floorId, { ...saveInput, fixtureUpdates: [{ id: ids.fixtureId, x: 30 }] })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(1);
  });
});
