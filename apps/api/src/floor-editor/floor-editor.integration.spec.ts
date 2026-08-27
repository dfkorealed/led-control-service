import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { FloorEditorService } from "./floor-editor.service";
import { hashEditorLeaseToken } from "./editor-lease-token";

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
    loginId: "floor_editor_operator",
    email: "floor-editor-operator@example.com",
    name: "Floor editor operator",
    role: "operator" as const,
    status: "active" as const
  };
  const viewer = {
    id: ids.viewerId,
    organizationId: ids.customerOrganizationId,
    organizationType: "customer" as const,
    loginId: "floor_editor_viewer",
    email: "floor-editor-viewer@example.com",
    name: "Floor editor viewer",
    role: "viewer" as const,
    status: "active" as const
  };
  const otherAdmin = {
    id: ids.otherAdminId,
    organizationId: ids.otherOrganizationId,
    organizationType: "customer" as const,
    loginId: "floor_editor_other_admin",
    email: "floor-editor-other-admin@example.com",
    name: "Other admin",
    role: "admin" as const,
    status: "active" as const
  };
  const unassignedOperator = {
    ...operator,
    id: ids.unassignedOperatorId,
    loginId: "floor_editor_unassigned_operator",
    email: "unassigned-floor-editor-operator@example.com",
    name: "Unassigned floor editor operator"
  };
  const lease = {
    token: "lease-token",
    fence: 1
  };
  const saveInput = {
    expectedRevision: 0,
    leaseToken: lease.token,
    leaseFence: lease.fence,
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

    const existingProvider = await prisma.organization.findFirst({
      where: { type: "service_provider" },
      select: { id: true }
    });
    if (existingProvider) {
      ids.providerOrganizationId = existingProvider.id;
      operator.organizationId = existingProvider.id;
      unassignedOperator.organizationId = existingProvider.id;
    } else {
      await prisma.organization.create({
        data: { id: ids.providerOrganizationId, name: "Provider", type: "service_provider" }
      });
    }
    await prisma.organization.upsert({
      where: { id: ids.customerOrganizationId },
      create: { id: ids.customerOrganizationId, name: "Customer", type: "customer" },
      update: { name: "Customer", type: "customer" }
    });
    await prisma.organization.upsert({
      where: { id: ids.otherOrganizationId },
      create: { id: ids.otherOrganizationId, name: "Other customer", type: "customer" },
      update: { name: "Other customer", type: "customer" }
    });
    for (const userRecord of [
      operator,
      viewer,
      otherAdmin,
      unassignedOperator
    ]) {
      await prisma.user.upsert({
        where: { id: userRecord.id },
        create: {
        id: userRecord.id,
        organizationId: userRecord.organizationId,
        loginId: userRecord.loginId,
        email: userRecord.email,
          name: userRecord.name,
          passwordHash: "test",
          role: userRecord.role,
          status: userRecord.status
        },
        update: {
        organizationId: userRecord.organizationId,
        loginId: userRecord.loginId,
        email: userRecord.email,
          name: userRecord.name,
          role: userRecord.role,
          status: userRecord.status
        }
      });
    }
    await prisma.site.upsert({
      where: { id: ids.siteId },
      create: {
        id: ids.siteId,
        organizationId: ids.customerOrganizationId,
        name: "Transaction site",
        address: "Test",
        tariffKwhRate: "100.00"
      },
      update: {
        organizationId: ids.customerOrganizationId,
        name: "Transaction site",
        address: "Test",
        tariffKwhRate: "100.00"
      }
    });
    await prisma.siteMembership.upsert({
      where: { userId_siteId: { userId: ids.operatorId, siteId: ids.siteId } },
      create: { userId: ids.operatorId, siteId: ids.siteId },
      update: {}
    });
    await prisma.siteMembership.upsert({
      where: { userId_siteId: { userId: ids.viewerId, siteId: ids.siteId } },
      create: { userId: ids.viewerId, siteId: ids.siteId },
      update: {}
    });
    await prisma.floor.upsert({
      where: { id: ids.floorId },
      create: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 },
      update: { siteId: ids.siteId, name: "B1", level: -1 }
    });
    await prisma.floor.upsert({
      where: { id: ids.otherFloorId },
      create: { id: ids.otherFloorId, siteId: ids.siteId, name: "B2", level: -2 },
      update: { siteId: ids.siteId, name: "B2", level: -2 }
    });
    await prisma.fixture.upsert({
      where: { id: ids.fixtureId },
      create: { id: ids.fixtureId, floorId: ids.floorId, name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10 },
      update: { floorId: ids.floorId, name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10 }
    });
    await prisma.fixture.upsert({
      where: { id: ids.foreignFixtureId },
      create: { id: ids.foreignFixtureId, floorId: ids.otherFloorId, name: "B2-L01", ratedWatt: "40.00", x: 10, y: 10 },
      update: { floorId: ids.otherFloorId, name: "B2-L01", ratedWatt: "40.00", x: 10, y: 10 }
    });
    await prisma.floorAsset.upsert({
      where: { id: ids.assetId },
      create: {
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
      },
      update: {
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
    await prisma.floor.update({
      where: { id: ids.floorId },
      data: {
        mapRevision: 0,
        editorLeaseFence: 0,
        editorLeaseTokenHash: null,
        editorLeaseHolderId: null,
        editorLeaseHolderName: null,
        editorLeaseAcquiredAt: null,
        editorLeaseExpiresAt: null
      }
    });
    await prisma.fixture.update({
      where: { id: ids.fixtureId },
      data: { name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10, size: 20 }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function activateLease(token = lease.token, fence = lease.fence, expiresAt = new Date(Date.now() + 60_000)) {
    await prisma.floor.update({
      where: { id: ids.floorId },
      data: {
        editorLeaseFence: fence,
        editorLeaseTokenHash: hashEditorLeaseToken(token),
        editorLeaseHolderId: operator.id,
        editorLeaseHolderName: operator.name,
        editorLeaseAcquiredAt: new Date(expiresAt.getTime() - 30_000),
        editorLeaseExpiresAt: expiresAt
      }
    });
    return { token, fence };
  }

  it("rolls back normalized rows and revision when transactional audit recording fails", async () => {
    await activateLease();
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
    await activateLease();
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.saveEditorState(operator, ids.floorId, saveInput)).resolves.toMatchObject({
      floor: { mapRevision: 1 },
      fixtures: [{ id: ids.fixtureId, x: 20 }]
    });
    await expect(service.saveEditorState(operator, ids.floorId, {
      ...saveInput,
      fixtureUpdates: [{ id: ids.fixtureId, x: 30 }]
    })).rejects.toBeInstanceOf(ConflictException);

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
    await activateLease();
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
      leaseToken: lease.token,
      leaseFence: lease.fence,
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
      leaseToken: lease.token,
      leaseFence: lease.fence,
      floorPlan: null,
      fixtureUpdates: [{ id: ids.fixtureId, name: "Mutated L01", x: 99 }],
      objectCreates: [{ ...rectangle, type: "text", text: "Mutated", width: 160, height: 40, points: null }],
      objectUpdates: [],
      objectDeletes: [savedObject.id]
    });
    const nextLease = await activateLease("restore-lease-token", 2);
    const restored = await service.restoreEditorRevision(operator, ids.floorId, 1, {
      expectedRevision: 2,
      leaseToken: nextLease.token,
      leaseFence: nextLease.fence
    });

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
    await activateLease();
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
    const nextLease = await activateLease("restore-lease-token", 2);

    await expect(service.restoreEditorRevision(operator, ids.floorId, 1, {
      expectedRevision: 2,
      leaseToken: nextLease.token,
      leaseFence: nextLease.fence
    })).resolves.toMatchObject({ skippedFixtureIds: [ids.missingFixtureId] });
    await expect(prisma.fixture.findUnique({ where: { id: ids.missingFixtureId } })).resolves.toBeNull();
  });

  it("rejects partial plans, non-ready assets, and foreign fixtures without changing revision state", async () => {
    await activateLease();
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

  it("rejects invalid merged object geometry without committing revision state", async () => {
    await activateLease();
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
      leaseToken: lease.token,
      leaseFence: lease.fence,
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

  it("preserves opaque restore access before validating an invalid revision path", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.restoreEditorRevision(otherAdmin, ids.floorId, "2147483648", {
      expectedRevision: 0,
      leaseToken: lease.token,
      leaseFence: lease.fence
    })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restoreEditorRevision(unassignedOperator, ids.floorId, "2147483648", {
      expectedRevision: 0,
      leaseToken: lease.token,
      leaseFence: lease.fence
    })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restoreEditorRevision(operator, ids.floorId, "2147483648", {
      expectedRevision: 0,
      leaseToken: lease.token,
      leaseFence: lease.fence
    })).rejects.toBeInstanceOf(BadRequestException);

    await expect(prisma.floor.findUniqueOrThrow({ where: { id: ids.floorId }, select: { mapRevision: true } }))
      .resolves.toEqual({ mapRevision: 0 });
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
  });

  it("commits only one of two concurrent saves with the same expected revision", async () => {
    await activateLease();
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    const results = await Promise.allSettled([
      service.saveEditorState(operator, ids.floorId, {
        ...saveInput,
        fixtureUpdates: [{ id: ids.fixtureId, x: 20 }]
      }),
      service.saveEditorState(operator, ids.floorId, {
        ...saveInput,
        fixtureUpdates: [{ id: ids.fixtureId, x: 30 }]
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(1);
  });
});
